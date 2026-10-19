// eSports: League of Legends (API pública de LoL Esports), Valorant y Counter-Strike 2 (Liquipedia, CC BY-SA).
// No hay momios gratis de eSports, así que el bot construye su propio Elo por mapa con cada resultado que observa.

const LOL_API = 'https://esports-api.lolesports.com/persisted/gw';
const LOL_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'; // clave pública que usa el sitio lolesports.com
const cache = new Map();

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

const teamId = (game, name) => `${game}:${String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;

// ---------- League of Legends ----------
async function lolEvents(league) {
  const data = await cached('lol', 4_000, async () => { // tiempo real (~5 s)
    const res = await fetch(`${LOL_API}/getSchedule?hl=es-MX`, { headers: { 'x-api-key': LOL_KEY } });
    if (!res.ok) throw new Error('LoL Esports HTTP ' + res.status);
    return res.json();
  });
  const now = Date.now();
  return (data.data?.schedule?.events || [])
    .filter((e) => e.type === 'match' && e.match?.teams?.length === 2)
    .filter((e) => Math.abs(new Date(e.startTime).getTime() - now) < 5 * 86400000)
    .map((e) => {
      const [t1, t2] = e.match.teams;
      const side = (t) => ({
        id: teamId('lol', t.name), name: t.name, abbr: t.code, logo: t.image || '',
        score: t.result?.gameWins ?? (e.state === 'unstarted' ? null : 0), winner: t.result?.outcome === 'win',
        record: t.record ? `${t.record.wins}-${t.record.losses}` : '', recW: t.record?.wins, recL: t.record?.losses, form: '', linescores: [],
      });
      const state = e.state === 'completed' ? 'post' : e.state === 'inProgress' ? 'in' : 'pre';
      const h = side(t1), a = side(t2);
      return {
        id: 'lol-' + e.match.id, leagueId: league.id, sport: 'esports', game: 'lol', name: `${h.name} vs ${a.name}`,
        date: e.startTime, state, completed: state === 'post',
        detail: state === 'in' ? `En vivo · ${h.score ?? 0}-${a.score ?? 0}` : state === 'post' ? 'Final' : '',
        clock: '', period: 0, home: h, away: a, odds: null,
        bestOf: e.match.strategy?.count || 1, tournament: e.league?.name || 'LoL', round: e.blockName || '', venue: e.league?.name || '',
        leagueLogo: e.league?.image || '',
      };
    });
}

// ---------- Valorant y CS2 (Liquipedia, vía el servidor local para respetar sus límites) ----------
async function liquipediaEvents(league) {
  const html = await cached('lp:' + league.wiki, 60_000, async () => {
    const url = `https://liquipedia.net/${league.wiki}/api.php?action=parse&page=Liquipedia:Matches&format=json&prop=text`;
    let res = await fetch('/api/proxy?url=' + encodeURIComponent(url));
    if (res.status === 429) {
      // Liquipedia permite 1 consulta cada 30 s: se espera y se reintenta una vez.
      const wait = Number(res.headers.get('Retry-After') || 30) + 1;
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await fetch('/api/proxy?url=' + encodeURIComponent(url));
    }
    if (!res.ok) throw new Error('Liquipedia HTTP ' + res.status);
    const j = JSON.parse(await res.text());
    return j.parse?.text?.['*'] || '';
  });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = new Map();
  const now = Date.now() / 1000;
  for (const m of doc.querySelectorAll('.match-info')) {
    const timer = m.querySelector('.timer-object');
    const ts = Number(timer?.dataset.timestamp || 0);
    const finished = timer?.dataset.finished === 'finished';
    const opps = m.querySelectorAll('.match-info-header-opponent');
    if (opps.length < 2 || !ts) continue;
    const scores = [...m.querySelectorAll('.match-info-header-scoreholder-score')].map((s) => Number(s.textContent.trim()));
    const lower = m.querySelector('.match-info-header-scoreholder-lower')?.textContent || '';
    const bestOf = Number((lower.match(/Bo(\d+)/i) || [])[1]) || 3;
    const tour = m.querySelector('.match-info-tournament-name')?.textContent.trim() || league.name;
    const side = (o, i) => {
      const a = o.querySelector('.name a') || o.querySelector('.name');
      const full = (a?.getAttribute('title') || a?.textContent?.trim() || 'Por definir').replace(/\s*\(page does not exist\)\s*$/i, '');
      // Logo original del equipo (versión para fondo oscuro si existe), servido a través del servidor local.
      const img = o.querySelector('.team-template-darkmode img') || o.querySelector('img');
      const src = img?.getAttribute('src') || '';
      return {
        id: teamId(league.game, full), name: full.replace(/_/g, ' '), abbr: a?.textContent?.trim() || '',
        logo: src.startsWith('/commons/images/') ? '/api/img?u=' + encodeURIComponent('https://liquipedia.net' + src) : '',
        score: scores.length === 2 ? scores[i] : null, winner: o.classList.contains('match-info-header-winner'), record: '', form: '', linescores: [],
      };
    };
    const h = side(opps[0], 0), a = side(opps[1], 1);
    if (/por definir|tbd/i.test(h.name + a.name)) continue;
    const state = finished ? 'post' : scores.length === 2 && ts <= now ? 'in' : 'pre';
    const id = `${league.game}-${ts}-${h.id}-${a.id}`;
    out.set(id, {
      id, leagueId: league.id, sport: 'esports', game: league.game, name: `${h.name} vs ${a.name}`,
      date: new Date(ts * 1000).toISOString(), state, completed: finished,
      detail: state === 'in' ? `En vivo · ${h.score}-${a.score}` : finished ? 'Final' : '',
      clock: '', period: 0, home: h, away: a, odds: null, bestOf, tournament: tour, round: `Bo${bestOf}`, venue: tour,
    });
  }
  const events = [...out.values()];
  try { await applyBo3(league.game, events); } catch (e) { console.warn('bo3.gg', e); }
  return events;
}

