// Contexto previo al partido: jugadores clave, bajas, descanso, récord de local/visita, serie entre ellos
// y lanzadores abridores. Fuentes que permiten su uso: ESPN (NBA, NFL, MLB, fútbol) y MLB Stats API (MLB y LMB).
// (SofaScore bloquea toda lectura automática; no se usa.)
//
// También calcula un AJUSTE prudente a la probabilidad del modelo del bot por bajas y descanso.
// El modelo no "sabe" quién juega; el mercado sí. Sin este ajuste, el modelo ve valor falso en equipos
// que perdieron a su estrella. El ajuste toca solo al modelo (el mercado ya lo descuenta) y tiene tope.

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB = 'https://site.web.api.espn.com/apis/site/v2/sports';
const MLB = 'https://statsapi.mlb.com/api/v1';
const cache = new Map();
async function get(url, ttl) {
  if (url.includes('espn.com')) url += (url.includes('?') ? '&' : '?') + 'lang=es&region=mx';
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const v = await res.json();
  cache.set(url, { t: Date.now(), v });
  return v;
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const sameTeam = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))); };

// Estado de lesión en español y qué tan probable es que NO juegue (0 = juega, 1 = baja segura).
const STATUS = [
  // Lesión larga (reserva de lesionados / lista de 10, 15 o 60 días): el equipo ya juega sin él, no es una baja "nueva".
  [/60-day/i, 'Lista de lesionados (60 días)', 1, true],
  [/15-day/i, 'Lista de lesionados (15 días)', 1, true],
  [/10-day/i, 'Lista de lesionados (10 días)', 1, true],
  [/injured reserve|reserva (de )?lesionad|\bir\b|\bil\b/i, 'Lista de lesionados', 1, true],
  [/out|fuera|baja/i, 'Baja', 1],
  [/suspen/i, 'Suspendido', 1],
  [/doubtful|muy dudoso/i, 'Muy dudoso', 0.75],
  [/questionable|duda/i, 'Duda', 0.5],
  [/day-to-day|día a día|dia a dia/i, 'Día a día', 0.4],
  [/probable/i, 'Probable', 0.15],
];
export function statusEs(s) {
  for (const [re, es, miss, long] of STATUS) if (re.test(String(s || ''))) return { text: es, miss, long: !!long };
  return s ? { text: String(s), miss: 0.5 } : null;
}

// ---------- ESPN ----------
async function roster(league, teamId) {
  const d = await get(`${SITE}/${league.path}/teams/${teamId}/roster`, 30 * 60_000);
  // NFL agrupa por posición ({ position, items }); NBA y fútbol vienen planos.
  const list = (d.athletes || []).flatMap((x) => (Array.isArray(x.items) ? x.items : [x]));
  const map = new Map();
  for (const p of list) {
    const inj = p.injuries?.[0];
    map.set(String(p.id), {
      id: String(p.id), name: p.displayName || p.fullName, pos: p.position?.abbreviation || '', headshot: p.headshot?.href || '',
      status: inj ? statusEs(inj.status) : null, detail: inj ? [inj.details?.type, inj.details?.detail].filter(Boolean).join(' · ') || inj.shortComment || '' : '',
    });
  }
  return map;
}

// Días de descanso: desde el último partido terminado del equipo antes de este.
async function rest(league, teamId, evDate) {
  const d = await get(`${SITE}/${league.path}/teams/${teamId}/schedule`, 60 * 60_000);
  const t = new Date(evDate).getTime();
  const past = (d.events || []).map((e) => new Date(e.date).getTime()).filter((x) => x < t - 3 * 3600_000).sort((a, b) => b - a);
  if (!past.length) return null;
  const days = Math.round((t - past[0]) / 86400000);
  const last7 = past.filter((x) => t - x <= 7 * 86400000).length;
  return { days, last: past[0], last7 };
}

// Jugadores clave con sus promedios de temporada (NBA) o líderes por categoría (NFL).
async function keyPlayers(league, teamId) {
  const d = await get(`${WEB}/${league.path}/teams/${teamId}/athletes/statistics`, 6 * 3600_000);
  const season = d.requestedSeason?.displayName || d.season?.displayName || '';
  if (league.sport === 'basketball') {
    const rows = (d.results?.[0]?.leaders || []).map((l) => {
      // Por nombre interno (avgPoints, avgMinutes…): las siglas se repiten entre promedio y total.
      const st = {};
      for (const cat of l.statistics || []) for (const s of cat.stats || []) if (s.name && !(s.name in st)) st[s.name] = Number(s.value);
      const gp = st.gamesPlayed || (st.minutes && st.avgMinutes ? Math.round(st.minutes / st.avgMinutes) : null);
      return { id: String(l.athlete?.id), name: l.athlete?.displayName, headshot: l.athlete?.headshot?.href || '', ppg: st.avgPoints, rpg: st.avgRebounds, apg: st.avgAssists, mpg: st.avgMinutes, gp };
    }).filter((p) => p.name);
    const top = rows.filter((p) => (p.gp || 0) >= 5).sort((a, b) => (b.ppg || 0) - (a.ppg || 0)).slice(0, 6);
    return { season, players: (top.length ? top : rows.slice(0, 6)).map((p) => ({ ...p, line: `${(p.ppg ?? 0).toFixed(1)} pts · ${(p.rpg ?? 0).toFixed(1)} reb · ${(p.apg ?? 0).toFixed(1)} ast · ${Math.round(p.mpg ?? 0)} min` })) };
  }
  if (league.sport === 'football') {
    const cat = (n) => (d.results || []).find((r) => r.name === n)?.leaders || [];
    const pick = (n, i, role, unit) => { const l = cat(n)[i]; return l ? { id: String(l.athlete?.id), name: l.athlete?.displayName, headshot: l.athlete?.headshot?.href || '', role, line: `${l.displayValue} ${unit}` } : null; };
    return { season, players: [pick('passing', 0, 'QB', 'yardas por pase'), pick('rushing', 0, 'Corredor', 'yardas por tierra'), pick('receiving', 0, 'Receptor', 'yardas recibidas'), pick('receiving', 1, 'Receptor', 'yardas recibidas'), pick('defensive', 0, 'Defensa', 'tacleadas'), pick('scoring', 0, 'Anotador', 'puntos')].filter(Boolean) };
  }
  return { season, players: [] };
}

