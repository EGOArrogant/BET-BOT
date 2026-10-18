# Investigación de fuentes de datos para el bot de apuestas

Fecha: 17 de octubre de 2026

Las fuentes marcadas como "probado" se consultaron en vivo y devolvieron datos reales.

## Ligas objetivo

Liga MX, Champions League, LaLiga, Premier League, Ligue 1, Serie A, NFL, NBA, MLB, Liga Mexicana de Béisbol (LMB), ATP y WTA.

## 1. Fuentes gratis (base del bot)

### ESPN API no oficial (probado)
- Base: `https://site.api.espn.com/apis/site/v2/sports/{deporte}/{liga}/...`
- Endpoints: `scoreboard`, `summary?event={id}`, `news`, `injuries`, `teams`, `standings`.
- Claves de liga: `soccer/mex.1`, `soccer/uefa.champions`, `soccer/esp.1`, `soccer/eng.1`, `soccer/fra.1`, `soccer/ita.1`, `football/nfl`, `basketball/nba`, `baseball/mlb`, `tennis/atp`, `tennis/wta`.
- Verificado en partidos reales de Liga MX, LaLiga y Premier:
  - **Formación** (por ejemplo Santos 3-4-3 contra Querétaro 4-2-3-1).
  - **Alineación completa**: titulares y suplentes.
  - **Más de 28 estadísticas por equipo**: posesión, tiros, tiros a puerta, pases, centros, entradas, intercepciones, córners, tarjetas, atajadas.
  - **Eventos clave** y **narración minuto a minuto**: de 100 a 116 entradas por partido.
  - **Bloques extra**: `pickcenter` y `odds` con momios de DraftKings (spread y over/under), `lastFiveGames` (forma), `standings` y `news`.
- **Lesiones de la NBA**: 27 equipos con reporte.
- **Ventajas**: gratis, sin clave y en tiempo real.
- **Riesgo**: no es oficial, puede cambiar sin aviso y no hay que saturarlo de peticiones. Hay que programar el bot con manejo de errores.

### MLB Stats API oficial (probado)
- Base: `https://statsapi.mlb.com/api/v1/`
- Datos: MLB completo (pitch por pitch, alineaciones, abridores probables, boxscores).
- **Incluye la LMB**: `sportId=23`, `leagueId=125` ("Mexican League", temporada 2026 activa).
- Gratis y sin clave.

### Noticias en tiempo real (probado)
- **Google News RSS** en español de México: `https://news.google.com/rss/search?q={búsqueda}&hl=es-419&gl=MX&ceid=MX:es-419`. Devolvió 100 notas para "Liga MX lesión" (TUDN, Récord, etc.).
- **ESPN RSS** y el endpoint `news` de cada liga.
- Uso: detectar lesiones, bajas, cambios de entrenador y rotaciones que mueven los momios.

### Métricas avanzadas de fútbol
- **Understat** (probado, en línea): xG y xGA de Premier, LaLiga, Serie A, Ligue 1 y Bundesliga. No cubre Liga MX.
- Para Liga MX el modelo se basa en tiros, tiros a puerta y el Elo propio.

### Otras librerías gratis por deporte
- **NBA**: `nba_api` (Python, datos de stats.nba.com: jugadas, eficiencia, ritmo, lineups).
- **NFL**: `nflverse` / `nfl_data_py` (jugadas con EPA, snaps, lesiones semanales).
- **Tenis**: el scoreboard de ESPN para ATP y WTA. Para el historial completo están los datasets de Jeff Sackmann en GitHub, con superficie, servicio y break points desde hace décadas. Con eso se calcula un Elo por superficie.

## 2. Momios

| Proveedor | Gratis | Pago | Notas |
|---|---|---|---|
| **The Odds API** | 500 créditos al mes | $30 USD/mes (20K), $59 USD/mes (100K) | Liga MX `soccer_mexico_ligamx`, EPL, LaLiga, Serie A, Ligue 1, Champions, NFL, NBA, MLB, ATP y WTA por torneo. Momios en vivo. Incluye Pinnacle en la región EU. **No incluye LMB.** |
| ESPN `pickcenter` | Sí | — | Momios de DraftKings solo como referencia, no en todos los partidos. |
| SportsGameOdds | Limitado (9 casas, 10 min de retraso) | Desde ~$99 USD/mes | Sí incluye LMB. |
| OddsPapi / SharpAPI | Tiers gratis pequeños | Desde ~$79 USD/mes | Alternativas con más casas. |

