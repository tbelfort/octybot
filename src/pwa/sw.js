const CACHE = "octybot-v19";

self.addEventListener("install", (e) => {
  // Skip pre-caching — always serve fresh from network
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Pure network — no cache fallback
  if (e.request.method !== "GET") return;
});
