"""Base histórica de partidos de fútbol (data/historico.db) para entrenar y probar modelos.

Fuentes (solo las que permiten este uso):
- openfootball (github.com/openfootball/football.json, dominio público CC0): resultados de Premier, LaLiga,
  Serie A, Ligue 1, Liga MX y Champions. Se descarga sola una vez al día.
- El propio bot: cada partido terminado que ve (incluye Liga MX y Champions actuales) con el momio previo de ESPN.
- football-data.co.uk: archivos CSV que TÚ descargas desde tu navegador (el sitio bloquea a los agentes de IA,
  así que el bot no los descarga solo). Traen momios de apertura y de cierre: permiten medir el CLV.
"""

from __future__ import annotations

import csv
import datetime as dt
import difflib
import io
import json
import re
import sqlite3
import threading
import unicodedata
from pathlib import Path

import httpx

LEAGUES = {"eng.1": "Premier League", "esp.1": "LaLiga", "ita.1": "Serie A", "fra.1": "Ligue 1", "mex.1": "Liga MX", "uefa.champions": "Champions League"}
OPENFOOTBALL = {"eng.1": "en.1", "esp.1": "es.1", "ita.1": "it.1", "fra.1": "fr.1", "mex.1": "mx.1", "uefa.champions": "uefa.cl"}
OF_SEASONS = ["2023-24", "2024-25", "2025-26", "2026-27"]
FD_DIV = {"E0": "eng.1", "SP1": "esp.1", "I1": "ita.1", "F1": "fra.1"}
FD_LEAGUE_NAME = {"liga mx": "mex.1"}
# Enlaces para descargar tú mismo (temporadas 2023-24 a 2026-27).
FD_LINKS = [f"https://www.football-data.co.uk/mmz4281/{s}/{d}.csv" for s in ("2324", "2425", "2526", "2627") for d in ("E0", "SP1", "I1", "F1")] + \
           ["https://www.football-data.co.uk/new/MEX.csv"]

# Nombres distintos entre fuentes → un solo nombre por equipo.
ALIASES = {
    "man united": "manchester united", "man utd": "manchester united", "man city": "manchester city", "nott m forest": "nottingham forest",
    "nottm forest": "nottingham forest", "wolves": "wolverhampton", "wolverhampton wanderers": "wolverhampton", "spurs": "tottenham",
    "tottenham hotspur": "tottenham", "newcastle united": "newcastle", "west ham united": "west ham", "brighton hove albion": "brighton",
    "brighton and hove albion": "brighton", "leicester city": "leicester", "leeds united": "leeds", "ipswich town": "ipswich",
    "luton town": "luton", "sheffield united": "sheffield utd", "sheffield weds": "sheffield wednesday", "afc bournemouth": "bournemouth",
    "ath madrid": "atletico madrid", "atletico de madrid": "atletico madrid", "club atletico de madrid": "atletico madrid",
    "ath bilbao": "athletic bilbao", "athletic club": "athletic bilbao", "betis": "real betis", "sociedad": "real sociedad",
    "celta": "celta vigo", "rc celta": "celta vigo", "espanol": "espanyol", "rcd espanyol": "espanyol", "vallecano": "rayo vallecano",
    "alaves": "alaves", "deportivo alaves": "alaves", "la coruna": "deportivo la coruna", "sp gijon": "sporting gijon",
    "inter": "internazionale", "inter milan": "internazionale", "milan": "ac milan", "roma": "as roma", "verona": "hellas verona",
    "paris sg": "paris saint germain", "psg": "paris saint germain", "st etienne": "saint etienne", "marseille": "olympique marseille",
    "lyon": "olympique lyonnais", "olympique lyon": "olympique lyonnais",
    "america": "club america", "guadalajara": "chivas", "cd guadalajara": "chivas", "uanl tigres": "tigres", "tigres uanl": "tigres",
    "unam pumas": "pumas unam", "pumas": "pumas unam", "atl san luis": "atletico san luis", "san luis": "atletico san luis",
    "queretaro": "queretaro", "mazatlan fc": "mazatlan", "fc juarez": "juarez", "club tijuana": "tijuana", "xolos": "tijuana",
}
DROP = r"\b(fc|cf|afc|sc|ac|ssc|as|cd|club|calcio|de|del|la|futbol|football|deportivo|rcd|ud|sd|1907|1909|1913|1899|1904)\b"


