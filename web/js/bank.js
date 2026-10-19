// Banca ficticia: estado persistente, tamaño de apuesta (Kelly fraccionado), liquidación,
// CLV y aprendizaje (ajuste del peso del modelo frente al mercado según su precisión real).

import { brier } from './models.js';
import { DEFAULT_BOOKS, recordQuote } from './books.js';

export const DEFAULT_STATE = () => ({
  version: 1,
  startBankroll: 2000,
  bankroll: 2000,
  bets: [],
  predictions: {},
  weights: { soccer: 0.35, football: 0.3, basketball: 0.3, baseball: 0.3, tennis: 0.25, mma: 0.2, boxing: 0.2, esports: 0.35 },
  settings: {
    kellyFraction: 0.25, // Kelly al 25%: crecimiento sólido con mucha menos volatilidad
    maxStakePct: 0.03,   // nunca más del 3% de la banca en una apuesta
    minStake: 10,
    minEV: 0.03,         // valor esperado mínimo del 3%
    minOdds: 1.4,
    maxOdds: 10,
    maxBetsPerDay: 8,
    autopilot: false,
    aiConfirm: false,
    practiceMode: true,  // modo práctica: apuestas ficticias diarias garantizadas para aprender desde el día 1
    practicePerDay: 5,
    practiceStake: 10,   // monto de cada apuesta de práctica (MXN)
    scanMinutes: 1,
  },
  history: [{ t: Date.now(), bankroll: 2000 }],
  log: [],
  books: DEFAULT_BOOKS(),
  bookQuotes: [],
  slip: [], // boleto: selecciones por apostar (compartido entre PC y celular)
  shadow: [], // apuestas sombra: todo lo que el bot habría apostado, para aprender sin arriesgar la banca
  smart: { follows: [], stats: {}, seen: {}, trail: [] }, // top apostadores de Polymarket que sigues y el rastro de sus entradas
});

let state = DEFAULT_STATE();
let saveTimer = null;
let rev = 0; // versión del estado en el servidor (para sincronizar varios dispositivos)
const listeners = new Set();
const conflictListeners = new Set();

export const getState = () => state;
export const onChange = (fn) => listeners.add(fn);
export const onConflict = (fn) => conflictListeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(state));

// Identificador de este dispositivo: solo uno corre el piloto automático a la vez.
export const deviceId = (() => {
  try {
    let id = localStorage.getItem('betbot-device');
    if (!id) { id = 'd' + Math.random().toString(36).slice(2, 10); localStorage.setItem('betbot-device', id); }
    return id;
  } catch { return 'd-sin-almacenamiento'; }
})();
// Un solo dispositivo opera el bot. Si el dispositivo asignado lleva más de 5 minutos sin dar señales
// (cerrado o apagado), el que esté abierto toma el control para que el bot nunca se quede sin operar.
const STALE_MS = 5 * 60_000;
export function claimDevice() {
  const s = state.settings;
  const stale = !s.autopilotSeen || Date.now() - s.autopilotSeen > STALE_MS;
  if (!s.autopilotDevice || (s.autopilotDevice !== deviceId && stale)) {
    s.autopilotDevice = deviceId;
    log('Este dispositivo tomó el control del bot (el anterior no estaba activo)');
  }
  if (s.autopilotDevice === deviceId) {
    if (!s.autopilotSeen || Date.now() - s.autopilotSeen > 60_000) { s.autopilotSeen = Date.now(); save(); }
    return true;
  }
  return false;
}
// Solo lectura (para la interfaz): ¿este dispositivo opera el piloto?
export const isAutopilotHere = () => state.settings.autopilot && state.settings.autopilotDevice === deviceId;

export async function loadState() {
  try {
    const res = await fetch('/api/state');
    rev = Number(res.headers.get('X-Rev') || 0);
    const remote = await res.json();
    if (remote && remote.version) state = merge(DEFAULT_STATE(), remote);
  } catch {
    try { const local = JSON.parse(localStorage.getItem('betbot-state')); if (local) state = merge(DEFAULT_STATE(), local); } catch {}
  }
  emit();
  return state;
}

