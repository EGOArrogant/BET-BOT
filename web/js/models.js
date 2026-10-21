// Modelos de probabilidad por deporte + detección de valor (EV) y Oportunidades de Oro.
// Principio: el mercado es muy eficiente, así que la probabilidad final MEZCLA modelo y mercado
// (peso del modelo = w, que el bot ajusta solo según su historial de aciertos; ver bank.js -> learn).

// ---------- matemáticas básicas ----------
const fact = [1];
for (let i = 1; i <= 20; i++) fact[i] = fact[i - 1] * i;
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / fact[k];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function normCdf(x) {
  // Aproximación de Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function normInv(p) {
  // Búsqueda por bisección (suficiente para la UI)
  let lo = -8, hi = 8;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

export function fairProbs(odds) {
  // Quita el margen de la casa de forma proporcional.
  const inv = odds.map((o) => (o ? 1 / o : 0));
  const s = inv.reduce((a, b) => a + b, 0);
  return s ? { probs: inv.map((x) => x / s), margin: s - 1 } : null;
}

// ---------- FÚTBOL: Poisson (ataque/defensa) ----------
const HOME_ADV = 1.12, AWAY_ADV = 0.89, PRIOR_GAMES = 10;

function soccerLambdas(event, table) {
  const rows = [...table.values()].filter((r) => r.gp > 0 && r.pf != null && !String(r.teamId).startsWith('n:'));
  const totGF = rows.reduce((a, r) => a + r.pf, 0), totGP = rows.reduce((a, r) => a + r.gp, 0);
  const avg = totGP > 0 ? totGF / totGP : 1.35;
  const rating = (id) => {
    const r = table.get(String(id));
    if (!r || !r.gp) return { att: 1, def: 1, gp: 0 };
    const w = r.gp / (r.gp + PRIOR_GAMES); // regresión a la media con pocos partidos
    return { att: 1 + w * (r.pf / r.gp / avg - 1), def: 1 + w * (r.pa / r.gp / avg - 1), gp: r.gp };
  };
  const h = rating(event.home.id), a = rating(event.away.id);
  const ha = event.neutral ? 1 : HOME_ADV, aa = event.neutral ? 1 : AWAY_ADV;
  return { lh: clamp(avg * h.att * a.def * ha, 0.2, 4.5), la: clamp(avg * a.att * h.def * aa, 0.15, 4), known: h.gp > 0 && a.gp > 0 };
}

function soccerOutcome(lh, la, curH = 0, curA = 0, line = 2.5) {
  let H = 0, D = 0, A = 0, over = 0, btts = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = pois(i, lh) * pois(j, la);
    const fh = curH + i, fa = curA + j;
    if (fh > fa) H += p; else if (fh === fa) D += p; else A += p;
    if (fh + fa > line) over += p;
    if (fh > 0 && fa > 0) btts += p;
  }
  const s = H + D + A;
  return { home: H / s, draw: D / s, away: A / s, over: over / s, under: 1 - over / s, btts: btts / s };
}

function soccerMinute(ev) {
  const m = parseInt(String(ev.clock).replace(/[^0-9+]/g, ''), 10);
  if (Number.isFinite(m)) return m;
  return ev.clockSec ? ev.clockSec / 60 : 0;
}

// xG reciente (365Scores): goles esperados generados y concedidos en los últimos partidos oficiales.
// Mide la calidad real de las ocasiones, con menos suerte que los goles. Se mezcla con la tabla:
// hasta 40% de peso con 6 partidos de cada equipo (menos si hay pocos).
const XG_MAX_W = 0.4, XG_FULL_N = 6;
function xgLambdas(ev, base) {
  const f = ev.xgForm;
  if (!f?.home?.n || !f?.away?.n || f.home.for == null || f.away.for == null) return null;
  const ha = ev.neutral ? 1 : 1.06, aa = ev.neutral ? 1 : 0.94; // el xG reciente ya mezcla local y visita
  const lhX = clamp(((f.home.for + f.away.against) / 2) * ha, 0.2, 4.5);
  const laX = clamp(((f.away.for + f.home.against) / 2) * aa, 0.15, 4);
  const w = XG_MAX_W * Math.min(1, Math.min(f.home.n, f.away.n) / XG_FULL_N) * (base.known ? 1 : 1.5);
  return { lhX, laX, w: Math.min(0.6, w) };
}

