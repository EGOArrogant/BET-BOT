// Mercados de predicción: Polymarket y Kalshi (solo LECTURA de precios públicos).
// Su precio (0 a 1) es la probabilidad que el dinero real le asigna a cada resultado: es una de las mejores
// referencias del mercado, sobre todo cuando hay mucha liquidez. El bot la usa para estimar la probabilidad
// "justa" y, en la simulación, como precio de referencia cuando no hay momio de casa (por ejemplo en eSports).
// El bot NO opera en estos sitios: solo lee sus precios.

const POLY = 'https://gamma-api.polymarket.com';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';

// Serie de cada liga en cada mercado.
const POLY_SERIES = {
  nfl: 12185, nba: 10345, mlb: 3, 'eng.1': 10188, 'esp.1': 10193, 'ita.1': 10203, 'fra.1': 10195,
  'uefa.champions': 10204, 'mex.1': 10290, atp: 10365, wta: 10366, lol: 10311, valorant: 10369, cs2: 10310,
  ufc: 38, boxing: 12578,
};
const KALSHI_SERIES = {
  nfl: 'KXNFLGAME', nba: 'KXNBAGAME', mlb: 'KXMLBGAME', lmb: 'KXLMBGAME', 'eng.1': 'KXEPLGAME', 'esp.1': 'KXLALIGAGAME',
  'ita.1': 'KXSERIEAGAME', 'fra.1': 'KXLIGUE1GAME', 'uefa.champions': 'KXUCLGAME', 'mex.1': 'KXLIGAMXGAME',
  atp: 'KXATPMATCH', wta: 'KXWTAMATCH', lol: 'KXLOLGAME', valorant: 'KXVALORANTGAME', cs2: 'KXCS2GAME',
  ufc: 'KXUFCFIGHT', boxing: 'KXBOXINGFIGHT',
};

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
const parseArr = (s) => { try { return Array.isArray(s) ? s : JSON.parse(s || '[]'); } catch { return []; } };

// ---------- Polymarket ----------
async function polymarket(league, { includeResolved = false } = {}) {
  const sid = POLY_SERIES[league.id];
  if (!sid) return [];
  const since = new Date(Date.now() - 6 * 3600000).toISOString();
  const data = await cached('poly:' + league.id, 8_000, async () => {
    const res = await fetch(`${POLY}/events?series_id=${sid}&closed=false&limit=100&end_date_min=${encodeURIComponent(since)}`);
    if (!res.ok) throw new Error('Polymarket HTTP ' + res.status);
    return res.json();
  });
  const out = [];
  for (const e of data || []) {
    if (!/ vs\.? /i.test(e.title || '') || /props|corners|cards|halftime|exact|total goals/i.test(e.title)) continue;
    const start = e.startTime || e.markets?.[0]?.gameStartTime;
    const ml = (e.markets || []).filter((m) => m.sportsMarketType === 'moneyline' && !m.closed);
    if (!ml.length) continue;
    const outcomes = [];
    if (ml.length === 1) {
      // Dos resultados en un solo mercado: ["Equipo A", "Equipo B"]
      const names = parseArr(ml[0].outcomes), prices = parseArr(ml[0].outcomePrices).map(Number);
      const ask = num(ml[0].bestAsk), bid = num(ml[0].bestBid);
      // cond = mercado y resultado exactos: sirven para consultar quiénes apuestan en cada lado.
      names.forEach((n, i) => outcomes.push({ name: n, prob: prices[i], ask: i === 0 ? ask : bid != null ? 1 - bid : null, cond: { conditionId: ml[0].conditionId, outcomeIndex: i } }));
    } else {
      // Fútbol: un mercado Sí/No por resultado ("¿Gana X?", "¿Empate?")
      for (const m of ml) {
        const prices = parseArr(m.outcomePrices).map(Number);
        const label = m.groupItemTitle || m.question || '';
        outcomes.push({ name: label, prob: prices[0], ask: num(m.bestAsk), draw: /draw|empate|tie/i.test(label), cond: { conditionId: m.conditionId, outcomeIndex: 0 } });
      }
    }
    const liq = Number(e.liquidity || ml.reduce((a, m) => a + Number(m.liquidity || 0), 0)) || 0;
    const resolved = outcomes.every((o) => !(o.prob > 0 && o.prob < 1));
    if (resolved && !includeResolved) continue; // mercado ya resuelto
    // Mercados extra de la pelea: ¿llega a la decisión?, ¿KO/TKO?, ¿sumisión?, rondas más/menos.
    const props = (e.markets || []).filter((m) => /go_the_distance|method_of_victory|totals/.test(m.sportsMarketType || '') && !m.closed).map((m) => {
      const names = parseArr(m.outcomes), prices = parseArr(m.outcomePrices).map(Number);
      return { q: m.question, type: m.sportsMarketType, names, prices, liquidity: Number(m.liquidity || 0), traded: Number(m.volume || 0) > 0 };
    });
    out.push({ source: 'Polymarket', title: e.title, start, outcomes, liquidity: liq, resolved, props, url: `https://polymarket.com/event/${e.slug}` });
  }
  return out;
}

