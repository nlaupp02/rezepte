// Offline-Speicher für die App selbst (nicht für die Rezepte, die hat Firestore).
// Immer zuerst das Netz, damit Updates sofort ankommen. Ohne Netz kommt die letzte Kopie.
const CACHE = "rezepte-app-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png?v=2", "./icon-180.png?v=2", "./icon-32.png?v=2"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  const own = url.origin === self.location.origin;
  const firebase = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (!own && !firebase) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) { try { const c = await caches.open(CACHE); await c.put(req, res.clone()); } catch (err) { /* egal */ } }
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === "navigate") { const idx = await caches.match("./index.html"); if (idx) return idx; }
      throw err;
    }
  })());
});
