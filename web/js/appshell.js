// App del iPhone (Agregar a pantalla de inicio): todo lo que la hace sentir como app nativa.
// - Pantalla completa, sin barra de Safari, con icono y pantalla de inicio propios (ver index.html y el manifiesto).
// - Conexión con la PC: si la PC se apaga o el celular sale del WiFi, avisa y se reconecta sola.
// - Deslizar hacia abajo para actualizar, y actualización al volver a abrir la app.
// - Vibración ligera (háptica) al tocar las pestañas, en iOS 18 o más reciente.

export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);

const $ = (s) => document.querySelector(s);
let opts = { refresh: async () => {}, isLocal: false };

export function initShell(o) {
  opts = { ...opts, ...o };
  document.documentElement.classList.toggle('standalone', isStandalone);
  document.documentElement.classList.toggle('ios', isIOS);
  if (isStandalone) pullToRefresh();
  connectionMonitor();
  resumeRefresh();
  hapticTabs();
  if (isIOS && !isStandalone && !opts.isLocal) installHint();
}

// ---------- Vibración ligera ----------
// Safari no tiene API de vibración; en iOS 18+ tocar un interruptor nativo produce un "tic" háptico.
let hapticLabel = null;
export function haptic() {
  if (!isIOS) { navigator.vibrate?.(8); return; }
  try {
    if (!hapticLabel) {
      hapticLabel = document.createElement('label');
      hapticLabel.className = 'haptic-sink';
      hapticLabel.innerHTML = '<input type="checkbox" switch>';
      document.body.appendChild(hapticLabel);
    }
    hapticLabel.click();
  } catch {}
}
function hapticTabs() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('#tabbar [data-tab], .segmented button, [data-slip], .refresh-pull')) haptic();
  }, true);
}

// ---------- Conexión con la PC ----------
let offline = false, fails = 0, pingTimer = null;
async function ping() {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('/api/config', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(to);
    if (r.status === 401) { showOffline('auth'); return false; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fails = 0;
    if (offline) { offline = false; hideOffline(); opts.refresh(); }
    return true;
  } catch {
    if (++fails >= 2 && !offline) { offline = true; showOffline('down'); }
    return false;
  }
}
function connectionMonitor() {
  const loop = () => { clearTimeout(pingTimer); pingTimer = setTimeout(async () => { if (!document.hidden) await ping(); loop(); }, offline ? 3000 : 8000); };
  loop();
  window.addEventListener('online', () => ping());
  window.addEventListener('offline', () => { offline = true; showOffline('down'); });
}
function showOffline(kind) {
  let el = $('#offline');
  if (!el) {
    el = document.createElement('div');
    el.id = 'offline';
    el.className = 'offline glass';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) { e.target.textContent = 'Conectando…'; ping(); } });
  }
  el.innerHTML = kind === 'auth'
    ? `<div class="offline-ic">🔒</div><b>Se perdió el acceso</b><div class="note">Escanea otra vez el código QR desde la PC (Más → Celular) y vuelve a agregar la app a la pantalla de inicio.</div>`
    : `<div class="offline-ic"><span class="spinner"></span></div><b>Sin conexión con tu PC</b>
      <div class="note">Revisa que la PC esté encendida con <b>iniciar.bat</b> abierto y que tu iPhone esté en el mismo WiFi. Se reconecta solo.</div>
      <button class="btn small primary mt" data-retry>Reintentar ahora</button>`;
  el.classList.add('show');
  document.documentElement.classList.add('is-offline');
}
function hideOffline() {
  $('#offline')?.classList.remove('show');
  document.documentElement.classList.remove('is-offline');
  const t = document.createElement('div');
  t.className = 'toast glass'; t.textContent = '✓ Conectado con tu PC';
  $('#toasts')?.appendChild(t); setTimeout(() => t.remove(), 2500);
}

// ---------- Al volver a abrir la app ----------
// iOS congela la app en segundo plano: al regresar se actualiza todo de inmediato.
function resumeRefresh() {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 20_000 && await ping()) opts.refresh();
  });
  // Al regresar con el gesto de "atrás" de iOS la página puede venir de la memoria.
  window.addEventListener('pageshow', (e) => { if (e.persisted) opts.refresh(); });
}

// ---------- Deslizar para actualizar ----------
function pullToRefresh() {
  const ind = document.createElement('div');
  ind.className = 'refresh-pull';
  ind.innerHTML = '<span class="arrow">↓</span>';
  document.body.appendChild(ind);
  let y0 = null, dy = 0, busy = false;
  const blocked = () => document.querySelector('.sheet.open, .notif-panel.open') || busy;
  window.addEventListener('touchstart', (e) => {
    if (blocked() || window.scrollY > 0 || e.touches.length !== 1) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (window.scrollY > 0) { y0 = null; dy = 0; }
    const d = Math.min(dy * 0.5, 90);
    ind.style.transform = `translate(-50%, ${d - 50}px) rotate(${dy > 140 ? 180 : 0}deg)`;
    ind.style.opacity = String(Math.min(1, dy / 100));
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (y0 == null) return;
    y0 = null;
    if (dy > 140) {
      busy = true; haptic();
      ind.classList.add('spin'); ind.innerHTML = '<span class="spinner"></span>';
      ind.style.transform = 'translate(-50%, 30px)'; ind.style.opacity = '1';
      try { await opts.refresh(); } catch {}
      busy = false;
    }
    ind.classList.remove('spin'); ind.innerHTML = '<span class="arrow">↓</span>';
    ind.style.transform = 'translate(-50%, -50px)'; ind.style.opacity = '0';
    dy = 0;
  });
}

// ---------- Guía para instalar la app (en Safari del iPhone) ----------
async function installHint() {
  // El enlace que guarda "Agregar a pantalla de inicio" lleva el código de acceso:
  // la app instalada no comparte la sesión de Safari y sin él pediría el QR de nuevo.
  try {
    const { token } = await (await fetch('/api/apptoken', { cache: 'no-store' })).json();
    if (token && !location.search.includes('t=')) history.replaceState(null, '', `/?t=${encodeURIComponent(token)}&app=1`);
  } catch {}
  let dismissed = false;
  try { dismissed = localStorage.getItem('bb-install-hint') === '1'; } catch {}
  if (dismissed) return;
  const el = document.createElement('div');
  el.className = 'install-hint glass';
  el.innerHTML = `<img src="/icons/icon-180.png" alt="" class="install-ic">
    <div class="grow"><b>Instala BetBot como app</b>
      <div class="note">Toca <span class="share-ic" aria-label="Compartir"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg></span> <b>Compartir</b> y luego <b>Agregar a pantalla de inicio</b>. Se abre en pantalla completa, con su icono.</div></div>
    <button class="close-x" aria-label="Cerrar">✕</button>`;
  el.querySelector('.close-x').addEventListener('click', () => { el.remove(); try { localStorage.setItem('bb-install-hint', '1'); } catch {} });
  document.body.appendChild(el);
}
