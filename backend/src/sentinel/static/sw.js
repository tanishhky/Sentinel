// Minimal passthrough service worker — required for PWA installability.
// No caching: every request hits the network so the dashboard always shows live data.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
