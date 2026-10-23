"""Aprendizaje de errores: el bot revisa sus apuestas (reales, de práctica y sombra) ya resueltas y busca
patrones donde gana claramente MENOS de lo que esperaba. Esos patrones se bloquean o se corrigen para no
repetir el error; los que le funcionan se reportan (sin inflarlos, para no sobreajustar).

Cada apuesta se describe con las mismas características que usa la app al decidir (ver models.js → featuresOf):
deporte, liga, mercado, favorito/underdog, rango de momio, desacuerdo modelo vs mercado, fuente del precio,
en vivo o previo, y si los sharps estaban a favor o en contra.

Evidencia, no corazonadas: un patrón solo cuenta con 20+ casos y una diferencia estadísticamente clara entre
lo que ganó y lo que esperaba (puntaje z). Un par de derrotas no bloquean nada.
"""

from __future__ import annotations

import json
import math
import time

MIN_N = 20
BLOCK_Z, BLOCK_ROI, BLOCK_N = -1.65, -0.10, 25
CORR_Z = -1.0
GOOD_Z, GOOD_ROI = 1.65, 0.05

LABELS = {
    "deporte": {"soccer": "fútbol", "football": "NFL", "basketball": "NBA", "baseball": "béisbol", "tennis": "tenis", "esports": "eSports", "mma": "MMA", "boxing": "boxeo"},
}


def odds_bucket(o):
    return "menos de 2.00" if o < 2 else "2.00 a 2.99" if o < 3 else "3.00 a 4.99" if o < 5 else "5.00 o más"


def gap_bucket(pm, pk):
    if pm is None or pk is None:
        return None
    g = pm - pk
    return "modelo abajo del mercado" if g < -0.05 else "casi igual (±5 pts)" if g < 0.05 else "modelo 5 a 10 pts arriba" if g < 0.10 \
        else "modelo 10 a 20 pts arriba" if g < 0.20 else "modelo 20+ pts arriba"


def features(x: dict) -> dict:
    """Mismo cálculo que featuresOf() en models.js."""
    o = x.get("odds") or 0
    f = {"deporte": x.get("sport"), "liga": x.get("leagueId"), "mercado": x.get("market")}
    if o:
        f["lado"] = "favorito" if o < 2 else "underdog"
        f["momio"] = odds_bucket(o)
    g = gap_bucket(x.get("pModel"), x.get("pMarket"))
    if g:
        f["desacuerdo"] = g
    if x.get("src"):
        f["fuente"] = str(x["src"])
    f["momento"] = "en vivo" if x.get("live") else "previo"
    if x.get("sharp"):
        f["sharps"] = x["sharp"]
    return {k: v for k, v in f.items() if v}


def resolved_items(state: dict) -> list[dict]:
    """Apuestas resueltas con su probabilidad, resultado y ganancia por unidad."""
    out = []
    preds = state.get("predictions") or {}
    for b in state.get("bets") or []:
        if b.get("status") not in ("won", "lost") or not b.get("odds") or b.get("p") is None:
            continue
        sharp = None
        if b.get("sharpSide"):
            sharp = "sharps a favor" if b["sharpSide"] == b.get("pick") else "sharps en contra"
        out.append({"sport": b.get("sport"), "leagueId": b.get("leagueId"), "market": b.get("market"), "odds": b["odds"], "p": b["p"],
                    "pModel": b.get("pModel"), "pMarket": b.get("pMarket"), "src": b.get("oddsSource"), "live": b.get("live"), "sharp": sharp,
                    "won": b["status"] == "won", "profit": (b["odds"] - 1) if b["status"] == "won" else -1.0, "kind": "apuesta"})
    for s in state.get("shadow") or []:
        if s.get("status") not in ("won", "lost") or not s.get("odds") or s.get("p") is None:
            continue
        pr = preds.get(str(s.get("eventId"))) or {}
        pm = s.get("pModel", (pr.get("model") or {}).get(s.get("pick")))
        pk = s.get("pMarket", (pr.get("market") or {}).get(s.get("pick")))
        out.append({"sport": s.get("sport"), "leagueId": s.get("leagueId"), "market": s.get("market"), "odds": s["odds"], "p": s["p"],
                    "pModel": pm, "pMarket": pk, "src": s.get("src"), "live": False, "sharp": None,
                    "won": s["status"] == "won", "profit": s.get("profit", (s["odds"] - 1) if s["status"] == "won" else -1.0), "kind": "sombra"})
    return out


def analyze(state: dict) -> dict:
    items = resolved_items(state)
    groups: dict[tuple, list] = {}
    for it in items:
        f = features(it)
        keys = [((k, v),) for k, v in f.items()]
        # Pares con el deporte: "underdog en NFL", "desacuerdo grande en tenis"...
        if f.get("deporte"):
            keys += [(("deporte", f["deporte"]), (k, v)) for k, v in f.items() if k not in ("deporte", "liga")]
        for key in keys:
            groups.setdefault(key, []).append(it)
    bad, good = [], []
    for key, g in groups.items():
        n = len(g)
        if n < MIN_N:
            continue
        exp = sum(x["p"] for x in g)
        var = sum(x["p"] * (1 - x["p"]) for x in g) or 1e-9
        wins = sum(1 for x in g if x["won"])
        z = (wins - exp) / math.sqrt(var)
        roi = sum(x["profit"] for x in g) / n
        row = {"conds": [list(c) for c in key], "n": n, "wins": wins, "expected": round(exp, 1), "z": round(z, 2), "roi": round(roi, 4),
               "kinds": {k: sum(1 for x in g if x["kind"] == k) for k in ("apuesta", "sombra")}}
        if z <= BLOCK_Z and roi <= BLOCK_ROI and n >= BLOCK_N:
            bad.append({**row, "action": "bloqueado", "factor": 0.0})
        elif z <= CORR_Z:
            # Corrige la probabilidad hacia lo que de verdad pasó (con prudencia: entre 85% y 100%).
            bad.append({**row, "action": "corregido", "factor": round(max(0.85, min(1.0, (wins + 3) / (exp + 3))), 3)})
        elif z >= GOOD_Z and roi >= GOOD_ROI:
            good.append({**row, "action": "funciona"})
    bad.sort(key=lambda r: r["z"])
    good.sort(key=lambda r: -r["z"])
    return {"t": time.time() * 1000, "analyzed": len(items), "byKind": {k: sum(1 for x in items if x["kind"] == k) for k in ("apuesta", "sombra")},
            "patterns": bad[:40], "good": good[:15], "rules": {"minN": MIN_N, "blockZ": BLOCK_Z, "blockRoi": BLOCK_ROI, "corrZ": CORR_Z}}


class Aprendizaje:
    def __init__(self, store):
        self.store = store
        self.result = None
        self.t = 0.0

    def get(self, max_age=1800):
        if self.result is None or time.time() - self.t > max_age:
            text, _ = self.store.get_state()
            try:
                self.result = analyze(json.loads(text) if text else {})
            except (ValueError, TypeError) as e:
                self.result = {"error": str(e), "patterns": [], "good": [], "analyzed": 0}
            self.t = time.time()
        return self.result
