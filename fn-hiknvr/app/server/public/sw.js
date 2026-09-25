/* 飞海监控 Service Worker —— 外壳走「网络优先、离线回退缓存」；API/直播/录像一律直连网络
   作用域自适应：既支持统一网关 /app/fn-hiknvr/ 也支持端口直连 / */
const CACHE = 'fh-shell-v40';
const BASE = self.registration.scope;            // 例如 https://host/app/fn-nvr/
const SCOPE_PATH = new URL(BASE).pathname;       // /app/fn-hiknvr/ 或 /
const SHELL = ['', 'index.html', 'settings.html', 'app.js', 'style.css', 'hls.min.js',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'manifest.webmanifest'].map(p => BASE + p);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  if (!u.pathname.startsWith(SCOPE_PATH)) return;
  const rel = u.pathname.slice(SCOPE_PATH.length);
  // 动态内容直连网络
  if (rel.startsWith('api/') || rel.startsWith('live/') || rel.startsWith('rec/')) return;
  // 外壳：网络优先（保证升级后立刻跑新版本），断网时回退缓存
  e.respondWith(
    fetch(req).then(resp => {
      if (resp && resp.ok) { const cp = resp.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
      return resp;
    }).catch(() => caches.match(req).then(hit => hit || caches.match(BASE + 'index.html')))
  );
});