// ---------- Marcador en vivo de CS2 y Valorant (bo3.gg, cada ~5 s) ----------
// Liquipedia solo se puede consultar cada 30–60 s y depende de que alguien edite la página;
// bo3.gg publica el resultado de cada mapa en cuanto termina, así que corrige estado, marcador y mapas.
const BO3 = 'https://api.bo3.gg/api/v1/matches';
const BO3_DISC = { cs2: 1, valorant: 2 };
async function bo3Matches(game) {
  const d = BO3_DISC[game];
  if (!d) return [];
  return cached('bo3:' + game, 4_000, async () => {
    // Hora redondeada: la URL no cambia en cada consulta (el servidor y bo3.gg la pueden reutilizar).
    const since = new Date(Math.floor((Date.now() - 18 * 3600_000) / 3600_000) * 3600_000).toISOString();
    const url = `${BO3}?filter[matches.discipline_id][eq]=${d}&filter[matches.status][in]=current,finished&filter[matches.start_date][gte]=${since}&page[limit]=100&with=teams,games&sort=-start_date`;
    const res = await fetch('/api/proxy?url=' + encodeURIComponent(url));
    if (!res.ok) throw new Error('bo3.gg HTTP ' + res.status);
    return JSON.parse(await res.text()).results || [];
  });
}

const normTeam = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(team|esports?|gaming|club|academy)\b/g, '').replace(/[^a-z0-9]/g, '');
const sameTeam = (a, b) => {
  const x = normTeam(a), y = normTeam(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x))));
};
const mapName = (m) => { const n = String(m || '').replace(/^de_/, ''); return n ? n[0].toUpperCase() + n.slice(1) : ''; };

export async function applyBo3(game, events) {
  const live = events.filter((e) => e.state !== 'post' && new Date(e.date).getTime() < Date.now() + 15 * 60_000);
  if (!live.length) return;
  const matches = await bo3Matches(game);
  for (const ev of live) {
    const t = new Date(ev.date).getTime();
    let swap = false;
    const m = matches.find((x) => {
      if (Math.abs(new Date(x.start_date).getTime() - t) > 8 * 3600_000) return false;
      if (sameTeam(ev.home.name, x.team1?.name) && sameTeam(ev.away.name, x.team2?.name)) { swap = false; return true; }
      if (sameTeam(ev.home.name, x.team2?.name) && sameTeam(ev.away.name, x.team1?.name)) { swap = true; return true; }
      return false;
    });
    if (!m) continue;
    const homeId = swap ? m.team2_id : m.team1_id;
    const hs = swap ? m.team2_score : m.team1_score, as = swap ? m.team1_score : m.team2_score;
    // Mapa por mapa, desde el lado del equipo local.
    ev.maps = (m.games || []).slice().sort((x, y) => x.number - y.number).map((g) => {
      const homeWon = g.winner_team_clan?.team_id === homeId || g.winner_team_clan?.team?.id === homeId;
      const done = g.status === 'finished' && g.winner_clan_score != null;
      return {
        n: g.number, map: mapName(g.map_name), status: done ? 'done' : g.status === 'current' ? 'live' : 'next',
        home: done ? (homeWon ? g.winner_clan_score : g.loser_clan_score) : null,
        away: done ? (homeWon ? g.loser_clan_score : g.winner_clan_score) : null,
        winner: done ? (homeWon ? 'home' : 'away') : null,
      };
    });
    ev.home.score = hs ?? 0; ev.away.score = as ?? 0;
    ev.liveSource = 'bo3.gg';
    if (m.status === 'finished') {
      const homeWin = m.winner_team_id != null ? m.winner_team_id === homeId : hs > as;
      ev.state = 'post'; ev.completed = true; ev.detail = 'Final';
      ev.home.winner = homeWin; ev.away.winner = !homeWin;
    } else if (m.status === 'current') {
      const cur = ev.maps.find((x) => x.status === 'live') || ev.maps.find((x) => x.status === 'next');
      ev.state = 'in';
      ev.detail = `En vivo · ${hs ?? 0}-${as ?? 0}${cur ? ` · Mapa ${cur.n}${cur.map ? ' (' + cur.map + ')' : ''}` : ''}`;
    }
  }
}

