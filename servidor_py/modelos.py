"""Modelo de fútbol entrenado con temporadas pasadas (Dixon-Coles), backtesting y calibración.

- Cada equipo tiene fuerza de ataque y de defensa; hay ventaja de local; los partidos recientes pesan más
  (vida media de ~200 días). Corrección de Dixon-Coles para marcadores bajos (0-0, 1-0, 0-1, 1-1).
- Backtesting "sin trampa": cada semana se re-entrena solo con los partidos anteriores y se predicen los de
  esa semana. Así se mide cómo le habría ido de verdad.
- Calibración isotónica: con los resultados del backtesting se corrige cada probabilidad (si cuando dice 40%
  pasa 35%, se ajusta). Se aplica a las predicciones nuevas.
- Contra el mercado: si hay momios (de los CSV que subas o los que vio el bot), compara precisión con el cierre,
  simula apuestas con valor y mide ROI y CLV (si el momio con el que apostó fue mejor que el de cierre).
No promete aciertos: el objetivo es saber honestamente cuándo el modelo aporta y cuándo conviene creerle al mercado.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import time
from pathlib import Path

import numpy as np
from scipy.optimize import minimize, minimize_scalar
from scipy.stats import poisson

from db import Store
from historico import LEAGUES, Historico, match_team

XI = 0.0035          # decaimiento por día (vida media ≈ 200 días)
RIDGE = 0.05         # suaviza equipos con pocos partidos (ascendidos) hacia el promedio
MAX_G = 10
MIN_TRAIN = 150      # partidos mínimos antes de empezar a predecir en el backtesting
MIN_EV = 0.03


def _dedupe(rows):
    """El mismo partido puede venir de dos fuentes con fecha distinta por la zona horaria: se queda uno."""
    out, seen = [], {}
    for r in rows:
        d = dt.date.fromisoformat(r[0][:10])
        k = (r[1], r[2])
        prev = seen.get(k)
        if prev and abs((d - prev[0]).days) <= 2:
            # Conserva el que tenga momios.
            if r[5] is not None or r[8] is not None:
                out[prev[1]] = r
            continue
        seen[k] = (d, len(out))
        out.append(r)
    return out


class Fit:
    def __init__(self, teams, x, rho):
        self.teams, self.idx, self.x, self.rho = teams, {t: i for i, t in enumerate(teams)}, x, rho
        n = len(teams)
        self.mu, self.home = x[0], x[1]
        self.att, self.dfn = x[2:2 + n], x[2 + n:2 + 2 * n]

    def lambdas(self, h, a):
        i, j = self.idx.get(h), self.idx.get(a)
        ah = self.att[i] if i is not None else 0.0
        dh = self.dfn[i] if i is not None else 0.0
        aa = self.att[j] if j is not None else 0.0
        da = self.dfn[j] if j is not None else 0.0
        return math.exp(self.mu + self.home + ah + da), math.exp(self.mu + aa + dh)

    def probs(self, h, a):
        lh, la = self.lambdas(h, a)
        m = np.outer(poisson.pmf(np.arange(MAX_G + 1), lh), poisson.pmf(np.arange(MAX_G + 1), la))
        r = self.rho
        m[0, 0] *= 1 - lh * la * r
        m[0, 1] *= 1 + lh * r
        m[1, 0] *= 1 + la * r
        m[1, 1] *= 1 - r
        m /= m.sum()
        home, draw, away = np.tril(m, -1).sum(), np.trace(m), np.triu(m, 1).sum()
        tot = np.add.outer(np.arange(MAX_G + 1), np.arange(MAX_G + 1))
        return {"lh": lh, "la": la, "home": float(home), "draw": float(draw), "away": float(away), "over25": float(m[tot > 2.5].sum())}


def fit(rows, ref: dt.date, x0=None, teams=None) -> Fit:
    """rows: (fecha, local, visita, gl, gv, ...) anteriores a ref."""
    teams = teams or sorted({r[1] for r in rows} | {r[2] for r in rows})
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    hi = np.array([idx[r[1]] for r in rows])
    ai = np.array([idx[r[2]] for r in rows])
    yh = np.array([r[3] for r in rows], float)
    ya = np.array([r[4] for r in rows], float)
    age = np.array([(ref - dt.date.fromisoformat(r[0][:10])).days for r in rows], float)
    w = np.exp(-XI * np.clip(age, 0, None))

    def nll(x):
        mu, home, att, dfn = x[0], x[1], x[2:2 + n], x[2 + n:]
        llh = mu + home + att[hi] + dfn[ai]
        lla = mu + att[ai] + dfn[hi]
        lh, la = np.exp(llh), np.exp(lla)
        f = np.sum(w * (lh - yh * llh + la - ya * lla)) + RIDGE * (att @ att + dfn @ dfn)
        gh, ga = w * (lh - yh), w * (la - ya)
        g = np.zeros_like(x)
        g[0] = gh.sum() + ga.sum()
        g[1] = gh.sum()
        np.add.at(g, 2 + hi, gh)
        np.add.at(g, 2 + ai, ga)
        np.add.at(g, 2 + n + ai, gh)
        np.add.at(g, 2 + n + hi, ga)
        g[2:] += 2 * RIDGE * x[2:]
        return f, g

    if x0 is None or len(x0) != 2 + 2 * n:
        x0 = np.zeros(2 + 2 * n)
        x0[0] = math.log(max(0.5, (yh.mean() + ya.mean()) / 2))
    res = minimize(nll, x0, jac=True, method="L-BFGS-B")
    x = res.x
    # Corrección de marcadores bajos (rho), estimada aparte.
    mu, home, att, dfn = x[0], x[1], x[2:2 + n], x[2 + n:]
    lh, la = np.exp(mu + home + att[hi] + dfn[ai]), np.exp(mu + att[ai] + dfn[hi])
    low = (yh <= 1) & (ya <= 1)

    def neg_rho(r):
        t = np.ones_like(lh)
        t[(yh == 0) & (ya == 0)] = 1 - lh[(yh == 0) & (ya == 0)] * la[(yh == 0) & (ya == 0)] * r
        t[(yh == 0) & (ya == 1)] = 1 + lh[(yh == 0) & (ya == 1)] * r
        t[(yh == 1) & (ya == 0)] = 1 + la[(yh == 1) & (ya == 0)] * r
        t[(yh == 1) & (ya == 1)] = 1 - r
        t = np.clip(t, 1e-6, None)
        return -np.sum(w[low] * np.log(t[low]))

    rho = minimize_scalar(neg_rho, bounds=(-0.2, 0.2), method="bounded").x
    return Fit(teams, x, float(rho))


# ---------- calibración isotónica (PAV) ----------
def isotonic(p, y):
    order = np.argsort(p)
    p, y = np.asarray(p)[order], np.asarray(y, float)[order]
    blocks = [[pi, yi, 1.0] for pi, yi in zip(p, y)]  # [suma p, suma y, peso]
    out = []
    for b in blocks:
        out.append(b)
        while len(out) > 1 and out[-2][1] / out[-2][2] > out[-1][1] / out[-1][2]:
            c = out.pop()
            out[-1] = [out[-1][0] + c[0], out[-1][1] + c[1], out[-1][2] + c[2]]
    xs = [b[0] / b[2] for b in out]
    ys = [b[1] / b[2] for b in out]
    return {"x": [round(v, 5) for v in xs], "y": [round(v, 5) for v in ys]}


def apply_cal(cal, probs: dict) -> dict:
    if not cal:
        return probs
    out = {}
    for k in ("home", "draw", "away"):
        c = cal.get(k)
        out[k] = float(np.interp(probs[k], c["x"], c["y"])) if c and len(c["x"]) > 1 else probs[k]
        # Mezcla prudente: 70% calibrado + 30% original (la calibración también tiene error).
        out[k] = 0.7 * out[k] + 0.3 * probs[k]
    s = sum(out.values()) or 1
    return {**probs, **{k: v / s for k, v in out.items()}}


def no_vig(h, d, a):
    if not (h and d and a):
        return None
    ih, idr, ia = 1 / h, 1 / d, 1 / a
    s = ih + idr + ia
    return {"home": ih / s, "draw": idr / s, "away": ia / s}


# ---------- backtesting ----------
def backtest(rows):
    preds = []
    if len(rows) < MIN_TRAIN + 20:
        return preds
    dates = [dt.date.fromisoformat(r[0][:10]) for r in rows]
    start = dates[MIN_TRAIN]
    week = start - dt.timedelta(days=start.weekday())
    last, prev_x, teams = dates[-1], None, None
    while week <= last:
        nxt = week + dt.timedelta(days=7)
        train = [r for r, d in zip(rows, dates) if d < week]
        test = [r for r, d in zip(rows, dates) if week <= d < nxt]
        if test and len(train) >= MIN_TRAIN:
            tset = sorted({r[1] for r in train} | {r[2] for r in train})
            m = fit(train, week, prev_x if tset == teams else None, tset)
            prev_x, teams = m.x, tset
            for r in test:
                p = m.probs(r[1], r[2])
                res = "home" if r[3] > r[4] else "away" if r[3] < r[4] else "draw"
                preds.append({"date": r[0][:10], "p": p, "res": res, "open": (r[5], r[6], r[7]), "close": (r[8], r[9], r[10]), "known": r[1] in m.idx and r[2] in m.idx})
        week = nxt
    return preds


def metrics(preds, cal=None):
    if not preds:
        return None
    ll = br = acc = 0.0
    mk_br = mk_n = 0
    bets = []
    for pr in preds:
        p = apply_cal(cal, pr["p"]) if cal else pr["p"]
        ll += -math.log(max(1e-9, p[pr["res"]]))
        br += sum((p[k] - (1.0 if k == pr["res"] else 0.0)) ** 2 for k in ("home", "draw", "away"))
        acc += 1.0 if max(("home", "draw", "away"), key=lambda k: p[k]) == pr["res"] else 0.0
        mk = no_vig(*pr["close"])
        if mk:
            mk_n += 1
            mk_br += sum((mk[k] - (1.0 if k == pr["res"] else 0.0)) ** 2 for k in ("home", "draw", "away"))
        # Apuesta con valor: al momio de apertura si existe (y se mide el CLV contra el cierre); si no, al de cierre.
        price = pr["open"] if all(pr["open"]) else pr["close"] if all(pr["close"]) else None
        if price:
            for i, k in enumerate(("home", "draw", "away")):
                o = price[i]
                if 1.4 <= o <= 10 and p[k] * o - 1 >= MIN_EV:
                    won = k == pr["res"]
                    clv = (o / pr["close"][i] - 1) if all(pr["open"]) and all(pr["close"]) else None
                    bets.append({"profit": (o - 1) if won else -1.0, "clv": clv, "beat": (clv > 0) if clv is not None else None})
    n = len(preds)
    clvs = [b["clv"] for b in bets if b["clv"] is not None]
    return {
        "n": n, "logLoss": ll / n, "brier": br / n, "accuracy": acc / n,
        "marketN": mk_n, "marketBrier": (mk_br / mk_n) if mk_n else None,
        "bets": len(bets), "roi": (sum(b["profit"] for b in bets) / len(bets)) if bets else None,
        "clv": (sum(clvs) / len(clvs)) if clvs else None, "beatClose": (sum(1 for c in clvs if c > 0) / len(clvs)) if clvs else None,
        "clvN": len(clvs),
    }


def reliability(preds, cal=None, bins=10):
    """Para la gráfica de calibración: por rango de probabilidad, lo que dijo vs. lo que pasó."""
    acc = [[0.0, 0.0, 0] for _ in range(bins)]
    for pr in preds:
        p = apply_cal(cal, pr["p"]) if cal else pr["p"]
        for k in ("home", "draw", "away"):
            b = min(bins - 1, int(p[k] * bins))
            acc[b][0] += p[k]
            acc[b][1] += 1.0 if k == pr["res"] else 0.0
            acc[b][2] += 1
    return [{"p": a[0] / a[2], "freq": a[1] / a[2], "n": a[2]} for a in acc if a[2] >= 15]


def best_blend(preds):
    """¿Cuánto peso le conviene al modelo frente al mercado? Se prueba mezclarlo con el momio (apertura si
    hay; si no, cierre) en pasos de 5% y se queda con el que menos se equivoca (log loss) en el backtesting.
    Si el mejor es 0%, el mercado ya sabe todo lo que el modelo sabe y el bot se guía por el mercado."""
    rows = []
    for pr in preds:
        ref = no_vig(*pr["open"]) if all(pr["open"]) else no_vig(*pr["close"]) if all(pr["close"]) else None
        if ref:
            rows.append((pr["p"], ref, pr["res"]))
    if len(rows) < 300:
        return None
    res = []
    for w in [i / 20 for i in range(0, 11)]:
        ll = sum(-math.log(max(1e-9, w * p[r] + (1 - w) * m[r])) for p, m, r in rows) / len(rows)
        res.append((ll, w))
    best_ll, best_w = min(res)
    return {"w": best_w, "n": len(rows), "ref": "apertura" if all(preds[0]["open"]) else "cierre",
            "llMarket": round(res[0][0], 4), "llBest": round(best_ll, 4), "curve": [{"w": w, "ll": round(ll, 4)} for ll, w in res]}


# ---------- entrenamiento completo ----------
class Modelos:
    def __init__(self, data_dir: Path, hist: Historico):
        self.dir = data_dir / "modelos"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.file = self.dir / "futbol.json"
        self.hist = hist
        self.fits: dict[str, Fit] = {}
        self.info: dict = {}
        self.cal = None
        self.busy = False
        self.error = None
        self.load()

    def load(self):
        if not self.file.exists():
            return
        try:
            d = json.loads(self.file.read_text(encoding="utf-8"))
            self.info, self.cal = d.get("info", {}), d.get("cal")
            for liga, m in d.get("fits", {}).items():
                self.fits[liga] = Fit(m["teams"], np.array(m["x"]), m["rho"])
        except (ValueError, KeyError) as e:
            self.error = f"No se pudo leer el modelo guardado: {e}"

    def age_hours(self):
        t = self.info.get("_trained")
        return (time.time() - t) / 3600 if t else None

    def train(self, update_data=True) -> dict:
        if self.busy:
            return {"busy": True}
        self.busy, self.error = True, None
        t0 = time.time()
        try:
            if update_data:
                try:
                    self.hist.update_openfootball()
                except Exception as e:  # sin internet: se entrena con lo que ya hay
                    self.error = f"No se pudo actualizar openfootball: {e}"
            all_preds, info, fits, by_league = [], {}, {}, {}
            today = dt.date.today()
            for liga in LEAGUES:
                rows = _dedupe(self.hist.matches(liga))
                if len(rows) < MIN_TRAIN:
                    info[liga] = {"name": LEAGUES[liga], "matches": len(rows), "trained": False}
                    continue
                preds = backtest(rows)
                for pr in preds:
                    pr["liga"] = liga
                by_league[liga] = preds
                all_preds += preds
                fits[liga] = fit(rows, today)
                blend = best_blend(preds)
                info[liga] = {"name": LEAGUES[liga], "matches": len(rows), "trained": True, "teams": len(fits[liga].teams),
                              "from": rows[0][0][:10], "to": rows[-1][0][:10], "rho": round(fits[liga].rho, 3),
                              "home": round(math.exp(fits[liga].home), 3), "raw": metrics(preds), "blend": blend}
            # Calibración medida sin trampa: se ajusta con la mitad MÁS VIEJA de las predicciones y se evalúa en la
            # mitad más reciente (que no vio). La que usa el bot después se ajusta con todas.
            def make_cal(ps):
                return {k: isotonic([pr["p"][k] for pr in ps], [1.0 if pr["res"] == k else 0.0 for pr in ps]) for k in ("home", "draw", "away")}

            all_preds.sort(key=lambda pr: pr["date"])
            cal, test, cal_half = None, [], None
            if len(all_preds) >= 300:
                half = len(all_preds) // 2
                cal_half, test = make_cal(all_preds[:half]), all_preds[half:]
                cal = make_cal(all_preds)
            for liga in list(info):
                if not info[liga].get("trained"):
                    continue
                lt = [pr for pr in test if pr["liga"] == liga]
                info[liga]["test"] = {"from": lt[0]["date"], "raw": metrics(lt), "cal": metrics(lt, cal_half)} if lt else None
            # Solo se usa la calibración si en la prueba (partidos que no vio) mejoró el error; si no, el modelo va sin ella.
            if cal and test:
                raw_ll, cal_ll = metrics(test)["logLoss"], metrics(test, cal_half)["logLoss"]
                if cal_ll >= raw_ll:
                    cal = None
            info["_calUsed"] = bool(cal)
            info["_global"] = {
                "raw": metrics(all_preds),
                "test": {"from": test[0]["date"], "raw": metrics(test), "cal": metrics(test, cal_half)} if test else None,
                "relRaw": reliability(test or all_preds), "relCal": reliability(test, cal_half) if test else None,
            }
            info["_trained"] = time.time()
            info["_seconds"] = round(time.time() - t0, 1)
            self.fits, self.info, self.cal = fits, info, cal
            Store._atomic_write(self.file, json.dumps({"info": info, "cal": cal, "fits": {
                l: {"teams": f.teams, "x": [float(v) for v in f.x], "rho": f.rho} for l, f in fits.items()}}))
            return {"ok": True, "seconds": info["_seconds"]}
        except Exception as e:
            self.error = f"Error al entrenar: {e}"
            return {"ok": False, "error": self.error}
        finally:
            self.busy = False

    def predict(self, liga, home, away) -> dict | None:
        f = self.fits.get(liga)
        if not f:
            return None
        h, a = match_team(home, f.teams), match_team(away, f.teams)
        if not h or not a:
            return None
        p = f.probs(h, a)
        c = apply_cal(self.cal, p)
        return {"lh": round(p["lh"], 4), "la": round(p["la"], 4), "home": round(c["home"], 4), "draw": round(c["draw"], 4),
                "away": round(c["away"], 4), "over25": round(p["over25"], 4), "raw": {k: round(p[k], 4) for k in ("home", "draw", "away")},
                "teams": [h, a], "calibrated": bool(self.cal),
                # Peso máximo que el backtesting le da al modelo en esta liga frente al mercado (None = sin momios para medirlo).
                "maxW": (self.info.get(liga, {}).get("blend") or {}).get("w")}