// ---------- MLB Stats API: abridores y alineación confirmada (MLB y LMB) ----------
async function mlbGame(ev, sportId) {
  const t = new Date(ev.date);
  const day = (x) => new Date(x).toISOString().slice(0, 10);
  const d = await get(`${MLB}/schedule?sportId=${sportId}&startDate=${day(t.getTime() - 86400000)}&endDate=${day(t.getTime() + 86400000)}&hydrate=probablePitcher,lineups`, 10 * 60_000);
  const games = (d.dates || []).flatMap((x) => x.games || []);
  return games.find((g) => String(g.gamePk) === String(ev.id))
    || games.find((g) => sameTeam(g.teams.home.team.name, ev.home.name) && sameTeam(g.teams.away.team.name, ev.away.name) && Math.abs(new Date(g.gameDate) - t) < 18 * 3600_000);
}
async function pitcher(p) {
  if (!p?.id) return null;
  const d = await get(`${MLB}/people/${p.id}/stats?stats=season,lastXGames&group=pitching&limit=3`, 6 * 3600_000);
  const s = (type) => d.stats?.find((x) => x.type?.displayName === type)?.splits?.[0]?.stat || null;
  const season = s('season'), last = s('lastXGames');
  const ip = (x) => (x ? Number(String(x.inningsPitched).replace(/\.(\d)$/, (m, f) => '.' + Math.round((f / 3) * 10))) : 0);
  return {
    name: p.fullName, era: season ? Number(season.era) : null, whip: season ? Number(season.whip) : null, ip: ip(season), k: season?.strikeOuts ?? null,
    gs: season?.gamesStarted ?? null, lastEra: last ? Number(last.era) : null, lastIp: ip(last),
  };
}

// ---------- Ajuste prudente del modelo ----------
function adjustments(sport, ctx) {
  const out = [];
  const side = (s) => (s === 'home' ? 1 : -1); // + favorece al local
  for (const s of ['home', 'away']) {
    const c = ctx[s];
    if (!c) continue;
    // Bajas de jugadores clave (NBA y NFL).
    if (sport === 'basketball') {
      let pts = 0;
      for (const p of c.players || []) {
        if (!p.status?.miss || p.status.long || (p.mpg || 0) < 18) continue;
        // Solo cuenta lo que aporta por encima de un suplente (~8 pts): estrella de 25 pts ≈ 3.5 pts de margen, de 15 ≈ 1.5.
        const impact = Math.min(4, Math.max(0, 0.18 * ((p.ppg || 0) - 8)) + 0.03 * ((p.rpg || 0) + (p.apg || 0))) * p.status.miss;
        if (impact >= 0.3) { pts += impact; out.push({ side: s, text: `${p.name} (${p.status.text.toLowerCase()}, ${(p.ppg || 0).toFixed(1)} pts)`, delta: 0 }); }
      }
      pts = Math.min(6, pts);
      if (pts) out.push({ side: s, text: `Bajas: −${pts.toFixed(1)} pts de margen`, delta: -side(s) * 0.03 * pts, sum: true });
      if (c.rest && c.rest.days <= 1) out.push({ side: s, text: 'Juega en días seguidos (back-to-back): −1.5 pts', delta: -side(s) * 0.045, sum: true });
    }
    if (sport === 'football') {
      let pts = 0;
      for (const p of c.players || []) {
        if (!p.status?.miss || p.status.long) continue;
        const base = p.role === 'QB' ? 5 : p.role === 'Anotador' ? 0 : 1;
        if (!base) continue;
        pts += base * p.status.miss;
        out.push({ side: s, text: `${p.name} (${p.role}, ${p.status.text.toLowerCase()})`, delta: 0 });
      }
      pts = Math.min(7, pts);
      if (pts) out.push({ side: s, text: `Bajas: −${pts.toFixed(1)} pts de margen`, delta: -side(s) * 0.027 * pts, sum: true });
      if (c.rest && c.rest.days <= 4) out.push({ side: s, text: `Semana corta (${c.rest.days} días de descanso): −1 pt`, delta: -side(s) * 0.027, sum: true });
      if (c.rest && c.rest.days >= 10) out.push({ side: s, text: `Viene de descanso largo (${c.rest.days} días): +1 pt`, delta: side(s) * 0.027, sum: true });
    }
    if (sport === 'soccer' && c.rest && ctx[s === 'home' ? 'away' : 'home']?.rest) {
      const other = ctx[s === 'home' ? 'away' : 'home'].rest.days;
      if (c.rest.days <= 3 && other >= 5) out.push({ side: s, text: `Menos descanso (${c.rest.days} vs ${other} días): −2%`, delta: -side(s) * 0.02, sum: true });
    }
  }
  // Béisbol: diferencia de calidad de los abridores (efectividad de temporada y de sus últimas 3 aperturas).
  if (sport === 'baseball') {
    const era = (p) => (!p || p.era == null || p.ip < 20 ? null : p.lastEra != null && p.lastIp >= 8 ? 0.7 * p.era + 0.3 * p.lastEra : p.era);
    const h = era(ctx.home?.pitcher), a = era(ctx.away?.pitcher);
    if (h != null && a != null && Math.abs(a - h) >= 0.3) {
      const d = clamp(0.05 * (a - h), -0.06, 0.06);
      out.push({ side: d > 0 ? 'home' : 'away', text: `Abridores: ${ctx.home.pitcher.name} (${h.toFixed(2)}) vs ${ctx.away.pitcher.name} (${a.toFixed(2)})`, delta: d, sum: true });
    }
  }
  const cap = { basketball: 0.08, football: 0.1, baseball: 0.06, soccer: 0.03 }[sport] || 0.05;
  const delta = clamp(out.filter((x) => x.sum).reduce((s, x) => s + x.delta, 0), -cap, cap);
  return { list: out, delta };
}

