// Capa de datos: ESPN (no oficial), MLB Stats API (LMB), Google News RSS y The Odds API.
// Todo se normaliza a un formato común de "evento" para que los modelos y la UI no dependan de la fuente.

import { getEsportsEvents } from './esports.js';
import { marketEvents, attachOddsApi } from './prediction.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_WEB = 'https://site.web.api.espn.com/apis/v2/sports';
const MLB = 'https://statsapi.mlb.com/api/v1';

// Orden = importancia (así se muestran en la app).
export const LEAGUES = [
  { id: 'uefa.champions', sport: 'soccer', name: 'Champions League', short: 'UCL', country: 'Europa', path: 'soccer/uefa.champions', oddsKey: 'soccer_uefa_champs_league' },
  { id: 'eng.1', sport: 'soccer', name: 'Premier League', short: 'ENG', country: 'Inglaterra', path: 'soccer/eng.1', oddsKey: 'soccer_epl' },
  { id: 'esp.1', sport: 'soccer', name: 'LaLiga', short: 'ESP', country: 'España', path: 'soccer/esp.1', oddsKey: 'soccer_spain_la_liga' },
  { id: 'mex.1', sport: 'soccer', name: 'Liga MX', short: 'MX', country: 'México', path: 'soccer/mex.1', oddsKey: 'soccer_mexico_ligamx' },
  { id: 'ita.1', sport: 'soccer', name: 'Serie A', short: 'ITA', country: 'Italia', path: 'soccer/ita.1', oddsKey: 'soccer_italy_serie_a' },
  { id: 'fra.1', sport: 'soccer', name: 'Ligue 1', short: 'FRA', country: 'Francia', path: 'soccer/fra.1', oddsKey: 'soccer_france_ligue_one' },
  { id: 'nfl', sport: 'football', name: 'NFL', short: 'NFL', path: 'football/nfl', oddsKey: 'americanfootball_nfl' },
  { id: 'nba', sport: 'basketball', name: 'NBA', short: 'NBA', path: 'basketball/nba', oddsKey: 'basketball_nba' },
  { id: 'mlb', sport: 'baseball', name: 'MLB', short: 'MLB', path: 'baseball/mlb', oddsKey: 'baseball_mlb' },
  { id: 'lmb', sport: 'baseball', name: 'Liga Mexicana de Béisbol', short: 'LMB', source: 'mlbstats', sportId: 23, leagueId: 125 },
  { id: 'atp', sport: 'tennis', name: 'ATP', short: 'ATP', path: 'tennis/atp' },
  { id: 'wta', sport: 'tennis', name: 'WTA', short: 'WTA', path: 'tennis/wta' },
  { id: 'ufc', sport: 'mma', name: 'UFC', short: 'UFC', path: 'mma/ufc', oddsKey: 'mma_mixed_martial_arts' },
  { id: 'boxing', sport: 'boxing', name: 'Boxeo', short: 'BOX', source: 'markets', oddsKey: 'boxing_boxing' },
  { id: 'lol', sport: 'esports', game: 'lol', name: 'League of Legends', short: 'LoL', source: 'lolesports' },
  { id: 'valorant', sport: 'esports', game: 'valorant', name: 'Valorant', short: 'VAL', source: 'liquipedia', wiki: 'valorant' },
  { id: 'cs2', sport: 'esports', game: 'cs2', name: 'Counter-Strike 2', short: 'CS2', source: 'liquipedia', wiki: 'counterstrike' },
];

// Secciones de la app: fútbol, el resto de deportes y eSports por separado.
export const SECTIONS = {
  soccer: { title: 'Fútbol', sub: 'Ligas ordenadas por importancia', sports: ['soccer'] },
  sports: { title: 'Deportes', sub: 'NFL, NBA, béisbol y tenis', sports: ['football', 'basketball', 'baseball', 'tennis'] },
  combat: { title: 'Combate', sub: 'UFC y boxeo', sports: ['mma', 'boxing'] },
  esports: { title: 'eSports', sub: 'League of Legends, Valorant y Counter-Strike 2', sports: ['esports'] },
};
export const sectionLeagues = (sec) => LEAGUES.filter((l) => SECTIONS[sec].sports.includes(l.sport));

