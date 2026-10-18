import * as D from './data.js';
import * as M from './models.js';
import * as B from './bank.js';
import { initAI, aiReady, analyzeWithAI, researchOdds } from './ai.js';
import { STRATEGY_HTML } from './strategy.js';
import * as K from './books.js';
import { updateElo, esportsTable } from './esports.js';

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
  cfg: {}, tab: 'home', secLeague: { soccer: 'all', sports: 'all', esports: 'all' }, matchFilter: 'upcoming',
  events: new Map(), tables: new Map(), analysis: new Map(), summaries: new Map(), ai: new Map(), oddsApi: new Map(),
  lastUpdate: null, scanning: false, open: null, sheetTab: 'analysis',
  moreTab: 'tables', tablesLeague: 'uefa.champions', newsLeague: 'mex.1', bankTab: 'pending', newsQuery: '',
  oddsResearch: new Map(), notifs: [], newsNotifs: [], newsCheckedAt: 0, goldFirstSeen: new Map(),
  version: null, update: null, pendingRender: false,
};
const allAnalyses = () => [...S.analysis.values()];
const allEvents = () => [...S.events.values()].flat();

function analyze(ev, table, winProb) {
  const st = B.getState();
  const model = M.modelEvent(ev, table || new Map(), winProb);
  const sels = M.selections(ev, model, st.settings, st.weights);
  const golden = M.goldenOpportunities(ev, model, sels);
  B.recordPrediction(ev, model, sels);
  // Aprendizaje sin IA: registra lo que el bot habría apostado (sin tocar la banca).
  if (ev.state === 'pre' && model.known) for (const s of sels) if (s.value) B.recordShadow(ev, s);
  const a = { ev, model, sels, golden };
  S.analysis.set(key(ev), a);
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
  S.events.set(lg.id, events);
  S.tables.set(lg.id, table);
  for (const k of [...S.analysis.keys()]) if (k.startsWith(lg.id + ':')) S.analysis.delete(k);
  for (const ev of events) analyze(ev, table, S.summaries.get(key(ev))?.winProb);
}