function soccerModel(ev, table) {
  const base = soccerLambdas(ev, table);
  let { lh, la, known } = base;
  const xg = xgLambdas(ev, base);
  if (xg) { lh = (1 - xg.w) * lh + xg.w * xg.lhX; la = (1 - xg.w) * la + xg.w * xg.laX; known = true; }
  // Modelo entrenado con temporadas pasadas (servidor de Python): goles esperados de Dixon-Coles y 1X2 calibrado.
  // Pesa 50% (70% si la app no tiene datos propios del partido); el 1X2 final mezcla ambos.
  const py = ev.pyModel;
  const wPy = py ? (known ? 0.5 : 0.7) : 0;
  if (py) { lh = (1 - wPy) * lh + wPy * py.lh; la = (1 - wPy) * la + wPy * py.la; known = true; }
  const line = ev.odds?.total?.line ?? 2.5;
  const pre = soccerOutcome(lh, la, 0, 0, line);
  if (py) {
    const mix = (k) => (1 - wPy) * pre[k] + wPy * py[k];
    const h = mix('home'), d = mix('draw'), a = mix('away'), s = h + d + a;
    pre.home = h / s; pre.draw = d / s; pre.away = a / s;
  }
  let live = null, liveXg = null;
  if (ev.state === 'in') {
    const min = soccerMinute(ev);
    const rem = clamp((93 - min) / 90, 0.01, 1) * 1.05; // los goles tardíos son algo más frecuentes
    const cur = (ev.home.score || 0) + (ev.away.score || 0);
    const liveLine = Math.max(line, cur + 0.5); // línea en vivo: la siguiente que todavía está abierta
    // Ritmo de xG del partido (365Scores): si un equipo está generando mucho más de lo esperado, su tasa
    // de gol para lo que resta sube. Peso creciente con los minutos (máx. 50% al final).
    let rh = lh, ra = la;
    const lx = ev.liveXg;
    if (lx && min >= 10) {
      const f = clamp(min / 90, 0, 1) * 0.5;
      rh = (1 - f) * lh + f * clamp((lx.home / min) * 90, 0.1, 5);
      ra = (1 - f) * la + f * clamp((lx.away / min) * 90, 0.1, 5);
      liveXg = { home: lx.home, away: lx.away, weight: f };
    }
    live = { ...soccerOutcome(rh * rem, ra * rem, ev.home.score || 0, ev.away.score || 0, liveLine), minute: min, line: liveLine };
  }
  return { kind: 'soccer', lh, la, line, pre, live, known, xg: xg ? { ...xg, base: { lh: base.lh, la: base.la } } : null, liveXg, py: py ? { ...py, w: wPy } : null };
}

// ---------- NFL / NBA / MLB: Pythagorean + log5 + localía ----------
const US = {
  basketball: { exp: 14, prior: 20, homeLogit: 0.32, sd: 12, periods: 4, periodSec: 720 },
  football: { exp: 2.37, prior: 8, homeLogit: 0.2, sd: 13.5, periods: 4, periodSec: 900 },
  baseball: { exp: 1.83, prior: 40, homeLogit: 0.16, sd: 3.6, innings: 9 },
};

function pythag(r, cfg) {
  if (!r || !r.gp || !r.pf) return 0.5;
  const pf = Math.pow(r.pf, cfg.exp), pa = Math.pow(r.pa, cfg.exp);
  const p = pf / (pf + pa);
  const w = r.gp / (r.gp + cfg.prior);
  return clamp(0.5 + w * (p - 0.5), 0.05, 0.95);
}