Pinnacle es clave porque es la casa más "afilada". Su momio sin margen se usa como estimación de la probabilidad real y para medir el CLV.

Las casas mexicanas (Caliente, Codere, bet365 MX) no están en estas APIs. Tú comparas el momio que recomienda el bot con el de tu casa antes de apostar.

## 3. APIs de pago recomendadas para "tiempo real serio"

| Proveedor | Precio | Qué agrega |
|---|---|---|
| **API-Football (api-sports.io)** | Gratis con 100 al día. Pro: $19 USD/mes (7,500 al día) | Alineaciones, lesiones, predicciones y estadísticas por jugador en vivo para más de 1,000 ligas. Cada deporte (NBA, NFL, béisbol) es una suscripción aparte. |
| Sportmonks | ~$20 USD a más de $1,000 USD/mes | xG, predicciones y momios como complementos. |
| Live Tennis API | Gratis con 100 al día | Punto por punto. Momios y probabilidades solo en planes de pago. |
| Sportradar / Statscore | Precios empresariales | Fuera de presupuesto. |

## 4. Recomendación

**Fase de simulación (costo $0):**
- ESPN para marcadores en vivo, formaciones, alineaciones, estadísticas, narración, lesiones y noticias de todas las ligas.
- MLB Stats API para MLB y LMB.
- Understat para xG de las 5 grandes ligas europeas.
- nba_api y nflverse para métricas avanzadas.
- Datos de Sackmann para el Elo de tenis.
- The Odds API gratis para momios, consultando solo los partidos que el bot va a analizar (500 créditos al mes).
- Google News RSS para noticias.

**Cuando el bot demuestre ventaja (~$50 USD al mes):**
- The Odds API 20K ($30 USD) para momios en vivo frecuentes.
- API-Football Pro ($19 USD) como respaldo y para lesiones y predicciones de fútbol.

## 5. Lo que necesito del usuario

1. Una clave gratis de **The Odds API** (the-odds-api.com, solo pide correo).
2. Una clave de la **API de Anthropic** (console.anthropic.com) para el módulo de IA.
3. Opcional: una clave gratis de **API-Football** (dashboard.api-football.com).

Las claves se guardan en un archivo `.env` local y nunca se suben a ningún lado.

## Restricción clave: solo se apuesta en México

Los datos pueden venir de cualquier país, pero las apuestas se colocan solo en casas que operan en México (Caliente, Codere, bet365 MX, Strendus, etc.). Esto cambia el diseño:

- **Los momios extranjeros (Pinnacle, casas de EU y UK) son solo referencia.** Sirven para estimar la probabilidad real y para detectar cuándo un momio mexicano está "mal puesto". No se apuesta en ellos.
- **El bot nunca da un momio extranjero como el momio a tomar.** Siempre da un **momio mínimo aceptable**: el valor a partir del cual la apuesta tiene valor esperado positivo. Tú lo comparas con el de tu app mexicana y solo apuestas si ese momio es igual o mejor.
- **Captura manual del momio real.** En la app habrá un campo para escribir el momio que te ofrece tu casa mexicana. La banca ficticia se liquida con ese momio, no con el de referencia, para que la simulación refleje lo que de verdad puedes cobrar.
- **Mercados disponibles en México.** El bot solo debe recomendar mercados que existan en las casas mexicanas. Los más comunes son 1X2, hándicap, over/under, ambos anotan y props principales.
- **Margen más alto.** Las casas mexicanas suelen cobrar más margen que Pinnacle, así que habrá menos apuestas con value. Por eso el filtro de valor esperado tiene que ser estricto.

## Modo de operación

El bot analiza en tiempo real y recomienda la apuesta: mercado, momio mínimo aceptable, monto en pesos y razón. El usuario coloca la apuesta manualmente en su casa. En paralelo, el bot registra todo en la banca ficticia de $2,000 MXN para medir el ROI y el CLV.
