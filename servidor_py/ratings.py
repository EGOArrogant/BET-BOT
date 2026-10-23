"""Modelos de rating (Elo) entrenados con temporadas pasadas para NFL, MLB, LMB, NBA y tenis.

Fuentes (solo las que permiten este uso):
- NFL: datos abiertos de nflverse (github.com/nflverse/nfldata, games.csv): resultados desde 2015 y
  momio moneyline de cierre → permite medir el modelo contra el mercado.
- MLB y LMB: API oficial de MLB (statsapi.mlb.com), la misma que ya usa el bot: resultados de temporadas pasadas.
- NBA y tenis: el sitio de la NBA prohíbe leer su API y la fuente abierta de tenis ya no existe, así que estos
  aprenden con los partidos que el propio bot ve terminar (con el momio previo de ESPN).

Cómo se entrena:
- Elo: cada equipo/jugador tiene un rating; el que gana sube y el que pierde baja, más si la diferencia de
  marcador fue grande; ventaja de local; al iniciar temporada los ratings regresan un poco a la media.
- Los ajustes (K, ventaja de local, regresión) se eligen con el 60% más viejo de los partidos y se mide en el
  40% más reciente, que el modelo no usó para elegirlos (backtesting sin trampa).
- Calibración isotónica y peso frente al mercado: igual que en fútbol, solo si mejoran en la prueba.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import math
import time
from pathlib import Path

import httpx

from db import Store
from historico import match_team, norm_team
from modelos import apply_cal, isotonic

SPORTS = {
    "nfl": {"name": "NFL", "sport": "football", "K": [15, 20, 25, 30], "HFA": [30, 48, 65], "REG": [0.25, 0.33, 0.5], "mov": True, "min": 400},
    "mlb": {"name": "MLB", "sport": "baseball", "K": [3, 4, 6, 8], "HFA": [15, 24, 35], "REG": [0.25, 0.5], "mov": True, "min": 1000},
    "lmb": {"name": "LMB", "sport": "baseball", "K": [4, 6, 8, 10], "HFA": [15, 24, 35], "REG": [0.25, 0.5], "mov": True, "min": 600},
    "nba": {"name": "NBA", "sport": "basketball", "K": [15, 20, 25], "HFA": [50, 70, 100], "REG": [0.25, 0.5], "mov": True, "min": 400},
    "atp": {"name": "ATP", "sport": "tennis", "K": [24, 32, 40], "HFA": [0], "REG": [0.0, 0.1], "mov": False, "min": 600},
    "wta": {"name": "WTA", "sport": "tennis", "K": [24, 32, 40], "HFA": [0], "REG": [0.0, 0.1], "mov": False, "min": 600},
}
# nflverse usa abreviaturas; el bot (ESPN) usa nombres completos.
NFL_TEAMS = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens", "BUF": "Buffalo Bills", "CAR": "Carolina Panthers",
    "CHI": "Chicago Bears", "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys", "DEN": "Denver Broncos",
    "DET": "Detroit Lions", "GB": "Green Bay Packers", "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "KC": "Kansas City Chiefs", "LA": "Los Angeles Rams", "LAR": "Los Angeles Rams", "STL": "Los Angeles Rams", "LAC": "Los Angeles Chargers",
    "SD": "Los Angeles Chargers", "LV": "Las Vegas Raiders", "OAK": "Las Vegas Raiders", "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings",
    "NE": "New England Patriots", "NO": "New Orleans Saints", "NYG": "New York Giants", "NYJ": "New York Jets", "PHI": "Philadelphia Eagles",
    "PIT": "Pittsburgh Steelers", "SEA": "Seattle Seahawks", "SF": "San Francisco 49ers", "TB": "Tampa Bay Buccaneers",
    "TEN": "Tennessee Titans", "WAS": "Washington Commanders", "WSH": "Washington Commanders",
}
UA = {"User-Agent": "BetBotMX/3.4 (app personal de analisis)"}


def am_to_dec(a):
    try:
        a = float(a)
    except (TypeError, ValueError):
        return None
    if a == 0:
        return None
    return 1 + (a / 100 if a > 0 else 100 / -a)


def season_of(liga: str, d: dt.date) -> int:
    # La NFL y la NBA cruzan de año (temporada 2026 = sep 2026 a feb 2027); béisbol y tenis van por año.
    if liga in ("nfl", "nba"):
        return d.year if d.month >= 7 else d.year - 1
    return d.year


class Juegos:
    """Partidos de otros deportes en data/historico.db (tabla juegos)."""

    def __init__(self, db, lock):
        self.db, self.lock = db, lock
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS juegos (
              liga TEXT NOT NULL, fecha TEXT NOT NULL, local TEXT NOT NULL, visita TEXT NOT NULL,
              pl REAL NOT NULL, pv REAL NOT NULL, neutral INTEGER DEFAULT 0, fuente TEXT,
              ch REAL, ca REAL,  -- momio de cierre (decimal) local / visita
              PRIMARY KEY (liga, fecha, local, visita)
            );
            """
        )

    def upsert(self, rows, source) -> int:
        n = 0
        with self.lock:
            for r in rows:
                if r.get("pl") is None or r.get("pv") is None:
                    continue
                key = (r["liga"], r["fecha"][:10], norm_team(r["local"]), norm_team(r["visita"]))
                if not all(key):
                    continue
                cur = self.db.execute(
                    "INSERT INTO juegos (liga, fecha, local, visita, pl, pv, neutral, fuente, ch, ca) VALUES (?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT (liga, fecha, local, visita) DO UPDATE SET ch = COALESCE(excluded.ch, ch), ca = COALESCE(excluded.ca, ca)",
                    (*key, float(r["pl"]), float(r["pv"]), int(bool(r.get("neutral"))), source, r.get("ch"), r.get("ca")))
                n += cur.rowcount
        return n

    def rows(self, liga):
        return self.db.execute("SELECT fecha, local, visita, pl, pv, neutral, ch, ca FROM juegos WHERE liga = ? ORDER BY fecha", (liga,)).fetchall()

    def summary(self):
        return {l: {"name": SPORTS.get(l, {}).get("name", l), "matches": n, "from": a, "to": b, "withClose": c or 0}
                for l, n, a, b, c in self.db.execute("SELECT liga, COUNT(*), MIN(fecha), MAX(fecha), SUM(ch IS NOT NULL) FROM juegos GROUP BY liga")}

    # ---------- fuentes ----------
    def update_nfl(self) -> int:
        r = httpx.get("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv", headers=UA, timeout=60, follow_redirects=True)
        r.raise_for_status()
        rows = []
        for g in csv.DictReader(io.StringIO(r.text)):
            try:
                if int(g["season"]) < 2015 or g["home_score"] in ("", "NA") or g["away_score"] in ("", "NA"):
                    continue
            except ValueError:
                continue
            rows.append({"liga": "nfl", "fecha": g["gameday"], "local": NFL_TEAMS.get(g["home_team"], g["home_team"]),
                         "visita": NFL_TEAMS.get(g["away_team"], g["away_team"]), "pl": g["home_score"], "pv": g["away_score"],
                         "neutral": g.get("location") == "Neutral", "ch": am_to_dec(g.get("home_moneyline")), "ca": am_to_dec(g.get("away_moneyline"))})
        return self.upsert(rows, "nflverse")

    def update_mlb(self, liga: str) -> int:
        params = {"mlb": {"sportId": 1}, "lmb": {"sportId": 23, "leagueId": 125}}[liga]
        rows, year = [], dt.date.today().year
        with httpx.Client(headers=UA, timeout=60) as c:
            for season in range(year - 3, year + 1):
                r = c.get("https://statsapi.mlb.com/api/v1/schedule", params={**params, "season": season, "gameType": "R,F,D,L,W"})
                if r.status_code != 200:
                    continue
                for d in r.json().get("dates", []):
                    for g in d.get("games", []):
                        if (g.get("status") or {}).get("abstractGameState") != "Final":
                            continue
                        t = g.get("teams") or {}
                        hs, as_ = (t.get("home") or {}).get("score"), (t.get("away") or {}).get("score")
                        if hs is None or as_ is None:
                            continue
                        rows.append({"liga": liga, "fecha": g.get("officialDate") or d.get("date"), "local": t["home"]["team"]["name"],
                                     "visita": t["away"]["team"]["name"], "pl": hs, "pv": as_})
        return self.upsert(rows, "mlb-statsapi")

    def update_nba(self, key: str) -> int:
        """NBA desde balldontlie (plan gratis: 5 consultas por minuto; se respeta con una pausa de 13 s)."""
        rows, year = [], dt.date.today().year
        current = season_of("nba", dt.date.today())
        # Temporadas pasadas: solo la primera vez (ya no cambian). La actual: cada día.
        seasons = [y for y in range(current - 3, current + 1) if y == current or self.meta(f"nba_{y}") != "ok"]
        with httpx.Client(headers={**UA, "Authorization": key}, timeout=60) as c:
            for season in seasons:
                cursor = None
                while True:
                    params = {"seasons[]": season, "per_page": 100}
                    if cursor:
                        params["cursor"] = cursor
                    r = c.get("https://api.balldontlie.io/v1/games", params=params)
                    if r.status_code == 429:
                        time.sleep(30)
                        continue
                    if r.status_code != 200:
                        raise RuntimeError(f"balldontlie HTTP {r.status_code}")
                    d = r.json()
                    for g in d.get("data", []):
                        if str(g.get("status", "")).lower() != "final" and g.get("status_state") != "final":
                            continue
                        hs, vs = g.get("home_team_score"), g.get("visitor_team_score")
                        if not hs and not vs:
                            continue
                        rows.append({"liga": "nba", "fecha": str(g.get("date", ""))[:10], "local": g["home_team"]["full_name"],
                                     "visita": g["visitor_team"]["full_name"], "pl": hs, "pv": vs})
                    cursor = (d.get("meta") or {}).get("next_cursor")
                    time.sleep(13)
                    if not cursor:
                        break
                if season != current:
                    self.upsert(rows, "balldontlie")
                    rows = []
                    self.meta(f"nba_{season}", "ok")
        return self.upsert(rows, "balldontlie")

    def meta(self, k, v=None):
        if v is None:
            r = self.db.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
            return r[0] if r else None
        self.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, v))

    def add_bot(self, items) -> int:
        rows = []
        for it in items:
            if it.get("leagueId") not in SPORTS:
                continue
            o = it.get("odds") or {}
            rows.append({"liga": it["leagueId"], "fecha": str(it.get("date", ""))[:10], "local": it.get("home", ""), "visita": it.get("away", ""),
                         "pl": it.get("hg"), "pv": it.get("ag"), "ch": o.get("home"), "ca": o.get("away")})
        return self.upsert(rows, "bot")