function remainingFraction(ev, cfg) {
  if (ev.sport === 'baseball') {
    const inn = ev.period || 1;
    return clamp((cfg.innings - inn + 0.5) / cfg.innings, 0.02, 1);
  }
  const total = cfg.periods * cfg.periodSec;
  const p = Math.min(ev.period || 1, cfg.periods);
  const left = (cfg.periods - p) * cfg.periodSec + (ev.clockSec || 0);
  return clamp(left / total, 0.01, 1);
}

function usModel(ev, table, liveWinProb) {
  const cfg = US[ev.sport];
  const ph = pythag(table.get(String(ev.home.id)), cfg), pa = pythag(table.get(String(ev.away.id)), cfg);
  let p = (ph - ph * pa) / (ph + pa - 2 * ph * pa); // log5
  p = sigmoid(logit(clamp(p, 0.02, 0.98)) + (ev.neutral ? 0 : cfg.homeLogit));
  const pre = { home: p, away: 1 - p };
  let live = null;
  if (ev.state === 'in') {
    if (liveWinProb && liveWinProb.home != null) {
      live = { home: liveWinProb.home, away: 1 - liveWinProb.home - (liveWinProb.tie || 0), source: 'ESPN' };
    } else {
      // Margen final ~ Normal(margen actual + margen esperado * tiempo restante, sd * sqrt(tiempo restante))
      const rem = remainingFraction(ev, cfg);
      const expMargin = normInv(p) * cfg.sd;
      const cur = (ev.home.score || 0) - (ev.away.score || 0);
      const ph2 = normCdf((cur + expMargin * rem) / (cfg.sd * Math.sqrt(rem)));
      live = { home: clamp(ph2, 0.001, 0.999), away: clamp(1 - ph2, 0.001, 0.999), source: 'modelo' };
    }
  }
  const known = !!(table.get(String(ev.home.id))?.gp && table.get(String(ev.away.id))?.gp);
  return { kind: 'us', pre, live, known };
}