def norm_team(name: str) -> str:
    s = unicodedata.normalize("NFD", str(name or "")).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s.replace("&", " and ").replace("'", " "))
    s = re.sub(r"\s+", " ", s).strip()
    if s in ALIASES:
        s = ALIASES[s]
    t = re.sub(DROP, " ", s)
    t = re.sub(r"\s+", " ", t).strip() or s
    return ALIASES.get(t, t)


def match_team(name: str, known: list[str]) -> str | None:
    """Busca el equipo en la lista de la liga: nombre exacto normalizado o el más parecido (≥ 80%)."""
    n = norm_team(name)
    if n in known:
        return n
    for k in known:  # "manchester city" vs "city" o "real betis balompie" vs "real betis"
        if len(k) >= 5 and (n.startswith(k) or k.startswith(n)):
            return k
    best = difflib.get_close_matches(n, known, n=1, cutoff=0.8)
    return best[0] if best else None


class Historico:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "historico.db"
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS partidos (
              liga TEXT NOT NULL, fecha TEXT NOT NULL, local TEXT NOT NULL, visita TEXT NOT NULL,
              gl INTEGER NOT NULL, gv INTEGER NOT NULL, fuente TEXT,
              ah REAL, ad REAL, aa REAL,  -- momio de apertura (decimal)
              ch REAL, cd REAL, ca REAL,  -- momio de cierre (decimal)
              PRIMARY KEY (liga, fecha, local, visita)
            );
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
            """
        )

    def meta(self, k: str, v: str | None = None):
        if v is None:
            r = self.db.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
            return r[0] if r else None
        self.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, v))

    def upsert(self, rows: list[dict], source: str) -> int:
        """Guarda partidos terminados; si ya existe, completa los momios que falten (no los borra)."""
        n = 0
        with self.lock:
            for r in rows:
                key = (r["liga"], r["fecha"][:10], norm_team(r["local"]), norm_team(r["visita"]))
                if not all(key) or r.get("gl") is None or r.get("gv") is None:
                    continue
                cur = self.db.execute(
                    "INSERT INTO partidos (liga, fecha, local, visita, gl, gv, fuente, ah, ad, aa, ch, cd, ca) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT (liga, fecha, local, visita) DO UPDATE SET "
                    "ah = COALESCE(excluded.ah, ah), ad = COALESCE(excluded.ad, ad), aa = COALESCE(excluded.aa, aa), "
                    "ch = COALESCE(excluded.ch, ch), cd = COALESCE(excluded.cd, cd), ca = COALESCE(excluded.ca, ca)",
                    (*key, int(r["gl"]), int(r["gv"]), source, r.get("ah"), r.get("ad"), r.get("aa"), r.get("ch"), r.get("cd"), r.get("ca")),
                )
                n += cur.rowcount
        return n

    def matches(self, liga: str) -> list[tuple]:
        return self.db.execute(
            "SELECT fecha, local, visita, gl, gv, ah, ad, aa, ch, cd, ca FROM partidos WHERE liga = ? ORDER BY fecha", (liga,)).fetchall()

    def summary(self) -> dict:
        out = {}
        for liga, n, desde, hasta, cierre, apertura in self.db.execute(
                "SELECT liga, COUNT(*), MIN(fecha), MAX(fecha), SUM(ch IS NOT NULL), SUM(ah IS NOT NULL) FROM partidos GROUP BY liga"):
            out[liga] = {"name": LEAGUES.get(liga, liga), "matches": n, "from": desde, "to": hasta, "withClose": cierre or 0, "withOpen": apertura or 0}
        return out

    # ---------- openfootball (automático) ----------
    def update_openfootball(self, force: bool = False) -> dict:
        last = self.meta("openfootball_t")
        if not force and last and (dt.datetime.now().timestamp() - float(last)) < 20 * 3600:
            return {"skipped": True}
        added = {}
        with httpx.Client(timeout=30, headers={"User-Agent": "BetBotMX/3.2 (app personal de analisis)"}, follow_redirects=True) as c:
            for liga, code in OPENFOOTBALL.items():
                rows = []
                for season in OF_SEASONS:
                    r = c.get(f"https://raw.githubusercontent.com/openfootball/football.json/master/{season}/{code}.json")
                    if r.status_code != 200:
                        continue
                    data = r.json()
                    # Algunos archivos traen los partidos directo y otros agrupados por jornada.
                    ms = data.get("matches") or [x for rd in data.get("rounds", []) for x in rd.get("matches", [])]
                    for m in ms:
                        sc = m.get("score")
                        # El marcador puede venir como {"ft": [2, 1]} o como [2, 1].
                        ft = sc.get("ft") if isinstance(sc, dict) else sc if isinstance(sc, list) else None
                        if ft is None and m.get("score1") is not None:
                            ft = [m.get("score1"), m.get("score2")]
                        if not ft or len(ft) != 2 or not m.get("date"):
                            continue
                        rows.append({"liga": liga, "fecha": m["date"], "local": m.get("team1", ""), "visita": m.get("team2", ""), "gl": ft[0], "gv": ft[1]})
                added[liga] = self.upsert(rows, "openfootball")
        self.meta("openfootball_t", str(dt.datetime.now().timestamp()))
        return added

    # ---------- resultados que ve el bot ----------
    def add_bot_results(self, items: list[dict]) -> int:
        rows = []
        for it in items:
            if it.get("leagueId") not in LEAGUES:
                continue
            o = it.get("odds") or {}
            rows.append({"liga": it["leagueId"], "fecha": str(it.get("date", ""))[:10], "local": it.get("home", ""), "visita": it.get("away", ""),
                         "gl": it.get("hg"), "gv": it.get("ag"), "ch": o.get("home"), "cd": o.get("draw"), "ca": o.get("away")})
        return self.upsert(rows, "bot")

    # ---------- archivos de football-data.co.uk que subes tú ----------
    def import_football_data(self, text: str) -> dict:
        text = text.lstrip("﻿")
        rd = csv.DictReader(io.StringIO(text))
        rows, ligas = [], set()

        def f(row, *keys):
            for k in keys:
                v = (row.get(k) or "").strip()
                if v:
                    try:
                        x = float(v)
                        if x > 1:
                            return x
                    except ValueError:
                        pass
            return None

        for row in rd:
            liga = FD_DIV.get((row.get("Div") or "").strip()) or FD_LEAGUE_NAME.get((row.get("League") or "").strip().lower())
            home, away = row.get("HomeTeam") or row.get("Home"), row.get("AwayTeam") or row.get("Away")
            hg, ag = row.get("FTHG") or row.get("HG"), row.get("FTAG") or row.get("AG")
            date = (row.get("Date") or "").strip()
            if not liga or not home or not away or hg in (None, "") or ag in (None, "") or not date:
                continue
            try:
                d, mth, y = date.split("/")
                y = ("20" + y) if len(y) == 2 else y
                fecha = f"{y}-{int(mth):02d}-{int(d):02d}"
            except ValueError:
                continue
            ligas.add(liga)
            rows.append({
                "liga": liga, "fecha": fecha, "local": home, "visita": away, "gl": int(float(hg)), "gv": int(float(ag)),
                # Apertura: Pinnacle si está; si no, promedio del mercado. Cierre: Pinnacle de cierre o promedio de cierre.
                "ah": f(row, "PSH", "AvgH", "B365H"), "ad": f(row, "PSD", "AvgD", "B365D"), "aa": f(row, "PSA", "AvgA", "B365A"),
                "ch": f(row, "PSCH", "AvgCH", "B365CH"), "cd": f(row, "PSCD", "AvgCD", "B365CD"), "ca": f(row, "PSCA", "AvgCA", "B365CA"),
            })
        n = self.upsert(rows, "football-data")
        return {"rows": len(rows), "saved": n, "leagues": sorted(ligas)}