export const SPORT_ICON = { soccer: '⚽', football: '🏈', basketball: '🏀', baseball: '⚾', tennis: '🎾', mma: '🥋', boxing: '🥊', esports: '🎮' };
export const SPORT_NAME = { soccer: 'Fútbol', football: 'Fútbol americano', basketball: 'Básquetbol', baseball: 'Béisbol', tennis: 'Tenis', mma: 'MMA (UFC)', boxing: 'Boxeo', esports: 'eSports' };
const WEIGHT_ES = {
  Strawweight: 'Peso paja', Flyweight: 'Peso mosca', Bantamweight: 'Peso gallo', Featherweight: 'Peso pluma', Lightweight: 'Peso ligero',
  Welterweight: 'Peso wélter', Middleweight: 'Peso medio', 'Light Heavyweight': 'Peso semipesado', Heavyweight: 'Peso pesado', Catchweight: 'Peso pactado',
};
const weightEs = (s) => { s = String(s || ''); const w = s.startsWith("Women's ") ? s.slice(8) : s; return (WEIGHT_ES[w] || w) + (s.startsWith("Women's ") ? ' femenil' : ''); };

// Traducciones de textos que ESPN o MLB a veces dejan en inglés.
const ROUND_ES = [
  [/qualifying/i, 'Clasificación'], [/round of (\d+)/i, 'Ronda de $1'], [/1st round/i, '1.ª ronda'], [/2nd round/i, '2.ª ronda'],
  [/3rd round/i, '3.ª ronda'], [/4th round/i, '4.ª ronda'], [/quarterfinals?/i, 'Cuartos de final'], [/semifinals?/i, 'Semifinal'], [/^final$/i, 'Final'],
];
export function roundEs(s) {
  let out = s || '';
  for (const [re, es] of ROUND_ES) out = out.replace(re, es);
  return out.replace('Clasificación 1.ª', 'Clasificación, 1.ª').replace('Clasificación 2.ª', 'Clasificación, 2.ª');
}
const STATE_ES = { Final: 'Final', 'Game Over': 'Final', Scheduled: 'Programado', 'Pre-Game': 'Previo', Warmup: 'Calentamiento', Postponed: 'Pospuesto', Suspended: 'Suspendido', Cancelled: 'Cancelado', Delayed: 'Retrasado', 'In Progress': 'En juego' };
const stateEs = (s) => STATE_ES[s] || s || '';
export const leagueById = (id) => LEAGUES.find((l) => l.id === id);

// Logos oficiales de las ligas (ESPN los actualiza al leer cada scoreboard).
export const LEAGUE_LOGO = {
  lmb: 'https://www.mlbstatic.com/team-logos/league-on-dark/125.svg',
  lol: 'https://static.lolesports.com/leagues/1592594612171_WorldsDarkBG.png',
};
export const leagueLogo = (id) => LEAGUE_LOGO[id] || '';

