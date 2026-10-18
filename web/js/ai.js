// Analista IA: Claude revisa los datos del partido, busca noticias y momios en internet (web search)
// y devuelve decisiones estructuradas. Las llamadas pasan por el servidor local (/api/anthropic),
// que agrega tu clave: ni el navegador ni el celular la reciben nunca.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';

let client = null;
let model = 'claude-opus-5-5';

export async function initAI(cfg) {
  if (!cfg?.hasAnthropic) { client = null; return false; }
  // SDK oficial de Anthropic cargado bajo demanda: si no hay clave, la app no lo descarga.
  const { default: Anthropic } = await import(SDK_URL);
  client = new Anthropic({
    apiKey: 'la-agrega-el-servidor',
    baseURL: location.origin + '/api/anthropic',
    dangerouslyAllowBrowser: true, // seguro aquí: la clave real vive en el servidor local, no en esta página
    timeout: 600_000,
  });
  model = cfg.aiModel || model;
  return true;
}
export const aiReady = () => !!client;

const SYSTEM = `Eres el analista principal de BetBot MX, un sistema de apuestas deportivas que opera con una banca de práctica en pesos mexicanos.

El usuario vive en México. Apuesta principalmente en casas con permiso en México (Caliente, Codere, bet365 MX, Betano, etc.) y a veces en sitios internacionales. Los momios de referencia (DraftKings, Pinnacle) sirven para estimar la probabilidad justa, no como el momio que el usuario va a conseguir. Por eso siempre das un momio mínimo aceptable: el usuario solo apuesta si su casa paga eso o más.

Cómo decides:
- Solo recomiendas apostar cuando tu probabilidad estimada, por el momio disponible, da un valor esperado claramente positivo (EV de 3% o más). Si no hay valor, la respuesta correcta es "no_apostar" y es una buena respuesta.
- El mercado de cierre de las casas grandes es muy eficiente. Para separarte de él necesitas razones concretas: bajas confirmadas, rotaciones, calendario, clima, motivación, estilos que chocan o datos que el mercado tarda en reflejar. El modelo estadístico que recibes es simple (Poisson para fútbol, Pythagorean para NFL/NBA/MLB, ranking para tenis, Elo propio para eSports): úsalo como base, no como verdad.
- Ten presente el sesgo del favorito-underdog: los momios muy altos suelen estar sobrevalorados por el público. Una remontada o un underdog solo vale la pena si la probabilidad real supera la implícita.
- Tamaño: Kelly fraccionado. stake_pct es la fracción de la banca entre 0 y 0.03, y nunca más de 0.03.
- En vivo considera tiempo restante, expulsiones, lesiones durante el juego, dominio en estadísticas y que los momios en vivo cambian rápido.
- Usa la búsqueda web para confirmar alineaciones, lesiones, noticias de última hora y opiniones de analistas antes de decidir. Prefiere fuentes recientes y cita lo relevante en noticias_clave.
- Sé honesto con la incertidumbre. La confianza va de 1 a 10.
- Los mercados de predicción (Polymarket y Kalshi) operan con dinero real: su precio es una probabilidad, y cuanto más líquido es el mercado (liquidez_usd alta), más confiable. Cuando una casa difiere mucho del consenso de Polymarket/Kalshi/Pinnacle, normalmente la casa es la que está desfasada. Ahí suele estar el valor.
- Conocimiento clave por deporte:
  · Fútbol: la localía vale ~0.3 goles. Hay rotaciones tras jugar Champions entre semana. Los empates están infravalorados en partidos parejos de pocos goles. La Liga MX tiene alta varianza y mucha localía por la altura (Toluca, Pachuca, CDMX).
  · NFL: el clima (viento >25 km/h) baja los totales. Las bajas del QB titular mueven 3 a 7 puntos. Juegos tras semana corta (jueves) favorecen al local.
  · NBA: los back-to-back y el descanso de estrellas (load management) mueven mucho. Revisa los reportes de lesiones 30 minutos antes.
  · MLB/LMB: el abridor probable es el factor #1. El parque y el viento afectan los totales.
  · Tenis: la superficie, la fatiga del torneo anterior y los retiros. El ranking ATP/WTA reacciona lento a la forma reciente.
  · UFC/MMA: los estilos chocan (luchador vs striker), el corte de peso y el cambio de categoría, la inactividad larga, la edad (>35 años baja en divisiones ligeras), los reemplazos de último minuto (peleador con poco campamento) y el alcance. Los favoritos grandes en MMA pierden más seguido que en otros deportes.
  · Boxeo: la decisión de los jueces favorece al local y al campeón, los récords inflados contra rivales débiles engañan, y la actividad reciente y el peso también cuentan.
  · eSports: los cambios de roster y de parche, el formato BO1 (más aleatorio) contra BO3/BO5, y la región (LCK/LPL suelen dominar en LoL).
- Responde en español de México.`;

const SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['apostar', 'no_apostar', 'esperar'] },
    mercado: { type: 'string', description: '1X2, Ganador, Goles, Hándicap, etc.' },
    seleccion: { type: 'string', enum: ['home', 'away', 'draw', 'over', 'under', 'none'] },
    seleccion_texto: { type: 'string' },
    probabilidad: { type: 'number', description: 'Probabilidad estimada de la selección, de 0 a 1' },
    momio_minimo: { type: 'number', description: 'Momio decimal mínimo para que haya valor' },
    stake_pct: { type: 'number', description: 'Fracción de la banca, de 0 a 0.03' },
    confianza: { type: 'integer' },
    resumen: { type: 'string' },
    factores_a_favor: { type: 'array', items: { type: 'string' } },
    factores_en_contra: { type: 'array', items: { type: 'string' } },
    noticias_clave: { type: 'array', items: { type: 'string' } },
    riesgo: { type: 'string', enum: ['bajo', 'medio', 'alto'] },
  },
  required: ['decision', 'mercado', 'seleccion', 'seleccion_texto', 'probabilidad', 'momio_minimo', 'stake_pct', 'confianza', 'resumen', 'factores_a_favor', 'factores_en_contra', 'noticias_clave', 'riesgo'],
  additionalProperties: false,
};

