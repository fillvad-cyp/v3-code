// Minimal security-first Service Worker for Home Screen Web App installability.
// Invariant: NEVER cache authenticated API, WebSocket, OAuth, or pairing responses.
const STATIC_CACHE = "v3code-shell-v1";
const PUBLIC_SHELL_ASSETS = [
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/icon-192x192.png",
  "/icon-512x512.png",
  "/favicon.ico",
];

const BYPASS_PREFIXES = ["/api/", "/ws", "/oauth/", "/.well-known/", "/pair", "/connect"];

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0B0F14" />
  <title>V3 Code — Offline</title>
  <style>
    :root { color-scheme: dark light; }
    body {
      margin: 0;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #0B0F14;
      color: #F8FAFC;
    }
    .card {
      max-width: 360px;
      width: 100%;
      padding: 24px;
      border-radius: 18px;
      background: #111827;
      border: 1px solid #1E293B;
      text-align: center;
    }
    h1 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0 0 18px; font-size: 14px; line-height: 1.5; color: #94A3B8; }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      background: #34D399;
      color: #06281E;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>V3 Code server unreachable</h1>
    <p>Check that your V3 Code host is online and your device is on the same Wi-Fi or Tailscale network.</p>
    <button type="button" onclick="location.reload()">Retry connection</button>
  </main>
</body>
</html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PUBLIC_SHELL_ASSETS))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(OFFLINE_HTML, {
            status: 503,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          }),
      ),
    );
    return;
  }

  if (PUBLIC_SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached ?? Response.error())),
    );
  }
});