// ---------- utilidades ----------
const cache = new Map();
async function getJSON(url, ttlMs = 30_000) {
  // ESPN en español de México: nombres, estados, estadísticas, narración y noticias.
  if (url.includes('espn.com')) url += (url.includes('?') ? '&' : '?') + 'lang=es&region=mx';
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  const v = await res.json();
  cache.set(url, { t: Date.now(), v });
  return v;
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

export function americanToDecimal(a) {
  if (a === undefined || a === null) return null;
  const s = String(a).trim().toUpperCase();
  if (s === 'EVEN' || s === 'EV') return 2;
  const n = Number(s.replace('+', ''));
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}

// ---------- ESPN: eventos ----------
function parseEspnOdds(comp) {
  const o = comp.odds && comp.odds[0];
  if (!o) return null;
  const ml = o.moneyline || {};
  const pick = (side, which) => americanToDecimal(ml[side]?.[which]?.odds);
  const home = pick('home', 'close') ?? americanToDecimal(o.homeTeamOdds?.moneyLine);
  const away = pick('away', 'close') ?? americanToDecimal(o.awayTeamOdds?.moneyLine);
  const draw = pick('draw', 'close') ?? americanToDecimal(o.drawOdds?.moneyLine);
  const t = o.total || {};
  const total = o.overUnder != null ? {
    line: Number(o.overUnder),
    over: americanToDecimal(t.over?.close?.odds),
    under: americanToDecimal(t.under?.close?.odds),
  } : null;
  if (!home && !away && !total) return null;
  return {
    provider: o.provider?.name || 'ESPN',
    home, away, draw, total,
    open: { home: pick('home', 'open'), away: pick('away', 'open'), draw: pick('draw', 'open') },
    details: o.details || '',
  };
}

function parseCompetitor(c) {
  const t = c.team || {};
  const a = c.athlete || {};
  return {
    id: t.id || a.id || c.id,
    name: t.displayName || a.displayName || c.displayName || '¿?',
    abbr: t.abbreviation || (a.displayName ? a.displayName.split(' ').slice(-1)[0].slice(0, 3).toUpperCase() : ''),
    logo: t.logo || a.flag?.href || '',
    score: num(c.score),
    form: c.form || '',
    record: c.records?.[0]?.summary || '',
    winner: c.winner === true,
    seed: c.seed || '',
    flag: a.flag?.alt || '',
    linescores: (c.linescores || []).map((l) => num(l.value)),
  };
}

function parseStatus(st) {
  const type = st?.type || {};
  return {
    state: type.state || 'pre',
    completed: !!type.completed,
    detail: type.shortDetail || type.detail || '',
    clock: st?.displayClock || '',
    period: st?.period || 0,
    clockSec: st?.clock || 0,
  };
}

function normalizeTeamEvent(ev, league) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((c) => c.homeAway === 'home') || comp.competitors[0];
  const away = comp.competitors.find((c) => c.homeAway === 'away') || comp.competitors[1];
  const h = parseCompetitor(home), a = parseCompetitor(away);
  return {
    id: ev.id, leagueId: league.id, sport: league.sport, name: `${h.name} vs ${a.name}`,
    date: ev.date, ...parseStatus(comp.status || ev.status),
    home: h, away: a,
    odds: parseEspnOdds(comp), venue: comp.venue?.fullName || '',
    neutral: !!comp.neutralSite,
  };
}

function normalizeTennis(ev, league) {
  const out = [];
  for (const g of ev.groupings || []) {
    const gname = g.grouping?.displayName || '';
    if (!/singles|individual/i.test(gname)) continue;
    const male = /men|varonil|masculin/i.test(gname) && !/women|femenil|femenin/i.test(gname);
    for (const comp of g.competitions || []) {
      if (!comp.competitors || comp.competitors.length < 2) continue;
      const [p1, p2] = comp.competitors;
      const bestOf = ev.major && male ? 5 : 3;
      out.push({
        id: comp.id, leagueId: league.id, sport: 'tennis',
        name: `${p1.athlete?.displayName || '?'} vs ${p2.athlete?.displayName || '?'}`,
        date: comp.date || comp.startDate, ...parseStatus(comp.status),
        home: parseCompetitor(p1), away: parseCompetitor(p2),
        odds: null, venue: ev.name, tournament: ev.name, round: roundEs(comp.round?.displayName),
        bestOf,
      });
    }
  }
  return out;
}

// UFC: cada evento de ESPN trae varias peleas; cada pelea se vuelve un "partido" (esquina roja vs azul).
// Segmento de la cartelera según el orden (ESPN lista de la primera pelea a la estelar).
function cardSegment(i, n) {
  const fromEnd = n - 1 - i;
  if (fromEnd === 0) return 'Estelar';
  if (fromEnd === 1) return 'Coestelar';
  if (fromEnd <= 4) return 'Cartelera principal';
  return 'Preliminares';
}