// ---------- Kalshi (vía el servidor local: no permite consultas directas desde el navegador) ----------
async function kalshi(league) {
  const series = KALSHI_SERIES[league.id];
  if (!series) return [];
  const data = await cached('kalshi:' + league.id, 8_000, async () => {
    const url = `${KALSHI}/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=100`;
    const res = await fetch('/api/proxy?url=' + encodeURIComponent(url));
    if (!res.ok) throw new Error('Kalshi HTTP ' + res.status);
    return JSON.parse(await res.text());
  });
  const out = [];
  for (const e of data.events || []) {
    const outcomes = (e.markets || []).map((m) => {
      const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
      const prob = bid != null && ask != null && ask > 0 ? (bid + ask) / 2 : last ?? bid ?? ask;
      return { name: m.yes_sub_title || m.title || '', prob, ask, draw: /^(tie|draw|empate)$/i.test(m.yes_sub_title || '') };
    }).filter((o) => o.prob > 0 && o.prob < 1);
    if (outcomes.length < 2) continue;
    const exp = e.markets?.[0]?.expected_expiration_time;
    out.push({ source: 'Kalshi', title: e.title, start: exp, outcomes, liquidity: (e.markets || []).reduce((a, m) => a + Number(m.volume || 0), 0), url: `https://kalshi.com/markets/${String(series).toLowerCase()}` });
  }
  return out;
}

// ---------- Peleas armadas solo desde mercados (boxeo: ESPN no lo cubre) ----------
// Polymarket + Kalshi + The Odds API (si tienes clave). Cuando Polymarket resuelve el mercado (precio 1/0),
// la pelea se marca como terminada con su ganador para poder liquidar las apuestas.
const fightKey = (a, b) => [a, b].map((n) => tokens(n).sort().join('')).sort().join('|');
let oddsApiOk = true;
async function oddsApiFights(league) {
  if (!league.oddsKey || !oddsApiOk) return [];
  return cached('odds:' + league.id, 30 * 60_000, async () => { // cada 30 min para cuidar tus créditos
    const p = `sports/${league.oddsKey}/odds?regions=us,eu&markets=h2h&oddsFormat=decimal`;
    const res = await fetch('/api/odds?p=' + encodeURIComponent(p));
    if (res.status === 401) { oddsApiOk = false; return []; } // sin clave de The Odds API
    if (!res.ok) return [];
    return res.json();
  });
}

// Momios de casas internacionales (The Odds API) para peleas que ya vienen de ESPN (UFC): mejor precio por peleador.
export async function attachOddsApi(league, events) {
  const odds = await oddsApiFights(league).catch(() => []);
  if (!odds?.length) return;
  const byKey = new Map();
  for (const g of odds) {
    const price = (name) => {
      let best = null, book = '';
      for (const b of g.bookmakers || []) for (const mk of b.markets || []) if (mk.key === 'h2h') for (const o of mk.outcomes) if (o.name === name && (!best || o.price > best)) { best = o.price; book = b.title; }
      return { best, book };
    };
    byKey.set(fightKey(g.home_team, g.away_team), { g, price });
  }
  for (const ev of events) {
    if (ev.odds) continue;
    const hit = byKey.get(fightKey(ev.home.name, ev.away.name));
    if (!hit) continue;
    // La Odds API puede listar a los peleadores en otro orden: se busca por nombre.
    const pick = (name) => { const n = [hit.g.home_team, hit.g.away_team].sort((x, y) => nameScore(name, y) - nameScore(name, x))[0]; return hit.price(n); };
    const h = pick(ev.home.name), a = pick(ev.away.name);
    if (h.best && a.best) ev.odds = { provider: 'The Odds API (mejor precio)', home: h.best, away: a.best, books: { home: h.book, away: a.book } };
  }
}

