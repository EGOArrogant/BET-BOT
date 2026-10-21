"""Momio por encima del precio justo (cazar momios).

El backtesting mostró que, en las ligas grandes, predecir mejor que el mercado por resultados no funciona.
Lo que sí da valor medible es encontrar una casa que pague MÁS que el precio justo:
- Precio justo = el momio de Pinnacle (la casa más precisa) sin su margen.
- Si otra casa paga más que ese precio justo, la apuesta tiene valor esperado positivo (EV > 0).
- Se guarda cada foto de precios: el último de Pinnacle antes del partido es el "cierre" y sirve para medir el CLV.

Créditos de The Odds API (cuestan dinero): todo pasa por aquí, con caché compartida entre dispositivos y presupuesto.
- La lista de partidos próximos usa /events, que NO gasta créditos.
- Solo se piden momios de las ligas con partidos cercanos, con más frecuencia entre más cerca del inicio.
- Presupuesto mensual (ODDS_CREDITOS_MES en .env, 500 = plan gratuito) repartido por día; reserva para el uso manual.
"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import threading
import time
from pathlib import Path

import httpx

from historico import norm_team

# Ligas del bot → clave de The Odds API.
SPORTS = {
    "uefa.champions": "soccer_uefa_champs_league", "eng.1": "soccer_epl", "esp.1": "soccer_spain_la_liga",
    "mex.1": "soccer_mexico_ligamx", "ita.1": "soccer_italy_serie_a", "fra.1": "soccer_france_ligue_one",
    "nfl": "americanfootball_nfl", "nba": "basketball_nba", "mlb": "baseball_mlb", "ufc": "mma_mixed_martial_arts",
}
SPORT_KIND = {"nfl": "football", "nba": "basketball", "mlb": "baseball", "ufc": "mma"}
# Casas: 'mx' = opera en México (verifica su permiso SEGOB); 'intl' = se puede usar desde México sin permiso SEGOB.
# Las casas de EE. UU. reguladas por estado (DraftKings, FanDuel...) no se pueden usar desde México: se ignoran.
BOOKS = {
    "betway": ("Betway", "mx"), "bet365": ("bet365", "mx"), "codere": ("Codere", "mx"), "betano": ("Betano", "mx"),
    "caliente": ("Caliente", "mx"), "playdoit": ("Playdoit", "mx"), "strendus": ("Strendus", "mx"), "betcris": ("Betcris", "mx"),
    "betfair_ex_eu": ("Betfair (exchange)", "intl"), "betfair_ex_uk": ("Betfair (exchange)", "intl"), "betfair_sb_uk": ("Betfair", "intl"),
    "bwin": ("bwin", "intl"), "williamhill": ("William Hill", "intl"), "unibet_eu": ("Unibet", "intl"), "unibet_uk": ("Unibet", "intl"),
    "betsson": ("Betsson", "intl"), "nordicbet": ("NordicBet", "intl"), "marathonbet": ("Marathonbet", "intl"), "sport888": ("888sport", "intl"),
    "onexbet": ("1xBet", "intl"), "coolbet": ("Coolbet", "intl"), "everygame": ("Everygame", "intl"), "matchbook": ("Matchbook", "intl"),
    "betonlineag": ("BetOnline", "intl"), "lowvig": ("LowVig", "intl"), "mybookieag": ("MyBookie", "intl"), "bovada": ("Bovada", "intl"),
    "tipico_de": ("Tipico", "intl"), "winamax_fr": ("Winamax", "intl"), "pinnacle": ("Pinnacle", "intl"),
}
SHARP = "pinnacle"
MIN_EV = 0.02          # paga al menos 2% más que el precio justo
ODDS_RANGE = (1.25, 12.0)
RESERVE = 25           # créditos que se dejan libres para consultas manuales


def no_vig(prices: list[float]) -> list[float] | None:
    if not prices or any(not p or p <= 1 for p in prices):
        return None
    inv = [1 / p for p in prices]
    s = sum(inv)
    return [x / s for x in inv]


class Precios:
    def __init__(self, data_dir: Path, read_env, base_url: str = "https://api.the-odds-api.com/v4"):
        self.read_env = read_env
        self.base = base_url
        self.lock = threading.RLock()
        self.db = sqlite3.connect(data_dir / "precios.db", check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS fotos (
              ev TEXT NOT NULL, liga TEXT NOT NULL, inicio TEXT NOT NULL, local TEXT NOT NULL, visita TEXT NOT NULL,
              casa TEXT NOT NULL, lado TEXT NOT NULL, momio REAL NOT NULL, t REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS fotos_ev ON fotos (ev, casa, t);
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
            """
        )
        self.events_cache: dict[str, tuple[float, list]] = {}
        self.last_fetch: dict[str, float] = {}
        self.proxy_cache: dict[str, tuple[float, bytes, int]] = {}
        self.blocked_until = 0.0
        self.last_error = None

    # ---------- créditos ----------
    def meta(self, k, v=None):
        if v is None:
            r = self.db.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
            return r[0] if r else None
        self.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, str(v)))

    def note_usage(self, headers) -> None:
        rem, used = headers.get("x-requests-remaining"), headers.get("x-requests-used")
        if rem is not None:
            self.meta("remaining", rem)
            self.meta("remaining_t", time.time())
        if used is not None:
            self.meta("used", used)
        # Gasto propio del día (para repartir el presupuesto).
        last = headers.get("x-requests-last")
        if last:
            day = dt.date.today().isoformat()
            if self.meta("day") != day:
                self.meta("day", day)
                self.meta("day_spent", 0)
            self.meta("day_spent", float(self.meta("day_spent") or 0) + float(last))

    def credits(self) -> dict:
        cfg = self.read_env()
        month = int(cfg.get("ODDS_CREDITOS_MES") or 500)
        regions = (cfg.get("ODDS_REGIONES") or "eu,uk").replace(" ", "")
        rem = self.meta("remaining")
        # Un saldo de hace más de 6 h ya no se cree (los créditos se renuevan cada mes): la siguiente consulta
        # gratuita de partidos (/events) lo vuelve a confirmar.
        if rem is not None and time.time() - float(self.meta("remaining_t") or 0) > 6 * 3600:
            rem = None
        day = dt.date.today().isoformat()
        spent = float(self.meta("day_spent") or 0) if self.meta("day") == day else 0.0
        return {"month": month, "daily": round(month / 30, 1), "spentToday": spent, "remaining": float(rem) if rem is not None else None,
                "regions": regions, "costPerFetch": len(regions.split(",")), "blocked": time.time() < self.blocked_until, "error": self.last_error}

    def can_spend(self, cost: float) -> bool:
        c = self.credits()
        if c["blocked"]:
            return False
        if c["remaining"] is not None and c["remaining"] - cost < RESERVE:
            return False
        return c["spentToday"] + cost <= c["daily"]

    def _get(self, path: str, params: dict):
        key = self.read_env().get("ODDS_API_KEY")
        if not key:
            raise RuntimeError("Falta ODDS_API_KEY")
        with httpx.Client(timeout=30) as c:
            r = c.get(f"{self.base}/{path}", params={**params, "apiKey": key})
        self.note_usage(r.headers)
        if r.status_code in (401, 429) or "OUT_OF_USAGE_CREDITS" in r.text[:300]:
            # Sin créditos o clave inválida: se pausa 6 h para no insistir.
            self.blocked_until = time.time() + 6 * 3600
            self.last_error = "The Odds API: se acabaron los créditos del mes o la clave no es válida" if r.status_code != 429 else "The Odds API: límite de consultas"
            if "OUT_OF_USAGE_CREDITS" in r.text[:300]:
                self.meta("remaining", 0)
        r.raise_for_status()
        self.last_error = None
        return r.json()

    # ---------- proxy compartido (/api/odds de la app): caché de 30 min para todos los dispositivos ----------
    def proxy(self, p: str) -> tuple[int, bytes, dict]:
        hit = self.proxy_cache.get(p)
        if hit and time.time() - hit[0] < 30 * 60:
            return hit[2], hit[1], {}
        if time.time() < self.blocked_until:
            if hit:
                return hit[2], hit[1], {}
            return 429, json.dumps({"error": self.last_error or "The Odds API en pausa"}).encode(), {}
        key = self.read_env().get("ODDS_API_KEY")
        if not key:
            return 401, b'{"error":"Falta ODDS_API_KEY"}', {}
        sep = "&" if "?" in p else "?"
        with httpx.Client(timeout=30) as c:
            r = c.get(f"{self.base}/{p}{sep}apiKey={key}")
        self.note_usage(r.headers)
        if r.status_code in (401, 429) or b"OUT_OF_USAGE_CREDITS" in r.content[:300]:
            self.blocked_until = time.time() + 6 * 3600
            self.last_error = "The Odds API: se acabaron los créditos del mes o la clave no es válida"
        if r.status_code == 200:
            self.proxy_cache[p] = (time.time(), r.content, 200)
        extra = {"X-Requests-Remaining": r.headers["x-requests-remaining"]} if r.headers.get("x-requests-remaining") else {}
        return r.status_code, r.content, extra

    # ---------- partidos próximos (gratis) ----------
    def upcoming(self, liga: str) -> list:
        hit = self.events_cache.get(liga)
        if hit and time.time() - hit[0] < 3 * 3600:
            return hit[1]
        evs = self._get(f"sports/{SPORTS[liga]}/events", {})
        self.events_cache[liga] = (time.time(), evs)
        return evs

    # ---------- ciclo: decide qué ligas consultar con el presupuesto ----------
    def due(self) -> list[tuple[float, str]]:
        """Ligas que toca actualizar, la más urgente primero. Frecuencia según qué tan pronto empieza su próximo partido."""
        now = dt.datetime.now(dt.timezone.utc)
        out = []
        if time.time() < self.blocked_until or not self.can_spend(self.credits()["costPerFetch"]):
            return out  # sin créditos o sin presupuesto hoy: ni siquiera se pregunta
        for liga in SPORTS:
            try:
                evs = self.upcoming(liga)
            except Exception as e:
                self.last_error = f"No se pudo leer la lista de partidos: {e}"
                continue
            hrs = [(dt.datetime.fromisoformat(e["commence_time"].replace("Z", "+00:00")) - now).total_seconds() / 3600 for e in evs]
            hrs = [h for h in hrs if 0.1 < h < 30]
            if not hrs:
                continue
            soon = min(hrs)
            every = 0.75 if soon < 3 else 3 if soon < 12 else 8   # horas entre consultas
            if time.time() - self.last_fetch.get(liga, 0) >= every * 3600:
                out.append((soon, liga))
        return sorted(out)

    def tick(self) -> dict:
        done = []
        for _, liga in self.due():
            cost = self.credits()["costPerFetch"]
            if not self.can_spend(cost):
                break
            try:
                self.fetch(liga)
                done.append(liga)
            except Exception as e:
                self.last_error = f"{liga}: {e}"
                break
        return {"fetched": done}

    def fetch(self, liga: str) -> int:
        regions = self.credits()["regions"]
        data = self._get(f"sports/{SPORTS[liga]}/odds", {"regions": regions, "markets": "h2h", "oddsFormat": "decimal"})
        self.last_fetch[liga] = time.time()
        now, rows = time.time(), []
        for g in data:
            home, away = g.get("home_team"), g.get("away_team")
            for b in g.get("bookmakers", []):
                if b.get("key") not in BOOKS:
                    continue
                for mk in b.get("markets", []):
                    if mk.get("key") != "h2h":
                        continue
                    for o in mk.get("outcomes", []):
                        lado = "home" if o["name"] == home else "away" if o["name"] == away else "draw" if o["name"].lower() == "draw" else None
                        if lado and o.get("price"):
                            rows.append((g["id"], liga, g["commence_time"], home, away, b["key"], lado, float(o["price"]), now))
        with self.lock:
            self.db.executemany("INSERT INTO fotos (ev, liga, inicio, local, visita, casa, lado, momio, t) VALUES (?,?,?,?,?,?,?,?,?)", rows)
            # Se guardan 45 días (suficiente para medir el cierre de las apuestas).
            self.db.execute("DELETE FROM fotos WHERE t < ?", (now - 45 * 86400,))
        return len(rows)

    # ---------- valor: casas que pagan más que el precio justo ----------
    def latest(self, where: str = "", args: tuple = ()) -> dict:
        """Último momio de cada casa y lado por partido: {ev: {"meta": (...), "casas": {casa: {lado: momio}}}}."""
        q = ("SELECT f.ev, f.liga, f.inicio, f.local, f.visita, f.casa, f.lado, f.momio, f.t FROM fotos f "
             "JOIN (SELECT ev, casa, MAX(t) mt FROM fotos GROUP BY ev, casa) u ON u.ev = f.ev AND u.casa = f.casa AND u.mt = f.t " + where)
        out: dict = {}
        for ev, liga, inicio, lo, vi, casa, lado, momio, t in self.db.execute(q, args):
            e = out.setdefault(ev, {"liga": liga, "inicio": inicio, "local": lo, "visita": vi, "casas": {}, "t": 0})
            e["casas"].setdefault(casa, {})[lado] = momio
            e["t"] = max(e["t"], t)
        return out

    def values(self) -> list[dict]:
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        spots = []
        for ev, e in self.latest("WHERE f.inicio > ?", (now,)).items():
            sharp = e["casas"].get(SHARP)
            if not sharp:
                continue
            lados = ["home", "draw", "away"] if "draw" in sharp else ["home", "away"]
            fair = no_vig([sharp.get(l) for l in lados])
            if not fair:
                continue
            for i, lado in enumerate(lados):
                best = None
                for casa, precios in e["casas"].items():
                    if casa == SHARP or lado not in precios:
                        continue
                    price = precios[lado]
                    if not (ODDS_RANGE[0] <= price <= ODDS_RANGE[1]):
                        continue
                    evv = price * fair[i] - 1
                    if evv >= MIN_EV and (not best or evv > best["ev"]):
                        name, group = BOOKS[casa]
                        best = {"book": casa, "bookName": name, "group": group, "price": price, "ev": round(evv, 4)}
                if best:
                    spots.append({
                        "id": ev, "leagueId": e["liga"], "commence": e["inicio"], "home": e["local"], "away": e["visita"], "pick": lado,
                        "fairP": round(fair[i], 4), "fairOdds": round(1 / fair[i], 3), "pinnacle": sharp[lado], "updated": int(e["t"] * 1000), **best,
                    })
        return sorted(spots, key=lambda s: -s["ev"])

    # ---------- CLV contra el cierre de Pinnacle ----------
    def closing_fair(self, home: str, away: str, date_iso: str) -> dict | None:
        """Precio justo de cierre: la última foto de Pinnacle antes del inicio del partido."""
        try:
            d = dt.datetime.fromisoformat(str(date_iso).replace("Z", "+00:00"))
        except ValueError:
            return None
        lo, hi = (d - dt.timedelta(hours=12)).isoformat(), (d + dt.timedelta(hours=12)).isoformat()
        nh, na = norm_team(home), norm_team(away)
        cands = self.db.execute("SELECT DISTINCT ev, local, visita, inicio FROM fotos WHERE inicio BETWEEN ? AND ? AND casa = ?", (lo, hi, SHARP)).fetchall()
        for ev, lo_, vi_, inicio in cands:
            a, b = norm_team(lo_), norm_team(vi_)
            same = (a == nh or a in nh or nh in a) and (b == na or b in na or na in b)
            if not same:
                continue
            rows = self.db.execute("SELECT lado, momio FROM fotos WHERE ev = ? AND casa = ? AND t = (SELECT MAX(t) FROM fotos WHERE ev = ? AND casa = ? AND t <= ?)",
                                   (ev, SHARP, ev, SHARP, dt.datetime.fromisoformat(inicio.replace("Z", "+00:00")).timestamp())).fetchall()
            prices = dict(rows)
            lados = ["home", "draw", "away"] if "draw" in prices else ["home", "away"]
            fair = no_vig([prices.get(l) for l in lados])
            if fair:
                return {l: 1 / p for l, p in zip(lados, fair)}
        return None

    def clv(self, ledger: list[dict]) -> dict:
        """CLV de las apuestas liquidadas: momio conseguido ÷ precio justo de cierre de Pinnacle − 1."""
        groups = {"precioJusto": [], "otras": []}
        for b in ledger:
            if b.get("status") not in ("won", "lost", "cashout") or not b.get("odds") or b.get("pick") not in ("home", "draw", "away"):
                continue
            ev = str(b.get("event") or "")
            sep = " vs " if " vs " in ev else " at " if " at " in ev else None
            if not sep:
                continue
            h, a = ev.split(sep, 1)
            if sep == " at ":
                h, a = a, h
            close = self.closing_fair(h, a, b.get("eventDate") or "")
            if not close or b["pick"] not in close:
                continue
            groups["precioJusto" if b.get("lineValue") else "otras"].append(b["odds"] / close[b["pick"]] - 1)
        out = {}
        for k, v in groups.items():
            out[k] = {"n": len(v), "clv": (sum(v) / len(v)) if v else None, "beat": (sum(1 for x in v if x > 0) / len(v)) if v else None}
        return out

    def status(self) -> dict:
        c = self.credits()
        n = self.db.execute("SELECT COUNT(DISTINCT ev), COUNT(*), MAX(t) FROM fotos").fetchone()
        return {"credits": c, "events": n[0], "quotes": n[1], "lastFetch": int(n[2] * 1000) if n[2] else None,
                "leagues": {l: int(t * 1000) for l, t in self.last_fetch.items()}}