// Trae cambios hechos desde otro dispositivo. Devuelve true si hubo cambios.
export async function pullState() {
  if (saveTimer) return false; // hay cambios locales por guardar
  try {
    const res = await fetch('/api/state');
    const r = Number(res.headers.get('X-Rev') || 0);
    if (r === rev) return false;
    const remote = await res.json();
    rev = r;
    if (remote && remote.version) { state = merge(DEFAULT_STATE(), remote); emit(); return true; }
  } catch {}
  return false;
}

function merge(base, s) {
  return {
    ...base, ...s, settings: { ...base.settings, ...(s.settings || {}) }, weights: { ...base.weights, ...(s.weights || {}) },
    books: { ...base.books, ...(s.books || {}) }, slip: Array.isArray(s.slip) ? s.slip : [],
    shadow: Array.isArray(s.shadow) ? s.shadow : [],
    smart: { ...base.smart, ...(s.smart || {}) },
  };
}

export function updateBook(id, patch) {
  state.books[id] = { ...(state.books[id] || {}), ...patch };
  save();
}

export function save() {
  emit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const body = JSON.stringify(state);
    try {
      const res = await fetch('/api/state', { method: 'PUT', body, headers: { 'Content-Type': 'application/json', 'X-Base-Rev': String(rev) } });
      if (res.status === 409) {
        // Otro dispositivo guardó primero: se adopta su versión y se avisa.
        rev = Number(res.headers.get('X-Rev') || rev);
        const remote = await res.json();
        if (remote && remote.version) state = merge(DEFAULT_STATE(), remote);
        emit();
        conflictListeners.forEach((fn) => fn());
        return;
      }
      if (res.ok) rev = (await res.json()).rev ?? rev;
    } catch { try { localStorage.setItem('betbot-state', body); } catch {} }
  }, 400);
}

// ---------- boleto ----------
export function addToSlip(item) {
  if (state.slip.some((s) => s.eventId === item.eventId && s.pick === item.pick && s.market === item.market)) return false;
  state.slip.push({ ...item, id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), addedAt: Date.now(), quotes: item.quotes || {} });
  save();
  return true;
}
export function updateSlip(id, patch) {
  const s = state.slip.find((x) => x.id === id);
  if (s) { Object.assign(s, patch); save(); }
}
export function removeFromSlip(id) { state.slip = state.slip.filter((x) => x.id !== id); save(); }

export function markPlacedReal(id, placed = true) {
  const b = state.bets.find((x) => x.id === id);
  if (b) { b.placedReal = placed; b.placedRealAt = placed ? Date.now() : null; save(); }
}

export function log(msg, kind = 'info') {
  // No repite el mismo mensaje si ya se registró en los últimos 30 minutos (evita llenar las notificaciones).
  if (state.log.some((l) => l.msg === msg && Date.now() - l.t < 30 * 60_000)) return;
  state.log.unshift({ t: Date.now(), msg, kind });
  state.log = state.log.slice(0, 300);
  save();
}

export function updateSettings(patch) { state.settings = { ...state.settings, ...patch }; save(); }

export function resetBank(amount = 2000) {
  const keep = { settings: state.settings, weights: state.weights, predictions: state.predictions, books: state.books, bookQuotes: state.bookQuotes, elo: state.elo, eloSeen: state.eloSeen, shadow: state.shadow, smart: state.smart };
  state = { ...DEFAULT_STATE(), ...keep, startBankroll: amount, bankroll: amount, history: [{ t: Date.now(), bankroll: amount }] };
  log(`Banca reiniciada a $${amount} MXN`);
}

// ---------- tamaño de apuesta ----------
export function suggestStake(p, odds) {
  const s = state.settings;
  if (!odds || odds <= 1) return 0;
  const k = (p * odds - 1) / (odds - 1);
  if (k <= 0) return 0;
  const raw = state.bankroll * k * s.kellyFraction;
  const capped = Math.min(raw, state.bankroll * s.maxStakePct);
  const rounded = Math.floor(capped / 5) * 5;
  return rounded >= s.minStake ? rounded : (state.bankroll * k * s.kellyFraction >= s.minStake * 0.6 ? s.minStake : 0);
}

