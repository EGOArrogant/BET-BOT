// Service worker de BetBot MX (solo con dirección segura: Tailscale https://….ts.net o localhost).
// - Notificaciones push en la pantalla de bloqueo, aunque la app esté cerrada.
// - Si la PC está apagada: pantalla propia en lugar del error de Safari.
// - Siempre pide primero a la PC (red primero): las actualizaciones llegan al instante.
//   Lo guardado solo se usa cuando no hay conexión. Los datos (/api) nunca se guardan aquí.
const CACHE = 'betbot-1.9.0';
const PRECACHE = ['/offline.html', '/icons/icon-192.png', '/icons/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // La página: de la PC; si no responde, la pantalla "Tu PC no está disponible".
    // (502/503/504: la PC está encendida pero el bot cerrado; Tailscale responde por él.)
    const offline = async () => (await caches.match('/offline.html')) || Response.error();
    // Un reintento antes de rendirse: tras reiniciar el servidor la primera conexión puede fallar.
    e.respondWith(fetch(req).catch(() => fetch(req)).then((r) => (r.status >= 502 && r.status <= 504 ? offline() : r)).catch(offline));
    return;
  }
  // Archivos de la app (js, css, iconos): red primero, copia de respaldo para abrir sin conexión.
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error('sin conexión');
    }
  })());
});

// ---------- Notificaciones push ----------
const TITLES = {
  gold: '★ Oportunidad de oro',
  won: '✅ Apuesta ganada',
  lost: '❌ Apuesta perdida',
  void: '↩️ Apuesta anulada',
  bet: '🎫 Nueva apuesta del bot',
  smart: '🐋 Dinero inteligente',
  test: '🔔 BetBot MX',
  more: '🔔 BetBot MX',
};
const TAB = { gold: 'gold', won: 'bank', lost: 'bank', void: 'bank', bet: 'bank', smart: 'smart' };

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { msg: e.data ? e.data.text() : '' }; }
  const kind = d.kind === 'ai' ? 'smart' : d.kind;
  let title = TITLES[kind] || 'BetBot MX';
  let body = d.msg || '';
  // Cobro anticipado llega como ganada/perdida: se respeta el texto del bot.
  if (kind === 'won' && body.startsWith('💸')) title = '💸 Cobro anticipado';
  if (kind === 'test') body = '¡Listo! Así te llegarán los avisos del bot, aunque la app esté cerrada.';
  if (kind === 'more') body = `Y ${d.count} avisos más. Abre la app para verlos.`;
  // Quita el emoji del inicio si el título ya lo trae.
  body = body.replace(/^(✅ Ganada|❌ Perdida|↩️ Anulada|★|🐋)\s*:?\s*/u, '');
  const tab = TAB[kind] || 'home';
  e.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body, tag: kind === 'more' ? 'more' : `${kind}-${d.t || Date.now()}`,
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      data: { url: `/#${tab}` }, timestamp: d.t || Date.now(),
    });
    // Número en el icono de la app (iOS 16.4+): cuántos avisos sin abrir.
    try {
      const n = (await self.registration.getNotifications()).length;
      if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
    } catch {}
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === location.origin) {
        await c.focus();
        c.postMessage({ type: 'open', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