export async function marketEvents(league) {
  const [poly, kal, odds] = await Promise.all([
    polymarket(league, { includeResolved: true }).catch(() => []), kalshi(league).catch(() => []), oddsApiFights(league).catch(() => []),
  ]);
  const map = new Map();
  const now = Date.now();
  const add = (names, start, extra = {}) => {
    if (!names[0] || !names[1]) return;
    const k = fightKey(names[0], names[1]);
    const cur = map.get(k) || { names, start, winner: null, odds: null, src: [] };
    if (!cur.start && start) cur.start = start;
    Object.assign(cur, Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)));
    map.set(k, cur);
  };
  for (const m of poly) {
    const t = m.outcomes.filter((o) => !o.draw);
    if (t.length !== 2) continue;
    add([t[0].name, t[1].name], m.start, { winner: m.resolved ? (t[0].prob === 1 ? 0 : t[1].prob === 1 ? 1 : null) : null });
  }
  for (const m of kal) { const t = m.outcomes.filter((o) => !o.draw); if (t.length === 2) add([t[0].name, t[1].name], m.start); }
  for (const g of odds || []) {
    const price = (name) => {
      let best = null;
      for (const b of g.bookmakers || []) for (const mk of b.markets || []) if (mk.key === 'h2h') for (const o of mk.outcomes) if (o.name === name && (!best || o.price > best)) best = o.price;
      return best;
    };
    add([g.home_team, g.away_team], g.commence_time, { odds: { provider: 'The Odds API (mejor precio)', home: price(g.home_team), away: price(g.away_team) } });
  }
  const out = [];
  for (const [k, f] of map) {
    const t = f.start ? new Date(f.start).getTime() : now;
    const done = f.winner != null;
    if (!done && t < now - 12 * 3600000) continue; // pelea vieja sin resultado
    const state = done ? 'post' : t > now ? 'pre' : 'in';
    const side = (i) => ({ id: 'bx' + tokens(f.names[i]).join(''), name: f.names[i], abbr: f.names[i].split(' ').slice(-1)[0], logo: '', score: null, form: '', record: '', winner: done && f.winner === i, linescores: [] });
    out.push({
      id: 'bx-' + k, leagueId: league.id, sport: league.sport, name: `${f.names[0]} vs ${f.names[1]}`, date: new Date(t).toISOString(),
      state, completed: done, detail: state === 'in' ? 'En curso' : done ? 'Final' : '', clock: '', period: 0,
      home: side(0), away: side(1), odds: f.odds, venue: '', tournament: league.name, round: '',
    });
  }
  return out;
}

export async function getPredictionMarkets(league) {
  const res = await Promise.allSettled([polymarket(league), kalshi(league)]);
  return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

// ---------- emparejar con un partido ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const STOP = new Set(['fc', 'cf', 'club', 'de', 'the', 'afc', 'sc', 'ac', 'cd', 'ud', 'rc', 'and', 'del', 'la', 'real', 'city', 'united', 'team', 'esports', 'gaming', 'win', 'will']);
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));

export function nameScore(a, b) {
  const ta = tokens(a), tb = new Set(tokens(b));
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  if (!hit) { // abreviaturas (ej. "Man Utd" vs "Manchester United")
    const na = norm(a).replace(/[^a-z0-9]/g, ''), nb = norm(b).replace(/[^a-z0-9]/g, '');
    if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) hit = 1;
  }
  return hit;
}

// Devuelve { home, away, draw, sources: [{source, url, liquidity, home, away, draw, askHome, ...}] } o null.
export function matchPrediction(ev, markets) {
  const found = [];
  const evTime = new Date(ev.date).getTime();
  for (const m of markets || []) {
    if (m.start && Math.abs(new Date(m.start).getTime() - evTime) > 2 * 86400000) continue;
    const teams = m.outcomes.filter((o) => !o.draw);
    if (teams.length < 2) continue;
    const pick = (side) => teams.map((o) => ({ o, s: nameScore(ev[side].name + ' ' + (ev[side].abbr || ''), o.name) })).sort((x, y) => y.s - x.s)[0];
    const h = pick('home'), a = pick('away');
    if (!h?.s || !a?.s || h.o === a.o) continue;
    const draw = m.outcomes.find((o) => o.draw) || null;
    // Normaliza para que las probabilidades sumen 1 (quita el pequeño margen del mercado).
    const sum = h.o.prob + a.o.prob + (draw ? draw.prob : 0);
    found.push({
      source: m.source, url: m.url, liquidity: m.liquidity, title: m.title, props: m.props || [],
      home: h.o.prob / sum, away: a.o.prob / sum, draw: draw ? draw.prob / sum : null,
      askHome: h.o.ask, askAway: a.o.ask, askDraw: draw?.ask ?? null,
      cond: h.o.cond ? { home: h.o.cond, away: a.o.cond, draw: draw?.cond || null } : null,
    });
  }
  if (!found.length) return null;
  const avg = (k) => { const v = found.map((f) => f[k]).filter((x) => x != null); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; };
  return { home: avg('home'), away: avg('away'), draw: avg('draw'), sources: found };
}