// ---------- Contexto completo de un partido ----------
export async function getContext(league, ev, sum) {
  const sport = league.sport;
  if (!['basketball', 'football', 'baseball', 'soccer'].includes(sport)) return null;
  const ctx = { home: {}, away: {}, sport, t: Date.now() };
  const espn = !!league.path;
  await Promise.all(['home', 'away'].map(async (s) => {
    const id = ev[s].id;
    if (!espn || !id) return;
    const [ro, re, kp] = await Promise.all([
      sport === 'baseball' ? null : roster(league, id).catch(() => null),
      rest(league, id, ev.date).catch(() => null),
      sport === 'basketball' || sport === 'football' ? keyPlayers(league, id).catch(() => null) : null,
    ]);
    const c = ctx[s];
    c.rest = re;
    c.season = kp?.season || '';
    c.players = (kp?.players || []).map((p) => ({ ...p, status: ro?.get(p.id)?.status || null, detail: ro?.get(p.id)?.detail || '' }));
    c.injuries = ro ? [...ro.values()].filter((p) => p.status && p.status.miss >= 0.15).sort((a, b) => b.status.miss - a.status.miss) : [];
  }));
  // Lesionados del resumen (MLB y fútbol traen la lista ahí).
  for (const t of sum?.injuries || []) {
    const s = sameTeam(t.team, ev.home.name) ? 'home' : sameTeam(t.team, ev.away.name) ? 'away' : null;
    if (!s || ctx[s].injuries?.length) continue;
    ctx[s].injuries = (t.list || []).map((i) => ({ name: i.name, status: statusEs(i.status), detail: i.detail })).filter((i) => i.status);
  }
  if (sport === 'baseball') {
    try {
      const g = await mlbGame(ev, league.sportId || 1);
      if (g) {
        const [ph, pa] = await Promise.all([pitcher(g.teams.home.probablePitcher), pitcher(g.teams.away.probablePitcher)]);
        ctx.home.pitcher = ph; ctx.away.pitcher = pa;
        const lu = (arr) => (arr || []).map((p) => `${p.fullName}${p.primaryPosition?.abbreviation ? ' (' + p.primaryPosition.abbreviation + ')' : ''}`);
        ctx.home.lineup = lu(g.lineups?.homePlayers); ctx.away.lineup = lu(g.lineups?.awayPlayers);
      }
    } catch {}
  }
  ctx.records = sum?.records || null;
  ctx.series = sum?.seasonSeries || [];
  ctx.predictor = sum?.predictor || null;
  ctx.adj = adjustments(sport, ctx);
  return ctx;
}

// Aplica el ajuste a las probabilidades previas del modelo (solo si el modelo tiene datos propios).
export function applyContext(model, ctx) {
  if (!ctx?.adj?.delta || !model?.pre || model.known === false) return;
  const d = ctx.adj.delta, p = model.pre;
  const home = clamp(p.home + d, 0.02, 0.98), away = clamp(p.away - (home - p.home), 0.02, 0.98);
  model.preRaw = { ...p };
  model.pre = { ...p, home, away };
  model.adj = ctx.adj;
}
