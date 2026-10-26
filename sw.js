// Offline support: keep the app itself and its libraries; never cache AI or map requests.
const VERSION = "artmuse-v6";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/ai.js", "js/common.js", "js/gemini.js", "js/claude.js", "js/verify.js", "js/store.js", "js/ui.js", "js/sync.js", "js/places.js", "js/museums.js", "js/calendar.js", "js/bulk.js", "data/museums.json", "data/museums-wikidata.json", "data/exhibitions.json", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "vendor/anthropic-sdk.js", "vendor/firebase.js", "vendor/exifr-lite.umd.js", "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css"];
const CDN = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // network first, so updates arrive; cache when offline
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
  } else if (CDN.includes(url.hostname)) {
    // fonts never change: cache first
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