async function refreshAll() {
  if (S.scanning) return;
  S.scanning = true;
  $('#last-update').textContent = 'Actualizando…';
  await B.pullState(); // cambios hechos desde otro dispositivo
  const firstLoad = !S.lastUpdate;
  // En la primera carga se pinta conforme llega cada liga (Liquipedia puede tardar ~30 s por su límite).
  await Promise.allSettled(D.LEAGUES.map((lg) => refreshLeague(lg).then(() => { if (firstLoad) render(); }).catch((e) => console.warn(lg.id, e))));
  if (firstLoad) S.lastUpdate = Date.now();
  const events = allEvents();
  B.settleWithEvents(events);
  B.settleShadow(events);
  B.learnFromEvents(events);
  await settleOld();
  // El piloto automático solo corre en el dispositivo donde se activó (evita apuestas duplicadas).
  if (B.isAutopilotHere()) await autopilot();
  try { await loadRelevantNews(); } catch {}
  collectNotifications();
  S.lastUpdate = Date.now();
  S.scanning = false;
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
      const evs = await D.getEventsAround(D.leagueById(b.leagueId), b.eventDate);
      B.settleWithEvents(evs); B.settleShadow(evs);
    } catch (e) { console.warn('liquidación', e); }
  }
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
  const st = B.getState(), s = st.settings;
  let room = s.maxBetsPerDay - B.betsToday();
  if (room <= 0) return;
  const segs = B.segmentStats();
  const cands = [];
  for (const a of allAnalyses()) {
    if (a.ev.state !== 'pre' || !a.model.known || B.hasBetOn(a.ev.id)) continue;
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
    let reasoning = `EV ${pct(sel.ev, 1)} · modelo ${pct(sel.pModel)} vs mercado ${pct(sel.pMarket)}`;
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
  bet: '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 5v12" stroke-dasharray="2 2"/>',
  gold: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/>',
  bank: '<path d="M3 17l5-5 4 4 8-9"/><path d="M15 7h5v5"/>',
  news: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h10M7 17h6"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
};
const icon = (id) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[id]}</svg>`;
const NAV = [['home', 'Inicio'], ['soccer', 'Fútbol'], ['sports', 'Deportes'], ['esports', 'eSports'], ['bet', 'Apostar'], ['gold', 'Oro'], ['bank', 'Banca'], ['news', 'Noticias'], ['more', 'Más']];
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
  const st = B.getState();
  const slipN = st.slip.length, toPlaceN = B.pendingBets().filter((b) => !b.placedReal).length;
  const unread = S.notifs.filter((n) => !isRead(n)).length;
  const badge = (id) => (id === 'bet' && slipN + toPlaceN ? `<span class="badge">${slipN + toPlaceN}</span>` : '');
  const sub = (sec) => (S.tab === sec ? `<div class="side-sub">${D.sectionLeagues(sec).map((l) => {
    const live = (S.events.get(l.id) || []).filter((e) => e.state === 'in').length;
    return `<button class="${S.secLeague[sec] === l.id ? 'active' : ''}" data-secleague="${sec}|${l.id}">${esc(l.name)}${live ? `<span class="dot live"></span>` : ''}</button>`;
  }).join('')}</div>` : '');
  $('#sidebar').innerHTML = `<div class="brand"><span class="brand-icon">⚽</span><div><b>BetBot MX</b><div class="note">v${esc(S.version?.version || '—')}</div></div></div>
    <nav>${NAV.map(([id, label]) => `<button class="side-item ${S.tab === id ? 'active' : ''}" data-tab="${id}">${icon(id)}<span>${label}</span>${badge(id)}</button>${['soccer', 'sports', 'esports'].includes(id) ? sub(id) : ''}`).join('')}</nav>
    <div class="side-foot"><div class="note">Banca disponible</div><b>${money(st.bankroll)}</b><div class="note">${st.settings.autopilot ? (B.isAutopilotHere() ? '🟢 Bot activo aquí' : '🟢 Bot activo en otro dispositivo') : '⚪ Bot en pausa'}</div></div>`;
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

// No se re-pinta mientras escribes en un campo (para no perder lo que tecleas).
const typingInView = () => { const a = document.activeElement; return a && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName); };

function render() {
  renderChrome();
  if (typingInView()) { S.pendingRender = true; return; }
  S.pendingRender = false;
  const v = $('#view');
  const views = { home: viewHome, soccer: () => viewSection('soccer'), sports: () => viewSection('sports'), esports: () => viewSection('esports'), bet: viewBet, gold: viewGold, bank: viewBank, news: viewNews, more: viewMore };
  v.innerHTML = views[S.tab]();
  if (S.tab === 'home' || S.tab === 'bank') drawEquity();
  if (S.tab === 'news') loadNews();
  if (S.tab === 'more' && S.moreTab === 'tables') loadTables();
  if (S.tab === 'more' && S.moreTab === 'phone') loadPhone();
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

function botWidget() {
  const st = B.getState(), s = st.settings;
  const sw = (id, on, dis = false) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}><span></span></label>`;
  return `<div class="widget glass">
    <h3>Piloto automático</h3>
    <div class="list" style="background:var(--fill)">
      <div class="row"><div class="icon-sq" style="background:var(--green-fill)">🤖</div><div class="grow"><b>Apostar automáticamente</b><div class="meta">Solo apuestas con EV ≥ ${pct(s.minEV)} · máx. ${s.maxBetsPerDay} al día${s.autopilot ? (B.isAutopilotHere() ? ' · corre en este dispositivo (mantén esta pestaña abierta)' : ' · corre en otro dispositivo') : ''}</div></div>${s.autopilot && !B.isAutopilotHere() ? '<button class="btn small" data-takeover>Correr aquí</button>' : ''}${sw('sw-auto', s.autopilot)}</div>
      <div class="row"><div class="icon-sq" style="background:var(--purple)">✦</div><div class="grow"><b>Confirmar con IA</b><div class="meta">${aiReady() ? 'Claude revisa cada apuesta y busca noticias' : 'Agrega tu clave de Anthropic en Más → Ajustes'}</div></div>${sw('sw-ai', s.aiConfirm, !aiReady())}</div>
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
  <div class="section-title">En vivo ahora <small>${live.length} partidos</small></div>
  ${live.length ? `<div class="league-block glass">${live.slice(0, 8).map(compactMatch).join('')}</div>` : `<div class="widget glass empty">No hay partidos en vivo en este momento.</div>`}
  <div class="section-title">Oportunidades de Oro <small><a href="#" data-tab-link="gold">Ver todas</a></small></div>
  ${golds.length ? `<div class="grid opps">${golds.map(({ g, a }) => oppCard(g, a)).join('')}</div>` : `<div class="widget glass empty">Sin oportunidades de oro por ahora. El bot sigue buscando.</div>`}
  <div class="section-title">Valor detectado <small>EV positivo con momio de referencia</small></div>
  ${values.length ? `<div class="league-block glass">${values.map(({ s, a }) => valueRow(s, a)).join('')}</div>` : `<div class="widget glass empty">Ninguna selección supera el EV mínimo ahora mismo. Así se ve un mercado eficiente: no apostar también es una decisión.</div>`}
  <div class="grid halves mt">
    <div class="widget glass"><h3>Apuestas pendientes</h3>${pend.length ? betsTable(pend, true) : '<div class="empty">Sin apuestas pendientes</div>'}</div>
    <div class="widget glass"><h3>Actividad del bot</h3>${logList(10)}</div>
  </div>`;
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
  return `<div class="team-line ${t.winner ? 'win' : ''}">${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="nm">${esc(t.name)}${t.seed ? ` <span class="note">(${esc(t.seed)})</span>` : ''}</span><span class="sc">${esc(sc)}</span></div>`;
}