// ---------- TENIS: puntos de ranking + cadena de sets ----------
function matchFromSet(ps, bestOf, a = 0, b = 0) {
  const need = Math.ceil(bestOf / 2);
  const memo = new Map();
  const f = (x, y) => {
    if (x >= need) return 1;
    if (y >= need) return 0;
    const k = x * 10 + y;
    if (!memo.has(k)) memo.set(k, ps * f(x + 1, y) + (1 - ps) * f(x, y + 1));
    return memo.get(k);
  };
  return f(a, b);
}
function setFromMatch(pm, bestOf) {
  let lo = 0.001, hi = 0.999;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (matchFromSet(m, bestOf) < pm) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
function setsWon(ls1, ls2) {
  let a = 0, b = 0;
  for (let i = 0; i < Math.min(ls1.length, ls2.length); i++) {
    const x = ls1[i] ?? 0, y = ls2[i] ?? 0;
    const done = (Math.max(x, y) >= 6 && Math.abs(x - y) >= 2) || Math.max(x, y) === 7;
    if (!done) continue;
    if (x > y) a++; else b++;
  }
  return [a, b];
}

function tennisModel(ev, table) {
  const r1 = table.get(String(ev.home.id)) || table.get('n:' + ev.home.name);
  const r2 = table.get(String(ev.away.id)) || table.get('n:' + ev.away.name);
  const pts1 = r1?.pts || 300, pts2 = r2?.pts || 300; // sin ranking = jugador de bajo nivel
  const pm = clamp(sigmoid(1.05 * Math.log(pts1 / pts2)), 0.03, 0.97);
  const bestOf = ev.bestOf || 3;
  const pre = { home: pm, away: 1 - pm };
  let live = null;
  if (ev.state === 'in') {
    const ps = setFromMatch(pm, bestOf);
    const [a, b] = setsWon(ev.home.linescores, ev.away.linescores);
    const p = matchFromSet(ps, bestOf, a, b);
    live = { home: p, away: 1 - p, sets: [a, b] };
  }
  return { kind: 'tennis', pre, live, rank1: r1?.rank, rank2: r2?.rank, known: !!(r1 && r2) };
}

// ---------- eSports: Elo por mapa (propio) + récord del torneo + serie al mejor de N ----------
function esportsModel(ev, table) {
  const r1 = table.get(String(ev.home.id)), r2 = table.get(String(ev.away.id));
  const e1 = r1?.elo ?? 1500, e2 = r2?.elo ?? 1500;
  let pMap = 1 / (1 + 10 ** ((e2 - e1) / 400));
  if (r1?.w != null && r2?.w != null && r1.w + r1.l > 0 && r2.w + r2.l > 0) {
    const wp = (x) => (x.w + 3) / (x.w + x.l + 6); // récord con regresión a 50%
    const a = wp(r1), b = wp(r2);
    pMap = (pMap + (a - a * b) / (a + b - 2 * a * b)) / 2;
  }
  pMap = clamp(pMap, 0.12, 0.88);
  const bo = ev.bestOf || 3;
  const ph = matchFromSet(pMap, bo);
  const pre = { home: ph, away: 1 - ph };
  let live = null;
  if (ev.state === 'in') {
    const a = ev.home.score || 0, b = ev.away.score || 0;
    const p = matchFromSet(pMap, bo, a, b);
    live = { home: p, away: 1 - p, sets: [a, b] };
  }
  // Datos propios suficientes: al menos 8 mapas observados de cada equipo, o récord del torneo (LoL) de ambos.
  const known = ((r1?.maps || 0) >= 8 && (r2?.maps || 0) >= 8) || (r1?.w != null && r2?.w != null && r1.w + r1.l >= 2 && r2.w + r2.l >= 2);
  return { kind: 'esports', pre, live, pMap, elo1: e1, elo2: e2, known };
}

// ---------- UFC / Boxeo: récord del peleador (con regresión fuerte) ----------
// El récord dice poco sin el nivel de los rivales, así que el modelo pesa poco y el precio del mercado manda.
function fightModel(ev) {
  const h = ev.home, a = ev.away;
  const has = (x) => x.recW != null && x.recL != null && x.recW + x.recL >= 5;
  const wp = (x) => (x.recW + 4) / (x.recW + x.recL + 8);
  let p = 0.5;
  if (has(h) && has(a)) { const x = wp(h), y = wp(a); p = (x - x * y) / (x + y - 2 * x * y); }
  p = clamp(p, 0.15, 0.85);
  // known: false → el récord se muestra como referencia, pero la probabilidad es la del mercado (Polymarket/Kalshi/casas).
  // Un récord como 10-0 contra rivales débiles no se compara con 31-12 contra la élite: usarlo crearía "valor" falso.
  return { kind: 'fight', pre: { home: p, away: 1 - p }, live: null, known: false, recordP: has(h) && has(a) ? p : null };
}

// ---------- API pública ----------
export function modelEvent(ev, table, liveWinProb) {
  if (ev.sport === 'mma' || ev.sport === 'boxing') return fightModel(ev);
  if (ev.sport === 'soccer') return soccerModel(ev, table);
  if (ev.sport === 'tennis') return tennisModel(ev, table);
  if (ev.sport === 'esports') return esportsModel(ev, table);
  return usModel(ev, table, liveWinProb);
}

const LABELS = { home: 'Local', away: 'Visitante', draw: 'Empate', over: 'Más de', under: 'Menos de' };

// Construye las selecciones apostables con probabilidad final, EV, Kelly y momio mínimo.
// Mezcla modelo y mercado. El mercado manda; el modelo solo lo corrige un poco:
// - zona muerta de 4 puntos: diferencias menores son ruido del modelo, no ventaja.
// - tope: como máximo 4 puntos o 10% relativo. Un modelo simple que "ve" 30% de EV casi siempre
//   está equivocado (pocos partidos, bajas que no conoce, compresión hacia 50%), no el mercado.
const DEADZONE = 0.04;
function blend(pModel, pMarket, w) {
  if (pMarket == null) return pModel;
  const diff = pModel - pMarket;
  const eff = Math.sign(diff) * Math.max(0, Math.abs(diff) - DEADZONE);
  const maxShift = Math.min(0.04, 0.1 * Math.min(pMarket, 1 - pMarket));
  return pMarket + clamp(w * eff, -maxShift, maxShift);
}

// EV requerido: crece con el momio (más varianza y más error de modelo en longshots).
export const requiredEV = (minEV, odds) => minEV * Math.sqrt(Math.max(1, odds / 2));
function minOddsFor(p, minEV) {
  let lo = 1.01, hi = 1000;
  if (p * hi - 1 < requiredEV(minEV, hi)) return null;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (p * m - 1 >= requiredEV(minEV, m)) hi = m; else lo = m; }
  return hi;
}

