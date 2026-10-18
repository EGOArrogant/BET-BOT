// Estudio de estrategia: las reglas que sigue el bot, explicadas.
export const STRATEGY_HTML = `
<div class="prose">
<h4>1. Cómo gana la casa</h4>
<p>Cada momio trae un margen ("vig" u overround). Si sumas las probabilidades implícitas (1 ÷ momio decimal) de todos los resultados, el total pasa de 100%. Lo que sobra es la ganancia de la casa. Pinnacle cobra entre 2% y 3%, y las casas mexicanas suelen cobrar entre 5% y 8%. Para ganar a largo plazo hay que superar ese margen. El bot lo quita de forma proporcional para obtener la probabilidad "justa" del mercado.</p>

<h4>2. Value betting: la única estrategia sostenible</h4>
<p>Una apuesta tiene valor cuando <b>tu probabilidad × momio − 1 &gt; 0</b>. Eso es el valor esperado (EV). No importa si el equipo es favorito: lo que importa es si el precio es correcto. El bot solo apuesta con un EV de 3% o más (ajustable) y te da el <b>momio mínimo</b> que necesitas en tu casa mexicana para que la apuesta valga la pena.</p>

<h4>3. CLV (closing line value): el termómetro real</h4>
<p>Con pocas apuestas, los resultados son casi pura suerte. La mejor señal temprana de habilidad es conseguir momios mejores que los de cierre. Si apuestas a 2.10 y el partido cierra a 1.95, le ganaste al mercado. El bot registra el CLV de cada apuesta previa al partido.</p>

<h4>4. Gestión de banca: Kelly fraccionado</h4>
<p>El criterio de Kelly dice qué fracción de la banca apostar: <span class="kbd">f = (p·o − 1) / (o − 1)</span>. El Kelly completo es demasiado agresivo cuando la probabilidad estimada tiene error, así que el bot usa <b>25% de Kelly</b> con un tope de <b>3% de la banca</b> por apuesta. Con $2,000 MXN, eso significa apuestas de unos $10 a $60.</p>

<h4>5. Modelos que usa el bot</h4>
<ul>
<li><b>Fútbol:</b> Poisson de ataque y defensa. Calcula los goles esperados de cada equipo con sus goles a favor y en contra frente al promedio de la liga, más la ventaja de localía. De ahí salen 1X2, más/menos goles y ambos anotan. En vivo recalcula con el marcador y el tiempo restante.</li>
<li><b>NFL, NBA y MLB:</b> expectativa pitagórica (puntos o carreras a favor y en contra), combinación log5 entre los dos equipos y ventaja de local. En vivo usa la probabilidad de victoria de ESPN o un modelo normal del margen según el tiempo restante.</li>
<li><b>Tenis:</b> probabilidad por puntos de ranking, convertida a probabilidad por set. En vivo calcula la cadena de sets según cómo va el partido.</li>
<li><b>Mezcla con el mercado:</b> los mercados grandes son muy eficientes, así que la probabilidad final es <span class="kbd">w·modelo + (1−w)·mercado</span>. El peso w empieza en 30%–35% y el bot lo ajusta solo: si su modelo acierta mejor que el mercado (Brier score), le da más peso; si no, menos. Además, el modelo nunca puede mover la probabilidad del mercado más de 5 puntos (o 20% relativo): cuando un modelo simple "ve" 30% de EV, casi siempre el que se equivoca es el modelo. En la Champions el modelo pesa menos, porque compara equipos de ligas de distinto nivel.</li>
</ul>

<h4>6. Sesgos de mercado que se pueden aprovechar</h4>
<ul>
<li><b>Sesgo favorito-underdog:</b> el público sobrepaga los momios muy altos. Las "remontadas" y los underdogs extremos casi siempre están mal pagados para el apostador. Por eso las Oportunidades de Oro exigen EV positivo, no solo un momio grande.</li>
<li><b>Equipos populares:</b> América, Chivas, Real Madrid, Barcelona y los Cowboys reciben dinero "de aficionado" y a veces su momio queda corto. A veces hay valor en el rival.</li>
<li><b>Sobrerreacción a rachas:</b> una o dos derrotas mueven el momio más de lo que justifican las estadísticas de fondo (tiros, xG, diferencia de puntos).</li>
<li><b>Noticias tardías:</b> bajas, rotaciones por Champions o calendario apretado, y cambios de abridor en béisbol. Si sabes primero, consigues mejor precio. El analista IA busca estas noticias en internet.</li>
</ul>

<h4>7. Comparar momios en México</h4>
<p>Abrir cuenta en 2 o 3 casas mexicanas y tomar siempre el mejor momio es la mejora más fácil y más grande que hay: 0.10 de diferencia en un momio de 2.00 son 5 puntos de EV. Compara el momio mínimo del bot con Caliente, Codere, bet365 MX o Strendus antes de apostar.</p>

<h4>8. Apuestas en vivo</h4>
<p>En vivo, el margen de la casa es mayor y los momios cambian en segundos. El bot calcula la probabilidad en vivo, pero los momios gratuitos de ESPN son de antes del partido. Por eso en vivo te da el <b>momio mínimo</b> y tú comparas con tu app. Busca situaciones donde el mercado sobrerreacciona: un gol tempranero del underdog, una expulsión del equipo débil o un favorito que domina pero no concreta.</p>

<h4>9. Varianza y paciencia</h4>
<p>Con un EV de 3% y momios cercanos a 2.0, hacen falta cientos de apuestas para distinguir habilidad de suerte. Son normales las rachas de 8 a 10 apuestas perdidas seguidas. La regla del bot: <b>mínimo 300 a 500 apuestas simuladas con CLV y ROI positivos antes de pensar en dinero real.</b></p>

<h4>10. Mercados de predicción: Polymarket y Kalshi</h4>
<p>Son bolsas donde la gente compra y vende contratos sobre resultados con dinero real. Si el contrato "gana el América" cuesta 0.62, el mercado le da 62% de probabilidad. Con mucha liquidez, sus precios están entre los más precisos que existen. El bot los usa así:</p>
<ul>
<li>Los <b>promedia con las casas</b> (sin margen) para obtener el consenso del mercado.</li>
<li>Los usa como <b>precio de referencia</b> cuando no hay momio de casa, como en eSports o algunos partidos de tenis.</li>
<li>Como se actualizan <b>en vivo</b>, los usa para detectar remontadas mal pagadas durante el partido.</li>
</ul>
<p>Cuando tu casa mexicana paga más que lo que implica Polymarket o Kalshi, es una buena señal de valor. El bot solo <b>lee</b> sus precios; no opera en esos sitios.</p>

<h4>11. Modo práctica y aprendizaje</h4>
<p>Para no esperar días a que aparezca una apuesta con mucho valor, el modo práctica hace cada día unas pocas apuestas ficticias al monto mínimo, eligiendo las mejores opciones disponibles. Además, las apuestas sombra registran todo lo que el bot habría apostado. Con los resultados, el bot aprende qué deportes, mercados y rangos de momio le funcionan, y deja de apostar en los que pierden.</p>

<h4>12. Disciplina y juego responsable</h4>
<ul>
<li>No perseguir pérdidas ni subir el monto después de perder.</li>
<li>Usar solo dinero que puedes perder sin afectar tus gastos.</li>
<li>Poner un límite de apuestas por día (configurable en Ajustes).</li>
<li>Si las apuestas dejan de ser divertidas o te generan estrés, para. En México puedes pedir ayuda en la Línea de la Vida: 800 911 2000.</li>
</ul>
</div>`;