# ---------- Elo ----------
def elo_run(rows, liga, K, HFA, REG, mov):
    """Recorre los partidos en orden: predice ANTES de ver el resultado y luego actualiza. Devuelve predicciones y ratings."""
    R, last_season, preds = {}, None, []
    for fecha, h, a, ph, pa, neutral, ch, ca in rows:
        d = dt.date.fromisoformat(fecha[:10])
        s = season_of(liga, d)
        if last_season is not None and s != last_season and REG:
            for t in R:
                R[t] = 1500 + (R[t] - 1500) * (1 - REG)
        last_season = s
        rh, ra = R.get(h, 1500.0), R.get(a, 1500.0)
        diff = rh - ra + (0 if neutral else HFA)
        p = 1 / (1 + 10 ** (-diff / 400))
        res = 1.0 if ph > pa else 0.0 if ph < pa else 0.5
        preds.append({"date": fecha[:10], "p": p, "res": res, "close": (ch, ca), "known": h in R and a in R})
        m = 1.0
        if mov and ph != pa:
            win_diff = diff if res == 1 else -diff
            m = math.log(abs(ph - pa) + 1) * (2.2 / (win_diff * 0.001 + 2.2))
        delta = K * m * (res - p)
        R[h], R[a] = rh + delta, ra - delta
    return preds, R, last_season