function normalizeFights(ev, league) {
  const comps = (ev.competitions || []).filter((c) => (c.competitors || []).length === 2);
  return comps.map((comp, i) => {
    const sorted = [...comp.competitors].sort((a, b) => (a.order || 0) - (b.order || 0));
    const weightRaw = comp.type?.abbreviation || comp.type?.text || '';
    const side = (c) => {
      const a = c.athlete || {};
      const aid = a.id || c.id;
      const rec = c.records?.[0]?.summary || '';
      const [w, l] = rec.split('-').map(Number);
      const belts = [].concat(a.accolades || []).filter((x) => x && /belt|title/i.test(`${x.type} ${x.name}`)).map((x) => x.name);
      return {
        id: 'f' + aid, athleteId: aid, name: a.displayName || '¿?', abbr: (a.shortName || a.displayName || '').split(' ').slice(-1)[0],
        logo: aid ? `https://a.espncdn.com/i/headshots/mma/players/full/${aid}.png` : a.flag?.href || '', flagUrl: a.flag?.href || '',
        score: null, form: '', record: rec, recW: Number.isFinite(w) ? w : null, recL: Number.isFinite(l) ? l : null,
        winner: c.winner === true, seed: '', flag: a.flag?.alt || '', linescores: [], belts,
      };
    };
    const h = side(sorted[0]), a = side(sorted[1]);
    const rounds = comp.format?.regulation?.periods || 3;
    // Pelea de campeonato: algún peleador tiene el cinturón de esta división (o interino) y la pelea es a 5 rounds.
    const wr = weightRaw.toLowerCase();
    const beltHere = wr && [...h.belts, ...a.belts].find((b) => { const bl = b.toLowerCase(); return bl.includes(`ufc ${wr} title`) || bl.includes(`interim ${wr} title`); });
    const titleFight = rounds === 5 && !!beltHere;
    const st = parseStatus(comp.status);
    return {
      id: comp.id, leagueId: league.id, sport: 'mma', name: `${h.name} vs ${a.name}`, date: comp.date || ev.date, ...st,
      home: h, away: a, odds: null, venue: comp.venue?.fullName || ev.name, tournament: ev.name,
      round: weightEs(weightRaw), weightRaw, women: /women/i.test(weightRaw), rounds,
      segment: cardSegment(i, comps.length), order: i, titleFight, belt: titleFight ? beltEs(beltHere) : '',
    };
  });
}
function beltEs(b) {
  let s = String(b || '').replace(/^UFC /, '').replace(/ Title$/, '');
  const interim = s.includes('Interim '), women = s.includes("Women's ");
  s = s.replace('Interim ', '').replace("Women's ", '');
  return `Título${interim ? ' interino' : ''} ${WEIGHT_ES[s] || s}${women ? ' femenil' : ''}`;
}

// Perfil y estadísticas de un peleador (ESPN): KO/TKO, sumisiones, decisiones, golpes, derribos, físico.
export async function getFighter(athleteId) {
  const [prof, stats, recs] = await Promise.allSettled([
    getJSON(`https://site.web.api.espn.com/apis/common/v3/sports/mma/athletes/${athleteId}`, 3_600_000),
    getJSON(`https://sports.core.api.espn.com/v2/sports/mma/athletes/${athleteId}/statistics`, 3_600_000),
    getJSON(`https://sports.core.api.espn.com/v2/sports/mma/athletes/${athleteId}/records`, 3_600_000),
  ]);
  const p = prof.status === 'fulfilled' ? prof.value.athlete || {} : {};
  const s = {};
  if (stats.status === 'fulfilled') for (const c of stats.value.splits?.categories || []) for (const x of c.stats || []) s[x.name] = x.value;
  const r = {};
  if (recs.status === 'fulfilled') for (const x of recs.value.items?.[0]?.stats || []) r[x.name] = x.value;
  return {
    name: p.displayName, nickname: p.nickname || '', age: p.age, height: p.displayHeight, reach: p.displayReach, weight: p.displayWeight,
    stance: p.stance?.text || '', style: p.displayFightingStyle || '', team: p.association?.name || '', country: p.citizenship || p.flag?.alt || '',
    headshot: p.headshot?.href || '',
    wins: r.wins, losses: r.losses, draws: r.draws, kos: r.tkos, subs: r.submissions, koLosses: r.tkoLosses, subLosses: r.submissionLosses,
    titleWins: r.titleWins, titleLosses: r.titleLosses,
    koPct: s.koPercentage ?? s.tkoPercentage, decPct: s.decisionPercentage, subAvg: s.submissionAvg,
    strikeLPM: s.strikeLPM, strikeAcc: s.strikeAccuracy, tdAvg: s.takedownAvg, tdAcc: s.takedownAccuracy,
  };
}