export const pendingBets = () => state.bets.filter((b) => b.status === 'pending');
export const hasBetOn = (eventId) => state.bets.some((b) => b.eventId === eventId && b.status === 'pending');
export const betsToday = () => {
  const d = new Date().toDateString();
  return state.bets.filter((b) => new Date(b.placedAt).toDateString() === d).length;
};

export function placeBet({ ev, sel, stake, odds, oddsMx = null, source = 'manual', reasoning = '', book = null, quotes = {} }) {
  const finalOdds = Number(oddsMx || odds);
  stake = Math.round(Number(stake));
  if (!finalOdds || finalOdds <= 1) throw new Error('Momio inválido');
  if (!stake || stake <= 0) throw new Error('Monto inválido');
  if (stake > state.bankroll) throw new Error('Saldo insuficiente');
  const bet = {
    id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    eventId: ev.id, leagueId: ev.leagueId, sport: ev.sport, eventName: ev.name, eventDate: ev.date,
    home: ev.home.name, away: ev.away.name, live: ev.state === 'in',
    scoreAtBet: ev.state === 'in' ? `${ev.home.score ?? 0}-${ev.away.score ?? 0}` : null,
    market: sel.market, pick: sel.pick, line: sel.line ?? null, label: sel.label,
    refOdds: odds || null, oddsMx: oddsMx ? Number(oddsMx) : null, odds: finalOdds,
    p: sel.p, pModel: sel.pModel, pMarket: sel.pMarket, ev: sel.p * finalOdds - 1,
    stake, source, reasoning, placedAt: Date.now(), status: 'pending', payout: 0, closingOdds: null, book,
    minOdds: sel.minOdds ?? null, placedReal: false, oddsSource: sel.oddsSource || null,
  };
  // Cada momio capturado por casa sirve para aprender qué casa paga mejor.
  for (const [b, q] of Object.entries(quotes)) if (q) recordQuote(state, { book: b, sport: ev.sport, market: sel.market, odds: q, refOdds: odds });
  state.bets.unshift(bet);
  state.bankroll = round2(state.bankroll - stake);
  log(`${source === 'manual' ? 'Apuesta' : 'Bot (' + source + ')'}: $${stake} a ${bet.label} @ ${finalOdds.toFixed(2)} — ${ev.name}`, 'bet');
  return bet;
}

export function cancelBet(id) {
  const b = state.bets.find((x) => x.id === id);
  if (!b || b.status !== 'pending') return;
  b.status = 'void';
  state.bankroll = round2(state.bankroll + b.stake);
  log(`Apuesta anulada: ${b.label} (${b.eventName})`);
}

// Cobro anticipado (cash out) simulado: cierra la apuesta antes de tiempo por el monto indicado.
export function cashOut(id, amount) {
  const b = state.bets.find((x) => x.id === id);
  if (!b || b.status !== 'pending') return false;
  amount = round2(Number(amount));
  if (!(amount > 0)) return false;
  b.status = 'cashout';
  b.payout = amount;
  b.settledAt = Date.now();
  state.bankroll = round2(state.bankroll + amount);
  const bk = b.book && state.books[b.book];
  if (bk && bk.balance != null && bk.balance !== '') bk.balance = round2(Number(bk.balance) + amount - b.stake);
  log(`💸 Cobro anticipado: ${b.label} (${b.eventName}) por $${amount} (apostaste $${b.stake})`, amount >= b.stake ? 'won' : 'lost');
  state.history.push({ t: Date.now(), bankroll: equityNow() });
  save();
  return true;
}

export function setMxOdds(id, oddsMx, book = null) {
  const b = state.bets.find((x) => x.id === id);
  if (!b || b.status !== 'pending') return;
  if (book) b.book = book;
  if (b.book && oddsMx && b.refOdds) recordQuote(state, { book: b.book, sport: b.sport, market: b.market, odds: Number(oddsMx), refOdds: b.refOdds });
  b.oddsMx = Number(oddsMx) || null;
  b.odds = b.oddsMx || b.refOdds;
  b.ev = b.p * b.odds - 1;
  save();
}

const round2 = (x) => Math.round(x * 100) / 100;
// Capital total = banca disponible + lo que está en juego (la gráfica no debe "caer" al apostar).
export const equityNow = () => round2(state.bankroll + pendingBets().reduce((a, b) => a + b.stake, 0));

