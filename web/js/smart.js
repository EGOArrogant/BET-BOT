// "Smart money": los mejores apostadores de deportes en Polymarket (datos públicos de la blockchain).
// - Ranking por ganancia (categoría SPORTS) con win rate real calculado de sus posiciones cerradas y ROI (ganancia ÷ volumen).
// - Rastro: sus posiciones abiertas en deportes, cuándo entraron y a qué precio; y en qué lado están en TUS partidos.
// Ojo: los que más ganan a veces son creadores de mercado (mucho volumen, ROI bajo). El ROI y el win rate ayudan a separarlos.

const DATA = 'https://data-api.polymarket.com';
const cache = new Map();
async function px(url, ttl) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const res = await fetch('/api/proxy?url=' + encodeURIComponent(url));
  if (!res.ok) throw new Error('Polymarket HTTP ' + res.status);
  const v = JSON.parse(await res.text());
  cache.set(url, { t: Date.now(), v });
  return v;
}

export async function leaderboard(period = 'MONTH', limit = 25) {
  const rows = await px(`${DATA}/v1/leaderboard?category=SPORTS&timePeriod=${period}&orderBy=PNL&limit=${limit}`, 15 * 60_000);
  return rows.map((r) => ({
    rank: Number(r.rank), wallet: r.proxyWallet, name: r.userName || r.proxyWallet.slice(0, 8), x: r.xUsername || '',
    pnl: Number(r.pnl), vol: Number(r.vol), roi: r.vol ? Number(r.pnl) / Number(r.vol) : null, image: r.profileImage || '',
    url: `https://polymarket.com/profile/${r.proxyWallet}`,
  }));
}

// Win rate real en una misma ventana de tiempo:
//  - "closed-positions" solo trae lo que se COBRÓ o se vendió (ahí están las ganadas); se piden las MÁS RECIENTES
//    (por defecto vienen ordenadas por ganancia, y eso inflaba la ventana y desequilibraba la cuenta),
//  - las PERDIDAS se quedan en "positions" con precio 0 (no se cobran),
// así que se juntan ambas fuentes y se cuentan solo las que terminaron dentro de la ventana que cubre la muestra (máx. 90 días).
export async function traderStats(wallet, { deep = true } = {}) {
  // deep: muestra más grande (ranking). Para los apostadores de cada partido se usa una muestra ligera (menos consultas).
  const ttl = 6 * 3600_000;
  const [closedPages, posPages] = await Promise.all([
    Promise.all((deep ? [0, 50, 100, 150] : [0, 50]).map((o) => px(`${DATA}/closed-positions?user=${wallet}&limit=50&offset=${o}&sortBy=TIMESTAMP&sortDirection=DESC`, ttl).catch(() => []))),
    Promise.all((deep ? [0, 500] : [0]).map((o) => px(`${DATA}/positions?user=${wallet}&limit=500&offset=${o}&sizeThreshold=0`, ttl).catch(() => []))),
  ]);
  const uniq = (arr) => { const seen = new Set(); return arr.filter((p) => { const k = p.conditionId + '|' + p.outcomeIndex; if (!p.conditionId || seen.has(k)) return false; seen.add(k); return true; }); };
  const closed = uniq(closedPages.flat());
  const positions = uniq(posPages.flat());
  const endT = (p) => new Date(p.endDate || (p.timestamp ? p.timestamp * 1000 : 0)).getTime() || 0;
  // Ventana: desde lo más viejo que cubre la muestra de cerradas (o 90 días), hasta hoy.
  const oldestClosed = closed.length ? Math.min(...closed.map(endT).filter(Boolean)) : Date.now() - 90 * 86400000;
  const from = Math.max(Date.now() - 90 * 86400000, oldestClosed || 0);
  const inWin = (p) => endT(p) >= from && endT(p) <= Date.now();
  const wins = closed.filter((p) => inWin(p) && Number(p.realizedPnl) > 0);
  const soldLoss = closed.filter((p) => inWin(p) && Number(p.realizedPnl) <= 0);
  const lostOpen = positions.filter((p) => inWin(p) && Number(p.curPrice) === 0 && Number(p.initialValue) > 0);
  const n = wins.length + soldLoss.length + lostOpen.length;
  const realized = wins.reduce((a, p) => a + Number(p.realizedPnl || 0), 0) + soldLoss.reduce((a, p) => a + Number(p.realizedPnl || 0), 0)
    - lostOpen.reduce((a, p) => a + Number(p.initialValue || 0), 0);
  return { n, wins: wins.length, losses: soldLoss.length + lostOpen.length, winRate: n ? wins.length / n : null, realized, days: Math.round((Date.now() - from) / 86400000), t: Date.now() };
}

