// Casas de apuestas (México e internacionales) y recomendación de dónde colocar cada apuesta.
// No hay API pública de momios de casas mexicanas, así que el bot recomienda con:
//   1) los momios que tú capturas por casa en el boleto (comparación directa: gana el mejor EV),
//   2) lo que ha aprendido de tus capturas: qué casa suele pagar mejor frente a la referencia, por deporte,
//   3) el saldo que tienes depositado en cada casa (no recomienda una casa sin fondos suficientes).
// Antes de abrir cuenta, verifica el permiso vigente en el portal de Juegos y Sorteos de SEGOB.

// group: 'mx' = opera en México (verifica su permiso SEGOB vigente)
//        'intl' = sitio internacional al que se puede entrar desde México, SIN permiso SEGOB:
//                 no tienes protección legal si no te paga o congela tu cuenta. Úsalos bajo tu propio riesgo.
export const BOOKS = [
  { id: 'caliente', name: 'Caliente', url: 'https://www.caliente.mx', color: '#e4002b', group: 'mx' },
  { id: 'codere', name: 'Codere', url: 'https://www.codere.mx', color: '#79c000', group: 'mx' },
  { id: 'bet365', name: 'bet365', url: 'https://www.bet365.mx', color: '#126e51', group: 'mx' },
  { id: 'betano', name: 'Betano', url: 'https://www.betano.mx', color: '#ff6a13', group: 'mx' },
  { id: 'rushbet', name: 'RushBet', url: 'https://www.rushbet.mx', color: '#1f4fd8', group: 'mx' },
  { id: 'strendus', name: 'Strendus', url: 'https://www.strendus.com.mx', color: '#7b2cbf', group: 'mx' },
  { id: 'playdoit', name: 'Playdoit', url: 'https://www.playdoit.mx', color: '#00a3e0', group: 'mx' },
  { id: 'novibet', name: 'Novibet', url: 'https://www.novibet.mx', color: '#0b3d91', group: 'mx' },
  { id: 'betway', name: 'Betway', url: 'https://betway.mx', color: '#111111', group: 'mx' },
  { id: 'pinnacle', name: 'Pinnacle', url: 'https://www.pinnacle.com', color: '#c8102e', group: 'intl', note: 'Margen más bajo del mercado; su momio es la referencia "justa".' },
  { id: 'stake', name: 'Stake', url: 'https://stake.mx', color: '#1a2c38', group: 'intl', note: 'Anunció su entrada a México; confirma si ya tiene permiso.' },
  { id: 'bwin', name: 'bwin', url: 'https://www.bwin.com', color: '#ffcc00', group: 'intl' },
  { id: 'betfair', name: 'Betfair (exchange)', url: 'https://www.betfair.com', color: '#ffb80c', group: 'intl', note: 'Bolsa de apuestas: apuestas contra otros usuarios.' },
];
export const GROUP_LABEL = {
  mx: 'Casas en México',
  intl: 'Internacionales (sin permiso SEGOB)',
};
export const bookById = (id) => BOOKS.find((b) => b.id === id);

export const DEFAULT_BOOKS = () => Object.fromEntries(BOOKS.map((b) => [b.id, { enabled: ['caliente', 'codere', 'bet365'].includes(b.id), balance: null }]));

// Registra un momio capturado para aprender qué casa paga mejor (relativo al momio de referencia).
export function recordQuote(state, { book, sport, market, odds, refOdds }) {
  if (!book || !odds || !refOdds) return;
  state.bookQuotes = state.bookQuotes || [];
  state.bookQuotes.push({ book, sport, market, ratio: odds / refOdds, t: Date.now() });
  if (state.bookQuotes.length > 2000) state.bookQuotes = state.bookQuotes.slice(-2000);
}

// Precio relativo promedio de cada casa: 1.02 = paga 2% más que la referencia (mejor para ti).
export function bookPriceStats(state, sport = null) {
  const out = {};
  for (const q of state.bookQuotes || []) {
    if (sport && q.sport !== sport) continue;
    const o = (out[q.book] ||= { n: 0, sum: 0 });
    o.n++; o.sum += q.ratio;
  }
  for (const o of Object.values(out)) o.avg = o.sum / o.n;
  return out;
}

export const enabledBooks = (state) => BOOKS.filter((b) => state.books?.[b.id]?.enabled);

// Saldo disponible en una casa = saldo capturado − apuestas pendientes ahí.
export function bookAvailable(state, id) {
  const cfg = state.books?.[id];
  if (!cfg || cfg.balance == null || cfg.balance === '') return null; // sin saldo capturado = no se controla
  const pending = state.bets.filter((b) => b.status === 'pending' && b.book === id).reduce((a, b) => a + b.stake, 0);
  return cfg.balance - pending;
}

// Recomendación de casa para una selección.
// quotes: { bookId: momioDecimal } capturados en el boleto (opcional).
export function recommendBook(state, { sport, p, stake = 0, quotes = {} }) {
  const books = enabledBooks(state);
  if (!books.length) return null;
  const stats = bookPriceStats(state, sport);
  const statsAll = bookPriceStats(state);
  const rows = books.map((b) => {
    const avail = bookAvailable(state, b.id);
    const q = quotes[b.id] || null;
    const learned = stats[b.id]?.n >= 3 ? stats[b.id].avg : statsAll[b.id]?.n >= 5 ? statsAll[b.id].avg : null;
    return {
      book: b, odds: q, ev: q ? p * q - 1 : null, learned, learnedN: stats[b.id]?.n || 0,
      avail, enough: avail == null || avail >= stake,
    };
  });
  const withQuotes = rows.filter((r) => r.odds && r.enough).sort((a, b) => b.ev - a.ev);
  if (withQuotes.length) return { best: withQuotes[0], rows, reason: 'quotes' };
  const learned = rows.filter((r) => r.learned && r.enough).sort((a, b) => b.learned - a.learned);
  if (learned.length) return { best: learned[0], rows, reason: 'learned' };
  const funded = rows.filter((r) => r.enough).sort((a, b) => (b.avail ?? 0) - (a.avail ?? 0));
  return { best: funded[0] || null, rows, reason: funded[0]?.avail != null ? 'balance' : 'none' };
}

export function reasonText(rec, sportName) {
  if (!rec?.best) return 'Activa tus casas en Más → Mis casas.';
  const b = rec.best;
  if (rec.reason === 'quotes') return `${b.book.name} paga el mejor momio de los que capturaste (${b.odds.toFixed(2)}, EV ${(b.ev * 100).toFixed(1)}%).`;
  if (rec.reason === 'learned') return `En ${sportName}, ${b.book.name} te ha pagado en promedio ${((b.learned - 1) * 100).toFixed(1)}% frente a la referencia (${b.learnedN} capturas). Confirma el momio en la app antes de apostar.`;
  if (rec.reason === 'balance') return `${b.book.name} es la casa con más saldo disponible. Compara el momio en tus otras casas: tomar siempre el mejor precio es la mejora más fácil.`;
  return `Compara el momio en tus casas (${rec.rows.map((r) => r.book.name).join(', ')}) y apuesta donde paguen más.`;
}
