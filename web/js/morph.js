// Actualiza la página cambiando SOLO lo que es distinto (en lugar de reemplazar todo con innerHTML).
// Evita parpadeos: las imágenes no se recargan, las animaciones no reinician, no se pierde el scroll
// interno, los paneles abiertos (<details>) siguen abiertos y los campos de texto no pierden el foco.

// Logos que ya fallaron: no se vuelven a pedir en cada actualización (evita el "parpadeo" del icono roto).
export const BAD_IMG = new Set();
window.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG') { BAD_IMG.add(t.getAttribute('src')); t.remove(); }
}, true);

const keyOf = (n) => (n.nodeType === 1 ? n.id || n.getAttribute('data-key') || n.getAttribute('data-open') || null : null);

const isPlaceholder = (n) => { const t = n.textContent.trim(); return !t ? !n.querySelector('img,svg,canvas,input,button') : !!n.querySelector('.shimmer') && t.length < 140; };

function syncAttrs(from, to) {
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
}

function morphNode(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) { from.replaceWith(to); return; }
  if (from.nodeType === 3 || from.nodeType === 8) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
  if (from.isEqualNode(to)) return;
  // Contenedores que se llenan después (noticias, peleadores, QR…): si lo nuevo es solo el "cargando"
  // y ya hay contenido, se conserva el contenido (si no, parpadearía entre cargando y datos).
  if (from.id && isPlaceholder(to) && !isPlaceholder(from)) return;
  // Gráficas dibujadas por código: se conserva lo dibujado (se redibuja aparte).
  if (from.hasAttribute('data-keep') && from.firstChild) { syncAttrs(from, to); from.setAttribute('data-keep', ''); return; }
  const tag = from.nodeName;
  if (tag === 'DETAILS') { if (from.open) to.setAttribute('open', ''); else to.removeAttribute('open'); }
  if (tag === 'IMG' && from.getAttribute('src') === to.getAttribute('src')) { syncAttrs(from, to); return; }
  if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && document.activeElement === from) return; // escribiendo
  syncAttrs(from, to);
  if (tag === 'INPUT') { if (from.type === 'checkbox' || from.type === 'radio') from.checked = to.hasAttribute('checked'); else if (from.value !== (to.getAttribute('value') ?? '')) from.value = to.getAttribute('value') ?? ''; }
  morphChildren(from, to);
}

function morphChildren(from, to) {
  const keyed = new Map();
  for (const c of from.childNodes) { const k = keyOf(c); if (k) keyed.set(k, c); }
  let cur = from.firstChild;
  for (const next of [...to.childNodes]) {
    const k = keyOf(next);
    let match = null;
    if (k && keyed.has(k)) { match = keyed.get(k); keyed.delete(k); }
    else if (cur && !keyOf(cur) && cur.nodeType === next.nodeType && cur.nodeName === next.nodeName) match = cur;
    if (match) {
      if (match !== cur) from.insertBefore(match, cur);
      else cur = cur.nextSibling;
      morphNode(match, next);
    } else {
      from.insertBefore(next, cur);
    }
  }
  while (cur) { const n = cur.nextSibling; cur.remove(); cur = n; }
}

// Reemplaza el contenido de `el` por `html` cambiando solo lo necesario.
export function morph(el, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const img of tpl.content.querySelectorAll('img')) if (BAD_IMG.has(img.getAttribute('src'))) img.remove();
  if (!el.firstChild) { el.appendChild(tpl.content); return; }
  const wrap = document.createElement(el.nodeName);
  wrap.appendChild(tpl.content);
  morphChildren(el, wrap);
}