// Mercados de deportes según el "slug" del evento de Polymarket.
const SPORT_SLUG = /^(nfl|nba|mlb|nhl|epl|lal|sea|fl1|bun|ucl|uel|mex|mls|atp|wta|ufc|box|boxing|cs2|lol|val|cbb|cfb|ncaa)-|ufc|boxing/i;

export async function traderPositions(wallet) {
  const rows = await px(`${DATA}/positions?user=${wallet}&limit=200&sizeThreshold=1&sortBy=CURRENT&sortDirection=DESC`, 2 * 60_000);
  return rows.filter((p) => SPORT_SLUG.test(p.eventSlug || p.slug || '') && Number(p.curPrice) > 0.01 && Number(p.curPrice) < 0.99)
    .map((p) => ({
      key: p.asset, conditionId: p.conditionId, title: p.title, eventSlug: p.eventSlug, outcome: p.outcome, outcomeIndex: p.outcomeIndex,
      avgPrice: Number(p.avgPrice), curPrice: Number(p.curPrice), size: Number(p.size), value: Number(p.currentValue),
      initial: Number(p.initialValue), pnl: Number(p.cashPnl), endDate: p.endDate, icon: p.icon,
    }));
}

// Algunos nombres son la cartera completa (0x…-123456): se recortan.
const shortName = (n) => (/^0x[0-9a-f]{20,}/i.test(n) ? n.slice(0, 6) + '…' + n.slice(38, 42) : n.length > 22 ? n.slice(0, 21) + '…' : n);

// Mayores apostadores de un mercado (por resultado). amount = acciones; cada acción paga $1 si gana.
export async function marketHolders(conditionId) {
  const groups = await px(`${DATA}/holders?market=${conditionId}&limit=20`, 2 * 60_000);
  return (groups || []).flatMap((g) => (g.holders || []).map((h) => ({
    wallet: h.proxyWallet, name: shortName(h.name || h.pseudonym || h.proxyWallet), amount: Number(h.amount), outcomeIndex: Number(h.outcomeIndex),
    image: h.profileImage || '', url: `https://polymarket.com/profile/${h.proxyWallet}`,
  })));
}

// ¿Es un apostador con historial bueno? (suficientes apuestas resueltas, win rate y ganancia positivos)
export const isSharp = (s) => !!s && s.n >= 20 && s.winRate >= 0.55 && s.realized > 0;

// Calidad de un apostador para "seguirlo": win rate con muestra suficiente + ROI positivo.
export function traderScore(t) {
  if (!t.stats || t.stats.n < 20 || t.stats.winRate == null) return null;
  return t.stats.winRate * 0.7 + Math.max(-0.1, Math.min(0.3, (t.roi || 0) * 3));
}

// ¿Qué lado de un partido nuestro tomó una posición? (2 resultados: nombre del equipo; fútbol: "¿Gana X?" Sí/No)
export function positionSide(pos, ev, nameScore) {
  const t = String(pos.title || '');
  if (/draw|empate|tie\b/i.test(t)) return /^yes$/i.test(pos.outcome) ? 'draw' : null;
  const m = t.match(/^Will (.+?) win/i);
  const who = m ? m[1] : pos.outcome;
  if (m && !/^yes$/i.test(pos.outcome)) return null; // "No" en un 1X2 no identifica un solo resultado
  const h = nameScore(ev.home.name, who), a = nameScore(ev.away.name, who);
  if (!h && !a) return null;
  return h >= a ? 'home' : 'away';
}
