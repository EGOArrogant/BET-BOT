// Gráficas de línea en SVG, ligeras y sin librerías: probabilidad de ganar, precio de mercado, etc.
// Al pasar el dedo o el mouse aparece una guía vertical con el valor de cada línea en ese punto.

const registry = new Map(); // id -> { series, x0, x1, xFmt, yFmt, W, H, pad }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// series: [{ name, color, dash?, pts: [{ x, y }] }]  (y entre 0 y 1)
// refs: [{ y, label, color }] líneas horizontales de referencia (p. ej. tu momio)
export function lineChart(id, { series, refs = [], xFmt = (x) => x, yFmt = (y) => Math.round(y * 100) + '%', height = 190, empty = 'Sin datos todavía' }) {
  const all = series.filter((s) => s.pts.length);
  if (!all.length) return `<div class="chart-empty note">${esc(empty)}</div>`;
  const W = 640, H = height, pad = { l: 38, r: 12, t: 10, b: 24 };
  const xs = all.flatMap((s) => s.pts.map((p) => p.x));
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x1 === x0) x1 = x0 + 1;
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - y) * (H - pad.t - pad.b);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((g) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(g)}" y2="${Y(g)}" class="cg${g === 0.5 ? ' mid' : ''}"/><text x="${pad.l - 6}" y="${Y(g) + 4}" class="cy">${Math.round(g * 100)}%</text>`).join('');
  const xt = [0, 0.5, 1].map((f) => { const x = x0 + f * (x1 - x0); return `<text x="${X(x)}" y="${H - 6}" class="cx" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${esc(xFmt(x))}</text>`; }).join('');
  const lines = all.map((s) => {
    const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    const last = s.pts[s.pts.length - 1];
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>
      <circle cx="${X(last.x)}" cy="${Y(last.y)}" r="4" fill="${s.color}" stroke="var(--bg-solid, #111)" stroke-width="2"/>`;
  }).join('');
  const refHtml = refs.map((r) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(r.y)}" y2="${Y(r.y)}" stroke="${r.color || 'var(--text-3)'}" stroke-width="1.5" stroke-dasharray="2 4"/><text x="${W - pad.r}" y="${Y(r.y) - 5}" class="cref" text-anchor="end">${esc(r.label)}</text>`).join('');
  registry.set(id, { series: all, X, Y, x0, x1, xFmt, yFmt, W, H, pad });
  const legend = all.length > 1 || refs.length ? `<div class="legend chart-legend">${all.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)} <b>${esc(yFmt(s.pts[s.pts.length - 1].y))}</b></span>`).join('')}</div>` : '';
  return `${legend}<div class="lc-chart" data-chart="${esc(id)}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(all.map((s) => s.name).join(', '))}">${grid}${xt}${refHtml}${lines}
    <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/></svg><div class="chart-tip" hidden></div></div>`;
}

// Guía y valores al pasar el mouse o el dedo (una sola escucha para todas las gráficas).
function onMove(e) {
  const box = e.target.closest?.('.lc-chart');
  document.querySelectorAll('.lc-chart .cross').forEach((c) => { if (!box || !box.contains(c)) c.setAttribute('visibility', 'hidden'); });
  document.querySelectorAll('.lc-chart .chart-tip').forEach((t) => { if (!box || !box.contains(t)) t.hidden = true; });
  if (!box) return;
  const c = registry.get(box.dataset.chart);
  if (!c) return;
  const svg = box.querySelector('svg'), r = svg.getBoundingClientRect();
  const pt = e.touches ? e.touches[0] : e;
  const vx = ((pt.clientX - r.left) / r.width) * c.W;
  const x = c.x0 + ((vx - c.pad.l) / (c.W - c.pad.l - c.pad.r)) * (c.x1 - c.x0);
  if (x < c.x0 || x > c.x1) return;
  const near = c.series.map((s) => { let best = s.pts[0]; for (const p of s.pts) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p; return { s, p: best }; });
  const cross = box.querySelector('.cross');
  cross.setAttribute('x1', c.X(near[0].p.x)); cross.setAttribute('x2', c.X(near[0].p.x)); cross.setAttribute('visibility', 'visible');
  const tip = box.querySelector('.chart-tip');
  tip.innerHTML = `<div class="note">${esc(c.xFmt(near[0].p.x))}</div>` + near.map(({ s, p }) => `<div><i style="background:${s.color}"></i>${esc(s.name)} <b>${esc(c.yFmt(p.y))}</b></div>`).join('');
  tip.hidden = false;
  const left = ((c.X(near[0].p.x) / c.W) * r.width);
  tip.style.left = Math.min(Math.max(left + 10, 0), r.width - 170) + 'px';
}
document.addEventListener('mousemove', onMove);
document.addEventListener('touchstart', onMove, { passive: true });
document.addEventListener('touchmove', onMove, { passive: true });
