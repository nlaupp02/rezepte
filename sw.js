// Offline-Speicher für die App selbst (nicht für die Rezepte, die hat Firestore).
// Eigene Dateien: Netz zuerst, aber höchstens 1,5 s warten, dann die gespeicherte Kopie (das Netz aktualisiert sie im Hintergrund).
// Firebase-Dateien (versionierte Adresse, ändern sich nie): aus dem Speicher, nur beim ersten Mal aus dem Netz.
const CACHE = "rezepte-app-v2";
const SHELL = ["./", "./manifest.webmanifest", "./icon-192.png?v=2", "./icon-180.png?v=2", "./icon-32.png?v=2"];
const NET_WAIT = 1500;

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
    const cache = await caches.open(CACHE);
    if (firebase) {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }
    const key = req.mode === "navigate" ? "./" : req;
    const hit = await cache.match(key);
    const hitCopy = hit && req.mode === "navigate" ? hit.clone() : null; // zum Vergleichen, bevor die Seite den Text verbraucht
    let servedStale = false;
    const net = fetch(req).then(async res => {
      if (res && res.ok) {
        // Neue Version angekommen, nachdem die gespeicherte schon läuft? Dann der App Bescheid sagen
        if (servedStale && hit && req.mode === "navigate") {
          try {
            const [a, b] = await Promise.all([hitCopy.text(), res.clone().text()]);
            if (a !== b) { await cache.put(key, res.clone()); const cs = await self.clients.matchAll({ type: "window" }); cs.forEach(c => c.postMessage({ type: "updated" })); return res; }
          } catch (err) { /* egal */ }
        }
        cache.put(key, res.clone()).catch(() => {});
      }
      return res;
    });
    if (!hit) { try { return await net; } catch (err) { throw err; } } // nichts gespeichert: aufs Netz warten
    const res = await Promise.race([net.catch(() => null), new Promise(r => setTimeout(() => r(null), NET_WAIT))]);
    if (res) return res;
    servedStale = true;
    e.waitUntil(net.catch(() => {})); // Netz läuft weiter und aktualisiert den Speicher
    return hit;
  })());
});