// Resultados terminados de CS2/Valorant desde una fecha (para liquidar apuestas cuyo partido
// Liquipedia ya quitó de su lista). Devuelve eventos con el mismo formato que el resto.
export async function finishedEsports(game, sinceIso) {
  const d = BO3_DISC[game];
  if (!d) return [];
  const since = new Date(Math.floor((new Date(sinceIso).getTime() - 12 * 3600_000) / 3600_000) * 3600_000).toISOString();
  return cached('bo3fin:' + game + since, 60_000, async () => {
    const url = `${BO3}?filter[matches.discipline_id][eq]=${d}&filter[matches.status][in]=finished&filter[matches.start_date][gte]=${since}&page[limit]=100&with=teams&sort=-start_date`;
    const res = await fetch('/api/proxy?url=' + encodeURIComponent(url));
    if (!res.ok) throw new Error('bo3.gg HTTP ' + res.status);
    const rows = JSON.parse(await res.text()).results || [];
    return rows.filter((m) => m.team1 && m.team2).map((m) => {
      const side = (t, sc, id) => ({ id: teamId(game, t.name), name: t.name, abbr: t.name, logo: t.image_url || '', score: sc ?? 0, winner: m.winner_team_id === id, record: '', form: '', linescores: [] });
      return {
        id: `bo3-${m.id}`, leagueId: game, sport: 'esports', game, name: `${m.team1.name} vs ${m.team2.name}`, date: m.start_date,
        state: 'post', completed: true, detail: 'Final', home: side(m.team1, m.team1_score, m.team1_id), away: side(m.team2, m.team2_score, m.team2_id),
        odds: null, bestOf: m.bo_type || 3,
      };
    });
  });
}

export async function getEsportsEvents(league) {
  return league.source === 'lolesports' ? lolEvents(league) : liquipediaEvents(league);
}

// ---------- Elo por mapa (aprendido por el bot) ----------
const K = 24;
export function updateElo(state, events) {
  state.elo ||= {};
  state.eloSeen ||= {};
  let changed = false;
  for (const ev of events) {
    if (ev.sport !== 'esports' || !ev.completed || state.eloSeen[ev.id]) continue;
    const g = (state.elo[ev.game] ||= {});
    const A = (g[ev.home.id] ||= { name: ev.home.name, elo: 1500, maps: 0, series: 0 });
    const Bt = (g[ev.away.id] ||= { name: ev.away.name, elo: 1500, maps: 0, series: 0 });
    let wa = ev.home.score ?? 0, wb = ev.away.score ?? 0;
    if (!wa && !wb) { if (ev.home.winner) wa = 1; else if (ev.away.winner) wb = 1; else continue; }
    // Cada mapa ganado cuenta como una partida de Elo.
    const seq = [...Array(wa).fill(1), ...Array(wb).fill(0)];
    for (const r of seq) {
      const exp = 1 / (1 + 10 ** ((Bt.elo - A.elo) / 400));
      A.elo += K * (r - exp);
      Bt.elo -= K * (r - exp);
    }
    A.maps += wa + wb; Bt.maps += wa + wb; A.series++; Bt.series++;
    state.eloSeen[ev.id] = Date.now();
    changed = true;
  }
  // limpia marcas viejas (60 días)
  for (const [k, t] of Object.entries(state.eloSeen)) if (Date.now() - t > 60 * 86400000) delete state.eloSeen[k];
  return changed;
}

// Tabla para el modelo: teamId -> { elo, maps, w, l }
export function esportsTable(state, events, game) {
  const g = state.elo?.[game] || {};
  const map = new Map(Object.entries(g).map(([id, r]) => [id, { ...r }]));
  for (const ev of events) {
    for (const t of [ev.home, ev.away]) {
      const r = map.get(t.id) || { name: t.name, elo: 1500, maps: 0 };
      if (t.recW != null) { r.w = t.recW; r.l = t.recL; }
      map.set(t.id, r);
    }
  }
  return map;
}