// ---------- liquidación ----------
function resultOf(bet, ev) {
  const hs = ev.home.score ?? 0, as = ev.away.score ?? 0;
  if (bet.market === 'Goles') {
    const t = hs + as;
    if (t === bet.line) return 'void';
    return (bet.pick === 'over' ? t > bet.line : t < bet.line) ? 'won' : 'lost';
  }
  let winner;
  if (['tennis', 'mma', 'boxing'].includes(ev.sport) || (ev.sport === 'esports' && hs === as)) winner = ev.home.winner ? 'home' : ev.away.winner ? 'away' : null;
  else winner = hs > as ? 'home' : hs < as ? 'away' : 'draw';
  if (!winner) return null;
  if (winner === 'draw' && bet.market === 'Ganador') return 'void';
  return winner === bet.pick ? 'won' : 'lost';
}

// Busca el partido de una apuesta: primero por id; si cambió (p. ej. eSports cambia de horario
// o la fuente es otra), por los nombres de los equipos y la fecha (±12 h).
const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(team|esports?|gaming|club|fc|cf|sc|ac)\b/g, '').replace(/[^a-z0-9]/g, '');
const sameName = (a, b) => { const x = normName(a), y = normName(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))); };
export function findEvent(b, events, byId) {
  const ev = byId ? byId.get(b.eventId) : events.find((e) => e.id === b.eventId);
  if (ev) return { ev, swap: false };
  const t = new Date(b.eventDate).getTime();
  const home = b.home ?? String(b.name || b.eventName || '').split(' vs ')[0];
  const away = b.away ?? String(b.name || b.eventName || '').split(' vs ')[1];
  for (const e of events) {
    if (e.sport !== b.sport || Math.abs(new Date(e.date).getTime() - t) > 12 * 3600_000) continue;
    if (sameName(e.home.name, home) && sameName(e.away.name, away)) return { ev: e, swap: false };
    // Mismo partido con local y visita invertidos (pasa entre fuentes de eSports).
    if (sameName(e.home.name, away) && sameName(e.away.name, home)) return { ev: e, swap: true };
  }
  return null;
}
const swapEv = (ev) => ({ ...ev, home: ev.away, away: ev.home });

// Avisos al liquidar (la app los usa para el registro en la base de datos y el panel en vivo).
const settleListeners = new Set();
export const onSettled = (fn) => settleListeners.add(fn);

export function settleWithEvents(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  let changed = false;
  for (const b of state.bets) {
    if (b.status !== 'pending') continue;
    const found = findEvent(b, events, byId);
    if (!found || !found.ev.completed) continue;
    const ev = found.swap ? swapEv(found.ev) : found.ev;
    const r = resultOf(b, ev);
    if (!r) continue;
    b.status = r;
    b.finalScore = `${ev.home.score ?? '-'}-${ev.away.score ?? '-'}`;
    b.settledAt = Date.now();
    b.settledBy = 'auto';
    if (!b.live && ev.odds && ev.odds[b.pick]) b.closingOdds = ev.odds[b.pick];
    if (r === 'won') { b.payout = round2(b.stake * b.odds); state.bankroll = round2(state.bankroll + b.payout); }
    if (r === 'void') { b.payout = b.stake; state.bankroll = round2(state.bankroll + b.stake); }
    // Saldo en la casa donde se colocó (si lo llevas capturado)
    const bk = b.book && state.books[b.book];
    if (bk && bk.balance != null && bk.balance !== '') {
      if (r === 'won') bk.balance = round2(Number(bk.balance) + b.payout - b.stake);
      if (r === 'lost') bk.balance = round2(Number(bk.balance) - b.stake);
    }
    log(`${r === 'won' ? '✅ Ganada' : r === 'lost' ? '❌ Perdida' : '↩️ Anulada'}: ${b.label} (${b.eventName}) ${b.finalScore}${r === 'won' ? ` · cobra $${b.payout} @ ${b.odds.toFixed(2)}` : ''}`, r);
    settleListeners.forEach((fn) => { try { fn(b, ev); } catch {} });
    changed = true;
  }
  if (changed) { state.history.push({ t: Date.now(), bankroll: equityNow() }); save(); }
  return changed;
}