// Mejor precio disponible en los mercados de predicción para un resultado: comprar al precio "ask" paga 1/ask.
function pmPrice(pm, side) {
  const k = { home: 'askHome', away: 'askAway', draw: 'askDraw' }[side];
  let best = null;
  for (const src of pm.sources || []) {
    const ask = src[k];
    if (!(ask > 0.03 && ask < 0.97)) continue;
    if (!best || ask < best.ask) best = { ask, odds: 1 / ask, source: src.source };
  }
  return best;
}

// Competencias entre ligas distintas (Champions): la tabla no compara bien la fuerza real.
const LEAGUE_WEIGHT = { 'uefa.champions': 0.4 };

export function selections(ev, model, settings, weights) {
  // Si el modelo no tiene datos propios de estos equipos, no opina: la probabilidad es 100% la del mercado.
  const w = model.known ? (weights?.[ev.sport] ?? settings.modelWeight ?? 0.35) * (LEAGUE_WEIGHT[ev.leagueId] ?? 1) : 0;
  const out = [];
  const isLive = ev.state === 'in';
  const probs = isLive && model.live ? model.live : model.pre;
  const o = ev.odds || {};
  // Los momios de ESPN son de cierre previo al partido: en vivo no sirven para apostar.
  const usableOdds = !isLive;

  const sides = model.kind === 'soccer' ? ['home', 'draw', 'away'] : ['home', 'away'];
  const mlOdds = sides.map((s) => (usableOdds ? o[s] : null));
  const fair = mlOdds.every((x) => x) ? fairProbs(mlOdds) : null;
  // Mercados de predicción (Polymarket / Kalshi): su precio es probabilidad con dinero real detrás, y se actualiza también en vivo.
  const pm = ev.pm && sides.every((s) => ev.pm[s] != null) ? ev.pm : null;
  sides.forEach((s, i) => {
    const pModel = probs[s];
    // Consenso del mercado = promedio de casas (sin margen) y mercados de predicción.
    const parts = [fair ? fair.probs[i] : null, pm ? pm[s] : null].filter((x) => x != null);
    const pMarket = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
    const p = blend(pModel, pMarket, w);
    let odds = mlOdds[i], oddsSource = odds ? o.provider || 'Casa' : null;
    if (!odds && pm) { const best = pmPrice(pm, s); if (best) { odds = best.odds; oddsSource = best.source; } }
    const team = s === 'home' ? ev.home.name : s === 'away' ? ev.away.name : 'Empate';
    out.push(pack(ev, settings, {
      market: model.kind === 'soccer' ? '1X2' : 'Ganador', pick: s, label: s === 'draw' ? 'Empate' : team,
      pModel, pMarket, p, odds, oddsSource, margin: fair?.margin, pPM: pm ? pm[s] : null,
    }));
  });

  if (model.kind === 'soccer') {
    const line = isLive && model.live ? model.live.line : model.line;
    const tot = usableOdds ? o.total : null;
    const fairT = tot?.over && tot?.under ? fairProbs([tot.over, tot.under]) : null;
    ['over', 'under'].forEach((s, i) => {
      const pModel = probs[s];
      const pMarket = fairT ? fairT.probs[i] : null;
      const p = blend(pModel, pMarket, w);
      out.push(pack(ev, settings, {
        market: 'Goles', pick: s, line, label: `${LABELS[s]} ${line} goles`, pModel, pMarket, p, odds: tot ? tot[s] : null,
      }));
    });
  }
  return out;
}