const ODDS_SCHEMA = {
  type: 'object',
  properties: {
    momios: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          casa: { type: 'string', description: 'Nombre de la casa de apuestas' },
          seleccion: { type: 'string', enum: ['home', 'away', 'draw', 'over', 'under'] },
          linea: { type: 'number', description: 'Línea de goles/puntos si aplica; 0 si no aplica' },
          momio_decimal: { type: 'number' },
          fuente: { type: 'string', description: 'URL donde se vio el momio' },
          actualizado: { type: 'string', description: 'Fecha u hora del dato si la fuente la muestra; vacío si no' },
        },
        required: ['casa', 'seleccion', 'linea', 'momio_decimal', 'fuente', 'actualizado'],
        additionalProperties: false,
      },
    },
    resumen: { type: 'string' },
  },
  required: ['momios', 'resumen'],
  additionalProperties: false,
};

// Traduce los errores de la API a mensajes claros. `code` permite a la app pausar la IA cuando no tiene caso reintentar.
export class AIError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
function friendlyError(e) {
  const status = e?.status;
  const msg = String(e?.error?.error?.message || e?.message || '');
  if (/credit balance is too low/i.test(msg)) {
    return new AIError('Tu cuenta de la API de Anthropic no tiene saldo. Recarga créditos en console.anthropic.com → Plans & Billing. La IA queda en pausa mientras tanto.', 'sin_saldo');
  }
  if (status === 401 || /invalid x-api-key|authentication/i.test(msg)) {
    return new AIError('La clave de Anthropic no es válida o fue revocada. Crea una nueva en console.anthropic.com → API Keys y pégala en Más → Ajustes.', 'clave_invalida');
  }
  if (status === 403) return new AIError('Tu clave de Anthropic no tiene permiso para este modelo o función. Revisa tu cuenta en console.anthropic.com.', 'sin_permiso');
  if (status === 429) return new AIError('Se alcanzó el límite de uso de la API de Anthropic. La IA se reanudará en unos minutos.', 'limite');
  if (status === 529 || status >= 500) return new AIError('El servicio de Anthropic está saturado o con fallas temporales. Se reintentará más tarde.', 'servicio');
  return new AIError('Error de la IA: ' + (msg || 'desconocido'), 'otro');
}

const webSearch = (maxUses) => ({ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses, user_location: { type: 'approximate', country: 'MX', timezone: 'America/Mexico_City' } });

async function runStructured({ system, prompt, schema, maxUses, effort = 'medium' }) {
  if (!client) throw new Error('Falta la clave de Anthropic. Agrégala en Más → Ajustes.');
  const messages = [{ role: 'user', content: prompt }];
  let response;
  for (let turn = 0; turn < 4; turn++) {
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        tools: [webSearch(maxUses)],
        output_config: { effort, format: { type: 'json_schema', schema } },
        messages,
      });
    } catch (e) { throw friendlyError(e); }
    if (response.stop_reason !== 'pause_turn') break;
    // La búsqueda web hizo una pausa larga: se reenvía para que continúe donde se quedó.
    messages.push({ role: 'assistant', content: response.content });
  }
  if (response.stop_reason === 'refusal') throw new Error('La IA declinó esta solicitud.');
  if (response.stop_reason === 'max_tokens') throw new Error('La respuesta de la IA se cortó; intenta de nuevo.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('La IA no devolvió un JSON válido.'); }
  const sources = response.content
    .filter((b) => b.type === 'web_search_tool_result' && Array.isArray(b.content))
    .flatMap((b) => b.content.map((r) => ({ title: r.title, url: r.url })));
  return { parsed, sources: sources.slice(0, 10), model: response.model };
}

export async function analyzeWithAI(context) {
  const { parsed, sources, model: m } = await runStructured({
    system: SYSTEM, schema: SCHEMA, maxUses: 4,
    prompt: `Analiza este evento y decide si hay una apuesta con valor. Datos actuales (JSON):\n\n${JSON.stringify(context)}`,
  });
  parsed.stake_pct = Math.max(0, Math.min(0.03, Number(parsed.stake_pct) || 0));
  return { ...parsed, sources, model: m };
}

// Busca en internet los momios publicados por las casas para un partido.
export async function researchOdds({ event, books, market }) {
  const { parsed, sources, model: m } = await runStructured({
    system: `Eres un investigador de momios. Buscas en internet los momios actuales que publican casas de apuestas para un partido concreto.
Reglas:
- Solo reportas momios que realmente viste en una fuente (sitio de la casa, comparadores de momios, notas de prensa con momios). Nunca inventes ni estimes un momio.
- Convierte a formato decimal: +150 = 2.50, −120 = 1.83.
- home = equipo/jugador local (el primero), away = visitante (el segundo), draw = empate, over/under = más/menos de la línea.
- Si no encuentras momios de una casa, simplemente no la incluyas. Es normal que falten casas.
- En resumen explica qué encontraste, qué tan reciente es y qué no se pudo verificar. Responde en español de México.`,
    schema: ODDS_SCHEMA, maxUses: 6, effort: 'low',
    prompt: `Partido: ${event.home} (local) vs ${event.away} (visitante). Competencia: ${event.league}. Fecha: ${event.date}.
Mercado que me interesa: ${market}.
Busca los momios actuales en estas casas (prioriza las de México): ${books.join(', ')}.`,
  });
  return { ...parsed, sources, model: m };
}