// Limpieza: apuestas cuyo partido terminó hace más de 3 días sin resultado oficial (cancelado, pospuesto
// o la fuente lo borró) se anulan solas y se devuelve el monto, para que no se queden "en juego" para siempre.
export function voidStale(maxAgeH = 72) {
  let changed = false;
  for (const b of state.bets) {
    if (b.status !== 'pending' || Date.now() - new Date(b.eventDate).getTime() < maxAgeH * 3600_000) continue;
    b.status = 'void'; b.payout = b.stake; b.settledAt = Date.now(); b.settledBy = 'sin-resultado';
    state.bankroll = round2(state.bankroll + b.stake);
    log(`↩️ Anulada por falta de resultado oficial (${maxAgeH} h después): ${b.label} (${b.eventName}). Se devolvieron $${b.stake}`, 'void');
    settleListeners.forEach((fn) => { try { fn(b, null); } catch {} });
    changed = true;
  }
  for (const s of state.shadow) if (s.status === 'pending' && Date.now() - new Date(s.eventDate).getTime() > maxAgeH * 3600_000) { s.status = 'void'; s.profit = 0; changed = true; }
  if (changed) { state.history.push({ t: Date.now(), bankroll: equityNow() }); save(); }
  return changed;
}

// El boleto se limpia solo: se quitan selecciones de partidos que ya empezaron o terminaron.
export function cleanSlip(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const before = state.slip.length;
  state.slip = state.slip.filter((x) => { const ev = byId.get(x.eventId); return !ev || ev.state === 'pre'; });
  if (state.slip.length !== before) save();
}

// ---------- aprendizaje sin IA: apuestas sombra ----------
// Cada selección con valor (antes del partido) se registra como si se apostara 1 unidad, sin tocar la banca.
// Al terminar el partido se califica. Con suficientes resultados, el bot sabe qué "segmentos"
// (deporte + mercado + rango de momio) le dan ganancia y cuáles no, y el piloto automático evita los malos.
export const oddsBucket = (o) => (o < 2 ? 'menos de 2.00' : o < 3 ? '2.00 a 2.99' : o < 5 ? '3.00 a 4.99' : '5.00 o más');
export const segKey = (sport, market, odds) => `${sport}|${market}|${oddsBucket(odds)}`;
const SEG_MIN = 30; // resultados mínimos antes de juzgar un segmento

export function recordShadow(ev, sel) {
  if (ev.state !== 'pre' || !sel.odds || !sel.value) return false;
  if (state.shadow.some((s) => s.eventId === ev.id && s.market === sel.market && s.pick === sel.pick)) return false;
  state.shadow.push({
    eventId: ev.id, leagueId: ev.leagueId, sport: ev.sport, eventDate: ev.date, name: ev.name,
    market: sel.market, pick: sel.pick, line: sel.line ?? null, label: sel.label,
    odds: sel.odds, p: sel.p, ev: sel.ev, seg: segKey(ev.sport, sel.market, sel.odds), t: Date.now(), status: 'pending',
  });
  if (state.shadow.length > 4000) state.shadow = state.shadow.slice(-4000);
  return true;
}

export function settleShadow(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  let changed = false;
  for (const s of state.shadow) {
    if (s.status !== 'pending') continue;
    const found = findEvent(s, events, byId);
    if (!found || !found.ev.completed) continue;
    const ev = found.swap ? swapEv(found.ev) : found.ev;
    const r = resultOf(s, ev);
    if (!r) continue;
    s.status = r;
    s.profit = r === 'won' ? s.odds - 1 : r === 'lost' ? -1 : 0;
    const close = s.market === 'Goles' ? (ev.odds?.total?.line === s.line ? ev.odds.total[s.pick] : null) : ev.odds?.[s.pick];
    if (close) s.closingOdds = close;
    changed = true;
  }
  if (changed) save();
  return changed;
}

