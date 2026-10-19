// 365Scores (servicio de datos webws.365scores.com, vía el servidor local): xG por remate, estadísticas
// en vivo y xG reciente de cada equipo para Liga MX, Champions, Premier, LaLiga, Serie A y Ligue 1.
// Pocas consultas: listas cada 10 min (en vivo cada 15 s), y los partidos terminados se guardan para siempre
// en este dispositivo (sus datos ya no cambian), así que cada partido viejo se pide una sola vez.
// Ideas tomadas de los notebooks de LanusStats (federicorabanos/futbol-data-visualizacion): xPoints con
// Poisson a partir del xG y promedios móviles de xG para medir la forma real de un equipo.

const BASE = 'https://webws.365scores.com/web';
const Q = 'appTypeId=5&langId=29&timezoneName=America/Mexico_City&userCountryId=31';
export const COMP365 = { 'mex.1': 141, 'uefa.champions': 572, 'eng.1': 7, 'esp.1': 11, 'ita.1': 17, 'fra.1': 35 };

const mem = new Map();
async function get(path, ttl) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}${Q}`;
  const hit = mem.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  if (hit?.p) return hit.p;
  const p = fetch('/api/proxy?url=' + encodeURIComponent(url)).then(async (r) => {
    if (!r.ok) throw new Error('365Scores HTTP ' + r.status);
    return JSON.parse(await r.text());
  });
  mem.set(url, { ...(hit || {}), p });
  try { const v = await p; mem.set(url, { t: Date.now(), v }); return v; }
  catch (e) { mem.delete(url); throw e; }
}
// Partidos terminados: guardados para siempre (localStorage) porque ya no cambian.
const DONE_KEY = 'bb-365-done';
const done = (() => { try { return new Map(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch { return new Map(); } })();
let saveT = null;
function remember(id, v) {
  done.set(String(id), v);
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { localStorage.setItem(DONE_KEY, JSON.stringify([...done].slice(-1500))); } catch {} }, 1500);
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(fc|cf|club|de|deportivo|cd|sc|ac|afc|ssc|as|rc|ca|the)\b/g, ' ').replace(/[^a-z0-9]/g, '');
const same = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))); };

// Busca el partido de 365Scores de un evento (por equipos y fecha ±12 h).
export async function findGame(ev) {
  const comp = COMP365[ev.leagueId];
  if (!comp) return null;
  const live = ev.state === 'in';
  const lists = await Promise.all([
    get(`/games/current/?competitions=${comp}`, live ? 15_000 : 600_000).catch(() => null),
    ev.state === 'post' ? get(`/games/results/?competitions=${comp}`, 600_000).catch(() => null) : null,
    ev.state === 'pre' ? get(`/games/fixtures/?competitions=${comp}`, 600_000).catch(() => null) : null,
  ]);
  const t = new Date(ev.date).getTime();
  for (const l of lists) for (const g of l?.games || []) {
    if (Math.abs(new Date(g.startTime).getTime() - t) > 12 * 3600_000) continue;
    if (same(g.homeCompetitor.name, ev.home.name) && same(g.awayCompetitor.name, ev.away.name)) return { id: g.id, homeId: g.homeCompetitor.id, awayId: g.awayCompetitor.id, swap: false, status: g.statusGroup };
    if (same(g.homeCompetitor.name, ev.away.name) && same(g.awayCompetitor.name, ev.home.name)) return { id: g.id, homeId: g.awayCompetitor.id, awayId: g.homeCompetitor.id, swap: true, status: g.statusGroup };
  }
  return null;
}

const statVal = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };

// Detalle de un partido: remates con xG (para el flujo de xG) y estadísticas de ambos equipos.
// homeId/awayId son los equipos de 365Scores ya acomodados como local/visita del bot.
export async function gameData(gid, homeId, awayId, finished) {
  const k = String(gid);
  if (done.has(k) && done.get(k).shots) return done.get(k);
  const ttl = finished ? 3600_000 : 15_000;
  const [g, s] = await Promise.all([get(`/game/?gameId=${gid}`, ttl), get(`/game/stats/?games=${gid}`, ttl)]);
  const game = g.game || {};
  const num365home = game.homeCompetitor?.id;
  const shots = (game.chartEvents?.events || []).map((e) => {
    const teamId = e.competitorNum === 1 ? num365home : game.awayCompetitor?.id;
    return { min: parseInt(e.time, 10) || 0, side: teamId === homeId ? 'home' : 'away', xg: statVal(e.xg) || 0, goal: e.outcome?.id === 0 || /gol/i.test(e.outcome?.name || ''), player: e.playerId };
  }).sort((a, b) => a.min - b.min);
  const byStat = new Map();
  for (const r of s.statistics || []) {
    const side = r.competitorId === homeId ? 'home' : r.competitorId === awayId ? 'away' : null;
    if (!side) continue;
    const row = byStat.get(r.id) || { id: r.id, name: r.name, cat: r.categoryName || '' };
    row[side] = r.value;
    byStat.set(r.id, row);
  }
  const stats = [...byStat.values()];
  const xgRow = stats.find((r) => r.id === 76);
  const out = {
    gameId: gid, shots, stats, minute: game.gameTime ?? null, status: game.statusGroup,
    xg: xgRow ? { home: statVal(xgRow.home) ?? 0, away: statVal(xgRow.away) ?? 0 } : shots.length ? {
      home: shots.filter((x) => x.side === 'home').reduce((a, x) => a + x.xg, 0), away: shots.filter((x) => x.side === 'away').reduce((a, x) => a + x.xg, 0),
    } : null,
  };
  if (game.statusGroup === 4) remember(k, out); // terminado: se guarda para siempre
  return out;
}

// xG reciente de un equipo: promedio de sus últimos partidos oficiales terminados (sin amistosos).
// Devuelve { for, against, n, series:[{date, for, against, opp}] }.
const formMem = new Map();
export async function teamForm(teamId, n = 6) {
  const hit = formMem.get(teamId);
  if (hit && Date.now() - hit.t < 6 * 3600_000) return hit.v;
  let r;
  try { r = await get(`/games/results/?competitors=${teamId}`, 6 * 3600_000); }
  catch { return { for: null, against: null, n: 0, series: [] }; } // falla temporal: se reintenta en el siguiente escaneo (no se guarda)
  const games = (r.games || []).filter((g) => g.statusGroup === 4 && !/amistoso|friendly/i.test(g.competitionDisplayName || '')).slice(0, n);
  const series = [];
  for (const g of games) {
    const k = String(g.id);
    let xg = done.get(k)?.xg;
    if (!xg) {
      try {
        const s = await get(`/game/stats/?games=${g.id}`, 24 * 3600_000);
        const rows = (s.statistics || []).filter((x) => x.id === 76);
        const h = rows.find((x) => x.competitorId === g.homeCompetitor.id), a = rows.find((x) => x.competitorId === g.awayCompetitor.id);
        if (!h || !a) continue;
        xg = { home: statVal(h.value), away: statVal(a.value) };
        remember(k, { ...(done.get(k) || {}), xg, homeTeam: g.homeCompetitor.id });
      } catch { continue; }
    }
    const isHome = g.homeCompetitor.id === teamId;
    series.push({ date: g.startTime, for: isHome ? xg.home : xg.away, against: isHome ? xg.away : xg.home, opp: isHome ? g.awayCompetitor.name : g.homeCompetitor.name, comp: g.competitionDisplayName });
  }
  const avg = (k) => (series.length ? series.reduce((a, x) => a + (x[k] || 0), 0) / series.length : null);
  const v = { for: avg('for'), against: avg('against'), n: series.length, series };
  formMem.set(teamId, { t: Date.now(), v });
  return v;
}

// xPoints: puntos esperados con Poisson a partir del xG de cada equipo (exacto, sin simular).
const fact = [1]; for (let i = 1; i <= 15; i++) fact[i] = fact[i - 1] * i;
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / fact[k];
export function xPoints(xgH, xgA) {
  let H = 0, D = 0, A = 0;
  for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) { const p = pois(i, xgH) * pois(j, xgA); if (i > j) H += p; else if (i === j) D += p; else A += p; }
  const s = H + D + A;
  return { pHome: H / s, pDraw: D / s, pAway: A / s, home: (3 * H + D) / s, away: (3 * A + D) / s };
}
