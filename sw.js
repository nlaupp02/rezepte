// Offline-Speicher für die App selbst (nicht für die Rezepte, die hat Firestore).
// Eigene Dateien: Netz zuerst, aber höchstens 1,5 s warten, dann die gespeicherte Kopie (das Netz aktualisiert sie im Hintergrund).
// Firebase-Dateien (versionierte Adresse, ändern sich nie): aus dem Speicher, nur beim ersten Mal aus dem Netz.
// v3: Das Speichern der neuen Version wird jetzt immer zu Ende gebracht. Vorher hat das iPhone den Service Worker
// oft beendet, bevor die Kopie geschrieben war; bei langsamem Netz kam dann eine uralte Version (V34) aus dem Speicher.
const CACHE = "rezepte-app-v3";
const SHELL = ["./", "./manifest.webmanifest", "./icon-192.png?v=2", "./icon-180.png?v=2", "./icon-32.png?v=2"];
const NET_WAIT = 1500;

self.addEventListener("install", e => {
  // cache: "reload" = am Browser-Zwischenspeicher vorbei, damit wirklich die aktuelle Version gespeichert wird
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// Gleiche Version? GitHub Pages schickt ETag bzw. Last-Modified mit, das reicht zum Vergleichen
const stamp = r => r && (r.headers.get("etag") || r.headers.get("last-modified") || r.headers.get("content-length") || "");
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  const own = url.origin === self.location.origin;
  const firebase = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (!own && !firebase) return;
  if (firebase) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) e.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      return res;
    })());
    return;
  }
  const nav = req.mode === "navigate";
  const key = nav ? "./" : req;
  const saved = caches.open(CACHE).then(c => c.match(key)).catch(() => null);
  // Seite: beim Server nachfragen (kurze Antwort, wenn unverändert), statt bis zu 10 Min. eine Kopie aus dem Browser zu nehmen
  const net = nav ? fetch(req.url, { cache: "no-cache", credentials: "same-origin", redirect: "manual" }) : fetch(req);
  let servedStale = false;
  // Neue Version speichern und, wenn gerade die alte läuft, der App Bescheid sagen. waitUntil sofort, damit das iPhone den
  // Service Worker nicht beendet, bevor die Kopie geschrieben ist.
  const store = net.then(async res => {
    if (!res || !res.ok) return;
    const copy = res.clone();
    const old = await saved;
    await (await caches.open(CACHE)).put(key, copy);
    if (nav && servedStale && old && stamp(old) !== stamp(res)) {
      const cs = await self.clients.matchAll({ type: "window" });
      cs.forEach(c => c.postMessage({ type: "updated" }));
    }
  });
  e.waitUntil(store.catch(() => {}));
  e.respondWith((async () => {
    const hit = await saved;
    if (!hit) return net; // nichts gespeichert: aufs Netz warten
    const res = await Promise.race([net.catch(() => null), new Promise(r => setTimeout(() => r(null), NET_WAIT))]);
    if (res) return res;
    servedStale = true;
    return hit;
  })());
});
