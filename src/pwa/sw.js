const CACHE = "octybot-v20";
const STATIC_ASSETS = ["/", "/index.html", "/style.css", "/app.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  // API calls: network-only (never cache)
  if (e.request.url.includes("/conversations") ||
      e.request.url.includes("/messages") ||
      e.request.url.includes("/settings") ||
      e.request.url.includes("/usage") ||
      e.request.url.includes("/projects") ||
      e.request.url.includes("/devices") ||
      e.request.url.includes("/memory") ||
      e.request.url.includes("/transcribe") ||
      e.request.url.includes("/tts")) {
    return;
  }

  // Static assets: network-first with cache fallback
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