def two_way_metrics(preds, cal=None):
    ps = [x for x in preds if x["res"] != 0.5 and x["known"]]
    if not ps:
        return None
    ll = br = acc = 0.0
    mk_br = mk_n = 0
    bets = []
    for x in ps:
        p = x["p"]
        if cal:
            p = apply_cal(cal, {"home": p, "draw": 0.0, "away": 1 - p})["home"]
        y = x["res"]
        ll += -math.log(max(1e-9, p if y else 1 - p))
        br += (p - y) ** 2
        acc += 1.0 if (p >= 0.5) == bool(y) else 0.0
        ch, ca = x["close"]
        if ch and ca:
            mh = (1 / ch) / (1 / ch + 1 / ca)
            mk_n += 1
            mk_br += (mh - y) ** 2
            for side, prob, o in (("home", p, ch), ("away", 1 - p, ca)):
                if 1.4 <= o <= 10 and prob * o - 1 >= 0.03:
                    won = (side == "home") == bool(y)
                    bets.append((o - 1) if won else -1.0)
    n = len(ps)
    return {"n": n, "logLoss": ll / n, "brier": br / n, "accuracy": acc / n, "marketN": mk_n, "marketBrier": (mk_br / mk_n) if mk_n else None,
            "bets": len(bets), "roi": (sum(bets) / len(bets)) if bets else None}


