/// <reference lib="webworker" />
/// <reference types="@types/serviceworker" />
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  matchPrecache,
} from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope;

// Register fetch event handler
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Don't intercept cross-origin requests - let the browser handle them natively.
  // Third-party resources (CDN images, the signaling server's TURN credentials,
  // etc.) must load with their own CORS/credentials semantics. Re-fetching them
  // through the SW forces `credentials: "include"` (needed only for same-origin
  // basic auth), which any server responding `Access-Control-Allow-Origin: *`
  // rejects with net::ERR_FAILED - so e.g. remote images never load on the
  // native app, where the SW controls every request from a cold cache.
  if (url.origin !== self.location.origin) {
    return; // Don't call respondWith - native fetch keeps the right credentials mode
  }

  // Only intercept navigations. Static assets stay with Workbox's
  // precacheAndRoute (so precached files keep serving during app updates), and
  // everything else goes straight to the network - there is no server API; all
  // data lives in the local-first store.
  if (event.request.mode !== "navigate") {
    return;
  }

  event.respondWith(handleNavigation(event.request));
});

console.log("[SW] Service worker script loaded");

// On install, clear stale offline-fallback and cache fresh index.html
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      console.log("[SW] Installing new version");

      // Clear old offline-fallback cache (may have stale index.html with old asset hashes)
      await caches.delete("offline-fallback");

      // Drop server-era API caches. The centralized server is gone (P2P
      // local-first); pages and images now live in the local store, so these
      // caches are dead weight on old installs.
      await Promise.all(
        ["pages-list", "pages-data", "images"].map((name) => caches.delete(name))
      );

      // Cache fresh index.html for offline fallback
      const cache = await caches.open("offline-fallback");
      await cache.add(new Request("/index.html", { cache: "reload", credentials: "include" }));

      console.log("[SW] Install complete");
    })()
  );
});

// Claim clients immediately on activate
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle skip waiting message from client
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Precache static assets (injected by vite-plugin-pwa at build time)
// Must be called before matchPrecache can be used
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Helper to fetch with credentials (for basic auth support)
function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: "include" });
}

// Helper to get cached index.html for offline navigation
async function getOfflineIndexHtml(): Promise<Response> {
  // 1. Check our dedicated offline-fallback cache first
  const fallbackCache = await caches.open("offline-fallback");
  const fallback = await fallbackCache.match("/index.html");
  if (fallback) return fallback;

  // 2. Try Workbox's precache
  const precached = await matchPrecache("/index.html");
  if (precached) return precached;

  // Last resort - styled fallback matching recovery UI
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tasfer - Offline</title>
  <style>
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      font-family: system-ui, -apple-system, sans-serif;
      text-align: center;
      background: #fff;
      color: #09090b;
    }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
    p { font-size: 14px; margin: 0; opacity: 0.6; }
    @media (prefers-color-scheme: dark) {
      body { background: #09090b; color: #fafafa; }
    }
  </style>
</head>
<body>
  <h1>You're offline</h1>
  <p>Please reconnect to continue.</p>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

// SPA navigation - network-first to ensure fresh index.html with correct asset
// hashes, falling back to cached index.html on any network failure for offline
// support. The recovery script in index.html handles stale cached assets.
async function handleNavigation(request: Request): Promise<Response> {
  try {
    const response = await authFetch(request.clone());
    if (response.ok) {
      // Update the offline fallback cache with fresh index.html
      const cache = await caches.open("offline-fallback");
      await cache.put("/index.html", response.clone());
    }
    // Non-OK responses (4xx, 5xx) still return so browser/recovery can handle
    return response;
  } catch {
    return getOfflineIndexHtml();
  }
}
