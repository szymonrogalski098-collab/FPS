// Offline cache: app shell is pre-cached, CDN modules (three.js) and fonts are cached on first use.
const VERSION = 'greywater-v3';
const SHELL = [
  './', './index.html', './css/style.css', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './js/main.js', './js/game.js', './js/config.js', './js/util.js', './js/textures.js', './js/materials.js', './js/physics.js',
  './js/geometry.js', './js/builder.js', './js/props.js', './js/level.js', './js/sky.js', './js/renderer.js', './js/input.js',
  './js/player.js', './js/audio.js', './js/effects.js', './js/nav.js', './js/weaponModels.js', './js/viewmodel.js',
  './js/weapons.js', './js/enemyModel.js', './js/enemy.js', './js/hud.js',
  './js/mountain.js', './js/mountainLayout.js', './js/terrain.js', './js/natureTextures.js', './js/natureMaterials.js',
  './js/ballistics.js', './js/survival.js', './js/thermal.js', './js/helicopter.js', './js/vegetation.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const cdn = url.hostname.includes('jsdelivr.net') || url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com');
  if (url.origin === location.origin) {
    // network first so updates land quickly, cache as fallback for offline play
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
  } else if (cdn) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
      return res;
    })));
  }
});