export function segmentStats() {
  const out = {};
  for (const s of state.shadow) {
    const o = (out[s.seg] ||= { seg: s.seg, sport: s.sport, market: s.market, bucket: oddsBucket(s.odds), n: 0, wins: 0, profit: 0, clvSum: 0, clvN: 0, pending: 0 });
    if (s.status === 'pending') { o.pending++; continue; }
    if (s.status === 'void') continue;
    o.n++; if (s.status === 'won') o.wins++; o.profit += s.profit;
    if (s.closingOdds) { o.clvSum += s.odds / s.closingOdds - 1; o.clvN++; }
  }
  for (const o of Object.values(out)) {
    o.roi = o.n ? o.profit / o.n : null;
    o.clv = o.clvN ? o.clvSum / o.clvN : null;
    o.status = segmentStatusFrom(o);
  }
  return out;
}
function segmentStatusFrom(o) {
  if (o.n < SEG_MIN) return 'aprendiendo';
  if (o.roi < -0.05) return 'bloqueado';
  if (o.roi > 0.03) return 'confiable';
  return 'en prueba';
}
export function segmentStatus(sport, market, odds) {
  const o = segmentStats()[segKey(sport, market, odds)];
  return o ? o.status : 'aprendiendo';
}
export const pendingShadows = () => state.shadow.filter((s) => s.status === 'pending');

// ---------- aprendizaje ----------
// Se guarda la predicción previa al partido (modelo y mercado). Al terminar, se compara la
// precisión (Brier) de ambos y se ajusta cuánto confiar en el modelo en cada deporte.
export function recordPrediction(ev, model, sels) {
  const prev = state.predictions[ev.id];
  // Se guarda la primera vez y se actualiza hasta que empieza el partido (la última estimación antes del inicio
  // es la que se califica; así también cuenta el xG de 365Scores, que llega 1–2 días antes).
  if (ev.state !== 'pre' || prev?.done) return;
  const ml = sels.filter((s) => s.market === '1X2' || s.market === 'Ganador');
  if (!ml.length) return;
  if (prev && prev.xg && !model.xg) return; // no perder la versión con xG si un momento no hay datos
  state.predictions[ev.id] = {
    sport: ev.sport, leagueId: ev.leagueId, date: ev.date, name: ev.name,
    model: Object.fromEntries(ml.map((s) => [s.pick, s.pModel])),
    final: Object.fromEntries(ml.map((s) => [s.pick, s.p])), // estimación final (modelo + mercado) que usa el bot
    xg: !!model.xg, // fútbol: el modelo usó el xG reciente de 365Scores (para medir si mejora la calibración)
    market: ml.every((s) => s.pMarket != null) ? Object.fromEntries(ml.map((s) => [s.pick, s.pMarket])) : null,
    done: false,
  };
}

export function learnFromEvents(events) {
  let changed = false;
  for (const ev of events) {
    const pr = state.predictions[ev.id];
    if (!pr || pr.done || !ev.completed) continue;
    const hs = ev.home.score ?? 0, as = ev.away.score ?? 0;
    const byFlag = ['tennis', 'mma', 'boxing'].includes(ev.sport);
    if (byFlag && !ev.home.winner && !ev.away.winner) continue; // sin ganador declarado (empate o sin decisión)
    const winner = byFlag ? (ev.home.winner ? 'home' : 'away') : hs > as ? 'home' : hs < as ? 'away' : 'draw';
    const sum = (probs) => Object.entries(probs).reduce((a, [k, p]) => a + brier(p, k === winner ? 1 : 0), 0);
    pr.outcome = winner;
    pr.brierModel = sum(pr.model);
    pr.brierMarket = pr.market ? sum(pr.market) : null;
    pr.done = true;
    changed = true;
  }
  if (!changed) return false;
  // Limpia predicciones viejas (más de 120 días)
  const cutoff = Date.now() - 120 * 86400000;
  for (const [k, v] of Object.entries(state.predictions)) if (new Date(v.date).getTime() < cutoff) delete state.predictions[k];
  for (const sport of Object.keys(state.weights)) {
    const done = Object.values(state.predictions).filter((p) => p.done && p.sport === sport && p.brierMarket != null);
    if (done.length < 15) continue;
    const bm = done.reduce((a, p) => a + p.brierModel, 0) / done.length;
    const bk = done.reduce((a, p) => a + p.brierMarket, 0) / done.length;
    const target = Math.max(0.1, Math.min(0.65, 0.35 + 3 * (bk - bm)));
    state.weights[sport] = Math.round((0.7 * state.weights[sport] + 0.3 * target) * 1000) / 1000;
  }
  save();
  return true;
}

