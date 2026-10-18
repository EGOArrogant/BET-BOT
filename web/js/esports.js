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
  const data = await cached('lol', 20_000, async () => {
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
  return [...out.values()];
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