function pack(ev, settings, s) {
  const minEV = settings.minEV ?? 0.03;
  const ev_ = s.odds ? s.p * s.odds - 1 : null;
  const b = s.odds ? s.odds - 1 : null;
  const kellyFull = s.odds ? (s.p * s.odds - 1) / b : null;
  return {
    ...s, eventId: ev.id, leagueId: ev.leagueId, sport: ev.sport,
    ev: ev_, kellyFull, minOdds: minOddsFor(s.p, minEV), reqEV: s.odds ? requiredEV(minEV, s.odds) : minEV,
    value: ev_ != null && ev_ >= requiredEV(minEV, s.odds) && s.odds >= (settings.minOdds ?? 1.4) && s.odds <= (settings.maxOdds ?? 10),
  };
}

// ---------- Oportunidades de Oro ----------
// 1) Underdog con valor (antes del partido): momio alto y EV positivo según modelo+mercado.
// 2) Remontada posible (en vivo): el favorito previo va perdiendo pero el modelo aún le da opciones reales.
export function goldenOpportunities(ev, model, sels) {
  const out = [];
  if (ev.state === 'pre') {
    for (const s of sels) {
      if (s.pick === 'over' || s.pick === 'under' || s.pick === 'draw') continue;
      if (s.odds && s.odds >= 2.8 && s.value) {
        out.push({
          type: 'underdog', title: `Underdog con valor: ${s.label}`, sel: s,
          why: `El mercado le da ${(100 / s.odds).toFixed(0)}% (con margen) y la estimación combinada ${(s.p * 100).toFixed(0)}%. EV ${(s.ev * 100).toFixed(1)}%.`,
          score: s.ev * Math.log(s.odds),
        });
      }
    }
  }
  if (ev.state === 'in' && model.live) {
    const hs = ev.home.score || 0, as = ev.away.score || 0;
    let trailing = null;
    if (ev.sport === 'tennis' || ev.sport === 'esports') {
      const [a, b] = model.live.sets || [0, 0];
      if (a < b) trailing = 'home'; else if (b < a) trailing = 'away';
    } else if (hs !== as) trailing = hs < as ? 'home' : 'away';
    if (trailing) {
      const preP = model.pre[trailing], liveP = model.live[trailing];
      const dc = ev.sport === 'soccer' ? liveP + model.live.draw : null; // doble oportunidad
      const team = ev[trailing].name;
      if (preP >= 0.42 && liveP >= 0.12) {
        out.push({
          type: 'comeback', title: `Remontada posible: ${team}`, pick: trailing,
          why: `Era favorito (${(preP * 100).toFixed(0)}% antes del partido) y va abajo, pero el modelo le da ${(liveP * 100).toFixed(0)}% de ganar${dc ? ` y ${(dc * 100).toFixed(0)}% de no perder` : ''}.`,
          liveP, dc, minOdds: minOddsFor(liveP, 0.05), minOddsDC: dc ? minOddsFor(dc, 0.05) : null,
          score: preP * liveP,
        });
      }
    }
  }
  return out;
}

export function brier(p, outcome) { return (p - outcome) ** 2; }