// Calibración: cuando el bot dice "60%", ¿gana de verdad 6 de cada 10? Se agrupan todas sus
// estimaciones de partidos terminados por rango de probabilidad y se compara con lo que pasó.
const CAL_BINS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
export function calibration(sport = null, { xg = null } = {}) {
  const bins = CAL_BINS.slice(0, -1).map((lo, i) => ({ lo, hi: CAL_BINS[i + 1], n: 0, sumP: 0, hits: 0 }));
  let n = 0, brierSum = 0, logLoss = 0;
  for (const p of Object.values(state.predictions)) {
    if (!p.done || (sport && p.sport !== sport)) continue;
    if (xg != null && !!p.xg !== xg) continue;
    const probs = p.final || p.model;
    for (const [pick, prob] of Object.entries(probs)) {
      if (prob == null) continue;
      const hit = pick === p.outcome ? 1 : 0;
      const b = bins.find((x) => prob >= x.lo && prob < x.hi);
      b.n++; b.sumP += prob; b.hits += hit;
      n++; brierSum += (prob - hit) ** 2; logLoss += -Math.log(Math.max(1e-6, hit ? prob : 1 - prob));
    }
  }
  for (const b of bins) { b.avgP = b.n ? b.sumP / b.n : null; b.freq = b.n ? b.hits / b.n : null; }
  // Error de calibración esperado (ECE): diferencia promedio entre lo que dice y lo que pasa.
  const ece = n ? bins.reduce((a, b) => a + (b.n ? (b.n / n) * Math.abs(b.avgP - b.freq) : 0), 0) : null;
  return { bins, n, brier: n ? brierSum / n : null, logLoss: n ? logLoss / n : null, ece };
}

export function learningStats() {
  const out = {};
  for (const p of Object.values(state.predictions)) {
    if (!p.done) continue;
    const o = (out[p.sport] ||= { n: 0, nm: 0, bm: 0, bk: 0, hits: 0 });
    o.n++;
    o.bm += p.brierModel;
    if (p.brierMarket != null) { o.nm++; o.bk += p.brierMarket; }
    const fav = Object.entries(p.model).sort((a, b) => b[1] - a[1])[0][0];
    if (fav === p.outcome) o.hits++;
  }
  for (const o of Object.values(out)) { o.bm /= o.n || 1; o.bk = o.nm ? o.bk / o.nm : null; o.hitRate = o.hits / (o.n || 1); }
  return out;
}

// ---------- métricas ----------
export function metrics() {
  const settled = state.bets.filter((b) => b.status === 'won' || b.status === 'lost' || b.status === 'cashout');
  const staked = settled.reduce((a, b) => a + b.stake, 0);
  const returned = settled.reduce((a, b) => a + (b.status === 'won' || b.status === 'cashout' ? b.payout : 0), 0);
  const wins = settled.filter((b) => b.status === 'won').length;
  const clvBets = settled.filter((b) => b.closingOdds);
  const clv = clvBets.length ? clvBets.reduce((a, b) => a + (b.odds / b.closingOdds - 1), 0) / clvBets.length : null;
  const pending = pendingBets();
  const bySport = {};
  for (const b of settled) {
    const s = (bySport[b.sport] ||= { n: 0, staked: 0, profit: 0 });
    s.n++; s.staked += b.stake; s.profit += (b.status === 'won' || b.status === 'cashout' ? b.payout : 0) - b.stake;
  }
  return {
    n: settled.length, wins, hitRate: settled.length ? wins / settled.length : null,
    staked, profit: returned - staked, roi: staked ? (returned - staked) / staked : null,
    clv, clvN: clvBets.length, pendingN: pending.length, pendingStake: pending.reduce((a, b) => a + b.stake, 0),
    equity: state.bankroll + pending.reduce((a, b) => a + b.stake, 0),
    avgOdds: settled.length ? settled.reduce((a, b) => a + b.odds, 0) / settled.length : null,
    expectedProfit: settled.reduce((a, b) => a + b.stake * b.ev, 0),
    bySport,
  };
}