async function espnScoreboard(league, dateStr) {
  const url = `${ESPN}/${league.path}/scoreboard${dateStr ? `?dates=${dateStr}` : ''}`;
  const data = await getJSON(url, 15_000);
  const lgLogo = data.leagues?.[0]?.logos?.find((l) => /dark/i.test((l.rel || []).join(' ')))?.href || data.leagues?.[0]?.logos?.[0]?.href;
  if (lgLogo && !/ESPN-icon/i.test(lgLogo)) LEAGUE_LOGO[league.id] = lgLogo;
  if (league.sport === 'tennis') return (data.events || []).flatMap((e) => normalizeTennis(e, league));
  if (league.sport === 'mma') {
    if (!dateStr) league._calendar = data.leagues?.[0]?.calendar || [];
    return (data.events || []).flatMap((e) => normalizeFights(e, league));
  }
  return (data.events || []).map((e) => normalizeTeamEvent(e, league));
}

// ---------- MLB Stats API: LMB ----------
async function lmbSchedule(league, from, to) {
  const url = `${MLB}/schedule?sportId=${league.sportId}&leagueId=${league.leagueId}&startDate=${from}&endDate=${to}&hydrate=linescore,probablePitcher`;
  const data = await getJSON(url, 30_000);
  const out = [];
  for (const d of data.dates || []) {
    for (const g of d.games || []) {
      const st = g.status?.abstractGameState;
      const ls = g.linescore || {};
      const side = (s) => ({
        id: String(g.teams[s].team.id), name: g.teams[s].team.name, abbr: (g.teams[s].team.name || '').slice(0, 3).toUpperCase(),
        logo: `https://www.mlbstatic.com/team-logos/${g.teams[s].team.id}.svg`, score: num(g.teams[s].score), form: '', record: g.teams[s].leagueRecord ? `${g.teams[s].leagueRecord.wins}-${g.teams[s].leagueRecord.losses}` : '',
        winner: !!g.teams[s].isWinner, linescores: [], pitcher: g.teams[s].probablePitcher?.fullName || '',
      });
      out.push({
        id: String(g.gamePk), leagueId: league.id, sport: 'baseball', name: `${g.teams.home.team.name} vs ${g.teams.away.team.name}`,
        date: g.gameDate, state: st === 'Final' ? 'post' : st === 'Live' ? 'in' : 'pre', completed: st === 'Final',
        detail: st === 'Live' ? `${{ Top: 'Alta', Bottom: 'Baja', Middle: 'Mitad', End: 'Fin' }[ls.inningState] || ''} ${ls.currentInning || ''}`.trim() : stateEs(g.status?.detailedState),
        clock: '', period: ls.currentInning || 0, home: side('home'), away: side('away'), odds: null, venue: g.venue?.name || '',
      });
    }
  }
  return out;
}