def best_blend_2way(preds):
    rows = [(x["p"], (1 / x["close"][0]) / (1 / x["close"][0] + 1 / x["close"][1]), x["res"]) for x in preds
            if x["res"] != 0.5 and x["known"] and x["close"][0] and x["close"][1]]
    if len(rows) < 300:
        return None
    res = []
    for w in [i / 20 for i in range(0, 11)]:
        ll = sum(-math.log(max(1e-9, (w * p + (1 - w) * m) if y else 1 - (w * p + (1 - w) * m))) for p, m, y in rows) / len(rows)
        res.append((ll, w))
    best_ll, best_w = min(res)
    return {"w": best_w, "n": len(rows), "ref": "cierre", "llMarket": round(res[0][0], 4), "llBest": round(best_ll, 4)}


class Ratings:
    def __init__(self, data_dir: Path, hist):
        self.juegos = Juegos(hist.db, hist.lock)
        self.hist = hist
        self.env_path = data_dir.parent / ".env"
        self.file = data_dir / "modelos" / "ratings.json"
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.models: dict = {}
        self.info: dict = {}
        self.busy = False
        self.error = None
        if self.file.exists():
            try:
                d = json.loads(self.file.read_text(encoding="utf-8"))
                self.models, self.info = d.get("models", {}), d.get("info", {})
            except ValueError as e:
                self.error = f"No se pudo leer ratings.json: {e}"

    def nba_key(self):
        """Clave de balldontlie desde el .env de la carpeta del bot (nunca sale de tu PC salvo hacia balldontlie)."""
        try:
            for line in self.env_path.read_text(encoding="utf-8-sig").splitlines():
                if line.strip().startswith("BALLDONTLIE_API_KEY="):
                    return line.split("=", 1)[1].strip().strip("\"' ") or None
        except OSError:
            pass
        return None

    def age_hours(self):
        t = self.info.get("_trained")
        return (time.time() - t) / 3600 if t else None

    def update_sources(self) -> dict:
        out = {}
        key = self.nba_key()
        if key:
            try:
                out["nba"] = self.juegos.update_nba(key)
            except Exception as e:
                out["nba"] = f"error: {e}"
        for name, fn in (("nfl", self.juegos.update_nfl), ("mlb", lambda: self.juegos.update_mlb("mlb")), ("lmb", lambda: self.juegos.update_mlb("lmb"))):
            try:
                out[name] = fn()
            except Exception as e:
                out[name] = f"error: {e}"
        return out

    def train(self, update_data=True) -> dict:
        if self.busy:
            return {"busy": True}
        self.busy, self.error = True, None
        t0 = time.time()
        try:
            if update_data:
                self.info["_sources"] = self.update_sources()
            models, info = {}, {"_sources": self.info.get("_sources")}
            for liga, cfg in SPORTS.items():
                rows = self.juegos.rows(liga)
                if len(rows) < cfg["min"]:
                    info[liga] = {"name": cfg["name"], "matches": len(rows), "trained": False, "need": cfg["min"]}
                    continue
                # 1) Ajustes: se eligen con el 60% más viejo (después de un 15% de calentamiento).
                cut_lo, cut_hi = int(len(rows) * 0.15), int(len(rows) * 0.6)
                best = None
                for K in cfg["K"]:
                    for H in cfg["HFA"]:
                        for G in cfg["REG"]:
                            preds, _, _ = elo_run(rows, liga, K, H, G, cfg["mov"])
                            m = two_way_metrics(preds[cut_lo:cut_hi])
                            if m and (best is None or m["logLoss"] < best[0]):
                                best = (m["logLoss"], K, H, G)
                _, K, H, G = best
                preds, R, last_season = elo_run(rows, liga, K, H, G, cfg["mov"])
                fit_part, test = preds[cut_lo:cut_hi], preds[cut_hi:]
                # 2) Calibración isotónica: se ajusta con la parte vieja; se usa solo si mejora en la prueba.
                tr = [x for x in fit_part if x["res"] != 0.5 and x["known"]]
                cal = {"home": isotonic([x["p"] for x in tr], [x["res"] for x in tr]), "away": isotonic([1 - x["p"] for x in tr], [1 - x["res"] for x in tr])} if len(tr) >= 300 else None
                raw_t, cal_t = two_way_metrics(test), two_way_metrics(test, cal) if cal else None
                use_cal = bool(cal and cal_t and raw_t and cal_t["logLoss"] < raw_t["logLoss"])
                blend = best_blend_2way(test)
                models[liga] = {"K": K, "HFA": H, "REG": G, "R": R, "season": last_season, "cal": cal if use_cal else None, "maxW": blend["w"] if blend else None}
                info[liga] = {"name": cfg["name"], "matches": len(rows), "trained": True, "teams": len(R), "from": rows[0][0][:10], "to": rows[-1][0][:10],
                              "params": {"K": K, "HFA": H, "REG": G}, "test": {"from": test[0]["date"] if test else None, "raw": raw_t, "cal": cal_t},
                              "calUsed": use_cal, "blend": blend}
            info["_trained"] = time.time()
            info["_seconds"] = round(time.time() - t0, 1)
            self.models, self.info = models, info
            Store._atomic_write(self.file, json.dumps({"models": models, "info": info}))
            return {"ok": True, "seconds": info["_seconds"]}
        except Exception as e:
            self.error = f"Error al entrenar: {e}"
            return {"ok": False, "error": self.error}
        finally:
            self.busy = False

    def predict(self, liga, home, away, date=None, neutral=False):
        m = self.models.get(liga)
        if not m:
            return None
        teams = list(m["R"].keys())
        h, a = match_team(home, teams), match_team(away, teams)
        if not h or not a:
            return None
        rh, ra = m["R"][h], m["R"][a]
        # Si ya empezó otra temporada desde el último partido conocido, se aplica la regresión a la media.
        try:
            d = dt.date.fromisoformat(str(date)[:10]) if date else dt.date.today()
        except ValueError:
            d = dt.date.today()
        if season_of(liga, d) != m["season"] and m["REG"]:
            rh, ra = 1500 + (rh - 1500) * (1 - m["REG"]), 1500 + (ra - 1500) * (1 - m["REG"])
        p = 1 / (1 + 10 ** (-(rh - ra + (0 if neutral else m["HFA"])) / 400))
        if m.get("cal"):
            p = apply_cal(m["cal"], {"home": p, "draw": 0.0, "away": 1 - p})["home"]
        return {"home": round(p, 4), "away": round(1 - p, 4), "elo": [round(rh), round(ra)], "teams": [h, a], "maxW": m.get("maxW")}
