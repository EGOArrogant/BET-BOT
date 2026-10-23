import * as D from './data.js';
import * as M from './models.js';
import * as B from './bank.js';
import { initAI, aiReady, analyzeWithAI, researchOdds } from './ai.js';
import { STRATEGY_HTML } from './strategy.js';
import * as K from './books.js';
import { updateElo, esportsTable, finishedEsports } from './esports.js';
import { getPredictionMarkets, matchPrediction, nameScore, priceHistory } from './prediction.js';
import * as SM from './smart.js';
import { morph } from './morph.js';
import { getContext, applyContext } from './context.js';
import * as X from './s365.js';
import { lineChart } from './charts.js';
import { initShell, saveSnapshot, pushSupport, pushState, enablePush, disablePush, testPush, setPushPrefs, pushOnHere, isTailscale } from './appshell.js';

// ---------- utilidades ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (x) => '$' + Number(x || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x, d = 0) => (x == null || !Number.isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');
const dec = (x) => (x ? Number(x).toFixed(2) : '—');
const signed = (x, fmt = money) => (x > 0 ? '+' : x < 0 ? '−' : '') + fmt(Math.abs(x));
const key = (ev) => ev.leagueId + ':' + ev.id;
const toAmerican = (d) => (!d ? '—' : d >= 2 ? '+' + Math.round((d - 1) * 100) : '−' + Math.round(100 / (d - 1)));

function when(ev) {
  if (ev.state === 'in') return `<span class="live-tag"><span class="dot live"></span>${esc(ev.detail || ev.clock || 'En vivo')}</span>`;
  if (ev.state === 'post') return 'Final';
  const d = new Date(ev.date);
  const today = new Date().toDateString() === d.toDateString();
  const day = today ? 'Hoy' : d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' });
  return `${esc(day)}<br>${d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`;
}