// Eventos de una liga: hoy y los próximos días (ESPN no acepta rangos, se pide día por día).
export async function getEvents(league, days = 3) {
  if (league.sport === 'esports') return (await getEsportsEvents(league)).sort((a, b) => new Date(a.date) - new Date(b.date));
  if (league.source === 'markets') return (await marketEvents(league)).sort((a, b) => new Date(a.date) - new Date(b.date));
  if (league.sport === 'mma') {
    // Evento más reciente + los próximos del calendario de la UFC (dos semanas).
    const out = new Map();
    for (const f of await espnScoreboard(league)) out.set(f.id, f);
    const now = Date.now();
    const next = (league._calendar || []).map((c) => (typeof c === 'string' ? { startDate: c } : c))
      .filter((c) => { const t = new Date(c.startDate).getTime(); return t > now - 86400000 && t < now + 15 * 86400000; }).slice(0, 2);
    for (const c of next) {
      const d = new Date(new Date(c.startDate).getTime() - 5 * 3600000); // fecha del evento en hora de EE. UU.
      try { for (const f of await espnScoreboard(league, ymd(d))) out.set(f.id, f); } catch {}
    }
    const fights = [...out.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
    await attachOddsApi(league, fights.filter((f) => f.state !== 'post')); // momios de casas (si tienes clave)
    return fights;
  }
  const now = new Date();
  if (league.source === 'mlbstats') {
    const from = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    const to = new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
    return lmbSchedule(league, from, to);
  }
  const reqs = [espnScoreboard(league)];
  if (league.sport !== 'tennis') {
    for (let i = 0; i < days; i++) reqs.push(espnScoreboard(league, ymd(new Date(now.getTime() + i * 86400000))));
  }
  const results = await Promise.allSettled(reqs);
  const seen = new Map();
  for (const r of results) if (r.status === 'fulfilled') for (const e of r.value) seen.set(e.id, e);
  return [...seen.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Eventos de una fecha concreta (para liquidar apuestas de días anteriores).
export async function getEventsAround(league, isoDate) {
  const d = new Date(isoDate);
  if (league.sport === 'esports') return getEsportsEvents(league);
  if (league.source === 'markets') return marketEvents(league);
  if (league.sport === 'mma') {
    const res = await Promise.allSettled([new Date(d.getTime() - 86400000), d].map((x) => espnScoreboard(league, ymd(x))));
    return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  }
  if (league.source === 'mlbstats') {
    const day = d.toISOString().slice(0, 10);
    return lmbSchedule(league, day, day);
  }
  if (league.sport === 'tennis') return espnScoreboard(league);
  const days = [new Date(d.getTime() - 86400000), d];
  const res = await Promise.allSettled(days.map((x) => espnScoreboard(league, ymd(x))));
  return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

// ---------- Tablas de posiciones ----------
function collectEntries(node, groupName, out) {
  if (node.standings?.entries?.length) out.push({ group: node.name || groupName, entries: node.standings.entries });
  for (const ch of node.children || []) collectEntries(ch, ch.name || groupName, out);
  return out;
}

export async function getStandings(league) {
  if (league.sport === 'esports') return []; // el ranking de eSports es el Elo propio del bot (lo arma la app)
  if (league.sport === 'mma' || league.sport === 'boxing') return []; // en combate no hay tabla: cuenta el récord de cada peleador
  if (league.sport === 'tennis') return getTennisRankings(league);
  if (league.source === 'mlbstats') {
    const season = new Date().getFullYear();
    const data = await getJSON(`${MLB}/standings?leagueId=${league.leagueId}&season=${season}`, 600_000);
    return (data.records || []).map((r, i) => ({
      group: r.division?.name || (i === 0 ? 'Zona Norte' : 'Zona Sur'),
      rows: r.teamRecords.map((t) => ({
        teamId: String(t.team.id), name: t.team.name, logo: '', gp: t.wins + t.losses, w: t.wins, l: t.losses, d: 0,
        pf: t.runsScored, pa: t.runsAllowed, pts: null, pct: Number(t.winningPercentage),
      })),
    }));
  }
  const data = await getJSON(`${ESPN_WEB}/${league.path}/standings`, 600_000);
  return collectEntries(data, data.name, []).map((g) => ({
    group: g.group,
    rows: g.entries.map((e) => {
      const s = Object.fromEntries((e.stats || []).map((x) => [x.name, x.value]));
      return {
        teamId: String(e.team.id), name: e.team.displayName, logo: e.team.logos?.[0]?.href || '',
        gp: s.gamesPlayed ?? (s.wins || 0) + (s.losses || 0) + (s.ties || 0),
        w: s.wins ?? 0, l: s.losses ?? 0, d: s.ties ?? 0,
        pf: s.pointsFor ?? 0, pa: s.pointsAgainst ?? 0, pts: s.points ?? null,
        pct: s.winPercent ?? null, rank: s.rank ?? null,
      };
    }).sort((a, b) => (a.rank && b.rank ? a.rank - b.rank : (b.pts ?? b.pct ?? 0) - (a.pts ?? a.pct ?? 0))),
  }));
}

export async function getTennisRankings(league) {
  const data = await getJSON(`${ESPN}/${league.path}/rankings`, 3_600_000);
  const ranks = data.rankings?.[0]?.ranks || [];
  return [{
    group: data.rankings?.[0]?.name || 'Ranking',
    rows: ranks.map((r) => ({ teamId: String(r.athlete?.id), name: r.athlete?.displayName, rank: r.current, pts: r.points, logo: r.athlete?.flag?.href || '' })),
  }];
}

// Mapa teamId -> fila de tabla (para modelos)
export async function getTeamTable(league) {
  try {
    const groups = await getStandings(league);
    const map = new Map();
    for (const g of groups) for (const r of g.rows) map.set(String(r.teamId), r);
    // Ranking de tenis: también por nombre (el scoreboard trae ids de atleta compatibles, pero por si acaso)
    if (league.sport === 'tennis') for (const g of groups) for (const r of g.rows) map.set('n:' + r.name, r);
    return map;
  } catch (e) {
    console.warn('Sin tabla para', league.id, e);
    return new Map();
  }
}

// ---------- Detalle de partido ----------
export async function getSummary(league, eventId) {
  if (league.sport === 'esports' || league.sport === 'mma' || league.sport === 'boxing') {
    return { lineups: [], stats: [], keyEvents: [], commentary: [], news: [], injuries: [], winProb: null, lastFive: [] };
  }
  if (league.source === 'mlbstats') {
    const data = await getJSON(`https://statsapi.mlb.com/api/v1.1/game/${eventId}/feed/live`, 20_000);
    const box = data.liveData?.boxscore?.teams || {};
    const lineup = (side) => (box[side]?.battingOrder || []).map((pid) => {
      const p = box[side].players['ID' + pid];
      return { name: p?.person?.fullName, pos: p?.position?.abbreviation, jersey: p?.jerseyNumber, starter: true };
    });
    return {
      lineups: [
        { team: data.gameData?.teams?.home?.name, formation: '', players: lineup('home') },
        { team: data.gameData?.teams?.away?.name, formation: '', players: lineup('away') },
      ],
      stats: [], keyEvents: (data.liveData?.plays?.scoringPlays || []).map((i) => {
        const p = data.liveData.plays.allPlays[i];
        return { clock: `${p.about.halfInning === 'top' ? 'Alta' : 'Baja'} ${p.about.inning}`, text: p.result.description, type: 'Carrera' };
      }),
      commentary: [], news: [], injuries: [], winProb: null, lastFive: [],
      probablePitchers: { home: data.gameData?.probablePitchers?.home?.fullName, away: data.gameData?.probablePitchers?.away?.fullName },
    };
  }
  const data = await getJSON(`${ESPN}/${league.path}/summary?event=${eventId}`, 10_000);
  const lineups = (data.rosters || []).map((r) => ({
    team: r.team?.displayName, teamId: String(r.team?.id), homeAway: r.homeAway, formation: r.formation || '',
    players: (r.roster || []).map((p) => ({
      name: p.athlete?.displayName, pos: p.position?.abbreviation, jersey: p.jersey, starter: !!p.starter,
      place: num(p.formationPlace), subIn: !!p.subbedIn, subOut: !!p.subbedOut,
    })),
  }));
  const stats = (data.boxscore?.teams || []).map((t) => ({
    team: t.team?.displayName, teamId: String(t.team?.id),
    stats: Object.fromEntries((t.statistics || []).map((s) => [s.label || s.name, s.displayValue])),
  }));
  const wp = data.winprobability?.length ? data.winprobability[data.winprobability.length - 1] : null;
  return {
    lineups, stats,
    keyEvents: (data.keyEvents || data.scoringPlays || []).map((k) => ({
      clock: k.clock?.displayValue || (k.period ? `P${k.period.number}` : ''), text: k.text || k.shortText || '', type: k.type?.text || '', team: k.team?.displayName || '',
    })),
    commentary: (data.commentary || []).map((c) => ({ clock: c.time?.displayValue || '', text: c.text })).reverse(),
    news: (data.news?.articles || []).map((a) => ({ title: a.headline, desc: a.description, date: a.published, url: a.links?.web?.href })),
    injuries: (data.injuries || []).map((t) => ({
      team: t.team?.displayName,
      list: (t.injuries || []).map((i) => ({ name: i.athlete?.displayName, status: i.status, detail: i.details?.type || i.type?.description || '' })),
    })),
    winProb: wp ? { home: wp.homeWinPercentage, tie: wp.tiePercentage || 0 } : null,
    lastFive: (data.lastFiveGames || []).map((t) => ({
      team: t.team?.displayName, teamId: String(t.team?.id),
      games: (t.events || []).map((g) => ({ result: g.gameResult, score: g.score, opp: g.opponent?.displayName, date: g.gameDate })),
    })),
    odds: data.pickcenter?.[0] ? parseEspnOdds({ odds: [data.pickcenter[0]] }) : null,
    standings: data.standings || null,
  };
}

// ---------- Noticias ----------
export async function getLeagueNews(league) {
  if (league.sport === 'esports') return searchNews(`${league.name} esports`, 10);
  if (league.sport === 'boxing') return searchNews('boxeo pelea', 12);
  if (!league.path) return [];
  try {
    const data = await getJSON(`${ESPN}/${league.path}/news`, 300_000);
    return (data.articles || []).map((a) => ({ title: a.headline, desc: a.description, date: a.published, url: a.links?.web?.href, source: 'ESPN' }));
  } catch { return []; }
}

export async function searchNews(query, max = 12, lang = 'es') {
  // lang 'en' sirve para opiniones de especialistas en inglés (MMA Junkie, MMA Fighting, Sherdog...).
  const loc = lang === 'en' ? 'hl=en-US&gl=US&ceid=US:en' : 'hl=es-419&gl=MX&ceid=MX:es-419';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:14d')}&${loc}`;
  const key = 'news:' + url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 300_000) return hit.v;
  try {
    const res = await fetch('/api/proxy?url=' + encodeURIComponent(url));
    const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
    const items = [...xml.querySelectorAll('item')].slice(0, max).map((it) => ({
      title: it.querySelector('title')?.textContent || '',
      url: it.querySelector('link')?.textContent || '',
      date: it.querySelector('pubDate')?.textContent || '',
      source: it.querySelector('source')?.textContent || 'Google News',
    }));
    cache.set(key, { t: Date.now(), v: items });
    return items;
  } catch (e) {
    console.warn('Noticias no disponibles', e);
    return [];
  }
}

// ---------- The Odds API (opcional, requiere clave) ----------
const normName = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(fc|cf|club|de|afc|sc|ac|cd|ud|rc|the)\b/g, '').replace(/[^a-z0-9]/g, '');

function nameMatch(a, b) {
  const x = normName(a), y = normName(b);
  return x && y && (x === y || x.includes(y) || y.includes(x));
}

export async function getOddsApi(league) {
  if (!league.oddsKey) return [];
  // Pasa por el servidor local, que agrega la clave (ODDS_API_KEY).
  const p = `sports/${league.oddsKey}/odds?regions=eu,us&markets=h2h,totals&oddsFormat=decimal`;
  const res = await fetch('/api/odds?p=' + encodeURIComponent(p));
  if (!res.ok) throw new Error(`The Odds API: HTTP ${res.status}`);
  const remaining = res.headers.get('x-requests-remaining');
  const data = await res.json();
  data._remaining = remaining;
  cache.set('oddsapi:' + league.id, { t: Date.now(), v: data });
  return data;
}

// Busca el partido en la respuesta de The Odds API y devuelve Pinnacle + mejor momio disponible.
export function matchOddsApi(event, oddsData) {
  const g = (oddsData || []).find((o) => nameMatch(o.home_team, event.home.name) && nameMatch(o.away_team, event.away.name));
  if (!g) return null;
  const books = g.bookmakers.map((b) => {
    const h2h = b.markets.find((m) => m.key === 'h2h');
    const price = (name) => h2h?.outcomes.find((o) => o.name === name)?.price ?? null;
    return { key: b.key, title: b.title, home: price(g.home_team), away: price(g.away_team), draw: price('Draw') };
  });
  const best = (k) => books.reduce((m, b) => (b[k] && b[k] > (m?.price || 0) ? { price: b[k], book: b.title } : m), null);
  return {
    pinnacle: books.find((b) => b.key === 'pinnacle') || null,
    best: { home: best('home'), away: best('away'), draw: best('draw') },
    books,
  };
}

export async function getConfig() {
  try { return await (await fetch('/api/config')).json(); } catch { return {}; }
}