function tagsFor(a) {
  const t = [];
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
    : ev.sport === 'esports' ? { home: ev.home.abbr || 'Eq. 1', away: ev.away.abbr || 'Eq. 2' }
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
    : 'Momios de referencia (DraftKings vía ESPN) · % = probabilidad estimada por el bot';
  const head = (l, items) => {
    const live = items.filter((a) => a.ev.state === 'in').length;
    return `<div class="league-head">${D.SPORT_ICON[l.sport]} ${esc(l.name)}${l.country ? ` <span class="note" style="font-weight:500">· ${esc(l.country)}</span>` : ''}
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
function betsTable(bets, compact = false) {
  const st = (b) => ({ pending: '<span class="tag bet">Pendiente</span>', won: '<span class="tag value">Ganada</span>', lost: '<span class="tag live">Perdida</span>', void: '<span class="tag">Anulada</span>' }[b.status]);
  const casa = (b) => { const k = K.bookById(b.book); return k ? `<span class="tag" style="background:${k.color};color:#fff">${esc(k.name)}</span>` : '<span class="note">—</span>'; };
  return `<div class="table-wrap"><table class="t"><thead><tr><th>Partido</th><th>Selección</th><th>Casa</th><th class="num">Momio</th><th class="num">Monto</th>${compact ? '' : '<th class="num">EV</th><th>Fuente</th><th class="num">Resultado</th>'}<th></th></tr></thead><tbody>
  ${bets.map((b) => `<tr><td class="wrap"><b>${esc(b.home)}</b> vs ${esc(b.away)}<div class="note">${D.leagueById(b.leagueId)?.short || ''} · ${new Date(b.placedAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}${b.live ? ' · en vivo ' + esc(b.scoreAtBet) : ''}</div></td>
    <td class="wrap">${esc(b.label)}<div class="note">${esc(b.market)}</div></td><td>${casa(b)}</td>
    <td class="num">${dec(b.odds)}${b.oddsMx ? '<div class="note">MX</div>' : '<div class="note">ref.</div>'}</td>
    <td class="num">${money(b.stake)}</td>
    ${compact ? '' : `<td class="num">${pct(b.ev, 1)}</td><td>${esc(b.source)}</td><td class="num">${b.status === 'won' ? `<b class="up">+${money(b.payout - b.stake)}</b>` : b.status === 'lost' ? `<b class="down">−${money(b.stake)}</b>` : ''}${b.finalScore ? `<div class="note">${esc(b.finalScore)}</div>` : ''}</td>`}
    <td>${b.status === 'pending' ? `${b.placedReal ? '<span class="tag value">Colocada</span> ' : ''}<button class="btn small" data-mx="${b.id}">Momio real</button> <button class="btn small danger" data-cancel="${b.id}">Anular</button>` : st(b)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function viewBank() {
  const st = B.getState(), m = B.metrics(), L = B.learningStats();
  const bets = S.bankTab === 'pending' ? B.pendingBets() : st.bets.filter((b) => b.status !== 'pending');
  const sports = Object.entries(m.bySport);
  return `${kpis()}
  <div class="grid two mt">
    <div class="widget glass"><h3>Evolución de la banca</h3><div class="chart" id="equity"></div></div>
    <div class="widget glass"><h3>Por deporte</h3>${sports.length ? `<table class="t"><thead><tr><th>Deporte</th><th class="num">Apuestas</th><th class="num">Ganancia</th><th class="num">ROI</th></tr></thead><tbody>
      ${sports.map(([s, v]) => `<tr><td>${D.SPORT_ICON[s]} ${D.SPORT_NAME[s]}</td><td class="num">${v.n}</td><td class="num ${v.profit >= 0 ? 'up' : 'down'}">${signed(v.profit)}</td><td class="num">${pct(v.profit / v.staked, 1)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Aún no hay apuestas liquidadas</div>'}</div>
  </div>
  <div class="section-title">Apuestas <div class="segmented"><button data-banktab="pending" class="${S.bankTab === 'pending' ? 'active' : ''}">Pendientes (${B.pendingBets().length})</button><button data-banktab="history" class="${S.bankTab === 'history' ? 'active' : ''}">Historial</button></div></div>
  <div class="widget glass">${bets.length ? betsTable(bets) : '<div class="empty">Nada por aquí todavía</div>'}</div>
  ${shadowSection()}
  <div class="section-title">Precisión del modelo <small>Frente al mercado (Brier: menor es mejor)</small></div>
  <div class="widget glass"><table class="t"><thead><tr><th>Deporte</th><th class="num">Partidos evaluados</th><th class="num">Acierto del favorito</th><th class="num">Brier modelo</th><th class="num">Brier mercado</th><th class="num">Peso del modelo</th></tr></thead><tbody>
    ${Object.keys(st.weights).map((s) => { const x = L[s]; return `<tr><td>${D.SPORT_ICON[s]} ${D.SPORT_NAME[s]}</td><td class="num">${x?.n || 0}</td><td class="num">${pct(x?.hitRate)}</td><td class="num">${x ? x.bm.toFixed(3) : '—'}</td><td class="num">${x?.bk != null ? x.bk.toFixed(3) : '—'}</td><td class="num"><b>${pct(st.weights[s])}</b></td></tr>`; }).join('')}
  </tbody></table><div class="note mt">El bot guarda su predicción de cada partido antes de que empiece. Con 15 partidos terminados o más en un deporte, ajusta cuánto confía en su modelo frente al mercado. Así aprende sin arriesgar dinero.</div></div>
  <div class="section-title">Actividad</div><div class="widget glass">${logList(40)}</div>`;
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
  const W = Math.max(el.clientWidth, 300), H = 200, P = { l: 56, r: 12, t: 12, b: 26 };
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
  const shortcuts = `<div class="shortcuts mobile-only">${['sports', 'esports', 'gold', 'news'].map((id) => `<button class="shortcut glass" data-tab="${id}">${icon(id)}<span>${NAV.find((n) => n[0] === id)[1]}</span></button>`).join('')}</div>`;
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
    if (box) box.innerHTML = `<div class="widget glass mt"><h3>Ranking Elo del bot · ${esc(lg.name)}</h3>${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>#</th><th>Equipo</th><th class="num">Elo</th><th class="num">Mapas</th><th class="num">Series</th></tr></thead><tbody>
      ${rows.slice(0, 100).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td class="num"><b>${Math.round(r.elo)}</b></td><td class="num">${r.maps}</td><td class="num">${r.series}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">El bot todavía no observa resultados de este juego. El ranking se construye solo con cada serie terminada.</div>'}
      <div class="note mt">Cada equipo empieza en 1500. Ganar un mapa a un rival fuerte sube más el Elo. Entre más resultados observe el bot, más confiable es.</div></div>`;
    return;
  }
  let groups = [];
  try { groups = await D.getStandings(lg); } catch (e) { console.warn(e); }
  const box = $('#tables-box');
  if (!box || S.moreTab !== 'tables') return;
  if (!groups.length) { box.innerHTML = '<div class="widget glass empty">Tabla no disponible</div>'; return; }
  const isTennis = lg.sport === 'tennis', isSoccer = lg.sport === 'soccer';
  box.innerHTML = groups.map((g) => `<div class="widget glass mt"><h3>${esc(g.group)}</h3><div class="table-wrap"><table class="t"><thead><tr><th>#</th><th>${isTennis ? 'Jugador' : 'Equipo'}</th>
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
  }, 30_000);
}

function closeSheets() {
  S.open = null; clearInterval(sheetTimer);
  $('#sheet').classList.remove('open'); $('#backdrop').classList.remove('open');
}

function renderSheet() {
  const a = S.analysis.get(S.open);
  if (!a) return;
  const ev = a.ev, lg = D.leagueById(ev.leagueId), sum = S.summaries.get(S.open);
  $('#sheet-title').innerHTML = `<div class="note">${D.SPORT_ICON[ev.sport]} ${esc(lg.name)}${ev.tournament ? ' · ' + esc(ev.tournament) + ' · ' + esc(ev.round) : ''}${ev.venue && !ev.tournament ? ' · ' + esc(ev.venue) : ''}</div>`;
  const big = ev.state === 'pre' ? (ev.sport === 'esports' ? `Bo${ev.bestOf}` : 'vs') : ev.sport === 'tennis' ?`${(a.model.live?.sets || [0, 0]).join('-')}` : `${ev.home.score ?? 0} - ${ev.away.score ?? 0}`;
  const status = ev.state === 'in' ? `<span class="live-tag" style="color:var(--red)"><span class="dot live"></span> ${esc(ev.detail)}</span>` : ev.state === 'post' ? 'Final' : new Date(ev.date).toLocaleString('es-MX', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const team = (t) => `<div>${t.logo ? `<img src="${esc(t.logo)}" alt="" onerror="this.remove()">` : `<div style="font-size:40px">${D.SPORT_ICON[ev.sport]}</div>`}<div class="tname">${esc(t.name)}</div><div class="note">${esc(t.record || t.flag || '')}${t.form ? ' · ' + esc(t.form) : ''}</div></div>`;
  const tabs = ev.sport === 'esports'
    ? [['analysis', 'Análisis'], ['news', 'Noticias'], ['ai', '✦ IA'], ['odds', 'Momios']]
    : [['analysis', 'Análisis'], ['lineups', ev.sport === 'soccer' ? 'Alineaciones' : 'Plantilla'], ['stats', 'Estadísticas'], ['feed', 'Minuto a minuto'], ['news', 'Noticias'], ['ai', '✦ IA'], ['odds', 'Momios']];
  $('#sheet-body').innerHTML = `<div class="scoreboard">${team(ev.home)}<div><div class="big">${esc(big)}</div><div class="st">${status}</div>${ev.sport === 'tennis' && ev.state !== 'pre' ? `<div class="note">${ev.home.linescores.join(' ')}<br>${ev.away.linescores.join(' ')}</div>` : ''}</div>${team(ev.away)}</div>
    <div class="segmented tabs-inline">${tabs.map(([k, l]) => `<button data-stab="${k}" class="${S.sheetTab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="stab-body">${sheetTab(a, sum)}</div>`;
  if (S.sheetTab === 'news') loadMatchNews(a);
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

function tabOdds(a) {
  const lg = D.leagueById(a.ev.leagueId);
  if (lg.sport === 'esports') return `<div class="widget" style="background:var(--fill)"><h3>Momios de eSports</h3><p class="note">No hay momios gratis de eSports. Caliente, Codere, bet365 y Betano sí tienen mercados de ${esc(lg.name)}: abre el boleto y captura el momio que veas en cada casa. El bot calcula el EV con su probabilidad (${pct(a.sels[0]?.p, 1)} / ${pct(a.sels[1]?.p, 1)}) y te dice dónde conviene apostar.</p>
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
  return ref + extra;
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

function viewBet() {
  const st = B.getState();
  const toPlace = B.pendingBets().filter((b) => !b.placedReal);
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
  for (const a of allAnalyses()) for (const g of a.golden) {
    const id = 'g' + key(a.ev) + g.type;
    if (!S.goldFirstSeen.has(id)) S.goldFirstSeen.set(id, Date.now());
    items.push({ id, t: S.goldFirstSeen.get(id), icon: '★', title: g.title, body: g.why, open: key(a.ev), src: 'Oportunidad de Oro', cat: 'gold' });
  }
  items.push(...S.newsNotifs);
  S.notifs = items.sort((x, y) => y.t - x.t).slice(0, 80);
  // Aviso del navegador para lo nuevo (solo si diste permiso).
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    for (const n of S.notifs.filter((x) => x.t > notifPushed && x.src !== 'Bot').slice(0, 3)) { try { new Notification('BetBot MX · ' + n.src, { body: n.title }); } catch {} }
  }
  notifPushed = Date.now();
}

// Noticias que pueden mover tus apuestas: equipos en el boleto o con apuestas pendientes.
async function loadRelevantNews() {
  if (Date.now() - S.newsCheckedAt < 10 * 60_000) return;
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
  const filters = [['unread', `Sin leer${unreadN ? ` (${unreadN})` : ''}`], ['all', 'Todas'], ['gold', '★ Oro'], ['news', 'Noticias'], ['bot', 'Bot']];
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
  const box = $('#phone-box');
  if (!box) return;
  if (!S.cfg.local) { box.innerHTML = '<div class="widget glass ok">✓ Ya estás usando BetBot MX desde otro dispositivo. Para generar el QR, ábrelo en la computadora.</div>'; return; }
  let net;
  try { net = await (await fetch('/api/network')).json(); } catch { box.innerHTML = '<div class="warn">No se pudo leer la red.</div>'; return; }
  const away = `<div class="widget glass mt"><h3>¿Fuera de casa?</h3><p class="note">El QR funciona en tu misma red WiFi. Para usar el bot con datos móviles, instala <b>Tailscale</b> (gratis) en la PC y en el celular con la misma cuenta. Luego entra desde el celular a <span class="kbd">http://IP-de-Tailscale-de-tu-PC:${net.port}/?t=…</span> (el mismo enlace del QR, cambiando la IP). Así no expones tu PC a internet.</p>
    <p class="note">El bot sigue analizando mientras la PC esté encendida con <span class="kbd">iniciar.bat</span> abierto. El piloto automático corre en el dispositivo donde lo activaste.</p></div>`;
  if (!net.lan) {
    box.innerHTML = `<div class="widget glass"><h3>Activar acceso desde el celular</h3>
      <p>Para que tu celular pueda abrir el bot, Windows necesita permitirlo una sola vez. Presiona el botón y acepta el aviso de administrador que aparecerá en esta PC.</p>
      <button class="btn primary" data-phoneenable>📱 Activar y mostrar el código QR</button>
      <div class="note mt">Esto permite que el bot se abra en tu red local y abre el puerto ${net.port} solo para redes <b>privadas</b> (tu casa), no en redes públicas. Para deshacerlo usa <span class="kbd">deshabilitar-telefono.bat</span>.</div>
      <details class="mt"><summary class="note">¿No funcionó el botón? Hazlo manual</summary><ol class="steps note">
      <li>Cierra la ventana negra de BetBot MX.</li>
      <li>En la carpeta del bot, da doble clic en <span class="kbd">habilitar-telefono.bat</span> y acepta el aviso de administrador.</li>
      <li>Abre de nuevo <span class="kbd">iniciar.bat</span> y regresa aquí.</li></ol></details></div>${away}`;
    return;
  }
  if (!net.ips.length) { box.innerHTML = '<div class="warn">No se encontró una red WiFi o Ethernet activa.</div>' + away; return; }
  let qr;
  try { qr = await loadQrLib(); } catch (e) { box.innerHTML = `<div class="warn">${esc(e.message)}</div>`; return; }
  const cards = net.ips.slice(0, 2).map((ip) => {
    const url = `http://${ip}:${net.port}/?t=${net.token}`;
    const q = qr(0, 'M'); q.addData(url); q.make();
    return `<div class="widget glass qr-card"><div class="qr">${q.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}</div>
      <div class="grow"><h3>Escanéalo con la cámara de tu celular</h3><ol class="steps"><li>Conecta el celular a la misma red WiFi que esta PC.</li><li>Abre la cámara y apunta al código.</li><li>En el navegador: Compartir → <b>Agregar a pantalla de inicio</b> para tenerlo como app.</li></ol>
      <div class="note">Dirección: <span class="kbd">http://${esc(ip)}:${net.port}</span></div><div class="warn mt">El QR contiene tu código de acceso: no lo compartas.</div></div></div>`;
  }).join('');
  box.innerHTML = cards + away;
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
      if (j.serverChanged) alert(`Se instaló la versión ${j.version}. Esta actualización cambió el servidor: cierra la ventana negra y abre de nuevo iniciar.bat.`);
      else toast(`✓ Versión ${j.version} instalada`);
      setTimeout(() => location.reload(), 1200);
    } catch (e) { S.update = { error: e.message }; render(); }
  }
}

// ---------- eventos ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-tab],[data-tab-link],[data-secleague],[data-mfilter],[data-slip],[data-open],[data-close],[data-stab],[data-ai-run],[data-oddsapi],[data-banktab],[data-cancel],[data-mx],[data-more],[data-tablesleague],[data-newsleague],[data-theme-set],[data-slipdel],[data-slipplace],[data-research],[data-placed],[data-notifclose],[data-notifperm],[data-savekey],[data-update],[data-copydiag],[data-takeover],[data-airetry],[data-phoneenable],[data-notifread],[data-notifall],[data-notiffilter],#bell,#scan-now,#refresh-btn,#reset-bank,#backdrop');
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
  if (t.dataset.banktab) { S.bankTab = t.dataset.banktab; render(); return; }
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
  if (t.id === 'sw-auto') {
    B.updateSettings(t.checked ? { autopilot: true, autopilotDevice: B.deviceId } : { autopilot: false });
    B.log(t.checked ? 'Piloto automático activado' : 'Piloto automático en pausa');
    render(); if (t.checked) refreshAll();
  }
  if (t.id === 'sw-ai') { B.updateSettings({ aiConfirm: t.checked }); render(); }
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

// ---------- arranque ----------
(async function init() {
  try { applyTheme(); } catch {}
  await B.loadState();
  S.cfg = await D.getConfig();
  try { S.version = await (await fetch('/version.json')).json(); } catch {}
  try { await initAI(S.cfg); } catch (e) { console.warn('No se pudo cargar el SDK de IA', e); }
  B.onConflict(() => { toast('↻ Se sincronizaron cambios hechos desde otro dispositivo'); render(); });
  render();
  await refreshAll();
  schedule();
  // Sincroniza con otros dispositivos (PC ↔ celular).
  setInterval(async () => { if (await B.pullState()) render(); }, 30_000);
  document.addEventListener('visibilitychange', async () => { if (!document.hidden && await B.pullState()) render(); });
  window.addEventListener('resize', () => { if (S.tab === 'home' || S.tab === 'bank') drawEquity(); });
})();