function toast(msg, ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast glass';
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function parseOddsInput(v) {
  const s = String(v || '').trim().replace(',', '.');
  if (!s) return null;
  if (/^[+-]\d+$/.test(s) || Math.abs(Number(s)) >= 100) return D.americanToDecimal(s);
  const n = Number(s);
  return n > 1 ? n : null;
}

// ---------- estado de la app ----------
const S = {
  cfg: {}, tab: 'home', secLeague: { soccer: 'all', sports: 'all', combat: 'all', esports: 'all' }, combatDiv: 'all', combatTitle: false, fighters: new Map(),
  smart: { period: 'MONTH', board: null, busy: false, lastScan: 0, positions: new Map(), byEvent: new Map(), error: null }, matchFilter: 'upcoming',
  events: new Map(), tables: new Map(), analysis: new Map(), summaries: new Map(), ai: new Map(), oddsApi: new Map(),
  lastUpdate: null, scanning: false, open: null, sheetTab: 'analysis',
  moreTab: 'tables', tablesLeague: 'uefa.champions', newsLeague: 'mex.1', bankTab: 'pending', betSource: 'all', newsQuery: '',
  oddsResearch: new Map(), notifs: [], newsNotifs: [], newsCheckedAt: 0, goldFirstSeen: new Map(),
  version: null, update: null, pendingRender: false,
};
// Orden fijo (liga por importancia → hora → id): las listas no "brincan" cuando una liga termina de actualizarse.
const LG_ORDER = new Map(D.LEAGUES.map((l, i) => [l.id, i]));
const cmpEv = (x, y) => (LG_ORDER.get(x.ev.leagueId) ?? 99) - (LG_ORDER.get(y.ev.leagueId) ?? 99)
  || new Date(x.ev.date) - new Date(y.ev.date) || String(x.ev.id).localeCompare(String(y.ev.id));
const allAnalyses = () => [...S.analysis.values()].sort(cmpEv);
const allEvents = () => [...S.events.values()].flat();

function analyze(ev, table, winProb) {
  const st = B.getState();
  const model = M.modelEvent(ev, table || new Map(), winProb);
  // Ajuste prudente por bajas y descanso (solo antes del partido y si ya se cargó el contexto).
  if (ev.state === 'pre' && S.ctx) applyContext(model, S.ctx.get(key(ev)));
  // Con precio de Polymarket/Kalshi hay referencia de mercado aunque el modelo no tenga datos propios.
  model.tradable = model.known || !!ev.pm || !!ev.lineValue?.some((x) => x.group === 'mx');
  const sels = M.applyLineValue(ev, M.selections(ev, model, st.settings, st.weights), st.settings);
  const golden = M.goldenOpportunities(ev, model, sels);
  B.recordPrediction(ev, model, sels);
  // Aprendizaje sin IA: registra lo que el bot habría apostado (sin tocar la banca).
  if (ev.state === 'pre' && model.tradable) for (const s of sels) if (s.value) B.recordShadow(ev, s, model.adj?.delta || 0);
  const a = { ev, model, sels, golden };
  S.analysis.set(key(ev), a);
  recordProb(a);
  return a;
}

async function refreshLeague(lg) {
  let events, table;
  if (lg.sport === 'esports') {
    events = await D.getEvents(lg);
    if (updateElo(B.getState(), events)) B.save();
    table = esportsTable(B.getState(), events, lg.game);
  } else {
    [events, table] = await Promise.all([D.getEvents(lg), D.getTeamTable(lg)]);
  }
  // Precios de Polymarket y Kalshi para cada partido (si existen).
  const pmk = await getPredictionMarkets(lg).catch(() => []);
  for (const ev of events) { ev.pm = matchPrediction(ev, pmk); attachX365(ev); }
  await attachPyModel(lg, events); // modelo entrenado con temporadas pasadas (servidor de Python)
  for (const e of events) attachLineValue(e); // casas que pagan más que el precio justo (Pinnacle sin margen)
  S.events.set(lg.id, events);
  S.tables.set(lg.id, table);
  for (const k of [...S.analysis.keys()]) if (k.startsWith(lg.id + ':')) S.analysis.delete(k);
  for (const ev of events) analyze(ev, table, S.summaries.get(key(ev))?.winProb);
}

// ---------- momio por encima del precio justo (servidor de Python) ----------
// El servidor consulta The Odds API con presupuesto de créditos y compara cada casa contra Pinnacle sin margen.
// Aquí solo se leen sus resultados (no gasta créditos) y se pegan a cada partido.
S.lv = { spots: [], status: null, t: 0 };
async function loadLineValues(force = false) {
  if (S.cfg?.engine !== 'python' || (!force && Date.now() - S.lv.t < 5 * 60_000)) return;
  try { const r = await (await fetch('/api/precios/valor', { cache: 'no-store' })).json(); S.lv = { spots: r.spots || [], status: r.status, t: Date.now() }; } catch {}
}
function attachLineValue(ev) {
  if (ev.state === 'post' || !S.lv.spots.length) { ev.lineValue = null; return; }
  const t = new Date(ev.date).getTime();
  const mine = S.lv.spots.filter((x) => x.leagueId === ev.leagueId && Math.abs(new Date(x.commence).getTime() - t) < 12 * 3600_000
    && nameScore(ev.home.name, x.home) > 0 && nameScore(ev.away.name, x.away) > 0);
  ev.lineValue = mine.length ? mine : null;
}
function lvTag(a) {
  const mx = (a.ev.lineValue || []).filter((x) => x.group === 'mx');
  if (!mx.length || a.ev.state !== 'pre') return '';
  const b = mx.sort((x, y) => y.ev - x.ev)[0];
  const who = b.pick === 'draw' ? 'Empate' : a.ev[b.pick].abbr || a.ev[b.pick].name;
  return `<span class="tag lv-tag" title="${esc(b.bookName)} paga ${dec(b.price)} y el precio justo (Pinnacle sin margen) es ${dec(b.fairOdds)}">💲 ${esc(who)} ${esc(b.bookName)} ${dec(b.price)} · EV ${pct(b.ev, 1)}</span>`;
}
function lineValueSection() {
  if (S.cfg?.engine !== 'python') return '';
  const st = S.lv.status, c = st?.credits;
  const spots = S.lv.spots.filter((x) => new Date(x.commence) > Date.now()).slice(0, 10);
  const credits = c ? `${c.remaining != null ? `${Math.round(c.remaining)} créditos restantes · ` : ''}hoy ${Math.round(c.spentToday)} de ${c.daily} · regiones ${esc(c.regions)}` : '';
  const head = `<div class="section-title">Momio por encima del precio justo <small>Casas que pagan más que Pinnacle sin margen</small></div>`;
  const warn = c?.error ? `<div class="warn">${esc(c.error)}. Se reanuda solo en unas horas; el plan gratuito da 500 créditos al mes.</div>` : '';
  if (!spots.length) return head + `<div class="widget glass empty">${warn}${st?.quotes ? 'Ninguna casa paga hoy más que el precio justo en los partidos revisados. Es lo normal: cuando aparezca, se verá aquí.' : 'Todavía no hay momios revisados.'}<div class="note mt">${credits}</div></div>`;
  const row = (x) => {
    const a = [...S.analysis.values()].find((y) => y.ev.lineValue?.includes(x));
    const who = x.pick === 'draw' ? 'Empate' : x.pick === 'home' ? x.home : x.away;
    const when = new Date(x.commence).toLocaleString('es-MX', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="match" ${a ? `data-open="${key(a.ev)}"` : ''} data-key="lv-${esc(x.id)}-${x.pick}">
      <div class="when">${esc(when)}</div>
      <div><b>${esc(who)}</b> <span class="note">· ${esc(x.home)} vs ${esc(x.away)}</span>
        <div class="note">${esc(x.bookName)} ${x.group === 'mx' ? '<span class="tag">en México</span>' : '<span class="tag">internacional · sin permiso SEGOB</span>'} · Pinnacle ${dec(x.pinnacle)} · justo ${dec(x.fairOdds)}</div></div>
      <div class="odds"><div class="odd value"><div class="k">${esc(x.bookName)}</div><div class="o">${dec(x.price)}</div><div class="p">EV ${pct(x.ev, 1)}</div></div>
        ${a ? `<button class="odd" data-slip="${key(a.ev)}|${x.pick}"><div class="k">Boleto</div><div class="o">+</div></button>` : ''}</div>
    </div>`;
  };
  return head + `${warn}<div class="league-block glass" data-key="lv-block">${spots.map(row).join('')}</div>
    <div class="note mt">Precio justo = momio de Pinnacle sin su margen. Si una casa paga más, la apuesta tiene valor esperado positivo. El piloto y el modo práctica usan solo las casas que operan en México. ${credits}</div>`;
}

// ---------- modelo entrenado (servidor de Python, fase 3) ----------
// Para fútbol, el servidor tiene un modelo Dixon-Coles entrenado con temporadas pasadas y calibrado con su
// backtesting. Se pide una vez cada 30 min por liga y se mezcla con el modelo de la app (ver models.js).
const PY_LEAGUES = new Set(['eng.1', 'esp.1', 'ita.1', 'fra.1', 'mex.1', 'uefa.champions']);
S.pyCache = new Map(); // id del partido -> { t, p }
// NFL, NBA, MLB, LMB y tenis: modelo Elo entrenado con temporadas pasadas (o con lo que ve el bot).
const RATING_LEAGUES = new Set(['nfl', 'nba', 'mlb', 'lmb', 'atp', 'wta']);
async function attachRating(lg, events) {
  const need = events.filter((e) => e.state !== 'post' && !(S.pyCache.get('r' + e.id) && Date.now() - S.pyCache.get('r' + e.id).t < 30 * 60_000));
  if (need.length) {
    try {
      const r = await fetch('/api/modelos/rating', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: need.map((e) => ({ leagueId: lg.id, home: e.home.name, away: e.away.name, date: e.date, neutral: !!e.neutral })) }) });
      const { preds } = await r.json();
      need.forEach((e, i) => S.pyCache.set('r' + e.id, { t: Date.now(), p: preds?.[i] || null }));
    } catch {}
  }
  for (const e of events) e.pyRating = S.pyCache.get('r' + e.id)?.p || null;
}
async function attachPyModel(lg, events) {
  if (S.cfg?.engine !== 'python') return;
  if (RATING_LEAGUES.has(lg.id)) return attachRating(lg, events);
  if (!PY_LEAGUES.has(lg.id)) return;
  const need = events.filter((e) => e.state !== 'post' && !(S.pyCache.get(e.id) && Date.now() - S.pyCache.get(e.id).t < 30 * 60_000));
  if (need.length) {
    try {
      const r = await fetch('/api/modelos/futbol', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: need.map((e) => ({ leagueId: lg.id, home: e.home.name, away: e.away.name })) }) });
      const { preds } = await r.json();
      need.forEach((e, i) => S.pyCache.set(e.id, { t: Date.now(), p: preds?.[i] || null }));
    } catch {}
  }
  for (const e of events) e.pyModel = S.pyCache.get(e.id)?.p || null;
}
// El motor 24/7 manda al servidor los partidos de fútbol terminados (con su momio previo) para seguir entrenando.
S.pySent = new Set();
function postFinishedSoccer() {
  if (!B.isServerBot) return;
  // Tenis: cuenta quién ganó (1-0); el resto, el marcador final.
  const sc = (e, side) => (e.sport === 'tennis' ? (e[side].winner ? 1 : 0) : Number(e[side].score));
  const items = allEvents().filter((e) => e.completed && (PY_LEAGUES.has(e.leagueId) || RATING_LEAGUES.has(e.leagueId)) && !S.pySent.has(e.id)
      && (e.sport === 'tennis' ? (e.home.winner || e.away.winner) : e.home.score != null && e.away.score != null))
    .map((e) => ({ id: e.id, leagueId: e.leagueId, date: e.date, home: e.home.name, away: e.away.name, hg: sc(e, 'home'), ag: sc(e, 'away'),
      odds: e.odds && e.odds.home && e.odds.away ? { home: e.odds.home, draw: e.odds.draw || null, away: e.odds.away } : null }));
  if (!items.length) return;
  fetch('/api/historico/resultados', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })
    .then((r) => { if (r.ok) items.forEach((x) => S.pySent.add(x.id)); }).catch(() => {});
}

async function refreshAll() {
  if (S.scanning) return;
  S.scanning = true;
  $('#last-update').textContent = 'Actualizando…';
  await B.pullState(); // cambios hechos desde otro dispositivo
  await loadLineValues();
  const firstLoad = !S.lastUpdate;
  // En la primera carga se pinta conforme llega cada liga (Liquipedia puede tardar ~30 s por su límite).
  await Promise.allSettled(D.LEAGUES.map((lg) => refreshLeague(lg).then(() => { if (firstLoad) render(); }).catch((e) => console.warn(lg.id, e))));
  if (firstLoad) S.lastUpdate = Date.now();
  const events = allEvents();
  B.settleWithEvents(events);
  B.settleShadow(events);
  B.learnFromEvents(events);
  postFinishedSoccer();
  await settleOld();
  B.cleanSlip(events);
  backfillLedger().catch(() => {});
  // El piloto automático y la práctica diaria corren solo en un dispositivo (evita apuestas duplicadas).
  await autopilot();
  try { await loadRelevantNews(); } catch {}
  scanX365().catch(() => {}); // xG de 365Scores: forma reciente de los equipos de los próximos partidos (segundo plano)
  refreshSmart().then(() => { mapSmartToEvents(); scanEventSmart(); });
  scanContext(); // jugadores clave, bajas y descanso de los partidos de las próximas 36 h // top apostadores de Polymarket + dinero inteligente por partido (segundo plano)
  mapSmartToEvents();
  collectNotifications();
  detectChanges();
  S.lastUpdate = Date.now();
  S.scanning = false;
  saveSnapshot({ bank: B.getState().bankroll, pending: B.pendingBets().length });
  B.save();
  render();
}

// Liquida apuestas de partidos que ya no aparecen en el scoreboard actual.
async function settleOld() {
  const loaded = new Set(allEvents().filter((e) => e.completed).map((e) => e.id));
  const old = (x) => !loaded.has(x.eventId) && Date.now() - new Date(x.eventDate).getTime() > 3 * 3600000;
  // Apuestas reales y apuestas sombra de partidos que ya no aparecen en la lista actual.
  const pend = [...B.pendingBets().filter(old), ...B.pendingShadows().filter(old)];
  const groups = new Map();
  for (const b of pend) groups.set(b.leagueId + '|' + String(b.eventDate).slice(0, 10), b);
  for (const b of [...groups.values()].slice(0, 12)) {
    try {
      let evs = await D.getEventsAround(D.leagueById(b.leagueId), b.eventDate);
      // CS2/Valorant: Liquipedia quita los partidos terminados; el resultado se toma de bo3.gg.
      const lg = D.leagueById(b.leagueId);
      if (lg?.sport === 'esports' && lg.game !== 'lol') evs = [...evs, ...await finishedEsports(lg.game, b.eventDate).catch(() => [])];
      B.settleWithEvents(evs); B.settleShadow(evs);
    } catch (e) { console.warn('liquidación', e); }
  }
  // Sin resultado oficial 3 días después: se anula y se devuelve el monto (no se queda "en juego" para siempre).
  B.voidStale(72);
}

// ---------- base de datos de apuestas (data/apuestas.jsonl en la PC) ----------
// Cada apuesta liquidada se guarda con todo su contexto: probabilidades, momios, mercado, sharps y resultado.
const ledgerQueue = [];
B.onSettled((b, ev) => {
  const smart = ev ? S.smart.events.get(ev.leagueId + ':' + ev.id) : null;
  ledgerQueue.push({
    id: b.id, t: b.settledAt, placedAt: b.placedAt, kind: b.source === 'manual' ? 'manual' : b.source,
    sport: b.sport, leagueId: b.leagueId, event: b.eventName, eventDate: b.eventDate, live: !!b.live,
    market: b.market, pick: b.pick, line: b.line, label: b.label,
    odds: b.odds, oddsMx: b.oddsMx, refOdds: b.refOdds, closingOdds: b.closingOdds, book: b.book,
    p: b.p, pModel: b.pModel, pMarket: b.pMarket, ev: b.ev, stake: b.stake, payout: b.payout,
    status: b.status, finalScore: b.finalScore || null, settledBy: b.settledBy || 'auto',
    sharpSide: smart?.best || null, lineValue: !!b.lineValue, lineBook: b.lineValue?.book || null, fairOdds: b.lineValue?.fairOdds || null, profit: b.status === 'void' ? 0 : Math.round(((b.payout || 0) - b.stake) * 100) / 100,
  });
  pushFeed({ kind: b.status, k: ev ? ev.leagueId + ':' + ev.id : null, text: `${b.status === 'won' ? '✅ Ganaste' : b.status === 'lost' ? '❌ Perdiste' : '↩️ Anulada'}: ${b.label} · ${b.eventName}${b.finalScore ? ' · ' + b.finalScore : ''}${b.status === 'won' ? ` · +${money(b.payout - b.stake)}` : b.status === 'lost' ? ` · −${money(b.stake)}` : ''}` });
  flushLedger();
});
async function flushLedger() {
  if (!ledgerQueue.length) return;
  const batch = ledgerQueue.splice(0);
  try { const r = await fetch('/api/ledger', { method: 'POST', body: JSON.stringify(batch), headers: { 'Content-Type': 'application/json' } }); if (!r.ok) throw 0; S.ledger = null; }
  catch { ledgerQueue.unshift(...batch); setTimeout(flushLedger, 30_000); }
}
// Registro inicial: las apuestas ya liquidadas antes de esta versión también entran a la base de datos (sin duplicados).
async function backfillLedger() {
  const done = B.getState().bets.filter((b) => !['pending'].includes(b.status));
  if (!done.length || B.getState().settings.ledgerV1) return;
  for (const b of done) ledgerQueue.push({ id: b.id, t: b.settledAt || b.placedAt, placedAt: b.placedAt, kind: b.source, sport: b.sport, leagueId: b.leagueId, event: b.eventName, eventDate: b.eventDate, market: b.market, pick: b.pick, line: b.line, label: b.label, odds: b.odds, oddsMx: b.oddsMx, refOdds: b.refOdds, closingOdds: b.closingOdds, p: b.p, pModel: b.pModel, pMarket: b.pMarket, ev: b.ev, stake: b.stake, payout: b.payout, status: b.status, finalScore: b.finalScore || null });
  await flushLedger();
  if (!ledgerQueue.length) B.updateSettings({ ledgerV1: true });
}

// ---------- pausa de la IA ante errores que no se arreglan reintentando ----------
const AI_PAUSE_MIN = { sin_saldo: 60, clave_invalida: 60, sin_permiso: 60, limite: 5, servicio: 10, otro: 10 };
const aiPaused = () => S.aiPause && Date.now() < S.aiPause.until;
function handleAIError(e) {
  const code = e?.code || 'otro';
  const mins = AI_PAUSE_MIN[code] ?? 10;
  const already = aiPaused() && S.aiPause.code === code;
  S.aiPause = { code, msg: e.message, until: Date.now() + mins * 60_000 };
  if (!already) { B.log(e.message, 'error'); toast('⚠️ ' + e.message, 6000); }
}

// ---------- piloto automático ----------
async function autopilot() {
  if (S.halted) return; // motor 24/7 duplicado o pausado: nunca apuesta
  const s = B.getState().settings;
  if (!s.autopilot && !s.practiceMode) return;
  if (!B.claimDevice()) return; // otro dispositivo activo está operando el bot
  if (s.autopilot) await valueBets();
  if (s.practiceMode) practiceBets();
}

// Modo práctica: garantiza apuestas ficticias diarias (monto mínimo) con las mejores opciones disponibles,
// aunque no lleguen al EV mínimo. Sirve para que el bot opere y aprenda desde el primer día.
function practiceBets() {
  const st = B.getState(), s = st.settings;
  const today = new Date().toDateString();
  const done = st.bets.filter((b) => b.source === 'práctica' && b.status !== 'void' && new Date(b.placedAt).toDateString() === today).length;
  let room = (s.practicePerDay ?? 5) - done;
  const stake = Math.max(1, Number(s.practiceStake) || 10);
  if (room <= 0 || st.bankroll < stake) return;
  const segs = B.segmentStats();
  const cands = [];
  for (const a of allAnalyses()) {
    if (a.ev.state !== 'pre' || B.hasBetOn(a.ev.id)) continue;
    const hrs = (new Date(a.ev.date) - Date.now()) / 3600000;
    if (hrs > 30 || hrs < 0.05) continue;
    if (!a.model.tradable) continue;
    for (const x of a.sels) {
      if (!x.odds || x.odds < 1.4 || x.odds > 3.6 || x.ev == null) continue; // momios moderados: aprendizaje más estable
      if (segs[B.segKey(a.ev.sport, x.market, x.odds)]?.status === 'bloqueado') continue;
      cands.push({ a, sel: x });
    }
  }
  cands.sort((x, y) => y.sel.ev - x.sel.ev); // mejor valor esperado primero
  const used = new Set();
  const perSport = {};
  for (const b of st.bets) if (b.source === 'práctica' && b.status !== 'void' && new Date(b.placedAt).toDateString() === today) perSport[b.sport] = (perSport[b.sport] || 0) + 1;
  for (const c of cands) {
    if (room <= 0) break;
    if (c.sel.ev < -0.04) break; // nunca algo claramente malo, aunque sea práctica
    if (used.has(c.a.ev.id)) continue;
    if ((perSport[c.a.ev.sport] || 0) >= 2) continue; // variedad: máximo 2 por deporte al día
    perSport[c.a.ev.sport] = (perSport[c.a.ev.sport] || 0) + 1;
    try {
      const book = K.recommendBook(st, { sport: c.a.ev.sport, p: c.sel.p, stake })?.best?.book;
      B.placeBet({
        ev: c.a.ev, sel: c.sel, stake, odds: c.sel.odds, source: 'práctica', book: book?.id || null,
        reasoning: `Práctica diaria: mejor opción disponible hoy (EV ${pct(c.sel.ev, 1)}, prob. ${pct(c.sel.p)}, precio ${c.sel.oddsSource || 'referencia'})`,
      });
      used.add(c.a.ev.id); room--;
      toast(`🎓 Práctica: $${stake} a ${c.sel.label} @ ${dec(c.sel.odds)}`);
    } catch (e) { B.log('No se pudo registrar la práctica: ' + e.message, 'error'); }
  }
}

async function valueBets() {
  const st = B.getState(), s = st.settings;
  let room = s.maxBetsPerDay - B.betsToday();
  if (room <= 0) return;
  const segs = B.segmentStats();
  const cands = [];
  for (const a of allAnalyses()) {
    if (a.ev.state !== 'pre' || !a.model.tradable || B.hasBetOn(a.ev.id)) continue;
    const hrs = (new Date(a.ev.date) - Date.now()) / 3600000;
    if (hrs > 36 || hrs < 0.05) continue;
    // Lo aprendido con las apuestas sombra: no apuesta en segmentos que han dado pérdidas.
    const best = a.sels.filter((x) => x.value && segs[B.segKey(a.ev.sport, x.market, x.odds)]?.status !== 'bloqueado').sort((x, y) => y.ev - x.ev)[0];
    if (best) cands.push({ a, sel: best });
  }
  cands.sort((x, y) => y.sel.ev - x.sel.ev);
  let aiCalls = 0;
  for (const c of cands) {
    if (room <= 0) break;
    let sel = c.sel, stake = B.suggestStake(sel.p, sel.odds), source = 'modelo';
    let reasoning = sel.lineValue
      ? `${sel.lineValue.bookName} paga ${dec(sel.lineValue.price)} y el precio justo (Pinnacle sin margen) es ${dec(sel.lineValue.fairOdds)} · EV ${pct(sel.ev, 1)}`
      : `EV ${pct(sel.ev, 1)} · modelo ${pct(sel.pModel)} vs mercado ${pct(sel.pMarket)}`;
    if (s.aiConfirm && aiReady()) {
      // IA en pausa (sin saldo, clave inválida, límite...): no se apuesta sin su confirmación ni se reintenta en cada escaneo.
      if (aiPaused()) break;
      if (aiCalls >= 2) break; // máximo 2 consultas de IA por escaneo para cuidar costos
      aiCalls++;
      try {
        const r = await runAI(c.a);
        const pick = c.a.sels.find((x) => x.pick === r.seleccion && x.odds);
        if (r.decision !== 'apostar' || !pick || r.probabilidad * pick.odds - 1 < s.minEV) {
          B.log(`IA descartó ${c.a.ev.name}: ${r.resumen}`, 'ai');
          continue;
        }
        sel = { ...pick, p: r.probabilidad };
        stake = Math.max(s.minStake, Math.floor((st.bankroll * r.stake_pct) / 5) * 5);
        source = 'IA';
        reasoning = r.resumen;
      } catch (e) { handleAIError(e); if (aiPaused()) break; continue; }
    }
    if (!stake) continue;
    try {
      const rec = K.recommendBook(st, { sport: c.a.ev.sport, p: sel.p, stake });
      const book = rec?.best?.book;
      B.placeBet({ ev: c.a.ev, sel, stake, odds: sel.odds, source, reasoning, book: book?.id || null });
      if (book) B.log(`→ Colócala en ${book.name} solo si paga ${dec(sel.minOdds)} (${toAmerican(sel.minOdds)}) o más`, 'bet');
      toast(`🤖 Bot apostó $${stake} a ${sel.label}${book ? ' · ' + book.name : ''}`);
      room--;
    } catch (e) { B.log('No se pudo apostar: ' + e.message, 'error'); }
  }
}

async function buildContext(a) {
  const lg = D.leagueById(a.ev.leagueId);
  const k = key(a.ev);
  let sum = S.summaries.get(k);
  if (!sum) { try { sum = await D.getSummary(lg, a.ev.id); S.summaries.set(k, sum); } catch { sum = null; } }
  const table = S.tables.get(lg.id) || new Map();
  const news = lg.sport === 'tennis' ? [] : await D.searchNews(`${a.ev.home.name} ${a.ev.away.name}`, 8);
  const st = B.getState();
  return {
    liga: lg.name, deporte: lg.sport, partido: a.ev.name, fecha: a.ev.date, estado: a.ev.state, detalle: a.ev.detail,
    marcador: a.ev.state !== 'pre' ? `${a.ev.home.score ?? 0}-${a.ev.away.score ?? 0}` : null,
    local: { nombre: a.ev.home.name, tabla: table.get(String(a.ev.home.id)) || null, forma: a.ev.home.form, record: a.ev.home.record, sets: a.ev.home.linescores },
    visitante: { nombre: a.ev.away.name, tabla: table.get(String(a.ev.away.id)) || null, forma: a.ev.away.form, record: a.ev.away.record, sets: a.ev.away.linescores },
    momios_referencia: a.ev.odds,
    pelea: a.ev.sport === 'mma' || a.ev.sport === 'boxing' ? {
      evento: a.ev.tournament, division: a.ev.round, rounds: a.ev.rounds, lugar_en_cartelera: a.ev.segment, campeonato: a.ev.titleFight ? a.ev.belt : 'no',
      peleador_1: { nombre: a.ev.home.name, record: a.ev.home.record, pais: a.ev.home.flag, cinturones: a.ev.home.belts, estadisticas: a.ev.home.athleteId ? await fighterData(a.ev.home) : null },
      peleador_2: { nombre: a.ev.away.name, record: a.ev.away.record, pais: a.ev.away.flag, cinturones: a.ev.away.belts, estadisticas: a.ev.away.athleteId ? await fighterData(a.ev.away) : null },
      mercados_de_metodo: (a.ev.pm?.sources || []).flatMap((s) => (s.props || []).map((p) => ({ pregunta: p.q, si: p.prices[0], operado: p.traded }))),
    } : undefined,
    xg_365scores: (() => { const r = S.x365.get(key(a.ev)); if (!r) return undefined; const fm = (t) => t && { xg_a_favor_prom: t.for != null ? +t.for.toFixed(2) : null, xg_en_contra_prom: t.against != null ? +t.against.toFixed(2) : null, partidos: t.n, ultimos: t.series.map((s) => `vs ${s.opp}: ${s.for}-${s.against}`) };
      return { forma_local: fm(r.form?.home), forma_visitante: fm(r.form?.away), xg_partido: r.data?.xg || null, xpoints: r.data?.xg ? X.xPoints(r.data.xg.home, r.data.xg.away) : null, estadisticas: r.data?.stats?.slice(0, 20).map((s) => `: ${s.home ?? '-'} vs ${s.away ?? '-'}`) }; })(),
    contexto_previo: (() => {
      const c = S.ctx.get(key(a.ev));
      if (!c || c.none || !c.home) return null;
      const side = (s) => ({
        descanso_dias: c[s].rest?.days ?? null, back_to_back: c[s].rest ? c[s].rest.days <= 1 : null, record: c.records?.[s] || null,
        jugadores_clave: (c[s].players || []).map((p) => `${p.name}${p.role ? ' (' + p.role + ')' : ''}: ${p.line}${p.status ? ' [' + p.status.text + ']' : ''}`),
        bajas: (c[s].injuries || []).slice(0, 10).map((i) => `${i.name}: ${i.status?.text}${i.detail ? ' (' + i.detail + ')' : ''}`),
        abridor: c[s].pitcher || null, alineacion_confirmada: c[s].lineup?.length ? c[s].lineup : null,
      });
      return { local: side('home'), visitante: side('away'), serie: c.series, pronostico_espn: c.predictor, ajuste_modelo: c.adj ? { cambio_prob_local: c.adj.delta, motivos: c.adj.list.map((x) => `${x.side === 'home' ? 'local' : 'visitante'}: ${x.text}`) } : null };
    })(),    valor_plantilla_transfermarkt: a.ev.sport === 'soccer' ? await Promise.all([D.squadValue(a.ev.home.name), D.squadValue(a.ev.away.name)]).then(([h, w]) => (h || w ? { local: h && { club: h.name, valor: h.valueTxt, jugadores: h.squad }, visitante: w && { club: w.name, valor: w.valueTxt, jugadores: w.squad } } : null)).catch(() => null) : undefined,
    top_apostadores_polymarket: (() => {
      const agg = S.smart.byEvent.get(key(a.ev));
      return agg ? Object.fromEntries(Object.entries(agg).map(([side, s]) => [side, { cuantos: s.traders.length, usd: Math.round(s.usd), quienes: s.traders.map((t) => `${t.name} a ${t.price}`) }])) : null;
    })(),
    dinero_inteligente_polymarket: await (async () => {
      const r = await loadEventSmart(a, { perSide: 6 }).catch(() => null);
      if (!r || !Object.keys(r.sides).length) return null;
      return {
        lado_de_los_sharps: r.best, // sharp = 20+ apuestas resueltas, win rate ≥55% y ganancia positiva (90 días)
        lados: Object.fromEntries(Object.entries(r.sides).map(([side, s]) => [side, {
          precio: s.price, usd_mayores: Math.round(s.all), sharps: s.sharpN, usd_sharps: Math.round(s.sharpValue),
          mayores: s.holders.slice(0, 6).map((h) => ({ nombre: h.name, usd: Math.round(h.value), win_rate: h.stats?.winRate ?? null, apuestas: h.stats?.n ?? null, ganancia_90d: h.stats ? Math.round(h.stats.realized) : null, ranking: h.rank })),
        }])),
      };
    })(),
    mercados_prediccion: a.ev.pm ? { prob_local: a.ev.pm.home, prob_visitante: a.ev.pm.away, prob_empate: a.ev.pm.draw, fuentes: a.ev.pm.sources.map((s) => ({ fuente: s.source, liquidez_usd: Math.round(s.liquidity || 0), local: s.home, visitante: s.away, empate: s.draw })) } : null,
    modelo: { previo: a.model.pre, en_vivo: a.model.live, goles_esperados: a.model.lh ? { local: a.model.lh, visitante: a.model.la } : undefined, peso_modelo: st.weights[a.ev.sport] },
    selecciones: a.sels.map((s) => ({ mercado: s.market, seleccion: s.pick, texto: s.label, linea: s.line, p_modelo: s.pModel, p_mercado: s.pMarket, p_final: s.p, momio_ref: s.odds, ev: s.ev, momio_minimo: s.minOdds })),
    alineaciones: sum?.lineups?.map((l) => ({ equipo: l.team, formacion: l.formation, titulares: l.players.filter((p) => p.starter).map((p) => `${p.name} (${p.pos})`) })),
    lesiones: sum?.injuries, estadisticas: sum?.stats, ultimos_5: sum?.lastFive, eventos_clave: sum?.keyEvents?.slice(-15),
    abridores: sum?.probablePitchers,
    noticias: [...(sum?.news || []).map((n) => n.title), ...news.map((n) => `${n.title} (${n.source})`)].slice(0, 12),
    banca_mxn: st.bankroll, ev_minimo: st.settings.minEV,
  };
}

async function runAI(a) {
  const ctx = await buildContext(a);
  const r = await analyzeWithAI(ctx);
  S.ai.set(key(a.ev), { ...r, t: Date.now() });
  B.log(`IA analizó ${a.ev.name}: ${r.decision.replace('_', ' ')} (${r.seleccion_texto}, confianza ${r.confianza}/10)`, 'ai');
  return r;
}

// ---------- render general ----------
const TITLES = {
  home: ['Inicio', 'Resumen del bot y de tu banca ficticia'],
  soccer: ['Fútbol', D.SECTIONS.soccer.sub],
  sports: ['Deportes', D.SECTIONS.sports.sub],
  esports: ['eSports', D.SECTIONS.esports.sub],
  combat: ['Combate', D.SECTIONS.combat.sub],
  smart: ['Top Polymarket', 'Los mejores apostadores de deportes: win rate, ROI y el rastro de sus apuestas'],
  bet: ['Apostar', 'Tu boleto, dónde colocar cada apuesta y recomendaciones'],
  gold: ['Oportunidades de Oro', 'Underdogs con valor y remontadas en vivo'],
  bank: ['Mi Banca', 'Apuestas simuladas, rendimiento y aprendizaje'],
  news: ['Noticias', 'Lo que puede mover los momios'],
  more: ['Más', 'Tablas, casas, celular, estrategia y ajustes'],
};

const ICONS = {
  home: '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>',
  soccer: '<circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 4.5h-5L8 10z"/><path d="M12 3v4M21 10h-5M17.5 19l-3-4.5M6.5 19l3-4.5M3 10h5"/>',
  sports: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  esports: '<path d="M6 9h12a4 4 0 0 1 4 4v1a3 3 0 0 1-5.2 2L15 14H9l-1.8 2A3 3 0 0 1 2 14v-1a4 4 0 0 1 4-4z"/><path d="M7 11.5v3M5.5 13h3"/>',
  combat: '<path d="M7 11V7a3 3 0 0 1 3-3h4a4 4 0 0 1 4 4v5a5 5 0 0 1-5 5h-2a4 4 0 0 1-4-4z"/><path d="M7 11H5.5a1.5 1.5 0 0 0 0 3H7M9 18v2h7v-2M11 8h5"/>',
  smart: '<path d="M3 14c3-6 9-8 14-5 2 1 3 3 4 5-2 3-6 5-10 4-3-1-5-2-8-4z"/><path d="M21 14l1-4-3 2M7 13h.01"/>',
  bet: '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 5v12" stroke-dasharray="2 2"/>',
  gold: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/>',
  bank: '<path d="M3 17l5-5 4 4 8-9"/><path d="M15 7h5v5"/>',
  news: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h10M7 17h6"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
};
const icon = (id) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[id]}</svg>`;
const NAV = [['home', 'Inicio'], ['soccer', 'Fútbol'], ['sports', 'Deportes'], ['combat', 'Combate'], ['esports', 'eSports'], ['bet', 'Apostar'], ['gold', 'Oro'], ['smart', 'Top Polymarket'], ['bank', 'Banca'], ['news', 'Noticias'], ['more', 'Más']];
const MOBILE_NAV = ['home', 'soccer', 'bet', 'bank', 'more'];

function go(tab, moreTab) {
  if (S.open) closeSheets();
  closeNotifs();
  S.tab = tab;
  if (moreTab) S.moreTab = moreTab;
  window.scrollTo({ top: 0 });
  render();
}

// Partes fijas: barra lateral, barra inferior, encabezado y contadores.
function renderChrome() {
  document.documentElement.dataset.sec = S.tab; // color propio de la sección actual
  const st = B.getState();
  const slipN = st.slip.length, toPlaceN = B.pendingBets().filter((b) => !b.placedReal && b.source !== 'práctica').length;
  const unread = S.notifs.filter((n) => !isRead(n)).length;
  const badge = (id) => (id === 'bet' && slipN + toPlaceN ? `<span class="badge">${slipN + toPlaceN}</span>` : '');
  const sub = (sec) => (S.tab === sec ? `<div class="side-sub">${D.sectionLeagues(sec).map((l) => {
    const live = (S.events.get(l.id) || []).filter((e) => e.state === 'in').length;
    const logo = D.leagueLogo(l.id);
    return `<button class="${S.secLeague[sec] === l.id ? 'active' : ''}" data-secleague="${sec}|${l.id}">${logo ? `<img class="lg-mini" src="${esc(logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${esc(l.name)}${live ? `<span class="dot live"></span>` : ''}</button>`;
  }).join('')}</div>` : '');
  $('#sidebar').innerHTML = `<div class="brand"><span class="brand-icon">⚽</span><div><b>BetBot MX</b><div class="note">v${esc(S.version?.version || '—')}</div></div></div>
    <nav>${NAV.map(([id, label]) => `<button class="side-item ${S.tab === id ? 'active' : ''}" data-tab="${id}">${icon(id)}<span>${label}</span>${badge(id)}</button>${['soccer', 'sports', 'combat', 'esports'].includes(id) ? sub(id) : ''}`).join('')}</nav>
    <div class="side-foot"><div class="note">Banca disponible</div><b>${money(st.bankroll)}</b><div class="note">${S.botStatus?.healthy ? '🖥️ Bot 24/7 activo en tu PC' : st.settings.autopilot ? (B.isAutopilotHere() ? '🟢 Bot activo aquí' : '🟢 Bot activo en otro dispositivo') : '⚪ Bot en pausa'}</div></div>`;
  $('#tabbar').innerHTML = MOBILE_NAV.map((id) => `<button data-tab="${id}" class="${S.tab === id || (id === 'more' && !MOBILE_NAV.includes(S.tab)) ? 'active' : ''}">${icon(id)}${NAV.find((n) => n[0] === id)[1]}${badge(id)}</button>`).join('');
  $('#page-title').textContent = TITLES[S.tab][0];
  $('#page-sub').textContent = TITLES[S.tab][1];
  $('#bank-pill').textContent = money(st.bankroll) + ' MXN';
  $('#bot-dot').className = 'dot' + (st.settings.autopilot ? ' on' : '');
  $('#bot-label').textContent = st.settings.autopilot ? (st.settings.aiConfirm && aiReady() ? 'Bot + IA activos' : 'Bot activo') : 'Bot en pausa';
  $('#last-update').textContent = S.lastUpdate ? new Date(S.lastUpdate).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
  $('#bell-count').textContent = unread ? (unread > 9 ? '9+' : unread) : '';
  $('#bell-count').hidden = !unread;
  $('#qr-btn').hidden = !S.cfg.local; // el QR se genera desde la PC
  const fab = $('#slip-fab');
  fab.hidden = S.tab === 'bet' || !slipN;
  $('#slip-fab-count').textContent = slipN;
}

// Tablas adaptables: en celular cada fila se convierte en tarjeta "etiqueta: valor" (ver .rtable en el CSS).
// Las tablas de posiciones (.keep) se quedan como tabla con desplazamiento horizontal.
function labelTables(root) {
  for (const table of root.querySelectorAll('table.t:not(.keep):not(.rtable)')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    table.classList.add('rtable');
    for (const tr of table.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, i) => {
        if (i === 0) td.classList.add('cell-main');
        else if (heads[i]) td.dataset.label = heads[i];
        else td.classList.add('cell-actions');
      });
    }
  }
}

// Aviso si la página es más nueva que el servidor que está corriendo (pasa si se actualizó sin reiniciar).
function serverBanner() {
  if (!S.cfg.local || !S.version) return '';
  const sv = S.cfg.serverVersion;
  if (sv && cmpVer(sv, '2.2.0') >= 0) return '';
  return `<div class="warn" style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><div class="grow"><b>El servidor sigue con la versión anterior.</b> Algunas funciones (como Top Polymarket) no van a funcionar hasta reiniciarlo.</div><button class="btn small primary" data-restartserver>↻ Reiniciar servidor</button></div>`;
}

// No se re-pinta mientras escribes en un campo (para no perder lo que tecleas).
const typingInView = () => { const a = document.activeElement; return a && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName); };

function render() {
  if (B.isServerBot) return; // motor del bot 24/7: no hay nadie mirando, no se dibuja nada
  renderChrome();
  if (typingInView()) { S.pendingRender = true; return; }
  S.pendingRender = false;
  const v = $('#view');
  const views = { home: viewHome, soccer: () => viewSection('soccer'), sports: () => viewSection('sports'), esports: () => viewSection('esports'), combat: viewCombat, smart: viewSmart, bet: viewBet, gold: viewGold, bank: viewBank, news: viewNews, more: viewMore };
  // Misma sección: solo se cambia lo que es distinto (sin parpadeos). Sección nueva: se pinta completa.
  const viewKey = S.tab + '|' + (S.moreTab || '') + '|' + (S.bankTab || '');
  const html = serverBanner() + views[S.tab]();
  const fresh = S.viewKey !== viewKey;
  if (fresh) { v.innerHTML = html; S.viewKey = viewKey; } else morph(v, html);
  labelTables(v);
  if (S.tab === 'home' || S.tab === 'bank') drawEquity();
  // Lo que se carga aparte solo se pide al entrar a la sección (después, el contenido se conserva).
  if (fresh || S.reloadView) {
    S.reloadView = false;
    if (S.tab === 'news') loadNews();
    if (S.tab === 'more' && S.moreTab === 'tables') loadTables();
    if (S.tab === 'more' && S.moreTab === 'phone') loadPhone();
  }
}

// ---------- Inicio ----------
function kpis() {
  const m = B.metrics(), st = B.getState();
  const total = m.equity - st.startBankroll;
  const k = (label, value, delta = '', cls = '') => `<div class="widget glass kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="delta">${delta}</div></div>`;
  return `<div class="grid kpis">
    ${k('Banca disponible', money(st.bankroll), `${m.pendingN} pendientes · ${money(m.pendingStake)} en juego`)}
    ${k('Capital total', money(m.equity), `${signed(total)} desde ${money(st.startBankroll)}`, total > 0 ? 'up' : total < 0 ? 'down' : '')}
    ${k('Ganancia neta', signed(m.profit), `Esperada por EV: ${signed(m.expectedProfit)}`, m.profit > 0 ? 'up' : m.profit < 0 ? 'down' : '')}
    ${k('ROI', pct(m.roi, 1), `${m.n} apuestas liquidadas`, m.roi > 0 ? 'up' : m.roi < 0 ? 'down' : '')}
    ${k('Acierto', pct(m.hitRate), m.avgOdds ? `Momio promedio ${dec(m.avgOdds)}` : 'Sin datos aún')}
    ${k('CLV promedio', pct(m.clv, 1), m.clvN ? `${m.clvN} apuestas con cierre` : 'Mide si le ganas al cierre', m.clv > 0 ? 'up' : m.clv < 0 ? 'down' : '')}
  </div>`;
}

// Estado del bot 24/7 (el motor que corre el servidor de la PC sin necesitar la app abierta).
function bot247Row() {
  const b = S.botStatus;
  if (!b || (b.browser === false && !b.enabled)) return '';
  const ago = (t) => { if (!t) return '—'; const sec = Math.round((Date.now() - t) / 1000); return sec < 90 ? `hace ${sec} s` : `hace ${Math.round(sec / 60)} min`; };
  const st = !b.enabled ? 'Desactivado: el bot solo opera con la app abierta'
    : b.browser === false ? 'No se encontró Microsoft Edge ni Chrome en la PC'
    : b.healthy ? `Activo · último escaneo ${ago(b.beat?.lastUpdate)} · opera aunque cierres la app${b.keepAwake ? ' · la PC no se duerme' : ''}`
    : b.running ? 'Arrancando el motor…' : `Detenido${b.lastReason ? ': ' + esc(b.lastReason) : ''} (se reinicia solo)`;
  const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${S.cfg.local ? '' : 'disabled'}><span></span></label>`;
  return `<div class="row"><div class="icon-sq" style="background:var(--teal)">🖥️</div><div class="grow"><b>Bot 24/7 en tu PC</b><div class="meta">${st}${b.restarts ? ` · ${b.restarts} reinicio${b.restarts > 1 ? 's' : ''} automático${b.restarts > 1 ? 's' : ''}` : ''}</div></div>${sw('sw-bot247', b.enabled)}</div>
    ${b.enabled && S.cfg.local ? `<div class="row"><div class="icon-sq" style="background:var(--fill-2)">🌙</div><div class="grow"><b>Que la PC no se duerma</b><div class="meta">Mientras el bot 24/7 esté activo (la pantalla sí se puede apagar)</div></div>${sw('sw-keepawake', b.keepAwake)}</div>` : ''}`;
}
async function refreshBotStatus() {
  try { S.botStatus = await (await fetch('/api/bot/status', { cache: 'no-store' })).json(); } catch { S.botStatus = null; }
}

function botWidget() {
  const st = B.getState(), s = st.settings;
  const sw = (id, on, dis = false) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}><span></span></label>`;
  return `<div class="widget glass">
    <h3>Piloto automático</h3>
    <div class="list" style="background:var(--fill)">
      <div class="row"><div class="icon-sq" style="background:var(--green-fill)">🤖</div><div class="grow"><b>Apostar automáticamente</b><div class="meta">Solo apuestas con EV ≥ ${pct(s.minEV)} · máx. ${s.maxBetsPerDay} al día${s.autopilot ? (s.autopilotDevice === B.SERVER_DEVICE ? ' · corre en el bot 24/7 de tu PC (no necesitas la app abierta)' : B.isAutopilotHere() ? ' · corre en este dispositivo (mantén esta pestaña abierta)' : ' · corre en otro dispositivo') : ''}</div></div>${s.autopilot && !B.isAutopilotHere() && !(s.autopilotDevice === B.SERVER_DEVICE && S.botStatus?.healthy) ? '<button class="btn small" data-takeover>Correr aquí</button>' : ''}${sw('sw-auto', s.autopilot)}</div>
      ${bot247Row()}
      <div class="row"><div class="icon-sq" style="background:var(--purple)">✦</div><div class="grow"><b>Confirmar con IA</b><div class="meta">${aiReady() ? 'Claude revisa cada apuesta y busca noticias' : 'Agrega tu clave de Anthropic en Más → Ajustes'}</div></div>${sw('sw-ai', s.aiConfirm, !aiReady())}</div>
      <div class="row"><div class="icon-sq" style="background:var(--orange-fill)">🎓</div><div class="grow"><b>Modo práctica diaria</b><div class="meta">Al menos ${s.practicePerDay} apuestas ficticias al día de $${s.practiceStake ?? 10} con las mejores opciones disponibles, para aprender desde hoy · hoy: ${st.bets.filter((b) => b.source === 'práctica' && new Date(b.placedAt).toDateString() === new Date().toDateString()).length}/${s.practicePerDay}</div></div>${sw('sw-practice', s.practiceMode)}</div>
      <div class="row"><div class="icon-sq" style="background:var(--blue)">⏱</div><div class="grow"><b>Escaneo</b><div class="meta">Cada ${s.scanMinutes} min · última ${S.lastUpdate ? new Date(S.lastUpdate).toLocaleTimeString('es-MX') : '—'}</div></div><button class="btn small" id="scan-now">Escanear</button></div>
    </div>
    ${aiPaused() ? `<div class="warn mt"><b>IA en pausa</b> hasta las ${new Date(S.aiPause.until).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}: ${esc(S.aiPause.msg)}${s.aiConfirm ? ' Mientras tanto, el piloto automático no apuesta (espera la confirmación de la IA).' : ''}
      <div class="flex mt">${S.aiPause.code === 'sin_saldo' ? '<a class="btn small" href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener">Recargar saldo ↗</a>' : ''}<button class="btn small" data-airetry>Reintentar ahora</button></div></div>` : ''}
    ${(() => { const segs = Object.values(B.segmentStats()); const blocked = segs.filter((o) => o.status === 'bloqueado').length, good = segs.filter((o) => o.status === 'confiable').length;
      return `<div class="row" style="padding:10px 0 0"><div class="icon-sq" style="background:var(--teal)">🧠</div><div class="grow"><b>Aprendizaje sin IA</b><div class="meta">${st.shadow.length} apuestas sombra · ${good} segmentos confiables · ${blocked} bloqueados${aiReady() ? '' : ' · funciona sin créditos de Anthropic'}</div></div><button class="btn small" data-tab="bank">Ver</button></div>`; })()}
    <div class="note mt">Kelly ${pct(s.kellyFraction)} · tope ${pct(s.maxStakePct)} por apuesta · Momios extra: ${S.cfg.hasOdds ? 'The Odds API ✓' : 'no configurado'}</div>
  </div>`;
}

function compactMatch(a) {
  const ev = a.ev;
  const best = a.sels.filter((s) => s.value).sort((x, y) => y.ev - x.ev)[0];
  return `<div class="match" data-open="${key(ev)}">
    <div class="when">${when(ev)}</div>
    <div>${teamLine(ev, 'home')}${teamLine(ev, 'away')}
      <div class="tags">${tagsFor(a)}</div></div>
    <div class="note" style="text-align:right">${best ? `<b class="up">EV ${pct(best.ev, 1)}</b><br>${esc(best.label)}` : D.leagueById(ev.leagueId).short}</div>
  </div>`;
}

function viewHome() {
  const live = allAnalyses().filter((a) => a.ev.state === 'in');
  const golds = allAnalyses().flatMap((a) => a.golden.map((g) => ({ g, a }))).sort((x, y) => y.g.score - x.g.score).slice(0, 3);
  const values = allAnalyses().filter((a) => a.ev.state === 'pre').flatMap((a) => a.sels.filter((s) => s.value).map((s) => ({ s, a }))).sort((x, y) => y.s.ev - x.s.ev).slice(0, 6);
  const pend = B.pendingBets().slice(0, 6);
  const st = B.getState();
  return `${kpis()}
  <div class="grid two mt">
    <div class="widget glass"><h3>Evolución del capital <span class="note" style="text-transform:none;letter-spacing:0">Inicial ${money(st.startBankroll)}</span></h3><div class="chart" id="equity"></div></div>
    ${botWidget()}
  </div>
  ${liveCenter()}
  <div class="section-title">En vivo ahora <small>${live.length} partidos · se actualiza solo cada 5 s</small></div>
  ${live.length ? liveByCategory(live) : `<div class="widget glass empty">No hay partidos en vivo en este momento.</div>`}
  <div class="section-title">Oportunidades de Oro <small><a href="#" data-tab-link="gold">Ver todas</a></small></div>
  ${golds.length ? `<div class="grid opps">${golds.map(({ g, a }) => oppCard(g, a)).join('')}</div>` : `<div class="widget glass empty">Sin oportunidades de oro por ahora. El bot sigue buscando.</div>`}
  ${lineValueSection()}
  <div class="section-title">Valor detectado <small>EV positivo con momio de referencia</small></div>
  ${values.length ? `<div class="league-block glass">${values.map(({ s, a }) => valueRow(s, a)).join('')}</div>` : `<div class="widget glass empty">Ninguna selección supera el EV mínimo ahora mismo. Así se ve un mercado eficiente: no apostar también es una decisión.</div>`}
  <div class="grid halves mt">
    <div class="widget glass"><h3>Mis apuestas en juego <span class="flex" style="text-transform:none;letter-spacing:0;gap:6px"><button class="btn small" data-banktab="won">✅ ${st.bets.filter((b) => b.status === 'won').length}</button><button class="btn small" data-banktab="lost">❌ ${st.bets.filter((b) => b.status === 'lost').length}</button><button class="btn small" data-banktab="all">Ver todas</button></span></h3>${pend.length ? betsTable(pend, true) : '<div class="empty">Sin apuestas en juego</div>'}</div>
    <div class="widget glass"><h3>Actividad del bot</h3>${logList(10)}</div>
  </div>`;
}

// ---------- Centro en tiempo real (dentro del dashboard, sin alarmas) ----------
// Compara cada actualización con la anterior y anota lo importante: goles/puntos en tus partidos o en
// partidos con señal, inicio y final de tus partidos, nuevas señales sharp, oportunidades de oro y liquidaciones.
S.feed = (() => { try { return JSON.parse(localStorage.getItem('bb-feed') || '[]').filter((x) => Date.now() - x.t < 12 * 3600_000); } catch { return []; } })();
S.snap = null; S.bump = new Map(); S.startedAt = Date.now();
S.sharpSeen = (() => { try { return new Map(JSON.parse(localStorage.getItem('bb-sharpseen') || '[]')); } catch { return new Map(); } })();
window.addEventListener('pagehide', () => { try { localStorage.setItem('bb-sharpseen', JSON.stringify([...S.sharpSeen].slice(-400))); } catch {} });
function pushFeed(item) {
  const it = { t: Date.now(), ...item };
  if (S.feed.some((x) => x.text === it.text && Date.now() - x.t < 10 * 60_000)) return;
  S.feed.unshift(it);
  S.feed = S.feed.slice(0, 60);
  try { localStorage.setItem('bb-feed', JSON.stringify(S.feed)); } catch {}
}
function detectChanges() {
  const now = new Map();
  for (const a of allAnalyses()) {
    const ev = a.ev, k = key(ev), r = S.smart.events.get(k);
    now.set(k, { state: ev.state, hs: ev.home.score, as: ev.away.score, sharp: r?.best || null, gold: a.golden.length, ev, a, r });
  }
  if (S.snap) {
    for (const [k, n] of now) {
      const o = S.snap.get(k);
      if (!o) continue;
      const ev = n.ev, mine = B.hasBetOn(ev.id), flagged = mine || n.sharp || n.gold;
      const score = `${ev.home.name} ${ev.home.score ?? 0}-${ev.away.score ?? 0} ${ev.away.name}`;
      if (o.state === 'pre' && n.state === 'in' && flagged) pushFeed({ kind: 'start', k, text: `▶️ Empezó ${ev.name}${mine ? ' · tienes apuesta' : ''}` });
      if (n.state !== 'pre' && (o.hs !== n.hs || o.as !== n.as) && o.state !== 'pre') {
        S.bump.set(k, Date.now());
        if (flagged) pushFeed({ kind: 'score', k, text: `${ev.sport === 'soccer' ? '⚽ Gol' : D.SPORT_ICON[ev.sport] + ' Marcador'}: ${score}${mine ? ' · tu apuesta' : ''}` });
      }
      if (o.state === 'in' && n.state === 'post' && flagged) pushFeed({ kind: 'end', k, text: `🏁 Terminó: ${score}` });
      // Señal sharp: se anuncia una vez por partido y lado (no cada vez que se vuelve a escanear).
      // Las que ya existían al abrir la app se registran sin aviso (no es algo "nuevo").
      if (n.sharp && ev.state !== 'post' && S.sharpSeen.get(k) !== n.sharp) {
        const first = !S.sharpSeen.has(k) && Date.now() - S.startedAt < 3 * 60_000;
        S.sharpSeen.set(k, n.sharp);
        const s = n.r.sides[n.sharp];
        if (!first) pushFeed({ kind: 'sharp', k, text: `🧠 Sharps cargados en ${n.sharp === 'draw' ? 'Empate' : ev[n.sharp].name} (${s.sharpN} sharp · ${money0(s.sharpValue)}) · ${ev.name}` });
      }
      if (n.gold > o.gold && ev.state !== 'post') { const g = n.a.golden[0]; pushFeed({ kind: 'gold', k, text: `★ ${g?.title || 'Oportunidad de oro'} · ${ev.name}` }); }
    }
  }
  S.snap = now;
}

function liveCenter() {
  const items = S.feed.slice(0, 8);
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.round(s / 60)} min` : new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }); };
  return `<div class="widget glass live-center mt" data-key="live-center"><h3>⚡ En tiempo real <span class="note" style="text-transform:none;letter-spacing:0">se actualiza solo · sin alarmas</span></h3>
    ${items.length ? `<div class="feed">${items.map((x) => `<div class="it lc-${x.kind} ${Date.now() - x.t < 10_000 ? 'fresh' : ''}" data-key="feed-${x.t}-${x.kind}" ${x.k ? `data-open="${x.k}" style="cursor:pointer"` : ''}><div class="c">${ago(x.t)}</div><div>${esc(x.text)}</div></div>`).join('')}</div>`
      : '<div class="note">Aquí aparecen al instante los goles y puntos de tus partidos, el inicio y final de tus apuestas, nuevas señales de sharps, oportunidades de oro y apuestas liquidadas.</div>'}</div>`;
}

// En vivo agrupado: categoría (Fútbol, Deportes, Combate, eSports) → liga con su logo → partidos en orden fijo.
function liveByCategory(live) {
  return Object.entries(D.SECTIONS).map(([sec, info]) => {
    const items = live.filter((a) => info.sports.includes(a.ev.sport));
    if (!items.length) return '';
    const byLg = new Map();
    for (const a of items) { if (!byLg.has(a.ev.leagueId)) byLg.set(a.ev.leagueId, []); byLg.get(a.ev.leagueId).push(a); }
    return `<div class="live-cat" data-key="livecat-${sec}"><div class="live-cat-head">${D.SPORT_ICON[info.sports[0]]} ${esc(info.title)} <span class="note">${items.length} en vivo</span></div>
      <div class="live-grid">${[...byLg].map(([id, arr]) => { const lg = D.leagueById(id);
        return `<div class="league-block glass" data-key="live-${id}"><div class="league-head">${lgMark(lg, arr[0].ev)} ${esc(lg.name)}<span class="spacer"></span><span class="meta note">${arr.length}</span></div>${arr.map(compactMatch).join('')}</div>`; }).join('')}</div></div>`;
  }).join('');
}

function valueRow(s, a) {
  const ev = a.ev;
  return `<div class="match" data-open="${key(ev)}">
    <div class="when">${when(ev)}</div>
    <div><b>${esc(s.label)}</b> <span class="note">· ${esc(s.market)}</span><div class="note">${esc(ev.name)} · ${D.leagueById(ev.leagueId).name}</div></div>
    <div class="odds"><div class="odd value"><div class="k">Momio ref.</div><div class="o">${dec(s.odds)}</div><div class="p">EV ${pct(s.ev, 1)}</div></div>
    <div class="odd"><div class="k">Mínimo MX</div><div class="o">${dec(s.minOdds)}</div><div class="p">${toAmerican(s.minOdds)}</div></div></div>
  </div>`;
}

function logList(n) {
  const l = B.getState().log.slice(0, n);
  if (!l.length) return '<div class="empty">Sin actividad todavía</div>';
  return `<div class="feed">${l.map((x) => `<div class="it"><div class="c">${new Date(x.t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</div><div>${esc(x.msg)}</div></div>`).join('')}</div>`;
}

// ---------- Partidos ----------
function teamLine(ev, side) {
  const t = ev[side];
  const showScore = ev.state !== 'pre';
  const sc = ev.sport === 'tennis' && showScore ? t.linescores.join(' ') : showScore ? t.score ?? '' : '';
  const bump = S.bump.get(key(ev)) > Date.now() - 6000;
  return `<div class="team-line ${t.winner ? 'win' : ''}">${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="nm">${esc(t.name)}${t.seed ? ` <span class="note">(${esc(t.seed)})</span>` : ''}${(ev.sport === 'mma' || ev.sport === 'boxing') && (t.record || t.flag) ? ` <span class="note">${esc([t.record, t.flag].filter(Boolean).join(' · '))}</span>` : ''}</span><span class="sc${bump ? ' bump' : ''}">${esc(sc)}</span></div>`;
}

// Marca de cada partido: precio en Polymarket (o Kalshi) con su logo; si no hay mercado, la conclusión del bot (distinta).
const PM_ICON = 'https://polymarket.com/icons/favicon-32x32.png';
function marketTag(a) {
  const ev = a.ev, pm = ev.pm;
  const ab = (s) => (s === 'draw' ? 'X' : ev[s].abbr || ev[s].name.split(' ').slice(-1)[0]);
  if (pm?.sources?.length) {
    const poly = pm.sources.find((s) => s.source === 'Polymarket'), src = poly || pm.sources[0];
    const icon = poly ? `<img class="tag-ic" src="${PM_ICON}" alt="Polymarket">` : '<b class="tag-ic k-ic">K</b>';
    const sides = ['home', 'draw', 'away'].filter((s) => pm[s] != null);
    return `<span class="tag pm-tag" title="Probabilidad con dinero real en ${esc(src.source)}${pm.sources.length > 1 ? ' (promedio de ' + pm.sources.length + ' mercados)' : ''}">${icon} ${sides.map((s) => `<span>${esc(ab(s))} <b>${Math.round(pm[s] * 100)}%</b></span>`).join(' · ')}</span>`;
  }
  const c = botConclusion(a);
  if (!c) return '';
  return `<span class="tag bot-tag" title="Sin mercado de predicción: conclusión propia del bot (${c.conf.toLowerCase()} confianza)">🤖 ${esc(ab(c.pick))} <b>${Math.round(c.p * 100)}%</b></span>`;
}

function tagsFor(a) {
  const t = [];
  const ev = a.ev;
  if (ev.sport === 'mma' || ev.sport === 'boxing') {
    // Distintivos de pelea: título, lugar en la cartelera, división y rondas.
    if (ev.titleFight) t.push(`<span class="tag title-fight">🏆 ${esc(ev.belt || 'Pelea de campeonato')}</span>`);
    if (ev.segment === 'Estelar') t.push('<span class="tag seg-main">⭐ Estelar</span>');
    else if (ev.segment === 'Coestelar') t.push('<span class="tag seg-co">Coestelar</span>');
    if (ev.round) t.push(`<span class="tag div-tag" style="--h:${(divRank(ev.round) * 37) % 360}">${esc(ev.round)}</span>`);
    if (ev.rounds === 5 && !ev.titleFight) t.push('<span class="tag">5 rounds</span>');
    t.push(lvTag(a));
    if (a.golden.length) t.push('<span class="tag gold">★ Oro</span>');
    const vv = a.sels.filter((s) => s.value);
    if (vv.length && ev.state === 'pre') t.push(`<span class="tag value">Valor ${pct(Math.max(...vv.map((s) => s.ev)), 1)}</span>`);
    if (B.hasBetOn(ev.id)) t.push('<span class="tag bet">Apostado</span>');
    t.push(marketTag(a), smartTag(a), sharpTag(a));
    return t.join('');
  }
  t.push(marketTag(a), smartTag(a), sharpTag(a));
  t.push(lvTag(a));
  if (a.golden.length) t.push('<span class="tag gold">★ Oro</span>');
  const v = a.sels.filter((s) => s.value);
  if (v.length && a.ev.state === 'pre') t.push(`<span class="tag value">Valor ${pct(Math.max(...v.map((s) => s.ev)), 1)}</span>`);
  if (B.hasBetOn(a.ev.id)) t.push('<span class="tag bet">Apostado</span>');
  if (a.ev.tournament) t.push(`<span class="tag">${esc(a.ev.round || a.ev.tournament)}</span>`);
  return t.join('');
}

function oddsButtons(a) {
  const ev = a.ev;
  const ml = a.sels.filter((s) => s.market === '1X2' || s.market === 'Ganador');
  const labels = ev.sport === 'soccer' ? { home: '1', draw: 'X', away: '2' }
    : ev.sport === 'tennis' ? { home: 'J1', away: 'J2' }
    : ev.sport === 'esports' || ev.sport === 'mma' || ev.sport === 'boxing' ? { home: ev.home.abbr || 'Eq. 1', away: ev.away.abbr || 'Eq. 2' }
    : { home: 'Local', away: 'Visita' };
  // Sin momio de referencia se muestra el momio mínimo que necesitas en tu casa.
  return `<div class="odds">${ml.map((s) => `<button class="odd ${s.value && ev.state === 'pre' ? 'value' : ''}" data-slip="${key(ev)}|${s.pick}" title="Probabilidad estimada ${pct(s.p, 1)}">
      <div class="k">${esc(labels[s.pick])}</div><div class="o">${s.odds ? dec(s.odds) : `<span class="note">mín</span> ${dec(s.minOdds)}`}</div><div class="p">${pct(s.p)}</div></button>`).join('')}</div>`;
}

function matchRow(a) {
  return `<div class="match" data-open="${key(a.ev)}">
    <div class="when">${when(a.ev)}</div>
    <div>${teamLine(a.ev, 'home')}${teamLine(a.ev, 'away')}<div class="tags">${tagsFor(a)}</div></div>
    ${a.ev.state === 'post' ? '<div></div>' : oddsButtons(a)}
  </div>`;
}

// Sección de partidos (Fútbol, Deportes o eSports): ligas en orden de importancia.
function viewSection(sec) {
  const leagues = D.sectionLeagues(sec);
  const ids = new Set(leagues.map((l) => l.id));
  const sel = S.secLeague[sec] || 'all';
  const inSec = allAnalyses().filter((a) => ids.has(a.ev.leagueId));
  const counts = new Map(leagues.map((l) => [l.id, (S.events.get(l.id) || []).filter((e) => e.state !== 'post').length]));
  const liveN = inSec.filter((a) => a.ev.state === 'in').length;
  const chip = (id, label, n) => `<button class="chip glass ${sel === id ? 'active' : ''}" data-secleague="${sec}|${id}">${label}${n != null ? ` <span class="count">${n}</span>` : ''}</button>`;
  let list = inSec;
  if (sel === 'live') list = list.filter((a) => a.ev.state === 'in');
  else {
    if (sel !== 'all') list = list.filter((a) => a.ev.leagueId === sel);
    list = list.filter((a) => (S.matchFilter === 'finished' ? a.ev.state === 'post' : a.ev.state !== 'post'));
  }
  list.sort((x, y) => (x.ev.state === 'in' ? -1 : 0) - (y.ev.state === 'in' ? -1 : 0) || (S.matchFilter === 'finished' ? new Date(y.ev.date) - new Date(x.ev.date) : new Date(x.ev.date) - new Date(y.ev.date)));
  const groups = leagues.map((l) => ({ l, items: list.filter((a) => a.ev.leagueId === l.id) })).filter((g) => g.items.length);
  const note = sec === 'esports'
    ? 'Sin momios gratis: se muestra el momio mínimo que necesitas en tu casa · % = probabilidad del bot (Elo propio)'
    : sec === 'combat'
      ? 'Precios de Polymarket y Kalshi (y The Odds API en boxeo) · % = probabilidad estimada · el récord de cada peleador aparece junto a su nombre'
      : 'Momios de referencia (DraftKings vía ESPN) · % = probabilidad estimada por el bot';
  const head = (l, items) => {
    const live = items.filter((a) => a.ev.state === 'in').length;
    const logo = (l.id === 'lol' && items[0]?.ev.leagueLogo) || D.leagueLogo(l.id);
    return `<div class="league-head">${logo ? `<img class="lg-logo" src="${esc(logo)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${D.SPORT_ICON[l.sport]}'))">` : D.SPORT_ICON[l.sport]} ${esc(l.name)}${l.country ? ` <span class="note" style="font-weight:500">· ${esc(l.country)}</span>` : ''}
      <span class="spacer"></span>${live ? `<span class="tag live"><span class="dot live"></span> ${live} en vivo</span>` : ''}<span class="meta note">${items.length}</span></div>`;
  };
  const empty = `<div class="widget glass empty">${S.lastUpdate ? 'No hay partidos para este filtro.' : 'Cargando partidos…'}${sel === 'lmb' ? '<br>La temporada de la LMB terminó en agosto; regresa en abril.' : ''}</div>`;
  return `<div class="chips">${chip('all', 'Todas')}${chip('live', '<span class="dot live"></span> En vivo', liveN)}${leagues.map((l) => chip(l.id, `${sec === 'soccer' ? '' : D.SPORT_ICON[l.sport] + ' '}${l.name}`, counts.get(l.id))).join('')}</div>
  <div class="flex tabs-inline">${sel === 'live' ? '' : `<div class="segmented">
    <button data-mfilter="upcoming" class="${S.matchFilter === 'upcoming' ? 'active' : ''}">En vivo y próximos</button>
    <button data-mfilter="finished" class="${S.matchFilter === 'finished' ? 'active' : ''}">Finalizados</button></div>`}
    <span class="note">${note}</span></div>
  ${groups.length ? groups.map(({ l, items }) => `<div class="league-block glass">${head(l, items)}${items.slice(0, 40).map(matchRow).join('')}</div>`).join('') : empty}`;
}

// ---------- Combate: carteleras, divisiones y peleas de título ----------
const DIV_ORDER = ['Peso paja', 'Peso mosca', 'Peso gallo', 'Peso pluma', 'Peso ligero', 'Peso wélter', 'Peso medio', 'Peso semipesado', 'Peso pesado'];
const divRank = (d) => { const base = String(d || '').replace(' femenil', ''); const i = DIV_ORDER.indexOf(base); return (i < 0 ? 50 : i) + (String(d).includes('femenil') ? 20 : 0); };
const SEG_RANK = { Estelar: 0, Coestelar: 1, 'Cartelera principal': 2, Preliminares: 3 };

function viewCombat() {
  const leagues = D.sectionLeagues('combat');
  const sel = S.secLeague.combat || 'all';
  const all = allAnalyses().filter((a) => a.ev.sport === 'mma' || a.ev.sport === 'boxing');
  let list = sel === 'all' ? all : sel === 'live' ? all.filter((a) => a.ev.state === 'in') : all.filter((a) => a.ev.leagueId === sel);
  if (sel !== 'live') list = list.filter((a) => (S.matchFilter === 'finished' ? a.ev.state === 'post' : a.ev.state !== 'post'));
  const divisions = [...new Set(list.map((a) => a.ev.round).filter(Boolean))].sort((x, y) => divRank(x) - divRank(y));
  const titles = list.filter((a) => a.ev.titleFight).length;
  if (S.combatDiv !== 'all') list = list.filter((a) => a.ev.round === S.combatDiv);
  if (S.combatTitle) list = list.filter((a) => a.ev.titleFight);
  // Agrupa por evento (UFC 333...) o, en boxeo, por día.
  const groupKey = (a) => (a.ev.sport === 'mma' ? a.ev.tournament : `Boxeo · ${new Date(a.ev.date).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' })}`);
  const groups = new Map();
  for (const a of list) { const k = groupKey(a); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  const ordered = [...groups.entries()].sort((x, y) => new Date(x[1][0].ev.date) - new Date(y[1][0].ev.date));
  const chip = (attr, val, label, active) => `<button class="chip glass ${active ? 'active' : ''}" ${attr}="${val}">${label}</button>`;
  const liveN = all.filter((a) => a.ev.state === 'in').length;
  const head = `<div class="chips">${chip('data-secleague', 'combat|all', 'Todas', sel === 'all')}${chip('data-secleague', 'combat|live', `<span class="dot live"></span> En vivo <span class="count">${liveN}</span>`, sel === 'live')}${leagues.map((l) => chip('data-secleague', `combat|${l.id}`, `${D.SPORT_ICON[l.sport]} ${l.name} <span class="count">${(S.events.get(l.id) || []).filter((e) => e.state !== 'post').length}</span>`, sel === l.id)).join('')}</div>
    <div class="note chip-group-title">División</div>
    <div class="chips">${chip('data-combatdiv', 'all', 'Todas', S.combatDiv === 'all')}${divisions.map((d) => chip('data-combatdiv', d, esc(d), S.combatDiv === d)).join('')}
      <button class="chip glass ${S.combatTitle ? 'active' : ''}" data-combattitle>🏆 Solo campeonatos <span class="count">${titles}</span></button></div>
    <div class="flex tabs-inline"><div class="segmented"><button data-mfilter="upcoming" class="${S.matchFilter === 'upcoming' ? 'active' : ''}">Próximas y en vivo</button><button data-mfilter="finished" class="${S.matchFilter === 'finished' ? 'active' : ''}">Resultados</button></div>
      <span class="note">Precios de Polymarket, Kalshi y casas · % = probabilidad · toca una pelea para ver estadísticas de KO, mercados y especialistas</span></div>`;
  if (!ordered.length) return head + `<div class="widget glass empty">${S.lastUpdate ? 'No hay peleas para este filtro.' : 'Cargando carteleras…'}</div>`;
  return head + ordered.map(([name, items]) => {
    const first = items[0].ev;
    const lg = D.leagueById(first.leagueId);
    const logo = D.leagueLogo(first.leagueId);
    items.sort((x, y) => (SEG_RANK[x.ev.segment] ?? 9) - (SEG_RANK[y.ev.segment] ?? 9) || (y.ev.order ?? 0) - (x.ev.order ?? 0) || new Date(x.ev.date) - new Date(y.ev.date));
    // Subtítulos de la cartelera: "Cartelera principal" (incluye estelar y coestelar) y "Preliminares".
    let lastSeg = null;
    const rows = items.map((a) => {
      const segLabel = a.ev.segment === 'Preliminares' ? 'Preliminares' : a.ev.segment ? 'Cartelera principal' : '';
      const header = segLabel && segLabel !== lastSeg ? `<div class="seg-head">${segLabel}</div>` : '';
      lastSeg = segLabel;
      return header + matchRow(a);
    }).join('');
    return `<div class="league-block glass fight-card">
      <div class="league-head">${logo ? `<img class="lg-logo" src="${esc(logo)}" alt="" loading="lazy" onerror="this.remove()">` : D.SPORT_ICON[lg.sport]} ${esc(name)}
        <span class="spacer"></span>${first.sport === 'mma' ? `<span class="note">${new Date(first.date).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })}${first.venue ? ' · ' + esc(first.venue) : ''}</span>` : ''}<span class="meta note">${items.length}</span></div>
      ${rows}</div>`;
  }).join('');
}

// ---------- Top Polymarket ("smart money") ----------
const money0 = (x) => (Math.abs(x) >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M' : Math.abs(x) >= 1e3 ? '$' + (x / 1e3).toFixed(1) + 'K' : '$' + Math.round(x));

// Escanea: ranking, win rate, posiciones de los que sigues, rastro de entradas y su lado en tus partidos.
async function refreshSmart(force = false) {
  const sm = S.smart;
  if (sm.busy || (!force && Date.now() - sm.lastScan < 4 * 60_000)) return;
  sm.busy = true; sm.error = null;
  const st = B.getState().smart;
  // v2/v3: el win rate ahora cuenta también las apuestas perdidas (antes salían en 100%); se recalcula todo una vez.
  if (!st.v3) { st.stats = {}; st.follows = []; st.autoFollow = true; st.v2 = st.v3 = true; } // v3: muestra de las más recientes
  try {
    sm.board = await SM.leaderboard(sm.period, 25);
    // Win rate real (ganadas + perdidas en la misma ventana), 3 a la vez; se guarda 6 h.
    const need = sm.board.filter((t) => !st.stats[t.wallet] || st.stats[t.wallet].losses == null || Date.now() - st.stats[t.wallet].t > 6 * 3600_000);
    for (let i = 0; i < need.length; i += 3) {
      await Promise.all(need.slice(i, i + 3).map(async (t) => { try { st.stats[t.wallet] = await SM.traderStats(t.wallet); } catch {} }));
    }
    for (const t of sm.board) t.stats = st.stats[t.wallet] || null;
    // Selección automática: los 8 mejores por puntaje (win rate + ROI), recalculada en cada escaneo
    // mientras no elijas a mano. Si sigues o dejas de seguir a alguien, se respeta tu lista.
    if (st.autoFollow !== false || !st.follows.length) {
      const picks = sm.board.map((t) => ({ t, s: SM.traderScore(t) })).filter((x) => x.s != null && x.t.pnl > 0).sort((a, b) => b.s - a.s).slice(0, 8)
        .map((x) => ({ wallet: x.t.wallet, name: x.t.name }));
      if (picks.length) { st.follows = picks; st.autoFollow = true; }
    }
    // Posiciones abiertas de los que sigues + rastro de nuevas entradas.
    st.known ||= {};
    sm.positions = new Map();
    for (const f of st.follows.slice(0, 15)) {
      try {
        const pos = await SM.traderPositions(f.wallet);
        sm.positions.set(f.wallet, pos);
        // Lo que ya tenía cuando empezaste a seguirlo no cuenta como "entrada nueva".
        const fresh = !st.known[f.wallet];
        for (const p of pos) {
          const k = f.wallet + '|' + p.key;
          if (st.seen[k]) continue;
          st.seen[k] = Date.now();
          st.trail.unshift({ t: Date.now(), wallet: f.wallet, name: f.name, title: p.title, outcome: p.outcome, price: p.avgPrice, value: p.value, eventSlug: p.eventSlug, initial: fresh });
          if (!fresh) B.log(`🐋 ${f.name} entró: ${p.outcome} en "${p.title}" a ${pct(p.avgPrice)} (${money0(p.value)})`, 'ai');
        }
        st.known[f.wallet] = Date.now();
      } catch {}
    }
    st.trail = st.trail.slice(0, 300);
    for (const [k, v] of Object.entries(st.seen)) if (Date.now() - v > 30 * 86400000) delete st.seen[k];
    mapSmartToEvents();
    sm.lastScan = Date.now();
    B.save();
  } catch (e) { sm.error = e.message; }
  sm.busy = false;
  if (S.tab === 'smart') render();
}

// En qué lado están los top apostadores en los partidos que ve el bot.
function mapSmartToEvents() {
  const sm = S.smart, st = B.getState().smart;
  const slugMap = new Map();
  for (const a of allAnalyses()) for (const src of a.ev.pm?.sources || []) {
    const m = String(src.url || '').match(/polymarket\.com\/event\/([^/?#]+)/);
    if (m) slugMap.set(m[1], a);
  }
  sm.byEvent = new Map();
  const names = Object.fromEntries(st.follows.map((f) => [f.wallet, f.name]));
  for (const [wallet, pos] of sm.positions) for (const p of pos) {
    const a = slugMap.get(p.eventSlug);
    if (!a) continue;
    const side = SM.positionSide(p, a.ev, nameScore);
    if (!side) continue;
    const k = key(a.ev);
    if (!sm.byEvent.has(k)) sm.byEvent.set(k, {});
    const agg = sm.byEvent.get(k);
    const s = (agg[side] ||= { traders: [], usd: 0 });
    s.traders.push({ name: names[wallet] || wallet.slice(0, 8), price: p.avgPrice, value: p.value });
    s.usd += p.value;
  }
}

function smartTag(a) {
  const agg = S.smart.byEvent.get(key(a.ev));
  if (!agg) return '';
  const best = Object.entries(agg).sort((x, y) => y[1].usd - x[1].usd)[0];
  const label = best[0] === 'home' ? a.ev.home.abbr || a.ev.home.name : best[0] === 'away' ? a.ev.away.abbr || a.ev.away.name : 'Empate';
  return `<span class="tag smart-tag" title="Top apostadores de Polymarket con posición en este partido">🐋 ${best[1].traders.length} en ${esc(label)}</span>`;
}

function smartBlock(a) {
  const agg = S.smart.byEvent.get(key(a.ev));
  if (!agg) return '';
  const label = { home: a.ev.home.name, away: a.ev.away.name, draw: 'Empate' };
  return `<div class="widget mt" style="background:var(--fill)"><h3>🐋 Lo que apuestan los top de Polymarket</h3>
    ${Object.entries(agg).map(([side, s]) => `<div class="prop-row"><div><b>${esc(label[side])}</b><div class="note">${s.traders.map((t) => `${esc(t.name)} (entró a ${pct(t.price)})`).join(' · ')}</div></div><div class="pp">${s.traders.length}</div><div class="note">${money0(s.usd)}</div></div>`).join('')}
    <div class="note mt">Es una señal, no una garantía: los mejores también pierden, y a veces cubren posiciones. Úsala junto con el análisis.</div></div>`;
}

// ---------- Dinero inteligente por partido ----------
// Para cada partido con mercado en Polymarket: quiénes son los que más dinero tienen en cada lado,
// su win rate real y si están en el ranking. "Sharp" = ≥20 apuestas resueltas, win rate ≥55% y ganancia positiva.
S.smart.events = new Map(); // key -> { t, busy, sides: { home|away|draw: { holders, value, sharpN, sharpValue, score } }, best }
const pmSource = (a) => (a.ev.pm?.sources || []).find((s) => s.source === 'Polymarket' && s.cond);

async function loadEventSmart(a, { perSide = 6, force = false } = {}) {
  const k = key(a.ev), src = pmSource(a);
  if (!src) return null;
  const sm = S.smart, st = B.getState().smart;
  const cur = sm.events.get(k);
  if (cur?.busy || (!force && cur && Date.now() - cur.t < 5 * 60_000 && cur.perSide >= perSide)) return cur;
  const rec = { t: Date.now(), busy: true, perSide, sides: {}, best: null, error: null };
  if (cur) Object.assign(rec, { sides: cur.sides, best: cur.best });
  sm.events.set(k, rec);
  try {
    const byCond = new Map(); // un mismo mercado trae los dos lados (partidos de 2 resultados)
    const sides = Object.entries(src.cond).filter(([, c]) => c);
    for (const [, c] of sides) if (!byCond.has(c.conditionId)) byCond.set(c.conditionId, await SM.marketHolders(c.conditionId));
    const ranks = new Map((sm.board || []).map((t) => [t.wallet, t.rank]));
    const out = {};
    for (const [side, c] of sides) {
      const price = src[side] ?? 0.5;
      const holders = byCond.get(c.conditionId).filter((h) => h.outcomeIndex === c.outcomeIndex).sort((x, y) => y.amount - x.amount);
      out[side] = { price, holders: holders.map((h) => ({ ...h, value: h.amount * price, rank: ranks.get(h.wallet) || null })), all: holders.reduce((s, h) => s + h.amount * price, 0) };
    }
    // Win rate de los más grandes de cada lado (3 a la vez; se guarda 6 h).
    const need = [...new Set(Object.values(out).flatMap((s) => s.holders.slice(0, perSide).map((h) => h.wallet)))]
      .filter((w) => !st.stats[w] || Date.now() - st.stats[w].t > 6 * 3600_000);
    for (let i = 0; i < need.length; i += 3) {
      await Promise.all(need.slice(i, i + 3).map(async (w) => { try { st.stats[w] = await SM.traderStats(w, { deep: false }); } catch {} }));
    }
    for (const s of Object.values(out)) {
      for (const h of s.holders) h.stats = st.stats[h.wallet] || null;
      const sharps = s.holders.slice(0, perSide).filter((h) => SM.isSharp(h.stats));
      s.sharpN = sharps.length;
      s.sharpValue = sharps.reduce((x, h) => x + h.value, 0);
      // Peso: dinero × ventaja sobre el 50% (un 70% de win rate pesa el doble que un 60%).
      s.score = sharps.reduce((x, h) => x + h.value * (h.stats.winRate - 0.5), 0);
    }
    const ranked = Object.entries(out).sort((x, y) => y[1].score - x[1].score);
    const [first, second] = ranked;
    rec.best = first && first[1].score > 0 && (!second || first[1].score >= 1.5 * second[1].score) ? first[0] : null;
    rec.sides = out;
    rec.t = Date.now();
  } catch (e) { rec.error = e.message; }
  rec.busy = false;
  return rec;
}

// En segundo plano: partidos de las próximas 36 h (y en vivo) con mercado en Polymarket, pocos a la vez.
let eventSmartBusy = false;
async function scanEventSmart() {
  if (eventSmartBusy) return;
  eventSmartBusy = true;
  try {
    const soon = Date.now() + 36 * 3600_000;
    const list = allAnalyses().filter((a) => a.ev.state !== 'post' && new Date(a.ev.date).getTime() < soon && pmSource(a))
      .filter((a) => { const r = S.smart.events.get(key(a.ev)); return !r || Date.now() - r.t > 15 * 60_000; })
      .sort((x, y) => new Date(x.ev.date) - new Date(y.ev.date)).slice(0, 6);
    for (const a of list) await loadEventSmart(a, { perSide: 4 });
    // Limpia win rates viejos (no crecer el archivo de datos sin fin).
    const st = B.getState().smart;
    for (const [w, s] of Object.entries(st.stats)) if (Date.now() - s.t > 7 * 86400000) delete st.stats[w];
    if (list.length) { B.save(); if (['home', 'soccer', 'sports', 'combat', 'esports', 'smart'].includes(S.tab)) render(); }
  } catch (e) { console.warn('smart eventos', e); }
  eventSmartBusy = false;
}

const sideName = (a, side) => (side === 'home' ? a.ev.home.name : side === 'away' ? a.ev.away.name : 'Empate');

function sharpTag(a) {
  const r = S.smart.events.get(key(a.ev));
  if (!r?.best) return '';
  const s = r.sides[r.best];
  const lbl = r.best === 'draw' ? 'Empate' : a.ev[r.best].abbr || a.ev[r.best].name;
  return `<span class="tag sharp-tag" title="Apostadores de Polymarket con buen historial (win rate ≥55%, 20+ apuestas) cargados de este lado">🧠 ${s.sharpN} sharp en ${esc(lbl)}</span>`;
}

function eventSmartSummary(a) {
  const r = S.smart.events.get(key(a.ev));
  if (!r || !Object.keys(r.sides).length) return '';
  const rows = Object.entries(r.sides).map(([side, s]) => `<div class="prop-row"><div><b>${esc(sideName(a, side))}</b><div class="note">${s.sharpN ? `${s.sharpN} sharp · ${money0(s.sharpValue)}` : 'sin sharps entre los grandes'}</div></div><div class="pp">${pct(s.price)}</div><div class="note">${money0(s.all)}</div></div>`).join('');
  return `<div class="widget mt sharp-box"><h3>🧠 Dinero inteligente ${r.best ? `→ <span class="up">${esc(sideName(a, r.best))}</span>` : ''}</h3>${rows}
    <button class="btn small mt" data-stab="smart">Ver quiénes son y su win rate →</button></div>`;
}

function tabEventSmart(a) {
  const src = pmSource(a);
  if (!src) return `<div class="widget" style="background:var(--fill)"><div class="note">Este partido no tiene mercado en Polymarket (todavía). Cuando lo abran, aquí verás quiénes apuestan, de qué lado y con qué win rate.</div></div>`;
  const r = S.smart.events.get(key(a.ev));
  const loading = '<div class="shimmer"></div><div class="shimmer"></div><div class="note">Buscando a los mayores apostadores y calculando su win rate…</div>';
  if (!r || (!Object.keys(r.sides).length && r.busy)) return `<div id="eventsmart-box">${loading}</div>`;
  if (r.error && !Object.keys(r.sides).length) return `<div class="warn">${esc(r.error)}</div><button class="btn small mt" data-eventsmart="${key(a.ev)}">↻ Reintentar</button>`;
  const verdict = r.best
    ? `<div class="widget sharp-box"><b>🧠 Los apostadores con mejor historial están cargados en ${esc(sideName(a, r.best))}</b><div class="note">${r.sides[r.best].sharpN} sharp con ${money0(r.sides[r.best].sharpValue)} en ese lado (precio ${pct(r.sides[r.best].price)}).</div></div>`
    : '<div class="widget" style="background:var(--fill)"><b>Sin consenso claro</b><div class="note">Los sharps están repartidos o no hay suficientes entre los grandes. Sin señal fuerte de dinero inteligente.</div></div>';
  const holderRow = (h) => {
    const s = h.stats, sharp = SM.isSharp(s);
    return `<tr class="${sharp ? 'sharp-row' : ''}"><td>${h.image ? `<img class="avatar" src="${esc(h.image)}" alt="" onerror="this.remove()">` : ''}<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.name)} ↗</a>
      ${h.rank ? `<span class="tag value">#${h.rank} ranking</span>` : ''}${sharp ? '<span class="tag sharp-tag">🧠 sharp</span>' : ''}</td>
      <td class="num">${money0(h.value)}<div class="note">cobra ${money0(h.amount)}</div></td>
      <td class="num ${s && s.winRate >= 0.55 ? 'up' : s && s.winRate < 0.45 ? 'down' : ''}">${s ? (s.winRate != null ? pct(s.winRate) : '—') + `<div class="note">${s.wins} de ${s.n}</div>` : '<span class="note">—</span>'}</td>
      <td class="num ${s && s.realized > 0 ? 'up' : s && s.realized < 0 ? 'down' : ''}">${s ? (s.realized >= 0 ? '+' : '') + money0(s.realized) : '—'}</td></tr>`;
  };
  const sides = Object.entries(r.sides).map(([side, s]) => `<div class="widget mt" style="background:var(--fill)">
    <h3>${esc(sideName(a, side))} <span class="note">· precio ${pct(s.price)} · ${money0(s.all)} de los ${s.holders.length} mayores</span></h3>
    ${s.holders.length ? `<table class="rtable"><thead><tr><th>Apostador</th><th class="num">Posición</th><th class="num">Win rate</th><th class="num">Ganancia</th></tr></thead><tbody>${s.holders.slice(0, r.perSide).map(holderRow).join('')}</tbody></table>
    ${s.holders.length > r.perSide ? `<div class="note">+${s.holders.length - r.perSide} apostadores más pequeños</div>` : ''}` : '<div class="note">Nadie con posición todavía.</div>'}</div>`).join('');
  return `<div id="eventsmart-box">${verdict}${sides}
    <div class="flex mt">${r.perSide < 10 ? `<button class="btn small" data-eventsmart="${key(a.ev)}" data-more="1">Analizar a más apostadores</button>` : ''}<button class="btn small" data-eventsmart="${key(a.ev)}">${r.busy ? 'Actualizando…' : '↻ Actualizar'}</button>
    <a class="btn small" href="${esc(src.url)}" target="_blank" rel="noopener">Abrir en Polymarket ↗</a></div>
    <div class="note mt">Win rate y ganancia de los últimos ~90 días (ganadas y perdidas, datos públicos). Posición = lo que vale hoy; "cobra" = lo que recibe si gana. Es una señal, no una garantía: los sharps también pierden y a veces cubren otras apuestas. Polymarket es solo referencia; tus apuestas son en casas de México.</div></div>`;
}

async function showEventSmart(a, opts) {
  const k = key(a.ev);
  const p = loadEventSmart(a, opts);
  if (S.open === k && S.sheetTab === 'smart') renderSheet(); // muestra "actualizando…"
  await p;
  if (S.open === k && (S.sheetTab === 'smart' || S.sheetTab === 'analysis')) renderSheet();
}

function viewSmart() {
  const sm = S.smart, st = B.getState().smart;
  const follows = new Set(st.follows.map((f) => f.wallet));
  const seg = `<div class="flex tabs-inline"><div class="segmented">${[['WEEK', 'Semana'], ['MONTH', 'Mes'], ['ALL', 'Histórico']].map(([k, l]) => `<button data-smartperiod="${k}" class="${sm.period === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <button class="btn small" data-smartscan>${sm.busy ? 'Actualizando…' : '↻ Actualizar'}</button><span class="note">${sm.lastScan ? 'Última: ' + new Date(sm.lastScan).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>`;
  const intro = `<div class="widget glass note">Los mejores apostadores de <b>deportes</b> en Polymarket, con datos públicos. El <b>win rate</b> sale de sus últimas posiciones cerradas y el <b>ROI</b> es ganancia ÷ dinero movido. Un ROI muy bajo con mucho volumen suele ser un creador de mercado, no alguien con buen ojo. Sigue a los que tengan buen win rate <i>y</i> buen ROI: el bot rastrea sus entradas y te avisa.</div>`;
  if (!sm.board) return intro + seg + `<div class="widget glass">${sm.error ? `<div class="warn">${esc(sm.error)}</div>` : '<div class="shimmer"></div><div class="shimmer"></div><div class="shimmer"></div><div class="note">Calculando win rates (puede tardar 20–40 s la primera vez)…</div>'}</div>`;
  const rows = sm.board.map((t) => {
    const s = t.stats, score = SM.traderScore(t);
    return `<tr><td><b>#${t.rank}</b> <a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)} ↗</a>${t.x ? `<div class="note">@${esc(t.x)}</div>` : ''}</td>
      <td class="num up">${money0(t.pnl)}</td><td class="num">${money0(t.vol)}</td><td class="num ${t.roi > 0.02 ? 'up' : ''}">${pct(t.roi, 1)}</td>
      <td class="num">${s ? `${pct(s.winRate)}<div class="note">${s.wins} de ${s.n} · ${s.days} d</div>` : '…'}</td>
      <td class="num">${score != null ? `<span class="tag ${score > 0.62 ? 'value' : ''}">${(score * 100).toFixed(0)}</span>` : '<span class="note">—</span>'}</td>
      <td><button class="btn small ${follows.has(t.wallet) ? 'primary' : ''}" data-smartfollow="${t.wallet}" data-name="${esc(t.name)}">${follows.has(t.wallet) ? '✓ Siguiendo' : 'Seguir'}</button></td></tr>`;
  }).join('');
  // Apuestas abiertas actuales de los que sigues (deportes), agrupadas por mercado.
  const open = [];
  for (const f of st.follows) for (const p of sm.positions.get(f.wallet) || []) open.push({ f, p });
  open.sort((x, y) => y.p.value - x.p.value);
  const slugToKey = new Map();
  for (const a of allAnalyses()) for (const src of a.ev.pm?.sources || []) { const m = String(src.url || '').match(/event\/([^/?#]+)/); if (m) slugToKey.set(m[1], key(a.ev)); }
  const openHtml = open.slice(0, 40).map(({ f, p }) => {
    const k = slugToKey.get(p.eventSlug);
    return `<div class="row" ${k ? `data-open="${k}" style="cursor:pointer"` : ''}><div class="grow"><b>${esc(p.outcome)}</b> <span class="note">· ${esc(p.title)}</span>
      <div class="meta">🐋 ${esc(f.name)} · entró a ${pct(p.avgPrice)} · ahora ${pct(p.curPrice)} · ${money0(p.value)} · <span class="${p.pnl >= 0 ? 'up' : 'down'}">${p.pnl >= 0 ? '+' : ''}${money0(p.pnl)}</span>${k ? ' · <b>está en tu cartelera →</b>' : ''}</div></div></div>`;
  }).join('');
  const trail = st.trail.filter((x) => !x.initial).slice(0, 40).map((x) => `<div class="it"><div class="c">${new Date(x.t).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div><div>🐋 <b>${esc(x.name)}</b> entró: <b>${esc(x.outcome)}</b> en "${esc(x.title)}" a ${pct(x.price)} (${money0(x.value)})</div></div>`).join('');
  return intro + seg + `<div class="widget glass"><h3>Ranking de deportes · ${{ WEEK: 'última semana', MONTH: 'último mes', ALL: 'histórico' }[sm.period]}</h3>
    <div class="table-wrap"><table class="t"><thead><tr><th>Apostador</th><th class="num">Ganancia</th><th class="num">Volumen</th><th class="num">ROI</th><th class="num">Win rate</th><th class="num">Puntaje</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="note mt">Win rate = apuestas ganadas ÷ todas las que se resolvieron en la ventana indicada (incluye las perdidas, que Polymarket no marca como cerradas). Puntaje = 70% win rate + ROI (solo con 20+ apuestas resueltas). Sigues a ${st.follows.length}${st.autoFollow !== false ? ' (elegidos automáticamente por puntaje; si tocas Seguir, manda tu lista)' : ' (tu lista)'}. ${st.autoFollow === false ? '<button class="btn small" data-smartauto>Volver a selección automática</button>' : ''}</div></div>
    <div class="section-title">Sus apuestas abiertas ahora <small>${open.length} posiciones de deportes de los que sigues</small></div>
    ${openHtml ? `<div class="list glass">${openHtml}</div>` : '<div class="widget glass empty">Los que sigues no tienen posiciones abiertas en deportes ahora.</div>'}
    <div class="section-title">Rastro de entradas <small>Cada vez que uno de ellos entra a un mercado nuevo</small></div>
    ${trail ? `<div class="widget glass"><div class="feed">${trail}</div></div>` : '<div class="widget glass empty">Todavía no hay entradas nuevas desde que empezaste a seguirlos. El bot revisa cada 5 minutos.</div>'}`;
}

// ---------- Oro ----------
function oppCard(g, a) {
  const ev = a.ev;
  const isUnder = g.type === 'underdog';
  const nums = isUnder
    ? `<div>Momio ref.<b>${dec(g.sel.odds)}</b></div><div>Prob. estimada<b>${pct(g.sel.p)}</b></div><div>EV<b class="up">${pct(g.sel.ev, 1)}</b></div><div>Mínimo MX<b>${dec(g.sel.minOdds)}</b></div>`
    : `<div>Prob. de ganar<b>${pct(g.liveP)}</b></div>${g.dc ? `<div>No perder<b>${pct(g.dc)}</b></div>` : ''}<div>Momio mínimo<b>${dec(g.minOdds)}</b></div>${g.minOddsDC ? `<div>Mín. doble op.<b>${dec(g.minOddsDC)}</b></div>` : ''}`;
  return `<div class="opp glass" data-open="${key(ev)}">
    <div class="opp-type" style="color:var(--gold)">★ ${isUnder ? 'Underdog con valor' : 'Remontada en vivo'} <span class="spacer"></span><span class="note" style="text-transform:none">${D.leagueById(ev.leagueId).name}</span></div>
    <div class="opp-title">${esc(isUnder ? g.sel.label : ev[g.pick].name)}</div>
    <div class="note">${esc(ev.name)} · ${ev.state === 'in' ? `${ev.home.score ?? 0}-${ev.away.score ?? 0} · ${esc(ev.detail)}` : new Date(ev.date).toLocaleString('es-MX', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div>
    <div class="opp-why">${esc(g.why)}</div>
    <div class="opp-nums">${nums}</div>
    <div class="flex"><button class="btn gold small" data-slip="${key(ev)}|${isUnder ? g.sel.pick : g.pick}">+ Agregar al boleto</button>
      <button class="btn small" data-open="${key(ev)}" data-goto="ai">Analizar con IA</button></div>
  </div>`;
}

function viewGold() {
  const all = allAnalyses().flatMap((a) => a.golden.map((g) => ({ g, a })));
  const comebacks = all.filter((x) => x.g.type === 'comeback').sort((x, y) => y.g.score - x.g.score);
  const dogs = all.filter((x) => x.g.type === 'underdog').sort((x, y) => y.g.score - x.g.score);
  return `<div class="widget glass note">Una Oportunidad de Oro no es "el que paga más". Es una situación donde el bot calcula que la probabilidad real de un resultado poco probable es <b>mayor</b> que la que paga el momio. Las remontadas en vivo muestran el <b>momio mínimo</b> que debes encontrar en tu casa mexicana; si tu app paga menos, no hay valor.</div>
  <div class="section-title">Remontadas en vivo <small>${comebacks.length}</small></div>
  ${comebacks.length ? `<div class="grid opps">${comebacks.map(({ g, a }) => oppCard(g, a)).join('')}</div>` : '<div class="widget glass empty">Ningún favorito va perdiendo con opciones reales en este momento.</div>'}
  <div class="section-title">Underdogs con valor <small>${dogs.length}</small></div>
  ${dogs.length ? `<div class="grid opps">${dogs.map(({ g, a }) => oppCard(g, a)).join('')}</div>` : '<div class="widget glass empty">Ningún underdog tiene valor positivo con los momios actuales.</div>'}`;
}

// ---------- Banca ----------
// Estado visual de cada apuesta: el contorno de la tarjeta cambia de color para distinguirla de un vistazo.
const BET_STATE = {
  open: { cls: 'bc-open', icon: '⏳', text: 'Abierta' },
  live: { cls: 'bc-live', icon: '●', text: 'En vivo' },
  ended: { cls: 'bc-ended', icon: '🏁', text: 'Terminado · liquidando' },
  cash: { cls: 'bc-cashnow', icon: '💸', text: 'Conviene cobrar' },
  won: { cls: 'bc-won', icon: '✅', text: 'Ganada' },
  lost: { cls: 'bc-lost', icon: '❌', text: 'Perdida' },
  cashout: { cls: 'bc-cashed', icon: '💰', text: 'Cobrada antes' },
  void: { cls: 'bc-void', icon: '↩️', text: 'Anulada' },
};

// ¿Conviene cobrar anticipadamente? Solo en vivo, cuando va ganando y aún no es casi segura.
const cashOutSuggested = (c) => !!c && c.live && c.profit > 0 && c.p < 0.85;

function betStateKey(b, c) {
  if (b.status !== 'pending') return b.status;
  if (cashOutSuggested(c)) return 'cash';
  // El partido ya terminó: se liquida solo en la siguiente actualización (o se anula si no hay resultado oficial en 3 días).
  const ev = allEvents().find((e) => e.id === b.eventId);
  if (ev && ev.state === 'post') return 'ended';
  return c?.live ? 'live' : 'open';
}

function betCard(b, { compact = false } = {}) {
  const c = b.status === 'pending' ? cashOutInfo(b) : null;
  const k = betStateKey(b, c);
  const s = BET_STATE[k];
  const bk = K.bookById(b.book);
  const lg = D.leagueById(b.leagueId);
  const result = b.status === 'won' ? `<b class="up">+${money(b.payout - b.stake)}</b>`
    : b.status === 'lost' ? `<b class="down">−${money(b.stake)}</b>`
    : b.status === 'cashout' ? `<b class="${b.payout >= b.stake ? 'up' : 'down'}">${signed(b.payout - b.stake)}</b>`
    : b.status === 'void' ? '<b>$0.00</b>' : `<b>${money(b.stake * b.odds)}</b>`;
  const resultLabel = b.status === 'pending' ? 'Cobro si gana' : b.status === 'void' ? 'Devuelto' : 'Resultado';
  const live = c?.live ? `<span class="down"> · ${esc(c.a.ev.detail || 'en vivo')} · ${c.a.ev.home.score ?? 0}-${c.a.ev.away.score ?? 0}</span>` : '';
  const cashBlock = c && !compact ? `<div class="bet-cash ${cashOutSuggested(c) ? 'hot' : ''}">
      <div class="opp-nums"><div>Prob. actual<b>${pct(c.p)}</b></div><div>Valor justo hoy<b>${money(c.fair)}</b></div><div>Mínimo aceptable<b>${money(c.fair * 0.95)}</b></div></div>
      <div class="note">${cashOutSuggested(c) ? '💸 Va ganando: si tu casa te ofrece el mínimo aceptable o más, cobrar asegura la ganancia.' : c.live && c.p < 0.25 ? 'Va perdiendo: si te ofrecen algo cercano al valor justo, recuperar parte puede tener sentido.' : c.p >= 0.85 ? 'Muy probable que gane: mantenerla suele valer más que cobrar.' : 'Sin cambios importantes: normalmente conviene mantenerla.'}${bk ? ` · ${esc(bk.name)} ${bk.cashout === true ? 'ofrece cash out' : '(cash out por verificar)'}` : ''}</div></div>` : '';
  return `<div class="bet-card glass ${s.cls}">
    <div class="bet-top"><span class="bet-state">${s.icon} ${s.text}</span><span class="note">${esc(SOURCE_LABEL[b.source] || b.source)} · ${esc(lg?.short || '')} · ${new Date(b.placedAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</span></div>
    <div class="bet-title">${esc(b.label)} <span class="note">· ${esc(b.market)}</span></div>
    <div class="note">${esc(b.home)} vs ${esc(b.away)}${b.finalScore ? ` · final ${esc(b.finalScore)}` : ''}${live}</div>
    <div class="bet-nums"><div><span>Monto</span><b>${money(b.stake)}</b></div><div><span>Momio</span><b>${dec(b.odds)}</b></div><div><span>${resultLabel}</span>${result}</div></div>
    ${cashBlock}
    ${b.status === 'pending' && !compact ? `<div class="bet-actions">${bk ? `<span class="tag" style="background:${bk.color};color:#fff">${esc(bk.name)}</span>` : ''}${b.placedReal ? '<span class="tag value">Colocada</span>' : ''}<span class="spacer"></span>
      ${c ? `<button class="btn small ${cashOutSuggested(c) ? 'gold' : ''}" data-cashout="${b.id}" data-amount="${(c.fair * 0.95).toFixed(2)}">Cobrar ${money(c.fair * 0.95)}</button>` : ''}
      <button class="btn small" data-mx="${b.id}">Momio real</button><button class="btn small danger" data-cancel="${b.id}">Anular</button></div>` : ''}
  </div>`;
}

// Compatibilidad: donde antes había tabla de apuestas ahora hay tarjetas.
function betsTable(bets, compact = false) {
  return `<div class="bet-grid">${bets.map((b) => betCard(b, { compact })).join('')}</div>`;
}

// ¿Quién hizo la apuesta? El bot (piloto automático) o tú (manual), con o sin IA.
const isBotBet = (b) => b.source === 'modelo' || b.source === 'IA' || b.source === 'práctica';
const SOURCE_LABEL = { modelo: '🤖 Bot', IA: '🤖 Bot + IA', 'práctica': '🎓 Práctica', manual: '👤 Tú', 'IA (manual)': '👤 Tú + IA' };

function myBetsSection() {
  const st = B.getState();
  const bySource = st.bets.filter((b) => (S.betSource === 'bot' ? isBotBet(b) : S.betSource === 'manual' ? !isBotBet(b) : true));
  const pend = bySource.filter((b) => b.status === 'pending');
  const groups = {
    pending: pend,
    cash: pend.filter((b) => cashOutSuggested(cashOutInfo(b))),
    won: bySource.filter((b) => b.status === 'won'),
    lost: bySource.filter((b) => b.status === 'lost'),
    cashout: bySource.filter((b) => b.status === 'cashout'),
    all: bySource,
  };
  const tab = groups[S.bankTab] ? S.bankTab : 'pending';
  const list = groups[tab];
  const staked = list.reduce((a, b) => a + b.stake, 0);
  const net = list.reduce((a, b) => a + (b.status === 'won' || b.status === 'cashout' ? b.payout - b.stake : b.status === 'lost' ? -b.stake : 0), 0);
  const summary = {
    pending: `${list.length} abiertas · ${money(staked)} apostados · si todas ganan cobras ${money(list.reduce((a, b) => a + b.stake * b.odds, 0))}`,
    cash: `${list.length} apuestas van ganando en vivo: revisa si tu casa ofrece cobrarlas por el mínimo aceptable o más`,
    won: `${list.length} ganadas · ganancia <b class="up">+${money(net)}</b>`,
    lost: `${list.length} perdidas · <b class="down">−${money(-net)}</b>`,
    cashout: `${list.length} cobradas antes de terminar · resultado <b class="${net >= 0 ? 'up' : 'down'}">${signed(net)}</b>`,
    all: `${list.length} apuestas · resultado neto <b class="${net >= 0 ? 'up' : 'down'}">${signed(net)}</b>`,
  }[tab];
  const tabs = [['pending', '⏳ Abiertas'], ['cash', '💸 Para cobrar'], ['won', '✅ Ganadas'], ['lost', '❌ Perdidas'], ['cashout', '💰 Cobradas'], ['all', 'Todas']];
  const sources = [['all', 'Todas'], ['bot', '🤖 Del bot'], ['manual', '👤 Mías']];
  // Abiertas: primero las que conviene cobrar y las en vivo; cerradas: las más recientes primero.
  const rank = (b) => ({ cash: 0, live: 1, open: 2 }[betStateKey(b, b.status === 'pending' ? cashOutInfo(b) : null)] ?? 3);
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || (b.settledAt || b.placedAt) - (a.settledAt || a.placedAt));
  const empty = { pending: 'No hay apuestas abiertas ahora.', cash: 'Ninguna apuesta va ganando en vivo en este momento.', won: 'Todavía no hay apuestas ganadas.', lost: 'Todavía no hay apuestas perdidas.', cashout: 'No has cobrado ninguna apuesta antes de tiempo.', all: 'Todavía no hay apuestas.' }[tab];
  return `<div class="section-title">Mis apuestas <small>Con dinero ficticio</small></div>
  <div class="segmented seg-full tabs-inline">${tabs.map(([k, l]) => `<button data-banktab="${k}" class="${tab === k ? 'active' : ''}">${l} <span class="seg-n">${groups[k].length}</span></button>`).join('')}</div>
  <div class="flex" style="margin:-6px 0 12px"><div class="segmented">${sources.map(([k, l]) => `<button data-betsource="${k}" class="${S.betSource === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
  <div class="bet-legend">${['open', 'live', 'cash', 'won', 'lost', 'cashout', 'void'].map((k) => `<span class="lg ${BET_STATE[k].cls}">${BET_STATE[k].text}</span>`).join('')}</div>
  <div class="note" style="margin:8px 4px 10px">${summary}</div>
  ${sorted.length ? betsTable(sorted) : `<div class="widget glass empty">${empty}${S.betSource === 'bot' ? '<br>Activa el piloto automático en Inicio para que el bot opere solo.' : ''}</div>`}`;
}

function viewBank() {
  const st = B.getState(), m = B.metrics(), L = B.learningStats();
  const sports = Object.entries(m.bySport);
  return `${kpis()}
  ${myBetsSection()}
  <div class="grid two mt">
    <div class="widget glass"><h3>Evolución de la banca</h3><div class="chart" id="equity"></div></div>
    <div class="widget glass"><h3>Por deporte</h3>${sports.length ? `<table class="t"><thead><tr><th>Deporte</th><th class="num">Apuestas</th><th class="num">Ganancia</th><th class="num">ROI</th></tr></thead><tbody>
      ${sports.map(([s, v]) => `<tr><td>${D.SPORT_ICON[s]} ${D.SPORT_NAME[s]}</td><td class="num">${v.n}</td><td class="num ${v.profit >= 0 ? 'up' : 'down'}">${signed(v.profit)}</td><td class="num">${pct(v.profit / v.staked, 1)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Aún no hay apuestas liquidadas</div>'}</div>
  </div>
  ${shadowSection()}
  ${learningReport()}
  <div class="section-title">Precisión del modelo <small>Frente al mercado (Brier: menor es mejor)</small></div>
  <div class="widget glass"><table class="t"><thead><tr><th>Deporte</th><th class="num">Partidos evaluados</th><th class="num">Acierto del favorito</th><th class="num">Brier modelo</th><th class="num">Brier mercado</th><th class="num">Peso del modelo</th></tr></thead><tbody>
    ${Object.keys(st.weights).map((s) => { const x = L[s]; return `<tr><td>${D.SPORT_ICON[s]} ${D.SPORT_NAME[s]}</td><td class="num">${x?.n || 0}</td><td class="num">${pct(x?.hitRate)}</td><td class="num">${x ? x.bm.toFixed(3) : '—'}</td><td class="num">${x?.bk != null ? x.bk.toFixed(3) : '—'}</td><td class="num"><b>${pct(st.weights[s])}</b></td></tr>`; }).join('')}
  </tbody></table><div class="note mt">El bot guarda su predicción de cada partido antes de que empiece. Con 15 partidos terminados o más en un deporte, ajusta cuánto confía en su modelo frente al mercado. Así aprende sin arriesgar dinero.</div></div>
  ${knowledgeSection()}
  ${modelSection()}
  <div class="section-title">Actividad</div><div class="widget glass">${logList(40)}</div>`;
}

// ---------- Modelo entrenado con temporadas pasadas (fase 3) ----------
async function loadModelos(force = false) {
  if (S.modelosLoading || (!force && S.modelos && Date.now() - S.modelos.t < 60_000)) return;
  S.modelosLoading = true;
  try { S.modelos = { t: Date.now(), ...(await (await fetch('/api/modelos/estado', { cache: 'no-store' })).json()) }; } catch { S.modelos = { t: Date.now(), error: 'sin servidor de Python' }; }
  try { S.lvClv = await (await fetch('/api/precios/clv', { cache: 'no-store' })).json(); } catch { S.lvClv = null; }
  S.modelosLoading = false;
  if (S.tab === 'bank') render();
}
function modelSection() {
  if (S.cfg?.engine !== 'python') return '';
  loadModelos();
  const m = S.modelos;
  const head = '<div class="section-title">Modelo entrenado con temporadas pasadas <small>Fútbol · Dixon-Coles · backtesting sin trampa</small></div>';
  if (!m) return head + '<div class="widget glass"><div class="shimmer"></div><div class="shimmer"></div></div>';
  const info = m.info || {}, g = info._global, ligas = Object.entries(info).filter(([k]) => !k.startsWith('_'));
  const n3 = (x) => (x == null ? '—' : x.toFixed(3));
  // Tu CLV real: ¿tus apuestas consiguieron mejor momio que el de cierre? (de la base de datos de apuestas)
  const led = (S.ledger || []).filter((x) => x.closingOdds && x.odds && x.status !== 'void');
  const clv = led.length ? led.reduce((a, x) => a + (x.odds / x.closingOdds - 1), 0) / led.length : null;
  const beat = led.length ? led.filter((x) => x.odds > x.closingOdds).length / led.length : null;
  const rows = ligas.map(([id, x]) => {
    const t = x.test, r = t?.raw, c = t?.cal;
    return `<tr><td>${esc(x.name || id)}</td><td class="num">${x.matches}</td><td class="num">${x.trained ? `${esc(x.from || '')} → ${esc(x.to || '')}` : '<span class="note">faltan partidos</span>'}</td>
      <td class="num">${r ? r.n : '—'}</td><td class="num">${r ? n3(r.logLoss) : '—'}</td><td class="num">${r ? pct(r.accuracy) : '—'}</td>
      <td class="num">${r?.marketBrier != null ? `${n3(r.brier)} vs ${n3(r.marketBrier)}` : '<span class="note">sin momios</span>'}</td>
      <td class="num">${r?.bets ? `${r.bets} · ${pct(r.roi, 1)}` : '—'}</td><td class="num">${r?.clv != null ? pct(r.clv, 1) : '—'}</td>
      <td class="num">${x.blend ? `<b>${pct(x.blend.w)}</b><div class="note">vs ${esc(x.blend.ref)}</div>` : '<span class="note">sin momios</span>'}</td></tr>`;
  }).join('');
  const rel = g?.relRaw?.length > 1 ? lineChart('py-calib', {
    series: [
      { name: 'Modelo (lo que pasó)', color: 'var(--acc-soccer, var(--green))', pts: g.relRaw.map((b) => ({ x: b.p, y: b.freq })) },
      { name: 'Calibración perfecta', color: 'var(--text-3)', dash: true, pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    ], xFmt: (x) => `Dijo ${Math.round(x * 100)}%`, height: 190,
  }) : '';
  const t = g?.test;
  const verdict = !t ? 'Todavía no hay suficientes partidos para el backtesting.'
    : `Probado en <b>${t.raw.n}</b> partidos que el modelo no vio (desde ${esc(t.from)}): acierta al favorito el <b>${pct(t.raw.accuracy)}</b> con error (log loss) de <b>${n3(t.raw.logLoss)}</b>; adivinar al azar daría 1.099. `
      + (t.raw.marketBrier != null ? (t.raw.brier < t.raw.marketBrier ? 'Fue <b>más preciso que el momio de cierre</b> en esos partidos.' : 'El <b>momio de cierre fue más preciso</b>: por eso el bot mezcla su modelo con el mercado.') : 'Para compararlo contra el momio de cierre y medir CLV, sube los archivos de football-data (abajo).')
      + (info._calUsed ? ' La calibración isotónica mejoró el error y se está usando.' : ' Ya sale bien calibrado: la calibración isotónica no lo mejoró, así que no se usa.')
      + (() => { const zero = ligas.filter(([, x]) => x.blend && x.blend.w === 0).map(([, x]) => x.name); const some = ligas.filter(([, x]) => x.blend && x.blend.w > 0).map(([, x]) => `${x.name} ${pct(x.blend.w)}`);
          return (zero.length ? `<br><br><b>Lo que aprendió del backtesting:</b> en ${esc(zero.join(', '))} el momio ya incluye todo lo que el modelo sabe por resultados: darle peso empeora la precisión y produce apuestas con CLV negativo. Ahí el bot se guía por el mercado y solo apuesta si una casa paga más que el precio justo.` : '')
            + (some.length ? ` Peso que sí le conviene al modelo: ${esc(some.join(', '))}.` : ''); })();
  const links = (m.links || []).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.split('/').slice(-2).join('/'))}</a>`).join(' · ');
  const data = Object.values(m.data || {}).reduce((a, x) => a + x.matches, 0);
  return `${head}
  <div class="grid two">
    <div class="widget glass"><h3>Qué tan bueno es</h3><p>${verdict}</p>${rel}
      <div class="kv mt"><span>Partidos en la base histórica</span><b>${data.toLocaleString('es-MX')}</b></div>
      <div class="kv"><span>Último entrenamiento</span><b>${m.busy ? 'entrenando…' : m.ageHours != null ? `hace ${m.ageHours < 1 ? Math.round(m.ageHours * 60) + ' min' : Math.round(m.ageHours) + ' h'}` : '—'}</b></div>
      <div class="kv"><span>Tu CLV real (${led.length} apuestas con cierre)</span><b class="${clv > 0 ? 'up' : clv < 0 ? 'down' : ''}">${clv != null ? pct(clv, 1) + ` · le ganas al cierre ${pct(beat)}` : '—'}</b></div>
      ${(() => { const c = S.lvClv; if (!c) return ''; const f = (x) => (x?.n ? `${pct(x.clv, 1)} · gana al cierre ${pct(x.beat)} (${x.n})` : 'sin apuestas medidas aún');
        return `<div class="kv"><span>CLV vs cierre de Pinnacle · precio justo</span><b class="${c.precioJusto?.clv > 0 ? 'up' : c.precioJusto?.clv < 0 ? 'down' : ''}">${f(c.precioJusto)}</b></div>
          <div class="kv"><span>CLV vs cierre de Pinnacle · otras apuestas</span><b class="${c.otras?.clv > 0 ? 'up' : c.otras?.clv < 0 ? 'down' : ''}">${f(c.otras)}</b></div>`; })()}
      ${m.error ? `<div class="warn mt">${esc(m.error)}</div>` : ''}
      ${S.cfg.local ? `<div class="flex mt"><button class="btn small" data-pytrain ${m.busy ? 'disabled' : ''}>${m.busy ? 'Entrenando…' : '↻ Re-entrenar ahora'}</button></div>` : ''}
      <div class="note mt">Se re-entrena solo cada 24 h con los partidos nuevos que ve el bot. El CLV positivo (conseguir mejor momio que el de cierre) es la mejor señal de que el bot encuentra valor de verdad, aunque una racha de resultados diga otra cosa.</div></div>
    <div class="widget glass"><h3>Momios históricos (para medir CLV)</h3>
      <p class="note">football-data.co.uk tiene los momios de apertura y cierre de cada partido, pero <b>no permite descargas de agentes de IA</b>, así que el bot no los baja solo. Descárgalos tú (clic en cada enlace) y súbelos aquí: el modelo se re-entrena y podrás ver su ROI y CLV histórico contra el cierre.</p>
      <div class="src-dl">${links}</div>
      ${S.cfg.local ? '<label class="btn small mt" style="display:inline-block">📤 Subir archivos CSV<input type="file" id="py-upload" accept=".csv,text/csv" multiple hidden></label><div class="note" id="py-upload-msg"></div>' : '<div class="note mt">Súbelos desde la PC.</div>'}
      <div class="note mt">Partidos con momio de cierre: ${Object.values(m.data || {}).reduce((a, x) => a + (x.withClose || 0), 0).toLocaleString('es-MX')} · con apertura: ${Object.values(m.data || {}).reduce((a, x) => a + (x.withOpen || 0), 0).toLocaleString('es-MX')}</div></div>
  </div>
  <div class="widget glass mt"><h3>Backtesting por liga (partidos que el modelo no vio)</h3><div class="table-wrap"><table class="t"><thead><tr><th>Liga</th><th class="num">Partidos</th><th class="num">Datos</th><th class="num">Probados</th><th class="num">Log loss</th><th class="num">Acierto</th><th class="num">Brier modelo vs cierre</th><th class="num">Apuestas · ROI</th><th class="num">CLV</th><th class="num">Peso del modelo</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="note mt">Log loss y Brier: menor es mejor. "Apuestas" simula apostar cuando el modelo ve valor (EV ≥ 3%) al momio disponible; solo aparece con momios históricos.</div></div>
  ${ratingsTable(m.ratings)}`;
}

// NFL, MLB, LMB, NBA y tenis: modelo Elo entrenado con temporadas pasadas (o con lo que ve el bot).
function ratingsTable(rt) {
  if (!rt?.info) return '';
  const n3 = (x) => (x == null ? '—' : x.toFixed(3));
  const src = { nfl: 'nflverse (abiertos)', mlb: 'API oficial de MLB', lmb: 'API oficial de MLB', nba: 'partidos que ve el bot', atp: 'partidos que ve el bot', wta: 'partidos que ve el bot' };
  const rows = Object.entries(rt.info).filter(([k]) => !k.startsWith('_')).map(([id, x]) => {
    const r = x.test?.raw;
    return `<tr><td>${esc(x.name || id)}<div class="note">${esc(src[id] || '')}</div></td><td class="num">${x.matches}</td>
      <td class="num">${x.trained ? `${esc(x.from)} → ${esc(x.to)}` : `<span class="note">junta ${x.need} partidos (lleva ${x.matches})</span>`}</td>
      <td class="num">${r ? r.n : '—'}</td><td class="num">${r ? pct(r.accuracy) : '—'}</td><td class="num">${r ? n3(r.logLoss) : '—'}</td>
      <td class="num">${r?.marketBrier != null ? `${n3(r.brier)} vs ${n3(r.marketBrier)}` : '<span class="note">sin momios</span>'}</td>
      <td class="num">${r?.bets ? `${r.bets} · ${pct(r.roi, 1)}` : '—'}</td>
      <td class="num">${x.blend ? `<b>${pct(x.blend.w)}</b>` : '<span class="note">normal</span>'}</td></tr>`;
  }).join('');
  return `<div class="widget glass mt"><h3>Otros deportes · Elo con temporadas pasadas</h3><div class="table-wrap"><table class="t"><thead><tr><th>Liga</th><th class="num">Partidos</th><th class="num">Datos</th><th class="num">Probados</th><th class="num">Acierto</th><th class="num">Log loss</th><th class="num">Brier modelo vs cierre</th><th class="num">Apuestas · ROI</th><th class="num">Peso del modelo</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="note mt">Elo: cada equipo o jugador sube al ganar y baja al perder, con ventaja de local. Los ajustes se eligen con el 60% más viejo y se prueba en el 40% reciente. Adivinar al azar da log loss 0.693. Si el peso del modelo es 0%, el momio ya sabe todo lo que el Elo sabe y ahí el bot se guía por el mercado. La NBA y el tenis aprenden con los partidos que ve el bot (sus sitios no permiten descargar historia).</div></div>`;
}

// Conocimiento acumulado: calibración de probabilidades y base de datos de apuestas liquidadas.
function knowledgeSection() {
  const cal = B.calibration();
  if (!S.ledger && !S.ledgerLoading) {
    S.ledgerLoading = true;
    fetch('/api/ledger', { cache: 'no-store' }).then((r) => r.json()).then((x) => { S.ledger = x; }).catch(() => { S.ledger = []; }).finally(() => { S.ledgerLoading = false; if (S.tab === 'bank') render(); });
  }
  const led = S.ledger || [];
  const done = led.filter((x) => x.status === 'won' || x.status === 'lost' || x.status === 'cashout');
  const prof = done.reduce((s, x) => s + (x.profit ?? ((x.payout || 0) - x.stake)), 0);
  // Por rango de momio: dónde gana y dónde pierde el bot (con todas las apuestas guardadas).
  const buckets = {};
  for (const x of done) { const b = (buckets[B.oddsBucket(x.odds)] ||= { n: 0, w: 0, p: 0, staked: 0 }); b.n++; if (x.status === 'won') b.w++; b.p += x.profit ?? ((x.payout || 0) - x.stake); b.staked += x.stake; }
  const pts = cal.bins.filter((b) => b.n >= 3);
  const chart = pts.length >= 2 ? lineChart('calib', {
    series: [
      { name: 'Lo que pasó', color: 'var(--blue)', pts: pts.map((b) => ({ x: b.avgP, y: b.freq })) },
      { name: 'Calibración perfecta', color: 'var(--text-3)', dash: true, pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    ], xFmt: (x) => `Dijo ${Math.round(x * 100)}%`, height: 200,
  }) : '<div class="chart-empty note">Se necesitan más partidos terminados para dibujar la calibración (mínimo 3 por rango).</div>';
  return `<div class="section-title">Conocimiento del bot <small>Probabilidad, estadística y resultados reales</small></div>
  <div class="grid two">
    <div class="widget glass"><h3>Calibración · ${cal.n} probabilidades evaluadas</h3>${chart}
      <div class="kv mt"><span>Brier (menor es mejor)</span><b>${cal.brier != null ? cal.brier.toFixed(3) : '—'}</b></div>
      <div class="kv"><span>Error de calibración</span><b>${cal.ece != null ? pct(cal.ece, 1) : '—'}</b></div>
      ${(() => { const cx = B.calibration('soccer', { xg: true }), cn = B.calibration('soccer', { xg: false });
        const f = (c) => (c.n ? `${c.brier.toFixed(3)} <span class="note">(${c.n})</span>` : '<span class="note">sin datos aún</span>');
        return `<div class="kv"><span>Fútbol con xG de 365Scores · Brier</span><b>${f(cx)}</b></div><div class="kv"><span>Fútbol sin xG · Brier</span><b>${f(cn)}</b></div>
          ${cx.n >= 30 && cn.n >= 30 ? `<div class="note">${cx.brier < cn.brier ? '✅ El xG está mejorando las predicciones de fútbol.' : '⚠️ Con xG todavía no mejora: el bot seguirá midiendo.'}</div>` : '<div class="note">Con 30 o más probabilidades de cada tipo se sabrá si el xG mejora al modelo.</div>'}`; })()}
      <div class="note mt">Si la línea azul va pegada a la diagonal, cuando el bot dice "60%" de verdad pasa 6 de cada 10 veces. Por arriba: es demasiado pesimista; por abajo: demasiado optimista.</div></div>
    <div class="widget glass"><h3>Base de datos de apuestas · ${led.length} registradas</h3>
      ${done.length ? `<table class="t"><thead><tr><th>Momio</th><th class="num">Apuestas</th><th class="num">Acierto</th><th class="num">ROI</th></tr></thead><tbody>
        ${Object.entries(buckets).map(([k, b]) => `<tr><td>${esc(k)}</td><td class="num">${b.n}</td><td class="num">${pct(b.w / b.n)}</td><td class="num ${b.p >= 0 ? 'up' : 'down'}">${pct(b.p / b.staked, 1)}</td></tr>`).join('')}</tbody></table>
        <div class="kv mt"><span>Resultado total registrado</span><b class="${prof >= 0 ? 'up' : 'down'}">${signed(prof)}</b></div>` : '<div class="empty">Aún no hay apuestas liquidadas en la base de datos.</div>'}
      <div class="note mt">Cada apuesta liquidada se guarda para siempre en <span class="kbd">data/apuestas.jsonl</span> de tu PC (momio, probabilidades, mercado, sharps y resultado). La IA y el bot la usan para aprender.</div></div>
  </div>`;
}

// ---------- Reporte de aprendizaje (apuestas sombra) ----------
// Explica cómo decide el bot, qué pensó en cada apuesta sombra (su modelo vs. el mercado) y qué ha aprendido
// de los resultados. Todo se calcula con tus datos y se actualiza solo conforme se califican más apuestas.
function learningReport() {
  const st = B.getState();
  const DEF = B.DEFAULT_STATE().weights;
  const sum = (arr, f) => arr.reduce((x, y) => x + (f(y) || 0), 0);
  const P = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
  // Lo que pensó en cada apuesta: guardado en la sombra (desde v2.3) o, para las anteriores, en su predicción del partido.
  const rows = st.shadow.filter((s) => s.status === 'won' || s.status === 'lost').map((s) => {
    const pr = st.predictions[s.eventId];
    return { ...s, pM: s.pModel ?? pr?.model?.[s.pick] ?? null, pK: s.pMarket ?? pr?.market?.[s.pick] ?? null, won: s.status === 'won' };
  });
  const head = '<div class="section-title">Reporte de aprendizaje <small>Qué pensó el bot, por qué eligió y qué aprendió de los resultados</small></div>';
  const how = `<div class="widget glass"><h3>Cómo decide una apuesta</h3>
    <ol class="steps">
      <li><b>Su modelo</b> calcula una probabilidad propia: Poisson y xG en fútbol, fuerza ofensiva/defensiva en NFL/NBA/MLB, ranking en tenis y Elo por mapa en eSports. Sin datos propios usa 50% y no le da peso.</li>
      <li><b>El mercado</b> dice la suya: precios con dinero real de Polymarket y Kalshi, o el momio de las casas sin su margen.</li>
      <li><b>Mezcla las dos</b> con un peso por deporte que va ajustando (fútbol ${P(st.weights.soccer)}, NFL ${P(st.weights.football)}, tenis ${P(st.weights.tennis)}, eSports ${P(st.weights.esports)} para su modelo; el resto es mercado). Si casi coinciden, se queda con el mercado; si discrepan mucho, limita cuánto puede alejarse.</li>
      <li><b>Valor:</b> si probabilidad × momio − 1 supera el mínimo (${P(st.settings.minEV)}, y más alto entre más alto el momio), la registra como apuesta sombra: 1 unidad, sin tocar tu banca.</li>
      <li><b>Califica:</b> al terminar el partido la cuenta como ganada o perdida y actualiza segmentos, pesos y calibración.</li>
    </ol></div>`;
  if (!rows.length) return head + how + '<div class="widget glass mt empty">Todavía no hay apuestas sombra calificadas. En cuanto terminen los partidos, aquí aparece lo que aprendió.</div>';

  const n = rows.length, wins = rows.filter((r) => r.won).length, expB = sum(rows, (r) => r.p), prof = sum(rows, (r) => r.profit);
  const both = rows.filter((r) => r.pM != null && r.pK != null);
  const wB = both.filter((r) => r.won).length, eM = sum(both, (r) => r.pM), eK = sum(both, (r) => r.pK);
  const gaps = [['Poco (menos de 10 pts)', -9, 0.10], ['Medio (10 a 20 pts)', 0.10, 0.20], ['Grande (20 pts o más)', 0.20, 9]].map(([l, lo, hi]) => {
    const g = both.filter((r) => r.pM - r.pK >= lo && r.pM - r.pK < hi);
    return { l, n: g.length, w: g.filter((r) => r.won).length, eK: sum(g, (r) => r.pK), eM: sum(g, (r) => r.pM), roi: g.length ? sum(g, (r) => r.profit) / g.length : null };
  });
  const dog = rows.filter((r) => r.odds >= 2), fav = rows.filter((r) => r.odds < 2);
  const L = B.learningStats(), cal = B.calibration();

  // Conclusiones escritas a partir de los datos.
  const C = [];
  const diff = wins - expB;
  C.push(`De <b>${n}</b> apuestas sombra calificadas ganó <b>${wins}</b>; según sus probabilidades esperaba <b>${expB.toFixed(1)}</b>. ${Math.abs(diff) < Math.max(1.5, Math.sqrt(expB) * 0.8) ? 'Está dentro de lo normal: sus probabilidades se comportan como dijo.' : diff < 0 ? 'Ganó menos de lo que esperaba: fue <b>optimista</b> con sus elecciones.' : 'Ganó más de lo que esperaba: fue algo <b>pesimista</b>.'} Resultado: ${prof >= 0 ? '+' : ''}${prof.toFixed(1)} unidades (ROI ${pct(prof / n, 1)}).`);
  if (both.length >= 8) {
    const errM = Math.abs(wB - eM), errK = Math.abs(wB - eK);
    C.push(`Comparando opiniones en ${both.length} apuestas: su <b>modelo</b> solo esperaba <b>${eM.toFixed(1)}</b> victorias, el <b>mercado</b> <b>${eK.toFixed(1)}</b> y pasaron <b>${wB}</b>. ${errK <= errM ? 'El mercado acertó más que su modelo: por eso el bot le da más peso al mercado y su modelo solo "inclina" la balanza.' : 'Su modelo acertó más que el mercado en estas apuestas: buena señal, pero hace falta más muestra para confiar.'}`);
  }
  const big = gaps[2];
  if (big.n >= 3) C.push(`Con <b>desacuerdos grandes</b> (su modelo 20 puntos o más arriba del mercado) ganó ${big.w} de ${big.n} (el mercado esperaba ${big.eK.toFixed(1)}). ${big.w <= big.eK ? 'Aprendizaje: un desacuerdo tan grande casi siempre es información que su modelo no tiene (lesiones, alineaciones, cansancio o falta de datos), no una ganga.' : 'Hasta ahora esos desacuerdos le han funcionado, pero son pocos casos.'}`);
  const mid = gaps[1];
  if (mid.n >= 5 && mid.roi > 0) C.push(`Su zona más rentable fueron los <b>desacuerdos medios</b> (10 a 20 pts): ${mid.w} de ${mid.n}, ROI ${pct(mid.roi)}.`);
  if (dog.length >= 5 && fav.length >= 3) C.push(`Por momio: con <b>underdogs</b> (momio 2.00 o más) ganó ${dog.filter((r) => r.won).length} de ${dog.length} (ROI ${pct(sum(dog, (r) => r.profit) / dog.length)}); con <b>favoritos</b> ${fav.filter((r) => r.won).length} de ${fav.length} (ROI ${pct(sum(fav, (r) => r.profit) / fav.length)}). Encuentra valor sobre todo en underdogs porque ahí el mercado se equivoca más seguido, pero también es donde más varía el resultado.`);
  for (const [sp, x] of Object.entries(L)) {
    if (!x.nm || x.nm < 5 || x.bk == null) continue;
    const better = x.bk < x.bm - 0.01 ? 'el mercado fue más preciso' : x.bm < x.bk - 0.01 ? 'su modelo fue más preciso' : 'su modelo y el mercado quedaron parejos';
    const w0 = DEF[sp], w1 = st.weights[sp];
    C.push(`${D.SPORT_ICON[sp] || ''} <b>${esc(D.SPORT_NAME[sp] || sp)}</b> (${x.n} partidos): ${better} (Brier modelo ${x.bm.toFixed(3)} vs mercado ${x.bk.toFixed(3)}; menor es mejor). ${Math.abs(w1 - w0) >= 0.005 ? `Ajustó el peso de su modelo de ${P(w0)} a <b>${P(w1)}</b>.` : x.nm < 15 ? `Con 15 partidos ajustará el peso (lleva ${x.nm}).` : 'Mantiene el peso.'}`);
  }
  const off = cal.bins.filter((b) => b.n >= 10 && Math.abs(b.avgP - b.freq) >= 0.08);
  for (const b of off.slice(0, 3)) C.push(`Calibración: cuando dice cerca de <b>${P(b.avgP)}</b>, en realidad pasó <b>${P(b.freq)}</b> (${b.n} casos): ${b.freq < b.avgP ? 'ahí exagera las probabilidades' : 'ahí se queda corto'}.`);
  const segs = Object.values(B.segmentStats()).filter((o) => o.n >= 5).sort((a, b) => b.roi - a.roi);
  if (segs.length) {
    const best = segs[0], worst = segs[segs.length - 1];
    const nm = (o) => `${D.SPORT_NAME[o.sport] || o.sport} · ${o.market} · momio ${o.bucket}`;
    if (best.roi > 0) C.push(`Mejor segmento hasta ahora: <b>${esc(nm(best))}</b> (${best.wins} de ${best.n}, ROI ${pct(best.roi)}).`);
    if (worst !== best && worst.roi < 0) C.push(`Peor segmento: <b>${esc(nm(worst))}</b> (${worst.wins} de ${worst.n}, ROI ${pct(worst.roi)}). Con 30 resultados, si sigue perdiendo más de 5%, el piloto automático lo bloquea.`);
  }
  // ¿Ayuda el ajuste por bajas y descanso? Se comparan las apuestas con ajuste contra las demás.
  const withAdj = rows.filter((r) => r.adj), noAdj = rows.filter((r) => !r.adj && ['soccer', 'football', 'basketball', 'baseball'].includes(r.sport));
  if (withAdj.length >= 3) {
    const st2 = (g) => ({ n: g.length, w: g.filter((r) => r.won).length, e: sum(g, (r) => r.p), roi: g.length ? sum(g, (r) => r.profit) / g.length : null });
    const A = st2(withAdj), N = st2(noAdj);
    C.push(`Con <b>ajuste por bajas y descanso</b> (${A.n} apuestas) ganó ${A.w} y esperaba ${A.e.toFixed(1)}, ROI ${pct(A.roi)}${N.n ? `; sin ajuste (${N.n}) ganó ${N.w} y esperaba ${N.e.toFixed(1)}, ROI ${pct(N.roi)}` : ''}. ${A.n < 30 ? 'Aún son pocas para concluir.' : A.roi > (N.roi ?? -1) ? 'El ajuste está ayudando.' : 'El ajuste todavía no mejora los resultados.'}`);
  } else {
    const pend = st.shadow.filter((s) => s.status === 'pending' && s.adj).length;
    if (pend) C.push(`El ajuste por bajas y descanso ya se registra en ${pend} apuesta${pend > 1 ? 's' : ''} pendiente${pend > 1 ? 's' : ''}; cuando se califiquen, aquí verás si mejora los resultados.`);
  }  const blind = rows.filter((r) => r.sport === 'esports' && r.pM === 0.5).length;
  if (blind) C.push(`En ${blind} apuesta${blind > 1 ? 's' : ''} de eSports su modelo aún no tenía datos de los equipos (50%) y se guió por el mercado: su Elo por mapa mejora con cada serie que observa.`);
  if (n < 100) C.push(`<span class="note">Ojo: ${n} resultados es una muestra pequeña. Un par de underdogs que ganan o pierden cambian mucho el ROI; las conclusiones se vuelven firmes a partir de unas 100 apuestas por segmento.</span>`);

  const recent = [...rows].sort((a, b) => new Date(b.eventDate) - new Date(a.eventDate)).slice(0, 15);
  const why = (r) => (r.pM == null || r.pK == null ? `Estimó ${P(r.p)}; a momio ${dec(r.odds)} el EV era ${pct(r.ev, 1)}.`
    : `Su modelo veía ${P(r.pM)}${r.pM === 0.5 && r.sport === 'esports' ? ' (sin datos)' : ''} y el mercado ${P(r.pK)}; al mezclar quedó en ${P(r.p)}. A momio ${dec(r.odds)} eso es EV ${pct(r.ev, 1)}.`);
  const table = `<div class="table-wrap"><table class="t"><thead><tr><th>Partido</th><th>Elección</th><th class="num">Modelo</th><th class="num">Mercado</th><th class="num">Bot</th><th class="num">Momio</th><th>Por qué</th><th>Resultado</th></tr></thead><tbody>
    ${recent.map((r) => `<tr><td>${D.SPORT_ICON[r.sport] || ''} ${esc(r.name)}<div class="note">${new Date(r.eventDate).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</div></td><td><b>${esc(r.label)}</b></td><td class="num">${P(r.pM)}</td><td class="num">${P(r.pK)}</td><td class="num"><b>${P(r.p)}</b></td><td class="num">${dec(r.odds)}</td><td class="note">${why(r)}</td><td>${r.won ? `<span class="tag value">✅ +${(r.odds - 1).toFixed(2)} u</span>` : '<span class="tag live">❌ −1 u</span>'}</td></tr>`).join('')}
  </tbody></table></div>`;
  const gapTable = `<table class="t"><thead><tr><th>Modelo arriba del mercado</th><th class="num">Apuestas</th><th class="num">Ganadas</th><th class="num">Esperaba el mercado</th><th class="num">Esperaba su modelo</th><th class="num">ROI</th></tr></thead><tbody>
    ${gaps.filter((g) => g.n).map((g) => `<tr><td>${g.l}</td><td class="num">${g.n}</td><td class="num"><b>${g.w}</b></td><td class="num">${g.eK.toFixed(1)}</td><td class="num">${g.eM.toFixed(1)}</td><td class="num ${g.roi >= 0 ? 'up' : 'down'}">${pct(g.roi)}</td></tr>`).join('')}</tbody></table>`;
  return `${head}${how}
  <div class="widget glass mt report-concl"><h3>Qué ha aprendido</h3><ul class="report-list">${C.map((c) => `<li>${c}</li>`).join('')}</ul></div>
  ${both.length ? `<div class="widget glass mt"><h3>¿Le conviene creerle a su modelo cuando discrepa del mercado?</h3>${gapTable}<div class="note mt">"Esperaba" = suma de probabilidades: las victorias que debieron salir si esa opinión fuera la correcta. La más cercana a "Ganadas" es la que acertó.</div></div>` : ''}
  <div class="widget glass mt"><h3>Qué pensó en cada apuesta · últimas ${recent.length}</h3>${table}</div>`;
}

// Aprendizaje sin IA: resultados de las apuestas sombra por segmento.
function shadowSection() {
  const st = B.getState();
  const segs = Object.values(B.segmentStats()).sort((a, b) => b.n - a.n || b.pending - a.pending);
  const settled = st.shadow.filter((s) => s.status === 'won' || s.status === 'lost');
  const profit = settled.reduce((a, s) => a + s.profit, 0);
  const wins = settled.filter((s) => s.status === 'won').length;
  const clvs = settled.filter((s) => s.closingOdds);
  const clv = clvs.length ? clvs.reduce((a, s) => a + (s.odds / s.closingOdds - 1), 0) / clvs.length : null;
  const tag = { aprendiendo: '<span class="tag">Aprendiendo</span>', 'en prueba': '<span class="tag bet">En prueba</span>', confiable: '<span class="tag value">Confiable</span>', bloqueado: '<span class="tag live">Bloqueado</span>' };
  return `<div class="section-title">Aprendizaje sin IA <small>Apuestas sombra: lo que el bot habría apostado, sin tocar tu banca</small></div>
  <div class="grid kpis">
    <div class="widget glass kpi"><div class="label">Apuestas sombra</div><div class="value">${st.shadow.length}</div><div class="delta">${B.pendingShadows().length} esperando resultado</div></div>
    <div class="widget glass kpi"><div class="label">ROI sombra</div><div class="value ${profit > 0 ? 'up' : profit < 0 ? 'down' : ''}">${settled.length ? pct(profit / settled.length, 1) : '—'}</div><div class="delta">${settled.length} calificadas · ${signed(profit, (x) => x.toFixed(1) + ' u')}</div></div>
    <div class="widget glass kpi"><div class="label">Acierto sombra</div><div class="value">${settled.length ? pct(wins / settled.length) : '—'}</div><div class="delta">${settled.length ? `${wins} de ${settled.length}` : 'Sin resultados aún'}</div></div>
    <div class="widget glass kpi"><div class="label">CLV sombra</div><div class="value ${clv > 0 ? 'up' : clv < 0 ? 'down' : ''}">${pct(clv, 1)}</div><div class="delta">${clvs.length} con momio de cierre</div></div>
  </div>
  <div class="widget glass mt">${segs.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Deporte</th><th>Mercado</th><th>Momios</th><th class="num">Calificadas</th><th class="num">Pendientes</th><th class="num">Acierto</th><th class="num">ROI</th><th class="num">CLV</th><th>Estado</th></tr></thead><tbody>
    ${segs.map((o) => `<tr><td>${D.SPORT_ICON[o.sport] || ''} ${esc(D.SPORT_NAME[o.sport] || o.sport)}</td><td>${esc(o.market)}</td><td>${esc(o.bucket)}</td><td class="num">${o.n}</td><td class="num">${o.pending}</td><td class="num">${o.n ? pct(o.wins / o.n) : '—'}</td><td class="num ${o.roi > 0 ? 'up' : o.roi < 0 ? 'down' : ''}">${pct(o.roi, 1)}</td><td class="num">${pct(o.clv, 1)}</td><td>${tag[o.status]}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">El bot empezará a registrar apuestas sombra en cuanto detecte selecciones con valor.</div>'}
  <div class="note mt">Cada selección con valor se registra como si se apostara 1 unidad. Con ${30} resultados o más, un segmento (deporte + mercado + rango de momio) pasa a <b>Confiable</b> si gana más de 3%, o a <b>Bloqueado</b> si pierde más de 5%. El piloto automático deja de apostar en los segmentos bloqueados. Todo esto funciona sin la IA y sin gastar créditos.</div></div>`;
}

function drawEquity() {
  const el = $('#equity');
  if (!el) return;
  const st = B.getState();
  const pts = [...st.history, { t: Date.now(), bankroll: B.equityNow() }];
  const W = Math.max(el.clientWidth, 280), H = window.innerWidth < 640 ? 170 : 200, P = { l: 56, r: 12, t: 12, b: 26 };
  const xs = pts.map((p) => p.t), ys = pts.map((p) => p.bankroll).concat([st.startBankroll]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max((y1 - y0) * 0.15, 20); y0 -= pad; y1 += pad;
  const X = (t) => P.l + ((t - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (v) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.bankroll).toFixed(1)}`).join('');
  const area = `${line}L${X(pts[pts.length - 1].t)},${H - P.b}L${X(pts[0].t)},${H - P.b}Z`;
  const ticks = [y0 + pad, (y0 + y1) / 2, y1 - pad];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Evolución de la banca">
    <defs><linearGradient id="eqg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--chart)" stop-opacity="0.28"/><stop offset="1" stop-color="var(--chart)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--sep)" stroke-width="1"/><text x="${P.l - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--text-2)">${money(v).replace('.00', '')}</text>`).join('')}
    <line x1="${P.l}" x2="${W - P.r}" y1="${Y(st.startBankroll)}" y2="${Y(st.startBankroll)}" stroke="var(--text-3)" stroke-dasharray="4 4"/>
    <path d="${area}" fill="url(#eqg)"/><path d="${line}" fill="none" stroke="var(--chart)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle r="5" fill="var(--chart)" stroke="var(--glass-strong)" stroke-width="2" cx="${X(pts[pts.length - 1].t)}" cy="${Y(pts[pts.length - 1].bankroll)}"/>
    <line id="eq-cross" y1="${P.t}" y2="${H - P.b}" stroke="var(--text-3)" stroke-width="1" opacity="0"/>
    <circle id="eq-dot" r="5" fill="var(--chart)" stroke="var(--glass-strong)" stroke-width="2" opacity="0"/>
    <text x="${P.l}" y="${H - 6}" font-size="11" fill="var(--text-2)">${new Date(x0).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</text>
    <text x="${W - P.r}" y="${H - 6}" font-size="11" fill="var(--text-2)" text-anchor="end">${new Date(x1).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</text>
    <rect x="${P.l}" y="0" width="${W - P.l - P.r}" height="${H}" fill="transparent" id="eq-hit"/>
  </svg><div class="tip glass" id="eq-tip"></div>`;
  const svg = el.querySelector('svg'), tip = $('#eq-tip'), cross = $('#eq-cross'), dot = $('#eq-dot');
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * W;
    const p = pts.reduce((best, q) => (Math.abs(X(q.t) - mx) < Math.abs(X(best.t) - mx) ? q : best), pts[0]);
    cross.setAttribute('x1', X(p.t)); cross.setAttribute('x2', X(p.t)); cross.setAttribute('opacity', 1);
    dot.setAttribute('cx', X(p.t)); dot.setAttribute('cy', Y(p.bankroll)); dot.setAttribute('opacity', 1);
    tip.style.left = (X(p.t) / W) * r.width + 'px'; tip.style.top = (Y(p.bankroll) / H) * r.height + 'px'; tip.style.opacity = 1;
    tip.textContent = `${money(p.bankroll)} · ${new Date(p.t).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  });
  svg.addEventListener('mouseleave', () => { tip.style.opacity = 0; cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); });
}

// ---------- Noticias ----------
function viewNews() {
  return `<div class="chips">${D.LEAGUES.filter((l) => l.path).map((l) => `<button class="chip glass ${S.newsLeague === l.id ? 'active' : ''}" data-newsleague="${l.id}">${D.SPORT_ICON[l.sport]} ${l.name}</button>`).join('')}</div>
  <form class="flex tabs-inline" id="news-form"><input class="input glass" style="max-width:460px" id="news-q" placeholder="Buscar noticias: equipo, jugador, lesión…" value="${esc(S.newsQuery)}"><button class="btn primary">Buscar</button></form>
  <div class="grid halves"><div class="widget glass"><h3>ESPN · ${esc(D.leagueById(S.newsLeague).name)}</h3><div id="news-espn"><div class="shimmer"></div><div class="shimmer"></div></div></div>
  <div class="widget glass"><h3>Google News · ${esc(S.newsQuery || D.leagueById(S.newsLeague).name)}</h3><div id="news-google"><div class="shimmer"></div><div class="shimmer"></div></div></div></div>`;
}
const newsList = (items) => (items.length ? items.map((n) => `<a class="news-item" href="${esc(n.url)}" target="_blank" rel="noopener"><div class="ttl"><b>${esc(n.title)}</b></div>${n.desc ? `<div class="note">${esc(n.desc)}</div>` : ''}<div class="src">${esc(n.source || '')} · ${n.date ? new Date(n.date).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</div></a>`).join('') : '<div class="empty">Sin noticias</div>');
async function loadNews() {
  const lg = D.leagueById(S.newsLeague);
  const q = S.newsQuery || `${lg.name} ${lg.sport === 'soccer' ? 'futbol' : ''}`;
  const [espn, g] = await Promise.all([D.getLeagueNews(lg), D.searchNews(q, 15)]);
  if (S.tab !== 'news') return;
  const e1 = $('#news-espn'), e2 = $('#news-google');
  if (e1) e1.innerHTML = newsList(espn);
  if (e2) e2.innerHTML = newsList(g);
}

// ---------- Más: tablas, estrategia, ajustes ----------
function viewMore() {
  // En el celular, accesos a las secciones que no caben en la barra inferior.
  const shortcuts = `<div class="shortcuts mobile-only">${['sports', 'combat', 'esports', 'gold', 'smart', 'news'].map((id) => `<button class="shortcut glass" data-tab="${id}">${icon(id)}<span>${NAV.find((n) => n[0] === id)[1]}</span></button>`).join('')}</div>`;
  const seg = `<div class="segmented tabs-inline">${[['tables', 'Tablas'], ['books', 'Mis casas'], ['phone', 'Celular'], ['strategy', 'Estrategia'], ['settings', 'Ajustes']].map(([k, l]) => `<button data-more="${k}" class="${S.moreTab === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const head = shortcuts + seg;
  if (S.moreTab === 'strategy') return head + `<div class="widget glass">${STRATEGY_HTML}</div>`;
  if (S.moreTab === 'books') return head + viewBooks();
  if (S.moreTab === 'phone') return head + viewPhone();
  if (S.moreTab === 'settings') return head + viewSettings();
  // Ligas agrupadas por sección (todas visibles, sin scroll horizontal).
  return head + Object.keys(D.SECTIONS).map((sec) => `<div class="note chip-group-title">${D.SECTIONS[sec].title}</div><div class="chips">${D.sectionLeagues(sec).map((l) => `<button class="chip glass ${S.tablesLeague === l.id ? 'active' : ''}" data-tablesleague="${l.id}">${D.SPORT_ICON[l.sport]} ${l.name}</button>`).join('')}</div>`).join('')
    + `<div id="tables-box"><div class="widget glass"><div class="shimmer"></div><div class="shimmer"></div><div class="shimmer"></div></div></div>`;
}

async function loadTables() {
  const lg = D.leagueById(S.tablesLeague);
  if (lg.sport === 'esports') {
    const box = $('#tables-box');
    const rows = Object.values(B.getState().elo?.[lg.game] || {}).sort((a, b) => b.elo - a.elo);
    if (box) box.innerHTML = `<div class="widget glass mt"><h3>Ranking Elo del bot · ${esc(lg.name)}</h3>${rows.length ? `<div class="table-wrap"><table class="t keep"><thead><tr><th>#</th><th>Equipo</th><th class="num">Elo</th><th class="num">Mapas</th><th class="num">Series</th></tr></thead><tbody>
      ${rows.slice(0, 100).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td class="num"><b>${Math.round(r.elo)}</b></td><td class="num">${r.maps}</td><td class="num">${r.series}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">El bot todavía no observa resultados de este juego. El ranking se construye solo con cada serie terminada.</div>'}
      <div class="note mt">Cada equipo empieza en 1500. Ganar un mapa a un rival fuerte sube más el Elo. Entre más resultados observe el bot, más confiable es.</div></div>`;
    return;
  }
  if (lg.sport === 'mma' || lg.sport === 'boxing') {
    const box = $('#tables-box');
    if (box) box.innerHTML = '<div class="widget glass empty">En combate no hay tabla de posiciones: el récord de cada peleador aparece junto a su nombre en la cartelera (sección Combate).</div>';
    return;
  }
  let groups = [];
  try { groups = await D.getStandings(lg); } catch (e) { console.warn(e); }
  const box = $('#tables-box');
  if (!box || S.moreTab !== 'tables') return;
  if (!groups.length) { box.innerHTML = '<div class="widget glass empty">Tabla no disponible</div>'; return; }
  const isTennis = lg.sport === 'tennis', isSoccer = lg.sport === 'soccer';
  box.innerHTML = groups.map((g) => `<div class="widget glass mt"><h3>${esc(g.group)}</h3><div class="table-wrap"><table class="t keep"><thead><tr><th>#</th><th>${isTennis ? 'Jugador' : 'Equipo'}</th>
    ${isTennis ? '<th class="num">Puntos</th>' : `<th class="num">PJ</th><th class="num">G</th>${isSoccer ? '<th class="num">E</th>' : ''}<th class="num">P</th><th class="num">${isSoccer ? 'GF' : 'PF'}</th><th class="num">${isSoccer ? 'GC' : 'PC'}</th><th class="num">${isSoccer ? 'Pts' : '%'}</th>`}</tr></thead><tbody>
    ${g.rows.slice(0, isTennis ? 100 : 40).map((r, i) => `<tr><td>${r.rank || i + 1}</td><td>${r.logo ? `<img src="${esc(r.logo)}" alt="" width="18" height="18" style="vertical-align:-4px;margin-right:6px;object-fit:contain" loading="lazy" onerror="this.remove()">` : ''}${esc(r.name)}</td>
      ${isTennis ? `<td class="num">${Number(r.pts || 0).toLocaleString('es-MX')}</td>` : `<td class="num">${r.gp}</td><td class="num">${r.w}</td>${isSoccer ? `<td class="num">${r.d}</td>` : ''}<td class="num">${r.l}</td><td class="num">${r.pf}</td><td class="num">${r.pa}</td><td class="num"><b>${isSoccer ? r.pts ?? '' : r.pct != null ? Number(r.pct).toFixed(3) : ''}</b></td>`}</tr>`).join('')}
    </tbody></table></div></div>`).join('');
}

function viewBooks() {
  const st = B.getState();
  const stats = K.bookPriceStats(st);
  const row = (b) => { const cfg = st.books[b.id] || {}; const s = stats[b.id]; const av = K.bookAvailable(st, b.id); return `<div class="row book-row">
    <span class="icon-sq" style="background:${b.color}">${esc(b.name[0])}</span>
    <div class="grow"><b>${esc(b.name)}</b> <a class="note" href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.url.replace(/^https:\/\/(www\.)?/, ''))} ↗</a>
      <div class="meta">${b.note ? esc(b.note) + ' · ' : ''}${s ? `Precio promedio vs referencia: <b class="${s.avg >= 1 ? 'up' : 'down'}">${s.avg >= 1 ? '+' : ''}${((s.avg - 1) * 100).toFixed(1)}%</b> (${s.n} capturas)` : 'Sin capturas de momios todavía'}${av != null ? ` · disponible ${money(av)}` : ''}</div></div>
    <input class="input" style="width:110px;text-align:right" type="number" min="0" placeholder="Saldo $" data-bookbal="${b.id}" value="${cfg.balance ?? ''}" title="Saldo depositado en esta casa">
    <label class="switch"><input type="checkbox" data-bookon="${b.id}" ${cfg.enabled ? 'checked' : ''}><span></span></label></div>`; };
  return `<div class="widget glass note">Activa las casas donde tienes cuenta y, si quieres, captura tu saldo. En el boleto escribes (o la IA busca) el momio de cada casa y el bot te dice dónde conviene apostar; además aprende cuál te paga mejor en cada deporte.</div>
  <div class="section-title">${K.GROUP_LABEL.mx} <small>Verifica su permiso vigente en el portal de Juegos y Sorteos de SEGOB</small></div>
  <div class="list glass">${K.BOOKS.filter((b) => b.group === 'mx').map(row).join('')}</div>
  <div class="section-title">${K.GROUP_LABEL.intl}</div>
  <div class="warn">Estos sitios no tienen permiso de SEGOB. Puedes entrar desde México, pero <b>no tienes protección legal</b> si no te pagan, congelan tu cuenta o te piden documentos para retirar. Depositar y retirar puede ser más difícil (a veces solo con cripto o tarjeta internacional) y las ganancias también deben declararse ante el SAT. Úsalos bajo tu propio riesgo.</div>
  <div class="list glass mt">${K.BOOKS.filter((b) => b.group === 'intl').map(row).join('')}</div>
  <div class="note mt">El saldo es opcional. Si lo capturas, el bot no te manda a una casa sin fondos suficientes y lo actualiza al liquidar cada apuesta.</div>`;
}

function viewSettings() {
  const s = B.getState().settings;
  const theme = localStorage.getItem('betbot-theme') || 'auto';
  const num = (id, label, val, step, hint) => `<div class="row"><div class="grow"><b>${label}</b><div class="meta">${hint}</div></div><input class="input" style="width:110px;text-align:right" type="number" step="${step}" data-setting="${id}" value="${val}"></div>`;
  return `<div class="grid halves">
  <div><div class="section-title" style="margin-top:4px">Gestión de banca</div><div class="list glass">
    ${num('kellyFraction', 'Fracción de Kelly', s.kellyFraction, 0.05, '0.25 = 25% de Kelly (recomendado)')}
    ${num('maxStakePct', 'Tope por apuesta', s.maxStakePct, 0.005, 'Fracción de la banca, 0.03 = 3%')}
    ${num('minStake', 'Apuesta mínima (MXN)', s.minStake, 5, 'Las casas mexicanas suelen pedir $10')}
    ${num('minEV', 'EV mínimo', s.minEV, 0.01, '0.03 = 3% de valor esperado')}
    ${num('minOdds', 'Momio mínimo', s.minOdds, 0.05, 'Evita favoritos muy cortos')}
    ${num('maxOdds', 'Momio máximo', s.maxOdds, 0.5, 'Evita longshots extremos')}
    ${num('maxBetsPerDay', 'Máximo de apuestas por día', s.maxBetsPerDay, 1, 'Disciplina del piloto automático')}
    ${num('practicePerDay', 'Apuestas de práctica por día', s.practicePerDay, 1, 'Modo práctica: apuestas ficticias garantizadas cada día')}
    ${num('practiceStake', 'Monto de cada práctica (MXN)', s.practiceStake ?? 10, 5, 'Bajo a propósito: es para aprender')}
    ${num('scanMinutes', 'Escanear cada (min)', s.scanMinutes, 1, 'Frecuencia de actualización')}
  </div></div>
  <div><div class="section-title" style="margin-top:4px">Apariencia</div><div class="list glass">
    <div class="row"><div class="grow"><b>Tema</b><div class="meta">Automático sigue a tu sistema</div></div><div class="segmented">${['auto', 'light', 'dark'].map((t) => `<button data-theme-set="${t}" class="${theme === t ? 'active' : ''}">${{ auto: 'Auto', light: 'Claro', dark: 'Oscuro' }[t]}</button>`).join('')}</div></div>
    <div class="row"><div class="icon-sq" style="background:var(--green-fill)">✓</div><div class="grow"><b>Fuentes gratis</b><div class="meta">ESPN · MLB Stats API (LMB) · LoL Esports · Liquipedia · Google News</div></div><span class="tag value">Activo</span></div>
  </div>
  <div class="section-title">Claves</div>${keysSection()}
  <div class="section-title">Actualizaciones</div>${updatesSection()}
  <div class="section-title">Reiniciar banca</div><div class="list glass"><div class="row"><div class="grow"><b>Empezar de nuevo</b><div class="meta">Borra las apuestas; conserva el aprendizaje</div></div><input class="input" id="reset-amt" style="width:110px;text-align:right" type="number" value="2000"><button class="btn danger" id="reset-bank">Reiniciar</button></div></div>
  <div class="note mt">Tus datos se guardan en <span class="kbd">data/state.json</span> de tu PC y se sincronizan con tu celular.</div></div>
  </div>`;
}

// ---------- hoja de partido ----------
let sheetTimer = null;
async function openMatch(k, tab = 'analysis') {
  S.open = k; S.sheetTab = tab;
  $('#backdrop').classList.add('open'); $('#sheet').classList.add('open');
  renderSheet();
  const a = S.analysis.get(k);
  if (!a) return;
  const lg = D.leagueById(a.ev.leagueId);
  try {
    const sum = await D.getSummary(lg, a.ev.id);
    S.summaries.set(k, sum);
    if (sum.winProb && a.ev.state === 'in') analyze(a.ev, S.tables.get(lg.id), sum.winProb);
  } catch (e) { console.warn('summary', e); S.summaries.set(k, { error: true }); }
  if (S.open === k) renderSheet();
  clearInterval(sheetTimer);
  if (a.ev.state === 'in') sheetTimer = setInterval(async () => {
    if (S.open !== k) return clearInterval(sheetTimer);
    await refreshLeague(lg).catch(() => {});
    try { const sum = await D.getSummary(lg, a.ev.id); S.summaries.set(k, sum); const cur = S.analysis.get(k); if (cur) analyze(cur.ev, S.tables.get(lg.id), sum.winProb); } catch {}
    renderSheet();
  }, 5_000); // partido en vivo abierto: se actualiza cada 5 s
}

function closeSheets() {
  S.open = null; clearInterval(sheetTimer);
  $('#sheet').classList.remove('open'); $('#backdrop').classList.remove('open');
}

// Pinta un contenedor: completo si es otro partido/pestaña; si es el mismo, solo lo que cambió.
function paint(el, fresh, html) { if (fresh) el.innerHTML = html; else morph(el, html); }

// Logo oficial de la liga o torneo (ESPN, LoL Esports, Liquipedia…); si no hay, el icono del deporte.
function lgMark(lg, ev = null, cls = 'lg-logo') {
  const src = ev?.leagueLogo || D.LEAGUE_LOGO[lg.id] || lg.logo || '';
  // Logos con letras oscuras (ATP, WTA, boxeo) llevan fondo claro para verse en el tema oscuro.
  if (['atp', 'wta', 'boxing'].includes(lg.id) && !ev?.leagueLogo) cls += ' lg-onlight';
  return src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy">` : `<span class="${cls} lg-emoji">${D.SPORT_ICON[lg.sport]}</span>`;
}

function renderSheet() {
  const a = S.analysis.get(S.open);
  if (!a) return;
  const ev = a.ev, lg = D.leagueById(ev.leagueId), sum = S.summaries.get(S.open);
  const sheetKey = S.open + '|' + S.sheetTab, sheetFresh = $('#sheet-body').dataset.k !== sheetKey;
  $('#sheet-body').dataset.k = sheetKey;
  paint($('#sheet-title'), sheetFresh, `<div class="note sheet-league">${lgMark(lg, ev)} ${esc(lg.name)}${ev.tournament ? ' · ' + esc(ev.tournament) + ' · ' + esc(ev.round) : ''}${ev.venue && !ev.tournament ? ' · ' + esc(ev.venue) : ''}</div>`);
  const big = ev.state === 'pre' ? (ev.sport === 'esports' ? `Bo${ev.bestOf}` : 'vs') : ev.sport === 'tennis' ?`${(a.model.live?.sets || [0, 0]).join('-')}` : `${ev.home.score ?? 0} - ${ev.away.score ?? 0}`;
  const status = ev.state === 'in' ? `<span class="live-tag" style="color:var(--red)"><span class="dot live"></span> ${esc(ev.detail)}</span>` : ev.state === 'post' ? 'Final' : new Date(ev.date).toLocaleString('es-MX', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const team = (t) => `<div>${t.logo ? `<img src="${esc(t.logo)}" alt="" onerror="this.remove()">` : `<div style="font-size:40px">${D.SPORT_ICON[ev.sport]}</div>`}<div class="tname">${esc(t.name)}</div><div class="note">${esc(t.record || t.flag || '')}${t.form ? ' · ' + esc(t.form) : ''}</div></div>`;
  const tabs = ev.sport === 'mma' || ev.sport === 'boxing'
    ? [['analysis', 'Análisis'], ['charts', '📈 Gráficas'], ['smart', '🧠 Dinero inteligente'], ['fighters', 'Peleadores'], ['markets', 'Mercados y momios'], ['experts', 'Especialistas'], ['ai', '✦ IA']]
    : ev.sport === 'esports'
    ? [['analysis', 'Análisis'], ['charts', '📈 Gráficas'], ['smart', '🧠 Dinero inteligente'], ['news', 'Noticias'], ['ai', '✦ IA'], ['odds', 'Momios']]
    : [['analysis', 'Análisis'], ['charts', '📈 Gráficas'], ...(CTX_SPORTS.includes(ev.sport) ? [['players', '👥 Jugadores']] : []), ['smart', '🧠 Dinero inteligente'], ['lineups', ev.sport === 'soccer' ? 'Alineaciones' : 'Plantilla'], ['stats', 'Estadísticas'], ['feed', 'Minuto a minuto'], ['news', 'Noticias'], ['ai', '✦ IA'], ['odds', 'Momios']];
  paint($('#sheet-body'), sheetFresh, `<div class="scoreboard">${team(ev.home)}<div><div class="big">${esc(big)}</div><div class="st">${status}</div>${ev.sport === 'tennis' && ev.state !== 'pre' ? `<div class="note">${ev.home.linescores.join(' ')}<br>${ev.away.linescores.join(' ')}</div>` : ''}</div>${team(ev.away)}</div>
    ${ev.maps?.length ? `<div class="maps-strip">${ev.maps.map((m) => `<div class="map-chip ${m.status}${m.winner ? ' w-' + m.winner : ''}"><div class="note">Mapa ${m.n}${m.map ? ' · ' + esc(m.map) : ''}</div><b>${m.status === 'done' ? `${m.home}-${m.away}` : m.status === 'live' ? '<span class="dot live"></span> en juego' : '—'}</b></div>`).join('')}
      <div class="note maps-src">Mapas en tiempo real: ${esc(ev.liveSource || '')}</div></div>` : ''}
    <div class="segmented tabs-inline">${tabs.map(([k, l]) => `<button data-stab="${k}" class="${S.sheetTab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="stab-body">${sheetTab(a, sum)}</div>`);
  labelTables($('#sheet-body'));
  if (sheetFresh) {
    if (S.sheetTab === 'news') loadMatchNews(a);
    if (S.sheetTab === 'fighters') loadFighters(a);
    if (S.sheetTab === 'experts') loadExperts(a);
  }
  if ((S.sheetTab === 'smart' || S.sheetTab === 'analysis') && pmSource(a) && !S.smart.events.get(S.open)) showEventSmart(a, { perSide: S.sheetTab === 'smart' ? 6 : 4 });
}

function sheetTab(a, sum) {
  const loading = '<div class="shimmer"></div><div class="shimmer"></div><div class="shimmer"></div>';
  switch (S.sheetTab) {
    case 'analysis': return tabAnalysis(a);
    case 'lineups': return !sum ? loading : tabLineups(a, sum);
    case 'stats': return !sum ? loading : tabStats(a, sum);
    case 'feed': return !sum ? loading : tabFeed(sum);
    case 'news': return '<div id="match-news">' + loading + '</div>';
    case 'ai': return tabAI(a);
    case 'odds': return tabOdds(a);
    case 'fighters': return '<div id="fighters-box">' + loading + '</div>';
    case 'markets': return tabFightMarkets(a);
    case 'experts': return '<div id="experts-box">' + loading + '</div>';
    case 'smart': return tabEventSmart(a);
    case 'charts': return tabCharts(a, sum);
    case 'players': return tabPlayers(a);
  }
  return '';
}

function tabAnalysis(a) {
  const ev = a.ev, m = a.model, st = B.getState();
  const probs = ev.state === 'in' && m.live ? m.live : m.pre;
  const sides = m.kind === 'soccer' ? [['home', ev.home.name, 'var(--blue)'], ['draw', 'Empate', 'var(--text-3)'], ['away', ev.away.name, 'var(--orange-fill)']] : [['home', ev.home.name, 'var(--blue)'], ['away', ev.away.name, 'var(--orange-fill)']];
  const bar = `<div class="probbar">${sides.map(([k, , c]) => `<span style="width:${(probs[k] * 100).toFixed(1)}%;background:${c}" title="${pct(probs[k], 1)}"></span>`).join('')}</div>
    <div class="legend">${sides.map(([k, n, c]) => `<span><i style="background:${c}"></i>${esc(n)} <b>${pct(probs[k], 1)}</b></span>`).join('')}</div>`;
  const extra = m.kind === 'soccer' ? `<div class="note mt">Goles esperados: <b>${m.lh.toFixed(2)}</b> - <b>${m.la.toFixed(2)}</b> · Ambos anotan ${pct(probs.btts)} · Más de ${probs.line ?? m.line}: ${pct(probs.over)}${m.live ? ` · Minuto ${Math.round(m.live.minute)}` : ''}</div>`
    : m.kind === 'tennis' ? `<div class="note mt">Ranking: ${m.rank1 ? '#' + m.rank1 : 'sin ranking'} vs ${m.rank2 ? '#' + m.rank2 : 'sin ranking'} · al mejor de ${ev.bestOf} sets</div>`
    : m.kind === 'fight' ? `<div class="note mt">${esc(ev.tournament || '')}${ev.round ? ' · ' + esc(ev.round) : ''}${ev.rounds ? ' · ' + ev.rounds + ' rounds' : ''}${ev.home.record ? ` · récord ${esc(ev.home.record)} vs ${esc(ev.away.record)}` : ''} · El récord sin el nivel de los rivales dice poco: aquí manda el precio de Polymarket/Kalshi.</div>`
    : m.kind === 'esports' ? `<div class="note mt">Elo del bot: ${Math.round(m.elo1)} vs ${Math.round(m.elo2)} · probabilidad por mapa ${pct(m.pMap, 1)} · al mejor de ${ev.bestOf}${ev.home.record ? ` · récord ${esc(ev.home.record)} vs ${esc(ev.away.record)}` : ''}</div>`
    : m.live ? `<div class="note mt">Probabilidad en vivo: ${m.live.source === 'ESPN' ? 'modelo de ESPN' : 'modelo del bot según marcador y tiempo'}</div>` : '';
  const warn = !m.known ? `<div class="warn mt">${ev.sport === 'esports' ? 'El bot todavía tiene pocos mapas observados de estos equipos: su Elo es poco confiable. Úsalo como referencia y apóyate en el análisis con IA.' : 'Faltan datos de tabla para uno de los equipos: la estimación se apoya más en el mercado.'}</div>` : '';
  const liveNote = ev.state === 'in' ? '<div class="warn mt">En vivo, los momios de ESPN ya no son válidos. Usa el <b>momio mínimo</b> y compáralo con el momio en vivo de tu app mexicana.</div>' : '';
  return `<div class="widget" style="background:var(--fill)"><h3>${ev.state === 'in' ? 'Probabilidad en vivo' : 'Probabilidad estimada'} <span class="note" style="text-transform:none;letter-spacing:0">peso del modelo ${pct(st.weights[ev.sport])}</span></h3>${bar}${extra}${warn}${liveNote}</div>
  <div class="table-wrap mt"><table class="t"><thead><tr><th>Selección</th><th class="num">Modelo</th><th class="num">Mercado</th><th class="num">Final</th><th class="num">Momio ref.</th><th class="num">EV</th><th class="num">Mínimo MX</th><th class="num">Monto Kelly</th><th></th></tr></thead><tbody>
  ${a.sels.map((s) => { const stake = s.odds && ev.state === 'pre' ? B.suggestStake(s.p, s.odds) : 0; return `<tr><td><b>${esc(s.label)}</b><div class="note">${esc(s.market)}</div></td><td class="num">${pct(s.pModel, 1)}</td><td class="num">${pct(s.pMarket, 1)}</td><td class="num"><b>${pct(s.p, 1)}</b></td><td class="num">${dec(s.odds)}</td>
    <td class="num ${s.ev > 0 ? 'up' : s.ev < 0 ? 'down' : ''}">${s.ev != null && ev.state === 'pre' ? pct(s.ev, 1) : '—'}</td><td class="num">${dec(s.minOdds)}<div class="note">${toAmerican(s.minOdds)}</div></td><td class="num">${stake ? money(stake) : '—'}</td>
    <td>${ev.state !== 'post' ? `<button class="btn small ${s.value && ev.state === 'pre' ? 'primary' : ''}" data-slip="${key(ev)}|${s.pick}">Apostar</button>` : ''}</td></tr>`; }).join('')}
  </tbody></table></div>
  ${a.golden.length ? `<div class="grid opps mt">${a.golden.map((g) => oppCard(g, a)).join('')}</div>` : ''}
  ${botConclusionBox(a)}
  ${eventSmartSummary(a)}
  <div class="note mt">Momio mínimo MX = el momio a partir del cual la apuesta tiene EV ≥ ${pct(st.settings.minEV)} según la estimación final. Momio decimal; entre paréntesis, el formato americano que usa Caliente.</div>`;
}

function tabLineups(a, sum) {
  if (sum.error) return '<div class="empty">No se pudo cargar el detalle</div>';
  const lu = sum.lineups || [];
  if (!lu.length || !lu.some((l) => l.players.length)) return `<div class="empty">Alineaciones aún no publicadas. Normalmente salen ~1 hora antes del partido.${sum.probablePitchers ? `<br>Abridores probables: ${esc(sum.probablePitchers.away || '?')} vs ${esc(sum.probablePitchers.home || '?')}` : ''}</div>`;
  let pitch = '';
  if (a.ev.sport === 'soccer' && lu.every((l) => l.formation)) {
    const place = (team, isHome) => {
      const starters = team.players.filter((p) => p.starter).sort((x, y) => (x.place || 99) - (y.place || 99));
      const rows = [1, ...team.formation.split('-').map(Number)];
      let idx = 0;
      return rows.map((n, ri) => {
        const ps = starters.slice(idx, idx + n); idx += n;
        const y = isHome ? 94 - ri * (36 / (rows.length - 1)) : 6 + ri * (36 / (rows.length - 1));
        return ps.map((p, i) => `<div class="pl ${isHome ? 'h' : 'a'}" style="left:${((i + 1) / (n + 1)) * 100}%;top:${y}%"><b>${esc(p.jersey || '')}</b>${esc((p.name || '').split(' ').slice(-1)[0])}</div>`).join('');
      }).join('');
    };
    const home = lu.find((l) => l.homeAway === 'home') || lu[0], away = lu.find((l) => l.homeAway === 'away') || lu[1];
    pitch = `<div class="grid halves"><div><div class="pitch">
      <svg class="lines" viewBox="0 0 68 105" preserveAspectRatio="none"><g fill="none" stroke="rgba(255,255,255,.55)" stroke-width=".4"><rect x="2" y="2" width="64" height="101"/><line x1="2" y1="52.5" x2="66" y2="52.5"/><circle cx="34" cy="52.5" r="9"/><rect x="14" y="2" width="40" height="16"/><rect x="14" y="87" width="40" height="16"/><rect x="25" y="2" width="18" height="6"/><rect x="25" y="97" width="18" height="6"/></g></svg>
      ${place(away, false)}${place(home, true)}</div>
      <div class="legend" style="justify-content:center"><span><i style="background:#fff;border:1px solid var(--sep)"></i>${esc(home.team)} ${esc(home.formation)}</span><span><i style="background:#111"></i>${esc(away.team)} ${esc(away.formation)}</span></div></div><div>${rosterLists(lu)}</div></div>`;
    return pitch + injuriesBlock(sum);
  }
  return rosterLists(lu) + injuriesBlock(sum);
}
function rosterLists(lu) {
  return lu.map((l) => `<div class="widget" style="background:var(--fill);margin-bottom:12px"><h3>${esc(l.team)} ${l.formation ? '· ' + esc(l.formation) : ''}</h3>
    <div class="note"><b>Titulares</b></div>${l.players.filter((p) => p.starter).map((p) => `<div class="flex" style="padding:3px 0"><span class="kbd">${esc(p.jersey || '')}</span> ${esc(p.name)} <span class="note">${esc(p.pos || '')}${p.subOut ? ' · salió' : ''}</span></div>`).join('')}
    ${l.players.some((p) => !p.starter) ? `<div class="note mt"><b>Suplentes</b></div><div class="note">${l.players.filter((p) => !p.starter).map((p) => esc(p.name) + (p.subIn ? ' ↑' : '')).join(' · ')}</div>` : ''}</div>`).join('');
}
function injuriesBlock(sum) {
  const inj = (sum.injuries || []).filter((t) => t.list.length);
  if (!inj.length) return '';
  return `<div class="widget mt" style="background:var(--fill)"><h3>Lesiones y bajas</h3>${inj.map((t) => `<div class="mt"><b>${esc(t.team)}</b>${t.list.map((i) => `<div class="note">• ${esc(i.name)} — ${esc(i.status)} ${esc(i.detail)}</div>`).join('')}</div>`).join('')}</div>`;
}

// ---------- Gráficas del partido ----------
// Historial de la probabilidad que calcula el bot en cada actualización (en esta sesión).
S.probHist = new Map(); S.pmHist = new Map();
function recordProb(a) {
  const k = key(a.ev), ml = a.sels.filter((s) => s.market === '1X2' || s.market === 'Ganador');
  if (!ml.length || a.ev.state === 'post') return;
  const pt = { t: Date.now() };
  for (const s of ml) pt[s.pick] = s.p;
  const arr = S.probHist.get(k) || [];
  const last = arr[arr.length - 1];
  if (last && Date.now() - last.t < 15_000 && Math.abs((last.home ?? 0) - (pt.home ?? 0)) < 0.005) return;
  arr.push(pt);
  if (arr.length > 400) arr.splice(0, arr.length - 400);
  S.probHist.set(k, arr);
}
async function loadPmHist(a) {
  const k = key(a.ev), src = pmSource(a);
  if (!src?.cond) return;
  const cur = S.pmHist.get(k);
  if (cur && (cur.busy || Date.now() - cur.t < 60_000)) return;
  S.pmHist.set(k, { ...(cur || {}), busy: true, t: Date.now() });
  try {
    const out = { t: Date.now(), busy: false };
    for (const side of ['home', 'away', 'draw']) if (src.cond[side]?.token) out[side] = await priceHistory(src.cond[side].token);
    S.pmHist.set(k, out);
  } catch (e) { S.pmHist.set(k, { t: Date.now(), busy: false, error: e.message }); }
  if (S.open === k && S.sheetTab === 'charts') renderSheet();
}

// Conclusión propia del bot: combina su modelo, el mercado (Polymarket/Kalshi), los sharps y el valor.
// Se muestra distinta a los datos de las fuentes para que sepas que es una opinión del bot.
function botConclusion(a) {
  const ev = a.ev, ml = a.sels.filter((s) => s.market === '1X2' || s.market === 'Ganador');
  if (!ml.length || ev.state === 'post') return null;
  const best = [...ml].sort((x, y) => y.p - x.p)[0];
  const name = best.pick === 'draw' ? 'Empate' : ev[best.pick].name;
  const favOf = (key) => { const v = ml.filter((s) => s[key] != null); return v.length ? v.sort((x, y) => y[key] - x[key])[0].pick : null; };
  const modelFav = favOf('pModel'), marketFav = favOf('pMarket');
  const sharp = S.smart.events.get(key(ev))?.best || null;
  const agree = [modelFav, marketFav, sharp].filter((x) => x === best.pick).length;
  const reasons = [];
  if (marketFav) reasons.push(marketFav === best.pick ? 'el mercado coincide' : 'el mercado ve otro favorito');
  if (modelFav && ml[0].pModel != null) reasons.push(modelFav === best.pick ? 'su modelo coincide' : 'su modelo ve otro favorito');
  if (sharp) reasons.push(sharp === best.pick ? 'los sharps están del mismo lado' : 'los sharps están del otro lado');
  if (a.model.adj?.delta) reasons.push(`ajustó su modelo por bajas o descanso (${a.model.adj.delta > 0 ? '+' : ''}${(a.model.adj.delta * 100).toFixed(1)} pts para ${ev.home.name})`);
  const value = ml.find((s) => s.value && ev.state === 'pre');
  if (value) reasons.push(`hay valor en ${value.pick === 'draw' ? 'el empate' : ev[value.pick].name} (EV ${pct(value.ev, 1)})`);
  const conf = best.p >= 0.65 && agree >= 2 ? 'Alta' : best.p >= 0.5 && agree >= 1 ? 'Media' : 'Baja';
  return { pick: best.pick, name, p: best.p, conf, reasons, value };
}
function botConclusionBox(a) {
  const c = botConclusion(a);
  if (!c) return '';
  return `<div class="widget bot-concl mt"><div class="bot-concl-head">🤖 Conclusión del bot <span class="tag">opinión propia · no es una fuente</span></div>
    <div class="bot-concl-pick">${esc(c.name)} <b>${pct(c.p)}</b> <span class="tag conf-${c.conf.toLowerCase()}">Confianza ${c.conf}</span></div>
    <div class="note">${c.reasons.length ? 'Porque ' + esc(c.reasons.join(', ')) + '.' : 'Basada solo en su modelo: no hay mercado ni sharps para comparar.'}</div></div>`;
}

function tabCharts(a, sum) {
  const ev = a.ev, k = key(ev);
  const C = { home: 'var(--blue)', away: 'var(--orange-fill)', draw: 'var(--text-3)' };
  const nm = { home: ev.home.name, away: ev.away.name, draw: 'Empate' };
  const myBets = B.getState().bets.filter((b) => b.eventId === ev.id && b.status === 'pending');
  const refs = myBets.filter((b) => b.pick in nm).map((b) => ({ y: 1 / b.odds, label: `Tu apuesta ${nm[b.pick]} @ ${dec(b.odds)} (equilibrio ${pct(1 / b.odds)})`, color: C[b.pick] }));
  const hm = (t) => new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const dm = (t) => new Date(t).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  // 1) Probabilidad de ganar durante el partido: ESPN jugada por jugada; si no hay, la del bot en cada actualización.
  const wp = sum?.wpSeries || [];
  let liveChart;
  if (wp.length > 2) {
    const sides = [['home', wp.map((w, i) => ({ x: i, y: w.home }))], ['away', wp.map((w, i) => ({ x: i, y: Math.max(0, 1 - w.home - w.tie) }))]];
    if (wp.some((w) => w.tie > 0)) sides.push(['draw', wp.map((w, i) => ({ x: i, y: w.tie }))]);
    liveChart = lineChart('wp-' + k, { series: sides.map(([s, pts]) => ({ name: nm[s], color: C[s], pts })), refs, xFmt: (x) => (x === 0 ? 'Inicio' : `Jugada ${Math.round(x)}`) });
  } else {
    const h = S.probHist.get(k) || [];
    const sides = ['home', 'away', 'draw'].filter((s) => h.some((p) => p[s] != null));
    liveChart = lineChart('bot-' + k, { series: sides.map((s) => ({ name: nm[s], color: C[s], pts: h.filter((p) => p[s] != null).map((p) => ({ x: p.t, y: p[s] })) })), refs, xFmt: hm, empty: 'La gráfica se llena con cada actualización (cada 5 s en vivo) mientras la app está abierta.' });
  }
  // 2) Precio en Polymarket a lo largo del tiempo (movimiento del mercado).
  const src = pmSource(a), ph = S.pmHist.get(k);
  if (src && !ph) loadPmHist(a);
  const pmChart = !src ? '<div class="chart-empty note">Este partido no tiene mercado en Polymarket.</div>'
    : !ph || ph.busy && !ph.home ? '<div class="shimmer"></div><div class="shimmer"></div>'
    : ph.error ? `<div class="warn">${esc(ph.error)}</div>`
    : lineChart('pm-' + k, { series: ['home', 'away', 'draw'].filter((s) => ph[s]?.length).map((s) => ({ name: nm[s], color: C[s], pts: ph[s].map((p) => ({ x: p.t, y: p.p })) })), refs, xFmt: dm, empty: 'Polymarket todavía no tiene operaciones en este mercado.' });
  // 3) Comparativa de estadísticas (ESPN) y forma reciente.
  const stats = sum && !sum.error ? tabStats(a, sum) : '<div class="shimmer"></div>';
  return `${botConclusionBox(a)}
    <div class="widget mt chart-card"><h3>Probabilidad de ganar ${wp.length > 2 ? '· jugada por jugada (ESPN)' : '· estimación del bot'}</h3>${liveChart}</div>
    <div class="widget mt chart-card"><h3><img class="src-ic" src="https://polymarket.com/icons/favicon-32x32.png" alt=""> Precio en Polymarket · historial</h3>${pmChart}
      <div class="note">Precio = probabilidad que paga el mercado con dinero real. Si sube antes del partido, entró dinero de ese lado.</div></div>
    ${xgBlock(a)}
    <div class="widget mt chart-card"><h3>Comparativa del partido</h3>${stats}</div>
    ${advancedBlock(a)}`;
}

// ---------- Jugadores y contexto previo (ESPN y MLB Stats API) ----------
// Jugadores clave con promedios, bajas y si juegan, descanso, récord de local/visita, serie entre ellos,
// abridores y alineación confirmada. Se cargan en segundo plano para los partidos de las próximas 36 h
// y al abrir un partido; con eso el modelo se ajusta por bajas y descanso (con tope).
S.ctx = new Map();
const CTX_SPORTS = ['soccer', 'football', 'basketball', 'baseball'];
async function loadCtx(a, force = false) {
  const ev = a.ev, k = key(ev), lg = D.leagueById(ev.leagueId);
  if (!CTX_SPORTS.includes(ev.sport) || ev.state === 'post') return null;
  const cur = S.ctx.get(k);
  if (cur && (cur.busy || (!force && Date.now() - cur.t < 30 * 60_000))) return cur;
  S.ctx.set(k, { ...(cur || {}), busy: true, t: Date.now() });
  try {
    const sum = S.summaries.get(k) && !S.summaries.get(k).error ? S.summaries.get(k) : await D.getSummary(lg, ev.id).catch(() => null);
    const ctx = await getContext(lg, ev, sum);
    S.ctx.set(k, ctx ? { ...ctx, busy: false } : { t: Date.now(), busy: false, none: true });
    // Se recalcula el partido con el ajuste (si el partido sigue en la lista).
    const now = (S.events.get(lg.id) || []).find((e) => e.id === ev.id);
    if (now && now.state === 'pre') analyze(now, S.tables.get(lg.id), S.summaries.get(k)?.winProb);
  } catch (e) { S.ctx.set(k, { t: Date.now(), busy: false, error: e.message }); }
  return S.ctx.get(k);
}
let ctxBusy = false;
async function scanContext() {
  if (ctxBusy) return;
  ctxBusy = true;
  try {
    const soon = Date.now() + 36 * 3600_000;
    const list = allAnalyses().filter((a) => CTX_SPORTS.includes(a.ev.sport) && a.ev.state === 'pre' && new Date(a.ev.date).getTime() < soon)
      .filter((a) => { const c = S.ctx.get(key(a.ev)); return !c || (!c.busy && Date.now() - c.t > 30 * 60_000); })
      .slice(0, 10);
    for (const a of list) await loadCtx(a);
    if (list.length && ['home', 'soccer', 'sports'].includes(S.tab)) render();
  } catch (e) { console.warn('contexto', e); }
  ctxBusy = false;
}

function tabPlayers(a) {
  const ev = a.ev, k = key(ev), c = S.ctx.get(k);
  if (!c || (c.busy && !c.home)) { loadCtx(a).then(() => { if (S.open === k && S.sheetTab === 'players') renderSheet(); }); return '<div class="shimmer"></div><div class="shimmer"></div><div class="note">Buscando jugadores clave, bajas y descanso…</div>'; }
  if (c.error && !c.home) return `<div class="warn">No se pudo cargar el contexto: ${esc(c.error)}</div>`;
  if (c.none) return '<div class="empty">Sin datos de jugadores para este partido.</div>';
  const nm = { home: ev.home.name, away: ev.away.name };
  const rec = (s) => { const r = c.records?.[s] || {}; return [r.total ? `Total ${r.total}` : '', s === 'home' && r.home ? `De local ${r.home}` : '', s === 'away' && (r.road || r.away) ? `De visita ${r.road || r.away}` : ''].filter(Boolean).join(' · ') || '—'; };
  const restTxt = (r) => (!r ? '—' : r.days <= 1 ? `<b class="down">${r.days} día · back-to-back</b>` : `${r.days} días${r.last7 >= 3 ? ` · ${r.last7} partidos en 7 días` : ''}`);
  const stTag = (st) => (!st ? '<span class="tag value">Juega</span>' : st.miss >= 0.75 ? `<span class="tag live">${esc(st.text)}</span>` : st.miss >= 0.3 ? `<span class="tag gold">${esc(st.text)}</span>` : `<span class="tag">${esc(st.text)}</span>`);
  const ctxRows = `<table class="t ctx-table"><thead><tr><th></th><th>${esc(nm.home)}</th><th>${esc(nm.away)}</th></tr></thead><tbody>
    <tr><td>Descanso</td><td>${restTxt(c.home.rest)}</td><td>${restTxt(c.away.rest)}</td></tr>
    <tr><td>Récord</td><td>${esc(rec('home'))}</td><td>${esc(rec('away'))}</td></tr>
    ${ev.sport === 'baseball' ? `<tr><td>Abridor</td>${['home', 'away'].map((s) => { const p = c[s].pitcher; return `<td>${p ? `<b>${esc(p.name)}</b><div class="note">ERA ${p.era ?? '—'} · WHIP ${p.whip ?? '—'} · ${p.ip || 0} IP · ${p.k ?? 0} K${p.lastEra != null ? ` · últimas 3: ERA ${p.lastEra}` : ''}</div>` : '<span class="note">Sin anunciar</span>'}</td>`; }).join('')}</tr>` : ''}
    <tr><td>Bajas</td><td>${c.home.injuries?.length || 0}</td><td>${c.away.injuries?.length || 0}</td></tr>
  </tbody></table>
  ${c.series?.length ? `<div class="note mt">Serie entre ellos: <b>${c.series.map(esc).join(' · ')}</b></div>` : ''}
  ${c.predictor ? `<div class="note">Pronóstico de ESPN: ${esc(nm.home)} ${pct(c.predictor.home)} · ${esc(nm.away)} ${pct(c.predictor.away)}</div>` : ''}`;
  const adj = c.adj?.list?.length ? `<div class="widget mt ctx-adj"><h3>Ajuste del bot por contexto</h3><ul class="report-list">${c.adj.list.map((x) => `<li>${x.sum ? `<b>${esc(nm[x.side])}</b>: ${esc(x.text)}` : `<span class="note">${esc(nm[x.side])} · ${esc(x.text)}</span>`}</li>`).join('')}</ul>
    <div class="note mt">Cambio en la probabilidad de ${esc(nm.home)} según su modelo: <b>${c.adj.delta >= 0 ? '+' : ''}${(c.adj.delta * 100).toFixed(1)} pts</b> (tope prudente). Solo corrige al modelo: el mercado ya descuenta las bajas.</div></div>`
    : '<div class="note mt">Sin bajas importantes ni diferencias de descanso: el bot no ajusta su modelo.</div>';
  const team = (s) => {
    const t = c[s];
    const players = (t.players || []).map((p) => `<div class="pl-row ${p.status?.miss >= 0.75 ? 'out' : ''}">${p.headshot ? `<img class="avatar" src="${esc(p.headshot)}" alt="" loading="lazy">` : '<span class="avatar ph"></span>'}
      <div class="grow"><b>${esc(p.name)}</b>${p.role ? ` <span class="note">${esc(p.role)}</span>` : ''}<div class="note">${esc(p.line || '')}</div>${p.detail ? `<div class="note down">${esc(p.detail)}</div>` : ''}</div>${stTag(p.status)}</div>`).join('');
    const others = (t.injuries || []).filter((i) => !(t.players || []).some((p) => p.name === i.name)).slice(0, 10);
    return `<div class="widget mt" style="background:var(--fill)"><h3>${esc(nm[s])}${t.season ? ` <span class="note" style="text-transform:none;letter-spacing:0">temporada ${esc(t.season)}</span>` : ''}</h3>
      ${players || (ev.sport === 'baseball' || ev.sport === 'soccer' ? '' : '<div class="note">ESPN aún no publica estadísticas por jugador de este equipo.</div>')}
      ${t.lineup?.length ? `<div class="mt"><b>Alineación confirmada</b><ol class="note lineup-ol">${t.lineup.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>` : ''}
      ${others.length ? `<div class="mt"><b>Otras bajas y dudas</b>${others.map((i) => `<div class="flex" style="padding:3px 0">${stTag(i.status)} ${esc(i.name)}${i.pos ? ` <span class="note">${esc(i.pos)}</span>` : ''}${i.detail ? ` <span class="note">· ${esc(i.detail)}</span>` : ''}</div>`).join('')}</div>` : (!players ? '<div class="note">Sin bajas reportadas.</div>' : '')}
    </div>`;
  };
  return `<div class="widget" style="background:var(--fill)"><h3>Contexto del partido</h3>${ctxRows}</div>${adj}
    <div class="grid halves">${team('home')}${team('away')}</div>
    <div class="note mt">Fuentes: ESPN${ev.sport === 'baseball' ? ' y MLB Stats API' : ''}. Se actualiza cada 30 min; el bot también lo usa antes de cada partido.${ev.sport === 'soccer' ? ' Para estadísticas de jugadores de fútbol (xG, pases) ve a 📈 Gráficas (365Scores).' : ''}</div>`;
}

// ---------- Datos avanzados y fuentes externas ----------
// Transfermarkt (valor de plantilla) se lee automáticamente porque lo permite; SofaScore, FBref, FotMob y Understat
// no permiten lectura automática, así que se abren con un botón (en tu navegador, como cualquier visita).
S.tm = new Map();
async function loadTm(a) {
  const k = key(a.ev);
  if (S.tm.has(k)) return;
  S.tm.set(k, { busy: true });
  const [h, w] = await Promise.all([D.squadValue(a.ev.home.name), D.squadValue(a.ev.away.name)]);
  S.tm.set(k, { home: h, away: w });
  if (S.open === k && S.sheetTab === 'charts') renderSheet();
}
const UNDERSTAT = { 'eng.1': 'EPL', 'esp.1': 'La_liga', 'ita.1': 'Serie_A', 'fra.1': 'Ligue_1' };
function sourceLinks(a) {
  const ev = a.ev, q = `${ev.home.name} ${ev.away.name}`;
  // "\" en DuckDuckGo abre directo el primer resultado de ese sitio (la página del partido o del equipo).
  const go = (site, query = q) => `https://duckduckgo.com/?q=${encodeURIComponent('\\site:' + site + ' ' + query)}`;
  const L = [];
  if (ev.sport === 'soccer') {
    L.push(['SofaScore', go('sofascore.com'), 'Momentum, mapa de calor y calificaciones']);
    L.push(['FotMob', go('fotmob.com'), 'xG, tiros y alineaciones con calificación']);
    L.push(['FBref', `https://fbref.com/search/search.fcgi?search=${encodeURIComponent(ev.home.name)}`, 'Estadísticas avanzadas de temporada']);
    if (UNDERSTAT[ev.leagueId]) L.push(['Understat', `https://understat.com/league/${UNDERSTAT[ev.leagueId]}`, 'xG y xGA de la liga']);
    L.push(['Transfermarkt', `https://www.transfermarkt.es/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(ev.home.name)}`, 'Plantilla, lesiones y valores']);
    L.push(['BDFA', go('bdfa.com.ar', ev.home.name), 'Base de datos histórica']);
    L.push(['dataref', 'https://dataref.net/', 'Argentinos en el mundo']);
  } else if (ev.sport === 'esports') {
    const wiki = { cs2: 'counterstrike', valorant: 'valorant', lol: 'leagueoflegends' }[ev.game] || 'counterstrike';
    L.push(['Liquipedia', `https://liquipedia.net/${wiki}/index.php?search=${encodeURIComponent(ev.home.name)}`, 'Torneo, plantillas y resultados']);
    if (ev.game === 'valorant') L.push(['vlr.gg', `https://www.vlr.gg/search/?q=${encodeURIComponent(ev.home.name)}`, 'Mapas, rondas y estadísticas']);
    if (ev.game !== 'lol') L.push(['bo3.gg', go('bo3.gg'), 'Mapas y estadísticas']);
  } else {
    L.push(['SofaScore', go('sofascore.com'), 'Estadísticas y momentum']);
  }
  return `<div class="src-links">${L.map(([n, u, d]) => `<a class="src-link" href="${esc(u)}" target="_blank" rel="noopener"><b>${esc(n)} ↗</b><span class="note">${esc(d)}</span></a>`).join('')}</div>`;
}
// ---------- xG de 365Scores ----------
// key -> { game: {id, homeId, awayId}, data (xG del partido, remates, estadísticas), form: {home, away}, t, busy }
S.x365 = new Map();
function attachX365(ev) {
  const r = S.x365.get(key(ev));
  if (!r) return;
  if (r.form?.home && r.form?.away) ev.xgForm = r.form;
  if (ev.state === 'in' && r.data?.xg) ev.liveXg = r.data.xg;
}
async function loadX365(ev, { data = false, form = false } = {}) {
  if (ev.sport !== 'soccer' || !X.COMP365[ev.leagueId]) return null;
  const k = key(ev);
  const r = S.x365.get(k) || {};
  if (r.busy) return r;
  r.busy = true; S.x365.set(k, r);
  try {
    if (!r.game) r.game = await X.findGame(ev);
    if (r.game) {
      if (data && (ev.state !== 'pre')) r.data = await X.gameData(r.game.id, r.game.homeId, r.game.awayId, ev.state === 'post');
      if (form && !r.form) {
        const [h, w] = await Promise.all([X.teamForm(r.game.homeId), X.teamForm(r.game.awayId)]);
        if (h.n || w.n) r.form = { home: h, away: w }; // si falló la consulta, se vuelve a intentar después
      }
    }
    r.t = Date.now(); r.error = null;
  } catch (e) { r.error = e.message; }
  r.busy = false;
  attachX365(ev);
  // Con el xG ya disponible, se recalcula el modelo de este partido.
  if (ev.xgForm || ev.liveXg) { const cur = S.analysis.get(k); if (cur) analyze(cur.ev === ev ? ev : (attachX365(cur.ev), cur.ev), S.tables.get(ev.leagueId), S.summaries.get(k)?.winProb); }
  return r;
}
// Antes del partido: forma de xG de los equipos de las próximas 48 h (pocos por escaneo; luego queda guardado).
let x365Busy = false;
async function scanX365() {
  if (x365Busy) return;
  x365Busy = true;
  try {
    const soon = Date.now() + 48 * 3600_000;
    const list = allAnalyses().filter((a) => a.ev.sport === 'soccer' && X.COMP365[a.ev.leagueId] && a.ev.state !== 'post' && new Date(a.ev.date).getTime() < soon && !S.x365.get(key(a.ev))?.form)
      .sort((x, y) => new Date(x.ev.date) - new Date(y.ev.date)).slice(0, 4);
    for (const a of list) { await loadX365(a.ev, { form: true, data: a.ev.state === 'in' }); analyze(a.ev, S.tables.get(a.ev.leagueId), S.summaries.get(key(a.ev))?.winProb); }
  } finally { x365Busy = false; }
}
// En vivo: xG y estadísticas del partido cada ~15 s (el servidor y este módulo guardan las respuestas).
async function liveX365() {
  const live = allAnalyses().filter((a) => a.ev.sport === 'soccer' && a.ev.state === 'in' && X.COMP365[a.ev.leagueId]).slice(0, 8);
  for (const a of live) { const r = S.x365.get(key(a.ev)); if (!r?.t || Date.now() - r.t > 14_000) await loadX365(a.ev, { data: true, form: true }); }
}

function xgBlock(a) {
  const ev = a.ev, k = key(ev);
  if (ev.sport !== 'soccer' || !X.COMP365[ev.leagueId]) return '';
  const r = S.x365.get(k);
  // Solo se pide si no hay nada cargando (si no, se repintaría sin parar mientras carga).
  const needLoad = !r || (!r.busy && ((!r.t && !r.error) || (ev.state === 'in' && Date.now() - (r.t || 0) > 20_000)));
  if (needLoad) loadX365(ev, { data: true, form: true }).then(() => { if (S.open === k && S.sheetTab === 'charts') renderSheet(); });
  if (!r || (!r.t && !r.error)) return '<div class="widget mt chart-card"><h3>Goles esperados (xG) · 365Scores</h3><div class="shimmer"></div><div class="shimmer"></div></div>';
  if (!r.game) return `<div class="widget mt chart-card"><h3>Goles esperados (xG) · 365Scores</h3><div class="note">${r.error ? esc(r.error) : '365Scores no tiene este partido.'}</div></div>`;
  const C = { home: 'var(--blue)', away: 'var(--orange-fill)' };
  let flow = '', xp = '', stats = '';
  const d = r.data;
  if (d?.shots?.length) {
    // Flujo de xG: suma de la calidad de las ocasiones de cada equipo, minuto a minuto (⚽ = gol).
    const end = Math.max(90, d.minute || 0, ...d.shots.map((s) => s.min));
    const series = ['home', 'away'].map((side) => {
      // La suma de los remates no siempre coincide con el xG oficial del partido (365Scores lo ajusta):
      // se escala la curva para que termine en el xG oficial y los números sean los mismos en toda la pestaña.
      const own = d.shots.filter((x) => x.side === side), raw = own.reduce((a, x) => a + x.xg, 0);
      const k2 = d.xg?.[side] != null && raw > 0 ? d.xg[side] / raw : 1;
      let acc = 0; const pts = [{ x: 0, y: 0 }], marks = [];
      for (const s of own) { acc += s.xg * k2; pts.push({ x: s.min, y: acc }); if (s.goal) marks.push({ x: s.min, y: acc, label: '⚽' }); }
      pts.push({ x: ev.state === 'post' ? end : Math.max(d.minute || 0, pts[pts.length - 1].x), y: acc });
      return { name: ev[side].name, color: C[side], step: true, marks, pts };
    });
    const ymax = Math.max(1, Math.ceil(Math.max(...series.map((s) => s.pts[s.pts.length - 1].y)) * 2) / 2);
    flow = lineChart('xg-' + k, { series, xFmt: (x) => `Min ${Math.round(x)}`, yFmt: (y) => y.toFixed(2) + ' xG', yMax: ymax, yTick: (v) => v.toFixed(1) });
  } else if (ev.state !== 'pre') flow = '<div class="chart-empty note">365Scores todavía no publica los remates con xG de este partido.</div>';
  if (d?.xg) {
    // xPoints: con el xG de cada equipo, ¿cuántos puntos "merecía" cada uno? (Poisson, como en los notebooks de LanusStats)
    const x = X.xPoints(d.xg.home, d.xg.away);
    xp = `<div class="opp-nums mt"><div>xG ${esc(ev.home.name)}<b>${d.xg.home.toFixed(2)}</b></div><div>xG ${esc(ev.away.name)}<b>${d.xg.away.toFixed(2)}</b></div>
      <div>xPoints ${esc(ev.home.abbr || ev.home.name)}<b>${x.home.toFixed(2)}</b></div><div>xPoints ${esc(ev.away.abbr || ev.away.name)}<b>${x.away.toFixed(2)}</b></div></div>
      <div class="note">Con estas ocasiones, ${esc(ev.home.name)} gana el ${pct(x.pHome)} de las veces, empate ${pct(x.pDraw)} y ${esc(ev.away.name)} ${pct(x.pAway)}. ${ev.state === 'post' ? 'Si el marcador no coincide, hubo suerte o puntería: útil para el próximo partido.' : ''}</div>`;
    const want = [76, 79, 3, 4, 24, 36, 10, 46, 78];
    const rows = want.map((id) => d.stats.find((s) => s.id === id)).filter(Boolean);
    stats = rows.map((s) => { const x1 = parseFloat(s.home), y1 = parseFloat(s.away), tot = (x1 || 0) + (y1 || 0) || 1;
      return `<div class="statrow"><div class="lbl">${esc(s.name)}</div><div class="v">${esc(s.home ?? '—')}</div><div class="bars"><span style="flex:${(x1 || 0) / tot || 0.5};background:var(--blue)"></span><span style="flex:${(y1 || 0) / tot || 0.5};background:var(--orange-fill)"></span></div><div class="v">${esc(s.away ?? '—')}</div></div>`; }).join('');
  }
  // Forma reciente (promedio móvil de xG de los últimos partidos oficiales).
  const fm = r.form;
  const formRow = (side) => { const f = fm?.[side]; if (!f?.n) return ''; return `<tr><td><b>${esc(ev[side].name)}</b><div class="note">${f.series.map((s) => `${s.for?.toFixed(1)}-${s.against?.toFixed(1)}`).join(' · ')}</div></td><td class="num">${f.for.toFixed(2)}</td><td class="num">${f.against.toFixed(2)}</td><td class="num ${f.for - f.against >= 0 ? 'up' : 'down'}">${(f.for - f.against >= 0 ? '+' : '') + (f.for - f.against).toFixed(2)}</td><td class="num">${f.n}</td></tr>`; };
  const form = fm?.home?.n || fm?.away?.n ? `<table class="t mt"><thead><tr><th>Forma xG (últimos oficiales)</th><th class="num">xG a favor</th><th class="num">xG en contra</th><th class="num">Diferencia</th><th class="num">Partidos</th></tr></thead><tbody>${formRow('home')}${formRow('away')}</tbody></table>
    ${a.model.xg ? `<div class="note">El modelo usa este xG con ${pct(a.model.xg.w)} de peso: goles esperados ${a.model.lh.toFixed(2)} - ${a.model.la.toFixed(2)} (solo con la tabla serían ${a.model.xg.base.lh.toFixed(2)} - ${a.model.xg.base.la.toFixed(2)}).</div>` : ''}` : '';
  return `<div class="widget mt chart-card"><h3>Goles esperados (xG) · 365Scores${ev.state === 'in' ? ' · en vivo' : ''}</h3>${flow}${xp}${stats}${form}
    <div class="note mt">xG = probabilidad de gol de cada remate según su posición y tipo. La suma mide la calidad real de las ocasiones, con menos suerte que el marcador.</div></div>`;
}

function advancedBlock(a) {
  const ev = a.ev, k = key(ev);
  let tm = '';
  if (ev.sport === 'soccer') {
    const t = S.tm.get(k);
    if (!t) loadTm(a);
    if (!t || t.busy) tm = '<div class="shimmer"></div>';
    else if (t.home?.value && t.away?.value) {
      const tot = t.home.value + t.away.value, fmt = (v) => (v >= 1e6 ? '€' + (v / 1e6).toFixed(1) + ' M' : '€' + Math.round(v / 1e3) + ' mil');
      tm = `<div class="statrow"><div class="lbl">Valor de la plantilla (Transfermarkt)</div><div class="v">${fmt(t.home.value)}</div><div class="bars"><span style="flex:${t.home.value / tot};background:var(--blue)"></span><span style="flex:${t.away.value / tot};background:var(--orange-fill)"></span></div><div class="v">${fmt(t.away.value)}</div></div>
        <div class="note">${esc(ev.home.name)}: ${t.home.squad || '—'} jugadores · ${esc(ev.away.name)}: ${t.away.squad || '—'} jugadores. La plantilla más valiosa ${t.home.value > t.away.value ? 'es la de ' + esc(ev.home.name) : 'es la de ' + esc(ev.away.name)} (${(Math.max(t.home.value, t.away.value) / Math.min(t.home.value, t.away.value)).toFixed(1)} veces).</div>`;
    } else tm = '<div class="note">Transfermarkt no encontró el valor de alguno de los equipos.</div>';
  }
  return `<div class="widget mt chart-card"><h3>Datos avanzados</h3>${tm}${sourceLinks(a)}</div>`;
}

function tabStats(a, sum) {
  const lf = (sum.lastFive || []).filter((t) => t.games.length);
  const formHtml = lf.length ? `<div class="grid halves mt">${lf.map((t) => `<div class="widget" style="background:var(--fill)"><h3>Últimos 5 · ${esc(t.team)}</h3>${t.games.map((g) => `<div class="flex" style="padding:3px 0"><span class="tag ${g.result === 'W' ? 'value' : g.result === 'L' ? 'live' : ''}">${{ W: 'G', L: 'P', D: 'E' }[g.result] || esc(g.result || '')}</span> ${esc(g.score || '')} <span class="note">vs ${esc(g.opp || '')}</span></div>`).join('')}</div>`).join('')}</div>` : '';
  const st = sum.stats || [];
  if (st.length < 2 || !Object.keys(st[0].stats).length) return (formHtml || '<div class="empty">Estadísticas disponibles cuando empiece el partido.</div>');
  const [h, aw] = a.ev.home && st[0].teamId === String(a.ev.away.id) ? [st[1], st[0]] : [st[0], st[1]];
  const keys = Object.keys(h.stats).filter((k) => aw.stats[k] != null).slice(0, 24);
  const rows = keys.map((k) => {
    const x = parseFloat(String(h.stats[k]).replace('%', '')), y = parseFloat(String(aw.stats[k]).replace('%', ''));
    const tot = (Number.isFinite(x) ? x : 0) + (Number.isFinite(y) ? y : 0) || 1;
    return `<div class="statrow"><div class="lbl">${esc(k)}</div><div class="v">${esc(h.stats[k])}</div><div class="bars"><span style="flex:${Number.isFinite(x) ? x / tot : 0.5};background:var(--blue)"></span><span style="flex:${Number.isFinite(y) ? y / tot : 0.5};background:var(--orange-fill)"></span></div><div class="v">${esc(aw.stats[k])}</div></div>`;
  }).join('');
  return `<div class="legend" style="justify-content:space-between"><span><i style="background:var(--blue)"></i>${esc(h.team)}</span><span><i style="background:var(--orange-fill)"></i>${esc(aw.team)}</span></div>${rows}${formHtml}`;
}

function tabFeed(sum) {
  const items = (sum.commentary?.length ? sum.commentary : [...(sum.keyEvents || [])].reverse());
  if (!items.length) return '<div class="empty">Sin narración disponible todavía.</div>';
  return `<div class="feed">${items.slice(0, 150).map((c) => `<div class="it"><div class="c">${esc(c.clock)}</div><div>${c.type ? `<b>${esc(c.type)}</b> · ` : ''}${esc(c.text)}</div></div>`).join('')}</div>`;
}

async function loadMatchNews(a) {
  const sum = S.summaries.get(key(a.ev));
  const q = a.ev.sport === 'tennis' ? `${a.ev.home.name} ${a.ev.away.name} tenis` : `${a.ev.home.name} ${a.ev.away.name}`;
  const g = await D.searchNews(q, 12);
  const el = $('#match-news');
  if (!el) return;
  el.innerHTML = `<div class="grid halves"><div><h3 class="note">ESPN</h3>${newsList(sum?.news || [])}</div><div><h3 class="note">Google News</h3>${newsList(g)}</div></div>`;
}

function tabAI(a) {
  const r = S.ai.get(key(a.ev));
  if (!aiReady()) return `<div class="ai-card"><b>✦ Analista IA desactivado</b><p class="note">Para que Claude analice partidos, busque noticias en internet y decida en tiempo real:</p><ol class="note"><li>Crea una clave en console.anthropic.com</li><li>Pégala en <b>Más → Ajustes → Claves</b> (desde la PC)</li></ol><button class="btn small" data-tab="more" data-more-tab="settings" data-close>Ir a Ajustes</button></div>`;
  if (r === 'loading') return `<div class="ai-card"><b>✦ Claude está analizando…</b><div class="note">Revisa estadísticas, alineaciones, momios y busca noticias recientes. Toma de 20 a 60 segundos.</div><div class="shimmer"></div><div class="shimmer"></div><div class="shimmer"></div></div>`;
  if (!r || r.error) return `<div class="ai-card"><b>✦ Análisis con IA</b><p class="note">Claude combina el modelo del bot, la tabla, la forma, las alineaciones, las lesiones y noticias de internet de último minuto, y te dice si hay una apuesta con valor y a qué momio mínimo.</p>${r?.error ? `<div class="warn">${esc(r.error)}</div>` : ''}<button class="btn primary mt" data-ai-run="${key(a.ev)}">Analizar este partido</button></div>`;
  const sel = a.sels.find((s) => s.pick === r.seleccion);
  const stake = Math.max(B.getState().settings.minStake, Math.floor((B.getState().bankroll * r.stake_pct) / 5) * 5);
  return `<div class="ai-card">
    <div class="flex"><span class="tag ${r.decision === 'apostar' ? 'value' : r.decision === 'esperar' ? 'gold' : 'live'}" style="font-size:13px">${{ apostar: 'APOSTAR', no_apostar: 'NO APOSTAR', esperar: 'ESPERAR' }[r.decision]}</span><b>${esc(r.seleccion_texto)}</b><span class="spacer"></span><span class="note">Confianza ${r.confianza}/10 · riesgo ${esc(r.riesgo)}</span></div>
    <p>${esc(r.resumen)}</p>
    <div class="opp-nums"><div>Probabilidad IA<b>${pct(r.probabilidad, 1)}</b></div><div>Momio mínimo<b>${dec(r.momio_minimo)} <span class="note">${toAmerican(r.momio_minimo)}</span></b></div><div>Monto sugerido<b>${r.decision === 'apostar' ? money(stake) : '—'}</b></div></div>
    <div class="grid halves mt"><div><b class="up">A favor</b><ul>${r.factores_a_favor.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div><div><b class="down">En contra</b><ul>${r.factores_en_contra.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>
    ${r.noticias_clave.length ? `<div class="mt"><b>Noticias clave</b><ul>${r.noticias_clave.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${r.sources?.length ? `<div class="note mt">Fuentes: ${r.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join(' · ')}</div>` : ''}
    <div class="flex mt">${r.decision === 'apostar' && sel ? `<button class="btn primary" data-slip="${key(a.ev)}|${sel.pick}" data-aistake="${stake}">Apostar recomendación</button>` : ''}<button class="btn" data-ai-run="${key(a.ev)}">Volver a analizar</button><span class="note">${new Date(r.t).toLocaleTimeString('es-MX')} · ${esc(r.model)}</span></div>
  </div>`;
}

// ---------- Peleas: peleadores, mercados y especialistas ----------
async function fighterData(t) {
  if (!t.athleteId) return null;
  if (!S.fighters.has(t.athleteId)) S.fighters.set(t.athleteId, await D.getFighter(t.athleteId).catch(() => null));
  return S.fighters.get(t.athleteId);
}

async function loadFighters(a) {
  const box = $('#fighters-box');
  if (!box) return;
  const ev = a.ev;
  if (ev.sport === 'boxing') { box.innerHTML = '<div class="widget glass empty">Para boxeo no hay una fuente gratuita de estadísticas por peleador. Revisa la pestaña Especialistas para análisis y pronósticos.</div>'; return; }
  const [h, w] = await Promise.all([fighterData(ev.home), fighterData(ev.away)]);
  if (!$('#fighters-box')) return;
  if (!h && !w) { box.innerHTML = '<div class="widget glass empty">ESPN no tiene estadísticas de estos peleadores todavía.</div>'; return; }
  const num = (x, d = 0) => (x == null || !Number.isFinite(Number(x)) ? '—' : Number(x).toFixed(d));
  // better: 1 = más alto es mejor, -1 = más bajo es mejor, 0 = sin comparación
  const row = (label, x, y, fmt = (v) => v ?? '—', better = 0) => {
    const nx = Number(x), ny = Number(y);
    const cmp = better && Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny ? (better * (nx - ny) > 0 ? 'l' : 'r') : '';
    return `<div class="cmp-row"><div class="l ${cmp === 'l' ? 'better' : ''}">${fmt(x)}</div><div class="c">${label}</div><div class="r ${cmp === 'r' ? 'better' : ''}">${fmt(y)}</div></div>`;
  };
  const pctF = (v) => (v == null ? '—' : num(v, 0) + '%');
  const side = (t, f) => `<div class="fh"><img src="${esc(f?.headshot || t.logo)}" alt="" onerror="this.style.visibility='hidden'"><div class="fn">${esc(t.name)}</div>${f?.nickname ? `<div class="note">"${esc(f.nickname)}"</div>` : ''}<div class="note">${esc([t.record, f?.country || t.flag].filter(Boolean).join(' · '))}</div>${(t.belts || []).length ? `<div class="tag title-fight" style="margin-top:4px">🏆 Campeón</div>` : ''}</div>`;
  box.innerHTML = `<div class="widget" style="background:var(--fill)">
    <div class="fighter-cmp">${side(ev.home, h)}<div class="c" style="align-self:center;font-weight:800;color:var(--text-2)">VS</div>${side(ev.away, w)}</div>
    <h3 class="mt">Cómo ganan</h3>
    ${row('Victorias por KO/TKO', h?.kos, w?.kos, (v) => num(v), 1)}
    ${row('Victorias por sumisión', h?.subs, w?.subs, (v) => num(v), 1)}
    ${row('% por KO/TKO', h?.koPct, w?.koPct, pctF, 1)}
    ${row('% por decisión', h?.decPct, w?.decPct, pctF, 0)}
    ${row('Derrotas por KO/TKO', h?.koLosses, w?.koLosses, (v) => num(v), -1)}
    ${row('Derrotas por sumisión', h?.subLosses, w?.subLosses, (v) => num(v), -1)}
    ${row('Peleas de título ganadas', h?.titleWins, w?.titleWins, (v) => num(v), 1)}
    <h3 class="mt">Estilo</h3>
    ${row('Golpes significativos/min', h?.strikeLPM, w?.strikeLPM, (v) => num(v, 2), 1)}
    ${row('Precisión de golpeo', h?.strikeAcc, w?.strikeAcc, pctF, 1)}
    ${row('Derribos por pelea', h?.tdAvg, w?.tdAvg, (v) => num(v, 2), 1)}
    ${row('Precisión de derribo', h?.tdAcc, w?.tdAcc, pctF, 1)}
    ${row('Intentos de sumisión', h?.subAvg, w?.subAvg, (v) => num(v, 2), 1)}
    <h3 class="mt">Físico</h3>
    ${row('Edad', h?.age, w?.age, (v) => num(v), -1)}
    ${row('Estatura', h?.height, w?.height)}
    ${row('Alcance', h?.reach, w?.reach)}
    ${row('Guardia', h?.stance, w?.stance)}
    ${row('Equipo', h?.team, w?.team)}
    <div class="note mt">En verde, quién tiene ventaja en cada dato. Fuente: ESPN. Ojo: las estadísticas no dicen contra quién se lograron.</div></div>`;
}

function tabFightMarkets(a) {
  const ev = a.ev, pm = ev.pm;
  const links = (pm?.sources || []).map((s) => `<a class="btn small" href="${esc(s.url)}" target="_blank" rel="noopener">Ver en ${esc(s.source)} ↗</a>`).join('');
  const props = (pm?.sources || []).flatMap((s) => (s.props || []).map((p) => ({ ...p, source: s.source })));
  const propLabel = (q) => String(q).replace(/^Fight to Go the Distance\?$/i, '¿La pelea llega a la decisión?').replace(/^Will the fight be won by KO or TKO\?$/i, '¿Termina por KO/TKO?')
    .replace(/^Will the fight be won by submission\?$/i, '¿Termina por sumisión?').replace(/^Will (.+) win by KO or TKO\?$/i, '¿$1 gana por KO/TKO?')
    .replace(/^Will (.+) win by submission\?$/i, '¿$1 gana por sumisión?').replace(/^O\/U ([\d.]+) Rounds$/i, 'Más/menos de $1 rounds');
  const propRows = props.map((p) => {
    const yes = p.names[0] === 'Over' ? 'Más' : 'Sí';
    const thin = !p.traded || (p.prices[0] === 0.5 && p.prices[1] === 0.5);
    return `<div class="prop-row"><div>${esc(propLabel(p.q))}<div class="note">${esc(p.source)}${thin ? ' · poco operado (precio poco confiable)' : ''}</div></div><div class="pp">${pct(p.prices[0])}</div><div class="note">${yes} · momio ${p.prices[0] > 0.02 ? dec(1 / p.prices[0]) : '—'}</div></div>`;
  }).join('');
  const books = ev.odds ? `<div class="widget mt" style="background:var(--fill)"><h3>Casas (mejor precio · ${esc(ev.odds.provider)})</h3>
      <div class="prop-row"><div><b>${esc(ev.home.name)}</b>${ev.odds.books?.home ? `<div class="note">${esc(ev.odds.books.home)}</div>` : ''}</div><div class="pp">${dec(ev.odds.home)}</div><div class="note">${toAmerican(ev.odds.home)}</div></div>
      <div class="prop-row"><div><b>${esc(ev.away.name)}</b>${ev.odds.books?.away ? `<div class="note">${esc(ev.odds.books.away)}</div>` : ''}</div><div class="pp">${dec(ev.odds.away)}</div><div class="note">${toAmerican(ev.odds.away)}</div></div></div>`
    : `<div class="note mt">${S.cfg.hasOdds ? 'The Odds API todavía no publica momios de esta pelea.' : 'Agrega tu clave de The Odds API en Ajustes para ver momios de casas.'}</div>`;
  return `${links ? `<div class="pm-links">${links}</div>` : '<div class="note">Polymarket y Kalshi no tienen mercado de esta pelea todavía.</div>'}
    <div class="mt">${predictionBlock(a)}</div>
    ${smartBlock(a)}${eventSmartSummary(a)}
    ${books}
    ${propRows ? `<div class="widget mt" style="background:var(--fill)"><h3>¿Cómo termina? (Polymarket)</h3>${propRows}
      <div class="note mt">Probabilidad que el dinero real asigna a cada forma de terminar. Compárala con el % de KO y decisiones de cada peleador (pestaña Peleadores).</div></div>` : ''}
    <div class="note mt">Para apostar en México: captura en el boleto el momio de Caliente, Codere o bet365 y el bot te dice si hay valor.</div>`;
}

async function loadExperts(a) {
  const ev = a.ev;
  const q = `"${ev.home.name.split(' ').slice(-1)[0]}" "${ev.away.name.split(' ').slice(-1)[0]}"`;
  const [es, en] = await Promise.all([
    D.searchNews(`${q} pronóstico OR predicción OR análisis OR apuesta`, 8),
    D.searchNews(`${q} prediction OR picks OR breakdown OR odds`, 10, 'en'),
  ]);
  const box = $('#experts-box');
  if (!box) return;
  box.innerHTML = `<div class="note" style="margin-bottom:8px">Pronósticos y análisis de medios especializados (MMA Junkie, MMA Fighting, Sherdog, ESPN, medios en español). Úsalos como contexto: los expertos también se equivocan.</div>
    <div class="grid halves"><div><h3 class="note">En español</h3>${newsList(es)}</div><div><h3 class="note">En inglés</h3>${newsList(en)}</div></div>
    ${aiReady() ? `<div class="ai-card mt"><b>✦ ¿Quieres un resumen?</b><div class="note">La IA lee estas fuentes, las estadísticas y los mercados, y te da su veredicto.</div><button class="btn primary mt" data-stab="ai">Analizar con IA</button></div>` : ''}`;
}

function predictionBlock(a) {
  const pm = a.ev.pm;
  if (!pm) return '<div class="note" style="margin-bottom:12px">Polymarket y Kalshi no tienen mercado para este partido.</div>';
  const hasDraw = pm.draw != null;
  return `<div class="widget" style="background:var(--fill);margin-bottom:12px"><h3>Mercados de predicción (dinero real)</h3><div class="table-wrap"><table class="t"><thead><tr><th>Fuente</th><th class="num">${esc(a.ev.home.name)}</th>${hasDraw ? '<th class="num">Empate</th>' : ''}<th class="num">${esc(a.ev.away.name)}</th><th class="num">Liquidez</th></tr></thead><tbody>
    ${pm.sources.map((s) => `<tr><td><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.source)} ↗</a></td><td class="num">${pct(s.home, 1)}<div class="note">${s.askHome ? 'momio ' + dec(1 / s.askHome) : ''}</div></td>${hasDraw ? `<td class="num">${pct(s.draw, 1)}<div class="note">${s.askDraw ? 'momio ' + dec(1 / s.askDraw) : ''}</div></td>` : ''}<td class="num">${pct(s.away, 1)}<div class="note">${s.askAway ? 'momio ' + dec(1 / s.askAway) : ''}</div></td><td class="num">${s.liquidity ? '$' + Math.round(s.liquidity).toLocaleString('es-MX') : '—'}</td></tr>`).join('')}
    <tr><td><b>Consenso</b></td><td class="num"><b>${pct(pm.home, 1)}</b></td>${hasDraw ? `<td class="num"><b>${pct(pm.draw, 1)}</b></td>` : ''}<td class="num"><b>${pct(pm.away, 1)}</b></td><td></td></tr></tbody></table></div>
    <div class="note mt">Precio = probabilidad que el dinero real asigna (actualizado cada ~30 s, también en vivo). Si tu casa mexicana paga un momio mayor que 1 ÷ probabilidad, hay valor.</div></div>`;
}

function tabOdds(a) {
  const lg = D.leagueById(a.ev.leagueId);
  if (lg.sport === 'mma' || lg.sport === 'boxing') return predictionBlock(a) + (a.ev.odds ? `<div class="note">Mejor precio en casas internacionales (The Odds API): ${esc(a.ev.home.name)} ${dec(a.ev.odds.home)} · ${esc(a.ev.away.name)} ${dec(a.ev.odds.away)}</div>` : '')
    + `<div class="note mt">Caliente, Codere, bet365 y Betano tienen momios de ${esc(lg.name)}: captúralos en el boleto y el bot te dice dónde conviene.</div>`;
  if (lg.sport === 'esports') return predictionBlock(a) + `<div class="widget" style="background:var(--fill)"><h3>Momios de eSports</h3><p class="note">Caliente, Codere, bet365 y Betano tienen mercados de ${esc(lg.name)}: abre el boleto y captura el momio que veas en cada casa. El bot calcula el EV con su probabilidad (${pct(a.sels[0]?.p, 1)} / ${pct(a.sels[1]?.p, 1)}) y te dice dónde conviene apostar.</p>
    <div class="flex">${a.sels.map((s) => `<div class="odd"><div class="k">${esc(s.label)}</div><div class="o">${dec(s.minOdds)}</div><div class="p">mínimo ${toAmerican(s.minOdds)}</div></div>`).join('')}</div>
    <p class="note mt">Datos de partidos: ${lg.source === 'lolesports' ? 'LoL Esports' : '<a href="https://liquipedia.net" target="_blank" rel="noopener">Liquipedia</a> (CC BY-SA 3.0)'}.</p></div>`;
  const o = a.ev.odds;
  const ref = o ? `<div class="widget" style="background:var(--fill)"><h3>${esc(o.provider)} · referencia</h3><table class="t"><thead><tr><th>Mercado</th><th class="num">Apertura</th><th class="num">Actual</th></tr></thead><tbody>
    <tr><td>${esc(a.ev.home.name)}</td><td class="num">${dec(o.open?.home)}</td><td class="num">${dec(o.home)}</td></tr>
    ${o.draw ? `<tr><td>Empate</td><td class="num">${dec(o.open?.draw)}</td><td class="num">${dec(o.draw)}</td></tr>` : ''}
    <tr><td>${esc(a.ev.away.name)}</td><td class="num">${dec(o.open?.away)}</td><td class="num">${dec(o.away)}</td></tr>
    ${o.total ? `<tr><td>Más de ${o.total.line}</td><td></td><td class="num">${dec(o.total.over)}</td></tr><tr><td>Menos de ${o.total.line}</td><td></td><td class="num">${dec(o.total.under)}</td></tr>` : ''}
    </tbody></table>${o.details ? `<div class="note mt">Línea: ${esc(o.details)}</div>` : ''}<div class="note">Si el momio se movió desde la apertura, el dinero "inteligente" pudo haber entrado de ese lado.</div></div>` : '<div class="empty">Sin momios de referencia gratis para este evento.</div>';
  const oa = S.oddsApi.get(key(a.ev));
  let extra = '';
  if (!S.cfg.hasOdds) extra = '<div class="note mt">Agrega tu clave de The Odds API en Más → Ajustes para ver Pinnacle y 40+ casas (500 consultas gratis al mes).</div>';
  else if (!lg.oddsKey) extra = '<div class="note mt">The Odds API no cubre esta liga.</div>';
  else if (oa === 'loading') extra = '<div class="shimmer mt"></div>';
  else if (oa?.error) extra = `<div class="warn mt">${esc(oa.error)}</div>`;
  else if (oa === null) extra = '<div class="note mt">The Odds API no tiene este partido.</div>';
  else if (oa) extra = `<div class="widget mt" style="background:var(--fill)"><h3>Casas internacionales (The Odds API)</h3><div class="table-wrap"><table class="t"><thead><tr><th>Casa</th><th class="num">Local</th>${oa.best.draw ? '<th class="num">Empate</th>' : ''}<th class="num">Visita</th></tr></thead><tbody>
    ${oa.books.sort((x, y) => (x.key === 'pinnacle' ? -1 : y.key === 'pinnacle' ? 1 : 0)).map((b) => `<tr><td>${b.key === 'pinnacle' ? '<b>Pinnacle (referencia sharp)</b>' : esc(b.title)}</td><td class="num">${dec(b.home)}</td>${oa.best.draw ? `<td class="num">${dec(b.draw)}</td>` : ''}<td class="num">${dec(b.away)}</td></tr>`).join('')}</tbody></table></div>
    <div class="note mt">Recuerda: solo puedes apostar en casas mexicanas. Usa estos momios para saber cuál es el precio justo.</div></div>`;
  else extra = `<button class="btn mt" data-oddsapi="${key(a.ev)}">Consultar Pinnacle y más casas</button>`;
  return predictionBlock(a) + smartBlock(a) + eventSmartSummary(a) + ref + extra;
}

// ---------- boleto: sección Apostar ----------
function addSelection(k, pick, extra = {}) {
  const a = S.analysis.get(k);
  if (!a) return;
  const sel = a.sels.find((s) => s.pick === pick);
  if (!sel) return;
  const ok = B.addToSlip({
    k, eventId: a.ev.id, leagueId: a.ev.leagueId, sport: a.ev.sport, name: a.ev.name, home: a.ev.home.name, away: a.ev.away.name,
    date: a.ev.date, market: sel.market, pick, line: sel.line ?? null, label: sel.label, stake: extra.stake || null, aiStake: !!extra.stake,
  });
  toast(ok ? `🎫 Agregado al boleto: ${sel.label}` : 'Ya está en tu boleto');
  renderChrome();
}

// Datos vivos de una selección del boleto (momios, recomendación de casa, EV).
function slipCalc(item) {
  const a = S.analysis.get(item.k);
  if (!a) return null;
  const sel = a.sels.find((s) => s.pick === item.pick && s.market === item.market) || a.sels.find((s) => s.pick === item.pick);
  if (!sel) return null;
  const st = B.getState();
  const ev = a.ev;
  const ref = ev.state === 'pre' ? sel.odds : null;
  const quotes = item.quotes || {};
  const stake = Number(item.stake) || (ref ? B.suggestStake(sel.p, ref) : 0) || st.settings.minStake;
  const rec = K.recommendBook(st, { sport: ev.sport, p: sel.p, stake, quotes });
  const chosen = rec?.reason === 'quotes' ? rec.best : null;
  const odds = chosen?.odds || ref;
  return { a, ev, sel, ref, quotes, stake, rec, chosen, odds, evv: odds ? sel.p * odds - 1 : null };
}

function slipCard(item) {
  const c = slipCalc(item);
  if (!c) return `<div class="slip-card glass"><div class="flex"><div class="grow"><b>${esc(item.label)}</b><div class="note">${esc(item.name)} · el partido ya no está en la lista</div></div><button class="close-x" data-slipdel="${item.id}">✕</button></div></div>`;
  const { ev, sel, ref, quotes, stake, rec, chosen, odds, evv } = c;
  const st = B.getState();
  const books = K.enabledBooks(st);
  const lg = D.leagueById(ev.leagueId);
  const groups = ['mx', 'intl'].map((g) => ({ g, list: books.filter((b) => b.group === g) })).filter((x) => x.list.length);
  return `<div class="slip-card glass">
    <div class="flex" style="align-items:flex-start"><div class="grow">
      <div class="note">${D.SPORT_ICON[ev.sport]} ${esc(lg.name)} · ${ev.state === 'in' ? `<span class="down">En vivo ${esc(ev.detail)}</span>` : new Date(ev.date).toLocaleString('es-MX', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
      <div class="slip-title">${esc(sel.label)}</div><div class="note">${esc(ev.name)} · ${esc(sel.market)}</div></div>
      <button class="close-x" data-slipdel="${item.id}" title="Quitar del boleto">✕</button></div>
    <div class="opp-nums mt"><div>Prob. del bot<b>${pct(sel.p, 1)}</b></div><div>Momio mínimo<b>${dec(sel.minOdds)} <span class="note">${toAmerican(sel.minOdds)}</span></b></div><div>Referencia<b>${dec(ref)}</b></div></div>
    ${groups.length ? groups.map(({ g, list }) => `<div class="note mt"><b>${K.GROUP_LABEL[g]}</b>${g === 'intl' ? ' · sin protección legal en México' : ''}</div>
      <div class="quote-grid">${list.map((b) => `<label class="quote ${chosen?.book.id === b.id ? 'best' : ''}"><span class="icon-sq" style="background:${b.color}">${esc(b.name[0])}</span><span class="qn">${esc(b.name)}</span>
        <input class="input" data-slipquote="${item.id}|${b.id}" value="${quotes[b.id] ? dec(quotes[b.id]) : ''}" placeholder="${ref ? toAmerican(ref) : '+150'}" inputmode="decimal"></label>`).join('')}</div>`).join('')
      : '<div class="warn mt">Activa tus casas en Más → Mis casas para comparar momios.</div>'}
    <div class="flex mt"><button class="btn small" data-research="${item.id}" ${aiReady() ? '' : 'disabled'}>🔎 Buscar momios en internet</button>${aiReady() ? '<span class="note">Claude busca los momios publicados por cada casa</span>' : '<span class="note">Requiere la clave de Anthropic (Más → Ajustes)</span>'}</div>
    ${researchBlock(S.oddsResearch.get(item.id))}
    ${rec?.best ? `<div class="rec mt"><span class="icon-sq" style="background:${rec.best.book.color}">${esc(rec.best.book.name[0])}</span><div class="grow"><div class="note">Apuesta en</div><b>${esc(rec.best.book.name)}</b>${rec.best.book.group === 'intl' ? ' <span class="tag gold">internacional</span>' : ''}<div class="note">${esc(K.reasonText(rec, D.SPORT_NAME[ev.sport].toLowerCase()))}</div></div><a class="btn small" href="${esc(rec.best.book.url)}" target="_blank" rel="noopener">Abrir ↗</a></div>` : ''}
    <div class="flex mt" style="align-items:flex-end"><div class="field" style="width:150px"><label>Monto (MXN)</label><input class="input" type="number" min="1" data-slipstake="${item.id}" value="${stake}"></div>
      <div class="grow ${evv == null ? 'note' : evv >= 0 ? 'ok' : 'warn'}">${odds ? `Momio ${dec(odds)} (${toAmerican(odds)}) · ganas ${money(stake * (odds - 1))} · EV <b>${pct(evv, 1)}</b>${evv < 0 ? ' — sin valor: el bot no la tomaría' : ''}` : 'Escribe el momio de al menos una casa (o búscalo en internet).'}</div></div>
    <button class="btn primary mt" style="width:100%;padding:13px" data-slipplace="${item.id}" ${odds ? '' : 'disabled'}>Registrar apuesta${chosen ? ' en ' + esc(chosen.book.name) : ''}</button>
  </div>`;
}

function researchBlock(r) {
  if (!r) return '';
  if (r === 'loading') return '<div class="ai-card mt"><b>✦ Buscando momios en internet…</b><div class="note">Claude revisa sitios de las casas y comparadores. Tarda de 30 a 90 segundos.</div><div class="shimmer"></div><div class="shimmer"></div></div>';
  if (r.error) return `<div class="warn mt">${esc(r.error)}</div>`;
  return `<div class="ai-card mt"><b>✦ Momios encontrados</b><div class="note">${esc(r.resumen)}</div>
    ${r.momios.length ? `<div class="table-wrap mt"><table class="t"><thead><tr><th>Casa</th><th>Selección</th><th class="num">Momio</th><th>Fuente</th></tr></thead><tbody>
    ${r.momios.map((m) => `<tr><td>${esc(m.casa)}</td><td>${esc({ home: 'Local', away: 'Visitante', draw: 'Empate', over: 'Más de', under: 'Menos de' }[m.seleccion] || m.seleccion)}${m.linea ? ' ' + m.linea : ''}</td><td class="num"><b>${dec(m.momio_decimal)}</b><div class="note">${toAmerican(m.momio_decimal)}</div></td><td class="wrap">${m.fuente ? `<a href="${esc(m.fuente)}" target="_blank" rel="noopener">ver ↗</a>` : ''}${m.actualizado ? `<div class="note">${esc(m.actualizado)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="note mt">⚠️ Los momios cambian rápido y la búsqueda puede estar desfasada: confírmalos en la app de la casa antes de apostar. Los que coinciden con tus casas ya se capturaron arriba.</div></div>`;
}

const normBook = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function researchSlipOdds(id) {
  const item = B.getState().slip.find((x) => x.id === id);
  const c = item && slipCalc(item);
  if (!c) return;
  S.oddsResearch.set(id, 'loading'); render();
  try {
    const books = K.enabledBooks(B.getState());
    const names = (books.length ? books : K.BOOKS.filter((b) => b.group === 'mx')).map((b) => b.name);
    const market = c.sel.market === 'Goles' ? `Total de goles, línea ${c.sel.line}` : c.ev.sport === 'soccer' ? 'Resultado final 1X2' : 'Ganador del partido (moneyline)';
    const r = await researchOdds({ event: { home: c.ev.home.name, away: c.ev.away.name, league: D.leagueById(c.ev.leagueId).name, date: c.ev.date }, books: names, market });
    S.oddsResearch.set(id, r);
    // Captura automática de los momios que coinciden con la selección y con tus casas activas.
    const quotes = { ...(item.quotes || {}) };
    let filled = 0;
    for (const m of r.momios) {
      if (m.seleccion !== item.pick || !(m.momio_decimal > 1)) continue;
      if (item.market === 'Goles' && Number(m.linea) !== Number(item.line)) continue;
      const b = books.find((x) => normBook(m.casa).includes(normBook(x.name).slice(0, 6)) || normBook(x.name).includes(normBook(m.casa).slice(0, 6)));
      if (b && !quotes[b.id]) { quotes[b.id] = m.momio_decimal; filled++; }
    }
    B.updateSlip(id, { quotes });
    B.log(`IA buscó momios de ${c.ev.name}: ${r.momios.length} encontrados, ${filled} capturados`, 'ai');
  } catch (e) { S.oddsResearch.set(id, { error: e.message }); if (e?.code === 'sin_saldo' || e?.code === 'clave_invalida') handleAIError(e); }
  render();
}

function placeFromSlip(id) {
  const item = B.getState().slip.find((x) => x.id === id);
  const c = item && slipCalc(item);
  if (!c || !c.odds) return;
  try {
    const bookId = c.chosen?.book.id || c.rec?.best?.book.id || null;
    const bet = B.placeBet({
      ev: c.ev, sel: c.sel, stake: c.stake, odds: c.ref, oddsMx: c.chosen?.odds || null, book: bookId,
      quotes: c.ref ? c.quotes : {}, source: item.aiStake ? 'IA (manual)' : 'manual',
    });
    B.removeFromSlip(id);
    S.oddsResearch.delete(id);
    const bk = K.bookById(bookId);
    toast(bk ? `✓ Registrada. Ahora colócala en ${bk.name}` : '✓ Apuesta simulada registrada');
    render();
    return bet;
  } catch (e) { toast('⚠️ ' + e.message); }
}

function toPlaceRow(b) {
  const bk = K.bookById(b.book);
  return `<div class="row"><span class="icon-sq" style="background:${bk?.color || 'var(--text-3)'}">${esc(bk ? bk.name[0] : '?')}</span>
    <div class="grow"><b>${esc(b.label)}</b> <span class="note">· ${esc(b.market)}</span><div class="meta">${esc(b.home)} vs ${esc(b.away)} · ${money(b.stake)} @ ${dec(b.odds)}${b.minOdds ? ` · acepta desde ${dec(b.minOdds)} (${toAmerican(b.minOdds)})` : ''}${bk ? ' · ' + esc(bk.name) : ''}</div></div>
    ${bk ? `<a class="btn small" href="${esc(bk.url)}" target="_blank" rel="noopener">Abrir ↗</a>` : ''}<button class="btn small primary" data-placed="${b.id}">Ya la coloqué</button></div>`;
}

// ---------- cobro anticipado (cash out) ----------
// Valor justo de una apuesta en este momento = monto × momio × probabilidad actual de ganar.
// Las casas suelen ofrecer un 5–10% menos que el valor justo: el bot te dice si su oferta es buena.
function cashOutInfo(b) {
  const a = [...S.analysis.values()].find((x) => x.ev.id === b.eventId && x.ev.leagueId === b.leagueId);
  if (!a) return null;
  let p = null;
  const sel = a.sels.find((s) => s.pick === b.pick && s.market === b.market && (b.market !== 'Goles' || s.line === b.line));
  if (sel) p = sel.p;
  if (p == null) return null;
  const full = b.stake * b.odds;
  const fair = full * p;
  return { a, p, fair, full, live: a.ev.state === 'in', profit: fair - b.stake };
}

function cashOutSection() {
  const pend = B.pendingBets().map((b) => ({ b, c: cashOutInfo(b) })).filter((x) => x.c);
  if (!pend.length) return '';
  const hot = pend.filter((x) => cashOutSuggested(x.c));
  // Primero las que conviene cobrar, luego en vivo, luego el resto.
  pend.sort((x, y) => (cashOutSuggested(y.c) - cashOutSuggested(x.c)) || (y.c.live - x.c.live) || (y.c.profit - x.c.profit));
  return `<div class="section-title">💸 Cobro anticipado (cash out) <small>${hot.length ? `<b class="gold-text">${hot.length} conviene${hot.length === 1 ? '' : 'n'} cobrar</b>` : 'Cuánto vale hoy cada apuesta abierta'}</small></div>
  ${betsTable(pend.map((x) => x.b))}
  <div class="note mt">Si tu casa te ofrece por la apuesta <b>al menos el "mínimo aceptable"</b>, cobrar es razonable; si ofrece menos, te está cobrando una comisión alta. El retiro a tu banco depende de cada casa (SPEI, OXXO, tarjeta).</div>`;
}
function viewBet() {
  const st = B.getState();
  const toPlace = B.pendingBets().filter((b) => !b.placedReal && b.source !== 'práctica');
  const recs = allAnalyses().filter((a) => a.ev.state === 'pre').flatMap((a) => a.sels.filter((s) => s.value).map((s) => ({ a, s }))).sort((x, y) => y.s.ev - x.s.ev).slice(0, 10);
  const golds = allAnalyses().flatMap((a) => a.golden.map((g) => ({ a, g }))).sort((x, y) => y.g.score - x.g.score).slice(0, 4);
  const inGold = new Set(golds.map(({ a, g }) => key(a.ev) + (g.sel?.pick || g.pick)));
  const recsOnly = recs.filter(({ a, s }) => !inGold.has(key(a.ev) + s.pick));
  const recRow = (a, s, gold = null) => `<div class="row"><div class="grow"><b>${esc(s ? s.label : a.ev[gold.pick].name)}</b>${gold ? ' <span class="tag gold">★ Oro</span>' : ''}
      <div class="meta">${D.SPORT_ICON[a.ev.sport]} ${esc(a.ev.name)} · ${s ? `ref. ${dec(s.odds)} · EV ${pct(s.ev, 1)}` : esc(gold.title)}</div></div>
      <button class="btn small" data-slip="${key(a.ev)}|${s ? s.pick : gold.pick}">+ Boleto</button></div>`;
  return `<div class="bet-layout"><div>
    <div class="section-title" style="margin-top:0">Tu boleto <small>${st.slip.length} ${st.slip.length === 1 ? 'selección' : 'selecciones'}</small></div>
    ${st.slip.length ? st.slip.map(slipCard).join('') : `<div class="widget glass empty">Tu boleto está vacío.<br>Toca cualquier momio en <a href="#" data-tab-link="soccer">Fútbol</a>, <a href="#" data-tab-link="sports">Deportes</a> o <a href="#" data-tab-link="esports">eSports</a>, o agrega una recomendación.</div>`}
    <div class="section-title">Por colocar en tu casa <small>${toPlace.length}</small></div>
    ${toPlace.length ? `<div class="list glass">${toPlace.map(toPlaceRow).join('')}</div>` : '<div class="widget glass empty">No tienes apuestas pendientes de colocar.</div>'}
    <div class="note mt">Las apuestas se registran en tu banca ficticia. Si decides apostar de verdad, colócala en la casa indicada y marca "Ya la coloqué" para llevar el control.</div>
    ${cashOutSection()}
  </div><aside>
    <div class="section-title" style="margin-top:0">Recomendadas ahora</div>
    ${recs.length || golds.length ? `<div class="list glass">${golds.map(({ a, g }) => recRow(a, g.sel || null, g)).join('')}${recsOnly.map(({ a, s }) => recRow(a, s)).join('')}</div>` : '<div class="widget glass empty">Ninguna selección tiene valor ahora mismo.</div>'}
  </aside></div>`;
}

// ---------- notificaciones ----------
// Leídas: "todo lo anterior a notifSeen" (Marcar todas) + ids marcados uno por uno. Se guarda por dispositivo.
const NOTIF_ICON = { bet: '🎫', won: '✅', lost: '❌', void: '↩️', ai: '✦', error: '⚠️', info: '🤖' };
const NOTIF_KINDS = new Set(['bet', 'won', 'lost', 'void', 'error', 'ai']); // los mensajes "info" del bot no generan aviso
let notifSeen = 0, notifPushed = Date.now(), notifRead = new Set(), notifFilter = 'unread';
try {
  notifSeen = Number(localStorage.getItem('betbot-notif-seen') || 0);
  notifRead = new Set(JSON.parse(localStorage.getItem('betbot-notif-read') || '[]'));
} catch {}
const isRead = (n) => n.t <= notifSeen || notifRead.has(n.id);
function markRead(ids) {
  for (const id of ids) notifRead.add(id);
  try { localStorage.setItem('betbot-notif-read', JSON.stringify([...notifRead].slice(-500))); } catch {}
}
function markAllRead() {
  notifSeen = Date.now(); notifRead = new Set();
  try { localStorage.setItem('betbot-notif-seen', String(notifSeen)); localStorage.setItem('betbot-notif-read', '[]'); } catch {}
}

function collectNotifications() {
  const items = [];
  for (const l of B.getState().log.slice(0, 60)) {
    if (!NOTIF_KINDS.has(l.kind)) continue;
    items.push({ id: 'l' + l.t, t: l.t, icon: NOTIF_ICON[l.kind] || '🤖', title: l.msg, src: 'Bot', cat: 'bot' });
  }
  // Oportunidades de oro nuevas: quedan en la bitácora y la PC las envía como aviso push al iPhone.
  // (goldSeen se comparte entre dispositivos para no avisar dos veces; la primera vez solo se marcan las actuales.)
  const stN = B.getState(), firstGold = !stN.goldSeen;
  stN.goldSeen ||= {};
  let goldChanged = false;
  for (const a of allAnalyses()) for (const g of a.golden) {
    const id = 'g' + key(a.ev) + g.type;
    if (!S.goldFirstSeen.has(id)) S.goldFirstSeen.set(id, Date.now());
    if (!stN.goldSeen[id]) {
      stN.goldSeen[id] = Date.now(); goldChanged = true;
      if (!firstGold && a.ev.state !== 'post') B.log(`★ ${g.title}${g.why ? ' — ' + g.why : ''}`, 'gold');
    }
    items.push({ id, t: S.goldFirstSeen.get(id), icon: '★', title: g.title, body: g.why, open: key(a.ev), src: 'Oportunidad de Oro', cat: 'gold' });
  }
  for (const [id, t0] of Object.entries(stN.goldSeen)) if (Date.now() - t0 > 3 * 86400000) { delete stN.goldSeen[id]; goldChanged = true; }
  if (goldChanged) B.save();
  items.push(...S.newsNotifs);
  // Rastro de los top apostadores de Polymarket que sigues.
  for (const x of B.getState().smart.trail.slice(0, 30)) {
    if (x.initial) continue;
    items.push({ id: 'sm' + x.t + x.wallet, t: x.t, icon: '🐋', title: `${x.name} entró: ${x.outcome}`, body: `${x.title} · a ${pct(x.price)} · ${money0(x.value)}`, src: 'Top Polymarket', cat: 'smart' });
  }
  S.notifs = items.sort((x, y) => y.t - x.t).slice(0, 80);
  // Aviso del navegador para lo nuevo (solo si diste permiso).
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !pushOnHere()) {
    for (const n of S.notifs.filter((x) => x.t > notifPushed && x.src !== 'Bot').slice(0, 3)) { try { new Notification('BetBot MX · ' + n.src, { body: n.title }); } catch {} }
  }
  notifPushed = Date.now();
}

// Noticias que pueden mover tus apuestas: equipos en el boleto o con apuestas pendientes.
async function loadRelevantNews() {
  if (Date.now() - S.newsCheckedAt < 3 * 60_000) return;
  S.newsCheckedAt = Date.now();
  const st = B.getState();
  const teams = [...new Set([...B.pendingBets().flatMap((b) => [b.home, b.away]), ...st.slip.flatMap((s) => [s.home, s.away])])].slice(0, 6);
  const out = [];
  for (const team of teams) {
    const items = await D.searchNews(`"${team}" lesión OR baja OR alineación OR descartado OR regresa`, 3);
    for (const n of items) out.push({ id: 'n' + n.url, t: Date.parse(n.date) || Date.now(), icon: '📰', title: n.title, body: `${n.source} · ${team}`, url: n.url, src: 'Noticias', cat: 'news' });
  }
  S.newsNotifs = out;
}

function renderNotifPanel() {
  const p = $('#notif-panel');
  const unreadN = S.notifs.filter((n) => !isRead(n)).length;
  const filters = [['unread', `Sin leer${unreadN ? ` (${unreadN})` : ''}`], ['all', 'Todas'], ['gold', '★ Oro'], ['smart', '🐋 Top'], ['news', 'Noticias'], ['bot', 'Bot']];
  const list = S.notifs.filter((n) => (notifFilter === 'unread' ? !isRead(n) : notifFilter === 'all' ? true : n.cat === notifFilter)).slice(0, 40);
  const item = (n) => {
    const read = isRead(n);
    const tag = n.url ? `a href="${esc(n.url)}" target="_blank" rel="noopener"` : 'div';
    return `<div class="notif-row ${read ? 'read' : 'unread'}"><${tag} class="notif" data-notifread="${esc(n.id)}" ${n.open ? `data-open="${n.open}"` : ''}>
      <div class="ni">${n.icon}</div><div class="grow"><div class="nt">${esc(n.title)}</div>${n.body && !read ? `<div class="note">${esc(n.body)}</div>` : ''}<div class="note">${esc(n.src)} · ${new Date(n.t).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></div></${n.url ? 'a' : 'div'}>
      ${read ? '' : `<button class="mark-read" data-notifread="${esc(n.id)}" data-only title="Marcar como leída">✓</button>`}</div>`;
  };
  p.innerHTML = `<div class="flex" style="padding:16px 18px 6px"><div class="grow"><div style="font-size:20px;font-weight:700">Notificaciones</div><div class="note">Toca una para leerla · ✓ la marca como leída</div></div><button class="close-x" data-notifclose>✕</button></div>
    <div class="flex" style="padding:0 18px 6px"><div class="segmented">${filters.map(([k, l]) => `<button data-notiffilter="${k}" class="${notifFilter === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    <div class="flex" style="padding:0 18px 4px">${unreadN ? '<button class="btn small" data-notifall>✓ Marcar todas como leídas</button>' : ''}${typeof Notification !== 'undefined' && Notification.permission === 'default' && isSecureContext ? '<button class="btn small" data-notifperm>Activar avisos del navegador</button>' : ''}</div>
    <div class="notif-list">${list.length ? list.map(item).join('') : `<div class="empty">${notifFilter === 'unread' ? '✓ Estás al día: no hay notificaciones sin leer.' : 'Sin notificaciones en esta categoría.'}</div>`}</div>`;
}

function openNotifs() {
  collectNotifications();
  renderNotifPanel();
  $('#notif-panel').classList.add('open');
  $('#backdrop').classList.add('open');
  renderChrome();
}

// ---------- celular (QR) ----------
let qrLib = null;
async function loadQrLib() {
  if (qrLib) return qrLib;
  await new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    s.onload = ok; s.onerror = () => fail(new Error('No se pudo cargar el generador de QR'));
    document.head.appendChild(s);
  });
  qrLib = window.qrcode;
  return qrLib;
}

function viewPhone() {
  return `<div id="phone-box"><div class="widget glass"><div class="shimmer"></div><div class="shimmer"></div></div></div>`;
}
async function loadPhone() {
  await loadPhoneLan();
  loadTailscale();
  loadPushBox();
}

// ---------- Tailscale: dirección segura para el iPhone (en casa y con datos móviles) ----------
async function loadTailscale() {
  const el = $('#ts-box');
  if (!el) return;
  if (!el.innerHTML) el.innerHTML = '<div class="widget glass mt"><div class="shimmer"></div><div class="shimmer"></div></div>';
  let t;
  try { t = await (await fetch('/api/tailscale', { cache: 'no-store' })).json(); } catch { el.innerHTML = ''; return; }
  const running = t.state === 'Running', ready = t.installed && running && t.https && t.serving && t.lan;
  const step = (n, done, html) => `<li class="ts-step ${done ? 'done' : ''}"><span class="ts-n">${done ? '✓' : n}</span><div class="grow">${html}</div></li>`;
  const steps = [
    step(1, t.installed, `<b>Instala Tailscale en esta PC</b> y crea tu cuenta gratis (puedes entrar con Google, Microsoft o Apple).
      ${t.installed ? '' : '<div class="mt"><a class="btn small primary" href="https://tailscale.com/download/windows" target="_blank" rel="noopener">Descargar Tailscale para Windows ↗</a></div>'}`),
    step(2, t.installed && running, `<b>Inicia sesión en Tailscale</b>: icono de Tailscale junto al reloj de Windows → <b>Log in</b>.
      ${t.installed && !running ? `<div class="note">Estado actual: ${esc(t.state || 'desconectado')}</div>` : ''}`),
    step(3, t.installed && t.https, `<b>Activa HTTPS en tu cuenta</b>: entra a <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noopener">login.tailscale.com/admin/dns ↗</a>,
      deja <b>MagicDNS</b> encendido y presiona <b>Enable HTTPS</b>.`),
    step(4, t.installed && t.serving && t.lan, `<b>Conecta el bot a Tailscale</b>. ${!t.lan
      ? 'Primero activa el acceso del celular con el botón de arriba.'
      : t.serving ? 'Listo: el bot ya responde en tu dirección segura.'
      : `<div class="mt"><button class="btn small primary" data-tsserve ${t.installed && running ? '' : 'disabled'}>🔒 Activar dirección segura</button></div>`}`),
    step(5, false, `<b>En tu iPhone</b>: instala <b>Tailscale</b> desde la App Store, entra con la <b>misma cuenta</b> y deja la conexión activada.`),
  ].join('');
  let qrHtml = '';
  if (ready && t.url) {
    const url = `${t.url}/?t=${t.token}&app=1`;
    try {
      const qr = await loadQrLib();
      const q = qr(0, 'M'); q.addData(url); q.make();
      qrHtml = `<div class="qr-card mt"><div class="qr">${q.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}</div>
        <div class="grow"><h3>Instala la app segura en tu iPhone</h3><ol class="steps">
        <li>Con Tailscale activado en el iPhone, escanea este código con la cámara.</li>
        <li>Se abre en <b>Safari</b>: <b>Compartir</b> → <b>Agregar a pantalla de inicio</b>.</li>
        <li>Abre BetBot desde el icono → <b>Más → Celular</b> → <b>Activar notificaciones</b>.</li>
        <li>Si tenías la app anterior (la de la red WiFi), bórrala para no tener dos.</li></ol>
        <div class="note">Dirección: <span class="kbd">${esc(t.url)}</span></div><div class="warn mt">El código lleva tu clave de acceso: no lo compartas.</div></div></div>`;
    } catch {}
  }
  el.innerHTML = `<div class="widget glass mt ts-card">
    <h3>🌎 Fuera de casa y avisos en la pantalla de bloqueo</h3>
    <p class="note">Con <b>Tailscale</b> (gratis) tu iPhone se conecta a tu PC de forma privada y cifrada, en casa o con datos móviles, sin abrir tu PC a internet.
    Además da la dirección segura (https) que el iPhone exige para las notificaciones y para mostrar una pantalla propia si la PC está apagada.</p>
    ${ready ? '<div class="ok">✓ Todo listo: tu bot tiene dirección segura.</div>' : ''}
    <ol class="ts-steps">${steps}</ol>${qrHtml}
    <div class="flex mt"><button class="btn small" data-tsrefresh>↻ Revisar de nuevo</button>${t.serving ? '<button class="btn small" data-tsreset>Quitar dirección segura</button>' : ''}</div>
    <div class="note mt" id="ts-msg"></div></div>`;
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const msg = $('#ts-msg');
    if (b.dataset.tsrefresh !== undefined) { b.textContent = 'Revisando…'; return loadTailscale(); }
    if (b.dataset.tsreset !== undefined) { await fetch('/api/tailscale/reset', { method: 'POST' }).catch(() => {}); return loadTailscale(); }
    if (b.dataset.tsserve !== undefined) {
      b.disabled = true; b.textContent = 'Activando…';
      try {
        const r = await (await fetch('/api/tailscale/serve', { method: 'POST' })).json();
        if (r.enableUrl) {
          msg.innerHTML = `Tailscale pide permitir esta función en tu cuenta (una sola vez): <a href="${esc(r.enableUrl)}" target="_blank" rel="noopener">abre este enlace ↗</a>, acepta y vuelve a presionar <b>Activar dirección segura</b>.`;
          b.disabled = false; b.textContent = '🔒 Activar dirección segura';
          return;
        }
        if (!r.ok) { msg.innerHTML = `<span class="down">No se pudo activar.</span> ${esc(r.output || r.error || '')}`; b.disabled = false; b.textContent = '🔒 Activar dirección segura'; return; }
        loadTailscale();
      } catch (err) { msg.textContent = err.message; b.disabled = false; }
    }
  };
}

// ---------- Notificaciones push (pantalla de bloqueo) ----------
const PUSH_CATS = [['gold', '★ Oportunidades de oro'], ['newbets', '🎫 Apuestas nuevas del bot'], ['bets', '✅ Ganadas, perdidas y cobros'], ['smart', '🐋 Entradas de los top apostadores']];
async function loadPushBox() {
  const el = $('#push-box');
  if (!el) return;
  const head = '<h3>🔔 Notificaciones en la pantalla de bloqueo</h3>';
  const sup = pushSupport();
  if (!sup.ok) {
    const why = {
      pc: 'Los avisos llegan a tu <b>iPhone</b>: completa los pasos de arriba, instala la app segura y actívalos desde <b>Más → Celular</b> en el iPhone. La PC es la que los envía.',
      insecure: S.cfg.local
        ? 'Los avisos del iPhone necesitan la dirección segura de Tailscale (pasos de arriba). Después actívalos desde la app del iPhone.'
        : 'Para recibir avisos con la app cerrada, instala la app desde la dirección segura de Tailscale (en la PC: Más → Celular).',
      install: 'Primero instala la app: <b>Compartir</b> → <b>Agregar a pantalla de inicio</b>, y ábrela desde su icono.',
      unsupported: 'Este navegador no admite notificaciones push. En iPhone necesitas iOS 16.4 o más reciente.',
    }[sup.why];
    el.innerHTML = `<div class="widget glass mt">${head}<p class="note">${why}</p></div>`;
    return;
  }
  let st;
  try { st = await pushState(); } catch (e) { el.innerHTML = `<div class="widget glass mt">${head}<div class="warn">${esc(e.message)}</div></div>`; return; }
  const prefs = st.prefs || { gold: true, newbets: true, bets: true, smart: true };
  const toggles = PUSH_CATS.map(([k, l]) => `<div class="row"><div class="grow">${l}</div><label class="switch"><input type="checkbox" data-pushpref="${k}" ${prefs[k] ? 'checked' : ''}><span></span></label></div>`).join('');
  el.innerHTML = `<div class="widget glass mt">${head}
    ${st.subscribed ? '<div class="ok">✓ Avisos activos en este dispositivo: llegan aunque la app esté cerrada.</div>' : '<p class="note">Recibe lo importante del bot en la pantalla de bloqueo, aunque la app esté cerrada.</p>'}
    <div class="list mt">${toggles}</div>
    <div class="flex mt">${st.subscribed
      ? '<button class="btn small" data-pushtest>Enviar aviso de prueba</button><button class="btn small danger" data-pushoff>Desactivar</button>'
      : '<button class="btn primary" data-pushon>🔔 Activar notificaciones</button>'}</div>
    <div class="note mt" id="push-msg">${st.permission === 'denied' ? '⚠️ Los avisos están bloqueados: actívalos en Ajustes del iPhone → Notificaciones → BetBot.' : ''}</div>
    <div class="note mt">Los envía tu PC cuando el bot detecta algo nuevo: necesitan la PC encendida con <span class="kbd">iniciar.bat</span> y BetBot abierto en el navegador de la PC (ahí corre el análisis).</div></div>`;
  const msg = () => $('#push-msg');
  const chosen = () => Object.fromEntries([...el.querySelectorAll('[data-pushpref]')].map((i) => [i.dataset.pushpref, i.checked]));
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pushon !== undefined) {
      // Sin esperas antes de pedir permiso: iOS solo lo muestra si viene directo del toque.
      b.disabled = true; b.textContent = 'Activando…';
      try { await enablePush(chosen()); toast('🔔 Notificaciones activadas'); await loadPushBox(); }
      catch (err) { msg().textContent = err.message; b.disabled = false; b.textContent = '🔔 Activar notificaciones'; }
    } else if (b.dataset.pushtest !== undefined) {
      b.disabled = true;
      try { const r = await testPush(); msg().textContent = r.ok ? '✓ Aviso enviado: debería llegar en unos segundos.' : `No se pudo enviar (código ${(r.codes || []).join(', ')}).`; }
      catch (err) { msg().textContent = err.message; }
      b.disabled = false;
    } else if (b.dataset.pushoff !== undefined) {
      try { await disablePush(); toast('Notificaciones desactivadas'); } catch (err) { msg().textContent = err.message; }
      loadPushBox();
    }
  };
  el.onchange = async (e) => {
    if (!e.target.dataset.pushpref || !st.subscribed) return;
    try { await setPushPrefs(chosen()); } catch (err) { msg().textContent = err.message; }
  };
}

async function loadPhoneLan() {
  const box = $('#phone-box');
  if (!box) return;
  if (!S.cfg.local) { box.innerHTML = `<div class="widget glass ok">✓ Estás usando BetBot MX desde ${isTailscale ? 'la <b>dirección segura</b> (Tailscale): funciona en casa y con datos móviles' : 'tu red WiFi'}.</div><div id="push-box"></div>`; return; }
  let net;
  try { net = await (await fetch('/api/network')).json(); } catch { box.innerHTML = '<div class="warn">No se pudo leer la red.</div>'; return; }
  const away = '<div id="ts-box"></div><div id="push-box"></div>';
  // Red marcada como "Pública": Windows bloquea al celular aunque el QR sea correcto (pantalla negra en el teléfono).
  const pub = (net.profiles || []).filter((p) => /public/i.test(p.category));
  const publicWarn = pub.length ? `<div class="widget glass" style="border:2px solid var(--orange-fill);margin-bottom:14px"><h3>⚠️ Tu red está como "Pública": Windows bloquea al celular</h3>
    <p>Por eso el celular se queda cargando en negro. Cámbiala a <b>Privada</b> (solo hazlo en la red de tu casa):</p>
    <ol class="steps"><li>Abre <b>Configuración</b> de Windows (tecla Windows + I).</li>
    <li>Ve a <b>Red e Internet</b> → <b>${esc(/wi-?fi|wlan/i.test(pub[0].name) ? 'Wi-Fi' : 'Ethernet')}</b>${pub[0].network ? ` → <b>${esc(pub[0].network)}</b>` : ''}.</li>
    <li>En <b>Tipo de perfil de red</b> elige <b>Red privada</b>.</li>
    <li>Vuelve a escanear el QR con el celular (no hace falta reiniciar el bot).</li></ol>
    <div class="note">Redes afectadas: ${pub.map((p) => esc(`${p.name}${p.network ? ' (' + p.network + ')' : ''}`)).join(', ')}</div></div>` : '';
  if (!net.lan) {
    box.innerHTML = `<div class="widget glass"><h3>Activar acceso desde el celular</h3>
      <p>Para que tu celular pueda abrir el bot, Windows necesita permitirlo una sola vez. Presiona el botón y acepta el aviso de administrador que aparecerá en esta PC.</p>
      <button class="btn primary" data-phoneenable>📱 Activar y mostrar el código QR</button>
      <div class="note mt">Esto permite que el bot se abra en tu red local y abre el puerto ${net.port} solo para redes <b>privadas</b> (tu casa), no en redes públicas. Para deshacerlo usa <span class="kbd">deshabilitar-telefono.bat</span>.</div>
      <details class="mt"><summary class="note">¿No funcionó el botón? Hazlo manual</summary><ol class="steps note">
      <li>Cierra la ventana negra de BetBot MX.</li>
      <li>En la carpeta del bot, da doble clic en <span class="kbd">habilitar-telefono.bat</span> y acepta el aviso de administrador.</li>
      <li>Abre de nuevo <span class="kbd">iniciar.bat</span> y regresa aquí.</li></ol></details></div>${publicWarn}${away}`;
    return;
  }
  if (!net.ips.length) { box.innerHTML = '<div class="warn">No se encontró una red WiFi o Ethernet activa.</div>' + away; return; }
  let qr;
  try { qr = await loadQrLib(); } catch (e) { box.innerHTML = `<div class="warn">${esc(e.message)}</div>`; return; }
  const cards = net.ips.slice(0, 2).map((ip) => {
    const url = `http://${ip}:${net.port}/?t=${net.token}`;
    const q = qr(0, 'M'); q.addData(url); q.make();
    return `<div class="widget glass qr-card"><div class="qr">${q.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}</div>
      <div class="grow"><h3>Escanéalo con la cámara de tu celular</h3><ol class="steps"><li>Conecta el celular a la misma red WiFi que esta PC.</li><li>Abre la cámara y apunta al código.</li><li>Se abre en <b>Safari</b>. Toca <b>Compartir</b> → <b>Agregar a pantalla de inicio</b> → <b>Agregar</b>.</li><li>Abre <b>BetBot</b> desde su icono: pantalla completa, desliza hacia abajo para actualizar y se reconecta sola con tu PC.</li></ol>
      <div class="note">Dirección: <span class="kbd">http://${esc(ip)}:${net.port}</span></div><div class="warn mt">El QR contiene tu código de acceso: no lo compartas.</div></div></div>`;
  }).join('');
  box.innerHTML = publicWarn + cards + away;
}

// ---------- ajustes: claves y actualizaciones ----------
function keysSection() {
  if (!S.cfg.local) return '<div class="widget glass note">Las claves solo se pueden cambiar desde la computadora.</div>';
  return `<div class="list glass">
    <div class="row" style="flex-wrap:wrap"><div class="icon-sq" style="background:var(--purple)">✦</div><div class="grow" style="min-width:200px"><b>Clave de Anthropic (Claude)</b><div class="meta">${S.cfg.hasAnthropic ? '<span class="up">✓ Configurada</span> · ' + esc(S.cfg.aiModel) : 'No configurada: la IA está desactivada'}</div></div>
      <input class="input" id="key-anthropic" type="password" autocomplete="off" placeholder="${S.cfg.hasAnthropic ? '•••••••• (pega una nueva para cambiarla)' : 'sk-ant-...'}" style="flex:1;min-width:220px"><button class="btn primary" data-savekey="anthropic">Guardar</button></div>
    <div class="row" style="flex-wrap:wrap"><div class="icon-sq" style="background:var(--orange-fill)">⇄</div><div class="grow" style="min-width:200px"><b>Clave de The Odds API</b><div class="meta">${S.cfg.hasOdds ? '<span class="up">✓ Configurada</span>' : 'Opcional · Pinnacle y 40+ casas'}</div></div>
      <input class="input" id="key-odds" type="password" autocomplete="off" placeholder="${S.cfg.hasOdds ? '••••••••' : 'tu clave'}" style="flex:1;min-width:220px"><button class="btn primary" data-savekey="odds">Guardar</button></div>
  </div>
  <div class="note mt">Cómo obtener la clave de Anthropic: entra a <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> → crea tu cuenta → <b>Billing</b> (agrega saldo, por ejemplo $5 USD) → <b>API Keys</b> → <b>Create Key</b> → cópiala y pégala aquí. Se guarda solo en el archivo <span class="kbd">.env</span> de tu PC; el navegador y el celular nunca la reciben.</div>`;
}

function updatesSection() {
  if (!S.cfg.local) return '<div class="widget glass note">Las actualizaciones se instalan desde la computadora.</div>';
  const u = S.update;
  return `<div class="list glass">
    <div class="row"><div class="icon-sq" style="background:var(--blue)">⬇︎</div><div class="grow"><b>Versión instalada: ${esc(S.version?.version || '—')}</b><div class="meta">${esc(S.version?.date || '')}</div></div><button class="btn primary" data-update="check">Buscar actualización</button></div>
    <div class="row" style="flex-wrap:wrap"><div class="grow" style="min-width:200px"><b>Dirección de actualizaciones</b><div class="meta">La URL del archivo version.json publicado (te la doy yo cuando publiquemos)</div></div>
      <input class="input" id="update-url" placeholder="https://..." style="flex:1;min-width:220px"><button class="btn" data-savekey="update">Guardar</button></div>
  </div>
  ${u === 'loading' ? '<div class="shimmer mt"></div>' : u?.error ? `<div class="warn mt">${esc(u.error)}</div>` : u?.configured === false ? '<div class="warn mt">Aún no hay dirección de actualizaciones configurada.</div>'
    : u?.remote ? (cmpVer(u.remote.version, u.local.version) > 0 ? `<div class="ok mt"><b>Hay una nueva versión: ${esc(u.remote.version)}</b>${(u.remote.notes || []).length ? `<ul>${u.remote.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}<button class="btn primary" data-update="apply">Instalar actualización</button><div class="note">Se respalda la versión actual en data/; tus apuestas y claves se conservan.</div></div>` : '<div class="ok mt">✓ Tienes la versión más reciente.</div>') : ''}
  <div class="widget glass mt"><h3>¿Quieres una mejora o algo nuevo?</h3><p class="note">Pídela en tu conversación con Claude. Cuando la nueva versión esté publicada, presiona <b>Buscar actualización</b> y se instala sola, sin perder tus datos.</p><button class="btn small" data-copydiag>Copiar datos de mi versión</button></div>`;
}
const cmpVer = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };

async function saveKey(which) {
  const body = which === 'anthropic' ? { anthropicKey: $('#key-anthropic').value } : which === 'odds' ? { oddsApiKey: $('#key-odds').value } : { updateUrl: $('#update-url').value };
  const val = Object.values(body)[0];
  if (!val || !val.trim()) { toast('Escribe un valor primero'); return; }
  try {
    const res = await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) { toast('⚠️ ' + (j.error || 'No se pudo guardar')); return; }
    if (which === 'anthropic') S.aiPause = null;
    if (which === 'anthropic') toast(j.anthropicValid ? '✓ Clave de Anthropic guardada y verificada' : '⚠️ Clave guardada, pero Anthropic la rechazó. Revisa que esté completa y que tengas saldo.');
    else toast('✓ Guardado');
    S.cfg = await D.getConfig();
    try { await initAI(S.cfg); } catch {}
    render();
  } catch (e) { toast('⚠️ ' + e.message); }
}

async function updateAction(kind) {
  if (kind === 'check') {
    S.update = 'loading'; render();
    try { S.update = await (await fetch('/api/update/check')).json(); } catch (e) { S.update = { error: e.message }; }
    render();
  } else {
    if (!confirm('¿Instalar la actualización? La página se recargará.')) return;
    S.update = 'loading'; render();
    try {
      const res = await fetch('/api/update/apply', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Error al actualizar');
      toast(`✓ Versión ${j.version} instalada`);
      if (j.restarting) await waitServerRestart();
      else if (j.serverChanged) alert('Esta actualización cambió el servidor: cierra la ventana negra y abre de nuevo iniciar.bat.');
      setTimeout(() => location.reload(), 800);
    } catch (e) { S.update = { error: e.message }; render(); }
  }
}

// Espera a que el servidor se reinicie solo (nueva ventana) antes de recargar la página.
async function waitServerRestart() {
  toast('↻ Reiniciando el servidor con la versión nueva…', 8000);
  await new Promise((r) => setTimeout(r, 3500));
  for (let i = 0; i < 20; i++) {
    try { const c = await (await fetch('/api/config', { cache: 'no-store' })).json(); if (c.serverVersion) return c; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function restartServer() {
  try {
    const res = await fetch('/api/restart', { method: 'POST' });
    if (!res.ok) throw new Error('El servidor no se puede reiniciar solo');
    await waitServerRestart();
    location.reload();
  } catch {
    alert('Este servidor es de una versión anterior y no puede reiniciarse solo. Cierra la ventana negra de BetBot MX y abre de nuevo iniciar.bat (solo esta vez).');
  }
}

// ---------- eventos ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-tab],[data-tab-link],[data-secleague],[data-mfilter],[data-slip],[data-open],[data-close],[data-stab],[data-ai-run],[data-oddsapi],[data-banktab],[data-cancel],[data-mx],[data-more],[data-tablesleague],[data-newsleague],[data-theme-set],[data-slipdel],[data-slipplace],[data-research],[data-placed],[data-notifclose],[data-notifperm],[data-savekey],[data-update],[data-copydiag],[data-takeover],[data-betsource],[data-cashout],[data-combatdiv],[data-combattitle],[data-smartperiod],[data-smartscan],[data-smartfollow],[data-smartauto],[data-restartserver],[data-pytrain],[data-eventsmart],[data-airetry],[data-phoneenable],[data-notifread],[data-notifall],[data-notiffilter],#bell,#scan-now,#refresh-btn,#reset-bank,#backdrop');
  if (!t) return;
  // Notificaciones: tocar una la marca como leída (y luego abre su partido o enlace); ✓ solo la marca.
  if (t.dataset.notifread) {
    markRead([t.dataset.notifread]);
    renderChrome();
    if (t.dataset.only !== undefined) { e.preventDefault(); e.stopPropagation(); renderNotifPanel(); return; }
    if (!t.dataset.open) { setTimeout(renderNotifPanel, 50); return; }
  }
  if (t.dataset.notifall !== undefined) { markAllRead(); renderNotifPanel(); renderChrome(); toast('✓ Todas marcadas como leídas'); return; }
  if (t.dataset.notiffilter) { notifFilter = t.dataset.notiffilter; renderNotifPanel(); return; }
  if (t.dataset.tabLink || t.dataset.tab) { e.preventDefault(); go(t.dataset.tabLink || t.dataset.tab, t.dataset.moreTab); return; }
  if (t.dataset.slip) { e.preventDefault(); e.stopPropagation(); const [k, pick] = t.dataset.slip.split('|'); addSelection(k, pick, { stake: Number(t.dataset.aistake) || 0 }); return; }
  if (t.dataset.open) { if (t.tagName !== 'A') { closeNotifs(); openMatch(t.dataset.open, t.dataset.goto || 'analysis'); } return; }
  if (t.dataset.close !== undefined || t.id === 'backdrop' || t.dataset.notifclose !== undefined) { closeNotifs(); closeSheets(); return; }
  if (t.id === 'bell') { openNotifs(); return; }
  if (t.dataset.notifperm !== undefined) { Notification.requestPermission().then(() => renderNotifPanel()); return; }
  if (t.dataset.secleague) { const [sec, id] = t.dataset.secleague.split('|'); S.secLeague[sec] = id; if (S.tab !== sec) S.tab = sec; render(); return; }
  if (t.dataset.mfilter) { S.matchFilter = t.dataset.mfilter; render(); return; }
  if (t.dataset.stab) { S.sheetTab = t.dataset.stab; renderSheet(); return; }
  if (t.dataset.banktab) { S.bankTab = t.dataset.banktab; if (S.tab !== 'bank') go('bank'); else render(); return; }
  if (t.dataset.betsource) { S.betSource = t.dataset.betsource; render(); return; }
  if (t.dataset.combatdiv) { S.combatDiv = t.dataset.combatdiv; render(); return; }
  if (t.dataset.smartperiod) { S.smart.period = t.dataset.smartperiod; S.smart.board = null; render(); refreshSmart(true); return; }
  if (t.dataset.smartscan !== undefined) { refreshSmart(true); render(); return; }
  if (t.dataset.eventsmart) { const a = S.analysis.get(t.dataset.eventsmart); if (a) showEventSmart(a, { force: true, perSide: t.dataset.more ? 12 : (S.smart.events.get(t.dataset.eventsmart)?.perSide || 6) }); return; }
  if (t.dataset.pytrain !== undefined) {
    t.disabled = true; t.textContent = 'Entrenando…';
    fetch('/api/modelos/entrenar', { method: 'POST' }).then(() => { toast('🧠 Entrenando el modelo de fútbol (tarda unos segundos)'); setTimeout(() => loadModelos(true), 8000); });
    return;
  }
  if (t.dataset.restartserver !== undefined) { t.disabled = true; t.textContent = 'Reiniciando…'; restartServer(); return; }
  if (t.dataset.smartauto !== undefined) { B.getState().smart.autoFollow = true; B.save(); refreshSmart(true); render(); return; }
  if (t.dataset.smartfollow) {
    const sm = B.getState().smart, w = t.dataset.smartfollow;
    if (sm.follows.some((f) => f.wallet === w)) { sm.follows = sm.follows.filter((f) => f.wallet !== w); toast('Dejaste de seguirlo'); }
    else { sm.follows.push({ wallet: w, name: t.dataset.name }); toast(`🐋 Siguiendo a ${t.dataset.name}`); }
    sm.autoFollow = false; // a partir de ahora manda tu lista
    B.save(); render(); refreshSmart(true);
    return;
  }
  if (t.dataset.combattitle !== undefined) { S.combatTitle = !S.combatTitle; render(); return; }
  if (t.dataset.more) { S.moreTab = t.dataset.more; render(); return; }
  if (t.dataset.tablesleague) { S.tablesLeague = t.dataset.tablesleague; render(); return; }
  if (t.dataset.newsleague) { S.newsLeague = t.dataset.newsleague; S.newsQuery = ''; render(); return; }
  if (t.dataset.themeSet) { try { localStorage.setItem('betbot-theme', t.dataset.themeSet); } catch {} applyTheme(); render(); return; }
  if (t.dataset.cancel) { B.cancelBet(t.dataset.cancel); render(); return; }
  if (t.dataset.slipdel) { B.removeFromSlip(t.dataset.slipdel); S.oddsResearch.delete(t.dataset.slipdel); render(); return; }
  if (t.dataset.slipplace) { placeFromSlip(t.dataset.slipplace); return; }
  if (t.dataset.research) { researchSlipOdds(t.dataset.research); return; }
  if (t.dataset.placed) { B.markPlacedReal(t.dataset.placed); toast('✓ Marcada como colocada'); render(); return; }
  if (t.dataset.savekey) { saveKey(t.dataset.savekey); return; }
  if (t.dataset.update) { updateAction(t.dataset.update); return; }
  if (t.dataset.phoneenable !== undefined) {
    t.disabled = true; t.textContent = 'Esperando el permiso de Windows…';
    try {
      const res = await fetch('/api/phone/enable', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'No se pudo activar');
      toast('✓ Acceso desde el celular activado');
      await new Promise((r) => setTimeout(r, 1500)); // el servidor se vuelve a abrir para la red local
      S.cfg = await D.getConfig();
    } catch (err) { toast('⚠️ ' + err.message, 6000); }
    render();
    return;
  }
  if (t.dataset.cashout) {
    const amt = Number(t.dataset.amount);
    if (confirm(`¿Cobrar ahora esta apuesta por ${money(amt)}? (simulado, en tu banca ficticia)`)) { B.cashOut(t.dataset.cashout, amt); toast('💸 Cobro anticipado registrado'); render(); }
    return;
  }
  if (t.dataset.airetry !== undefined) { S.aiPause = null; toast('Reintentando la IA…'); refreshAll(); return; }
  if (t.dataset.takeover !== undefined) { B.updateSettings({ autopilot: true, autopilotDevice: B.deviceId }); B.log('Piloto automático movido a este dispositivo'); render(); refreshAll(); return; }
  if (t.dataset.copydiag !== undefined) {
    const txt = `BetBot MX ${S.version?.version || ''} · ${navigator.userAgent} · IA: ${S.cfg.hasAnthropic ? 'sí' : 'no'} · Odds API: ${S.cfg.hasOdds ? 'sí' : 'no'} · celular: ${S.cfg.lan ? 'sí' : 'no'}`;
    try { await navigator.clipboard.writeText(txt); toast('✓ Copiado: pégalo en tu mensaje a Claude'); } catch { prompt('Copia este texto:', txt); }
    return;
  }
  if (t.dataset.mx) {
    const v = prompt('Momio que conseguiste en tu casa (ej. +150 o 2.50):');
    const o = parseOddsInput(v);
    if (o) { B.setMxOdds(t.dataset.mx, o); render(); } else if (v) toast('Momio no válido');
    return;
  }
  if (t.dataset.aiRun) {
    const k = t.dataset.aiRun, a = S.analysis.get(k);
    S.ai.set(k, 'loading'); renderSheet();
    try { await runAI(a); S.aiPause = null; } catch (err) { S.ai.set(k, { error: err.message }); if (err?.code === 'sin_saldo' || err?.code === 'clave_invalida') handleAIError(err); }
    if (S.open === k) renderSheet();
    return;
  }
  if (t.dataset.oddsapi) {
    const k = t.dataset.oddsapi, a = S.analysis.get(k), lg = D.leagueById(a.ev.leagueId);
    S.oddsApi.set(k, 'loading'); renderSheet();
    try {
      const data = await D.getOddsApi(lg);
      S.oddsApi.set(k, D.matchOddsApi(a.ev, data));
      if (data._remaining) toast(`The Odds API: quedan ${data._remaining} créditos este mes`);
    } catch (err) { S.oddsApi.set(k, { error: err.message }); }
    renderSheet();
    return;
  }
  if (t.id === 'scan-now' || t.id === 'refresh-btn') { refreshAll(); return; }
  if (t.id === 'reset-bank') {
    const amt = Number($('#reset-amt').value) || 2000;
    if (confirm(`¿Reiniciar la banca ficticia a ${money(amt)}? Se borran las apuestas (el aprendizaje se conserva).`)) { B.resetBank(amt); render(); }
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'py-upload') {
    const files = [...(t.files || [])];
    const msg = $('#py-upload-msg');
    (async () => {
      let saved = 0, rows = 0;
      for (const f of files) {
        if (msg) msg.textContent = `Importando ${f.name}…`;
        try { const r = await (await fetch('/api/historico/subir', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await f.text() })).json(); saved += r.saved || 0; rows += r.rows || 0; } catch {}
      }
      if (msg) msg.textContent = `Listo: ${rows} partidos leídos, ${saved} guardados o completados con momios. El modelo se está re-entrenando.`;
      setTimeout(() => loadModelos(true), 10000);
    })();
    return;
  }
  if (t.id === 'sw-bot247' || t.id === 'sw-keepawake') {
    const body = t.id === 'sw-bot247' ? { enabled: t.checked } : { keepAwake: t.checked };
    fetch('/api/bot/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json()).then((x) => { S.botStatus = x; toast(t.id === 'sw-bot247' ? (t.checked ? '🖥️ Bot 24/7 activado' : 'Bot 24/7 desactivado') : (t.checked ? '🌙 La PC no se dormirá mientras opere' : 'La PC puede dormirse')); render(); })
      .catch(() => toast('No se pudo cambiar (solo desde la PC)'));
    return;
  }
  if (t.id === 'sw-auto') {
    B.updateSettings(t.checked ? { autopilot: true, autopilotDevice: B.deviceId } : { autopilot: false });
    B.log(t.checked ? 'Piloto automático activado' : 'Piloto automático en pausa');
    render(); if (t.checked) refreshAll();
  }
  if (t.id === 'sw-ai') { B.updateSettings({ aiConfirm: t.checked }); render(); }
  if (t.id === 'sw-practice') {
    B.updateSettings(t.checked ? { practiceMode: true, autopilotDevice: B.getState().settings.autopilotDevice || B.deviceId } : { practiceMode: false });
    B.log(t.checked ? 'Modo práctica diaria activado' : 'Modo práctica diaria en pausa');
    render(); if (t.checked) refreshAll();
  }
  if (t.dataset.bookon) { B.updateBook(t.dataset.bookon, { enabled: t.checked }); render(); }
  if (t.dataset.bookbal) { B.updateBook(t.dataset.bookbal, { balance: t.value === '' ? null : Number(t.value) }); toast('Saldo guardado'); render(); }
  if (t.dataset.setting) { const v = Number(t.value); if (Number.isFinite(v)) { B.updateSettings({ [t.dataset.setting]: v }); toast('Ajuste guardado'); if (t.dataset.setting === 'scanMinutes') schedule(); } }
  if (t.dataset.slipquote) {
    const [id, book] = t.dataset.slipquote.split('|');
    const item = B.getState().slip.find((x) => x.id === id);
    if (!item) return;
    const o = parseOddsInput(t.value);
    if (t.value.trim() && !o) toast('Momio no válido: usa +150, −120 o 2.50');
    const quotes = { ...(item.quotes || {}) };
    if (o) quotes[book] = o; else delete quotes[book];
    B.updateSlip(id, { quotes });
    render();
  }
  if (t.dataset.slipstake) { B.updateSlip(t.dataset.slipstake, { stake: Number(t.value) || null }); render(); }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'news-form') { e.preventDefault(); S.newsQuery = $('#news-q').value.trim(); render(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeNotifs(); closeSheets(); } });
// Si había un re-pintado pendiente mientras escribías, se aplica al salir del campo.
document.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender && !typingInView()) render(); }, 0));

function closeNotifs() { $('#notif-panel').classList.remove('open'); if (!S.open) $('#backdrop').classList.remove('open'); }

function applyTheme() {
  let t = 'auto';
  try { t = localStorage.getItem('betbot-theme') || 'auto'; } catch {}
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

let scanTimer = null;
function schedule() {
  clearInterval(scanTimer);
  scanTimer = setInterval(refreshAll, Math.max(1, B.getState().settings.scanMinutes) * 60_000);
}

// Tiempo real: cada 5 s se actualizan solo las ligas con partidos en vivo (o por empezar en 10 min):
// marcadores, probabilidades en vivo, precios de Polymarket/Kalshi y liquidación de apuestas.
let liveBusy = false;
async function liveTick() {
  if (S.scanning || liveBusy || document.hidden) return;
  const soon = (e) => e.state === 'in' || (e.state === 'pre' && new Date(e.date) - Date.now() < 10 * 60_000 && new Date(e.date) - Date.now() > -4 * 3600_000);
  const leagues = D.LEAGUES.filter((lg) => (S.events.get(lg.id) || []).some(soon));
  if (!leagues.length) return;
  liveBusy = true;
  try {
    await Promise.allSettled(leagues.map((lg) => refreshLeague(lg)));
    const events = allEvents();
    B.settleWithEvents(events); B.settleShadow(events); B.cleanSlip(events);
    liveX365().catch(() => {}); // xG en vivo de los partidos de fútbol en juego
    detectChanges();
    S.lastUpdate = Date.now();
    render();
  } finally { liveBusy = false; }
}

// ---------- arranque ----------
(async function init() {
  try { applyTheme(); } catch {}
  await B.loadState();
  S.cfg = await D.getConfig();
  try { S.version = await (await fetch('/version.json')).json(); } catch {}
  try { await initAI(S.cfg); } catch (e) { console.warn('No se pudo cargar el SDK de IA', e); }
  B.onConflict(() => { toast('↻ Se sincronizaron cambios hechos desde otro dispositivo'); render(); });
  render();
  window.__bbStarted = true; // la app ya se pintó: el aviso de error de arranque ya no aplica
  // Bot 24/7: el motor invisible avisa al servidor que sigue vivo (si deja de latir, el servidor lo reinicia).
  if (B.isServerBot) {
    window.addEventListener('error', (e) => { S.lastError = String(e.message || 'error').slice(0, 200); });
    window.addEventListener('unhandledrejection', (e) => { S.lastError = String(e.reason?.message || e.reason || 'error').slice(0, 200); });
    // Cada pestaña del motor tiene su identificación: el servidor solo deja operar a una.
    const pageId = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    let fails = 0;
    const halt = () => { S.halted = true; location.replace('about:blank'); }; // deja de operar por completo
    const beat = () => {
      const st = B.getState(), s = st.settings, today = new Date().toDateString();
      fetch('/api/bot/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        page: pageId, t: Date.now(), lastUpdate: S.lastUpdate || null, scanning: !!S.scanning, autopilot: !!s.autopilot, practice: !!s.practiceMode,
        practiceToday: st.bets.filter((b) => b.source === 'práctica' && new Date(b.placedAt).toDateString() === today).length,
        betsToday: st.bets.filter((b) => b.source !== 'manual' && new Date(b.placedAt).toDateString() === today).length,
        pending: B.pendingBets().length, events: allEvents().length, live: allEvents().filter((e) => e.state === 'in').length,
        aiPaused: aiPaused() ? S.aiPause.msg : null, version: S.version?.version || null, error: S.lastError || null,
      }) }).then((r) => r.json()).then((x) => { fails = 0; if (x && x.stop) halt(); })
        .catch(() => { if (++fails >= 3) halt(); }); // sin servidor 90 s: se apaga (el servidor lo vuelve a abrir al regresar)
    };
    beat();
    setInterval(beat, 30_000);
  } else {
    refreshBotStatus().then(() => render());
    setInterval(async () => { await refreshBotStatus(); if (S.tab === 'home') render(); }, 30_000);
  }
  // App del iPhone: conexión con la PC, deslizar para actualizar, actualizar al volver, guía de instalación.
  if (!B.isServerBot) try { initShell({ refresh: async () => { await refreshAll(); }, isLocal: !!S.cfg.local }); } catch (e) { console.warn('appshell', e); }
  // Datos en tiempo real: escaneo completo cada minuto (si tenías el valor anterior de 3 min, se ajusta a 1).
  if (!B.getState().settings.rt13) B.updateSettings({ scanMinutes: Math.min(B.getState().settings.scanMinutes, 1), rt13: true });
  if (!B.getState().settings.w13) {
    // Pesos más prudentes para modelos con menos información (tenis por ranking, eSports por Elo propio).
    const w = B.getState().weights;
    if (w.tennis >= 0.5) w.tennis = 0.25;
    if (w.esports >= 0.5) w.esports = 0.35;
    B.updateSettings({ w13: true });
  }
  // Al tocar una notificación push: abre su sección (#gold, #bank, #smart).
  const fromHash = () => { const h = location.hash.slice(1); if (NAV.some(([k]) => k === h)) { go(h); history.replaceState(null, '', location.pathname + location.search); } };
  window.addEventListener('hashchange', fromHash);
  fromHash();
  await refreshAll();
  schedule();
  setInterval(liveTick, 5_000);
  // Sincroniza con otros dispositivos (PC ↔ celular).
  setInterval(async () => { if (await B.pullState()) render(); }, 30_000);
  document.addEventListener('visibilitychange', async () => { if (!document.hidden && await B.pullState()) render(); });
  window.addEventListener('resize', () => { if (S.tab === 'home' || S.tab === 'bank') drawEquity(); });
})();
