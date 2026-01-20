/// <reference lib="webworker" />
/// <reference types="@types/serviceworker" />
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  matchPrecache,
} from "workbox-precaching";
import { Router } from "./sw-router";

declare let self: ServiceWorkerGlobalScope;

// Initialize router
const app = new Router();

// Register fetch event handler
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const pathname = url.pathname;

  // Don't intercept static assets - let Workbox's precacheAndRoute handle them
  // This ensures precached assets are served from cache during app updates,
  // preventing 404 errors when old files are deleted from the server
  if (
    url.origin === self.location.origin &&
    !pathname.startsWith("/api/") &&
    event.request.mode !== "navigate"
  ) {
    return; // Don't call respondWith - let Workbox handle it
  }

  event.respondWith(
    (async () => {
      const response = await app.handleRequest(event.request);
      if (response) return response;
      // No route matched, pass through to network
      return authFetch(event.request);
    })()
  );
});

console.log("[SW] Service worker script loaded");

// On install, clear stale offline-fallback and cache fresh index.html
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      console.log("[SW] Installing new version");

      // Clear old offline-fallback cache (may have stale index.html with old asset hashes)
      // Keep pages-list and pages-data - user data shouldn't be cleared on app updates
      await caches.delete("offline-fallback");

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

// Helper to clean up caches when a page is deleted
async function cleanupPageCaches(pageId: string): Promise<void> {
  // Delete from pages-data cache
  const pagesDataCache = await caches.open("pages-data");
  await pagesDataCache.delete(`/api/pages/${pageId}`);

  // Clear pages-list cache (forces fresh fetch on next request)
  const pagesListCache = await caches.open("pages-list");
  const keys = await pagesListCache.keys();
  for (const key of keys) {
    await pagesListCache.delete(key);
  }

  // Notify client to clean up IndexedDB and native storage
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach((client) => {
    client.postMessage({
      type: "PAGE_DELETED",
      pageId,
    });
  });
}

// Helper to queue mutation and return synthetic response
async function queueMutation(request: Request) {
  const body = await request.clone().json();

  // Send message to client to queue mutation
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach((client) => {
    client.postMessage({
      type: "QUEUE_MUTATION",
      payload: {
        url: request.url,
        method: request.method,
        body,
      },
    });
  });
}

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
  <title>Cypher - Offline</title>
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

// ============================================================
// Routes
// ============================================================

// Cache page list with network-first
// Fresh data when online, cached data when offline
app.get("/api/pages/list", async (req, res) => {
  const cache = await caches.open("pages-list");
  const request = req._request;

  try {
    // Try network first for fresh data
    const response = await authFetch(request.clone());

    if (response.ok) {
      // Cache successful response
      await cache.put(request, response.clone());
    }

    return res.send(response);
  } catch {
    // Offline - serve from cache
    const cached = await cache.match(request);
    if (cached) return res.send(cached);

    // No cache, return offline error
    return res.json({ success: false }, { status: 503 });
  }
});

// Cache individual pages with network-first and 404 cache cleanup
// Content should be fresh when online, cached when offline
app.get("/api/pages/{id}", async (req, res) => {
  const cache = await caches.open("pages-data");
  const request = req._request;
  const pageId = req.params.id;

  try {
    const response = await authFetch(request.clone());

    if (response.status === 404 && pageId) {
      // Page was deleted - clean up caches
      await cleanupPageCaches(pageId);
      return res.send(response);
    }

    if (response.ok) {
      // Cache successful response
      await cache.put(request, response.clone());
    }

    return res.send(response);
  } catch {
    // Offline - serve from cache
    const cached = await cache.match(request);
    if (cached) return res.send(cached);

    // No cache, return offline error
    return res.json({ success: false }, { status: 503 });
  }
});

// Cache images with cache-first (immutable by ID)
app.get("/api/images/{id}", async (req, res) => {
  const cache = await caches.open("images");
  const request = req._request;

  // Check cache first
  const cached = await cache.match(request);
  if (cached) {
    return res.send(cached);
  }

  // Not in cache, fetch from network
  try {
    const response = await authFetch(request.clone());
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return res.send(response);
  } catch {
    return res.json({ success: false }, { status: 503 });
  }
});

// Handle page mutations (PUT)
app.put("/api/pages/{id}", async (req, res) => {
  const request = req._request;

  // If definitely offline, queue immediately
  if (!navigator.onLine) {
    await queueMutation(request);
    return res.json({ success: true });
  }

  // If online, try the network but fall back to queueing on failure
  try {
    const response = await authFetch(request.clone());
    return res.send(response);
  } catch {
    // Network error - queue mutation for later
    await queueMutation(request);
    return res.json({ success: true });
  }
});

// Handle page deletion
app.delete("/api/pages/{id}", async (req, res) => {
  const request = req._request;
  const pageId = req.params.id;

  // If definitely offline, queue immediately
  if (!navigator.onLine) {
    await queueMutation(request);
    await cleanupPageCaches(pageId);
    return res.json({ success: true });
  }

  // If online, try the network but fall back to queueing on failure
  try {
    const response = await authFetch(request.clone());
    // Clean up caches on successful delete OR 404 (already deleted)
    if (response.ok || response.status === 404) {
      await cleanupPageCaches(pageId);
    }
    return res.send(response);
  } catch {
    // Network error - queue mutation for later
    await queueMutation(request);
    await cleanupPageCaches(pageId);
    return res.json({ success: true });
  }
});

// Handle page creation
app.post("/api/pages/create", async (req, res) => {
  const request = req._request;

  // If online, try the network but fall back to queueing on failure
  try {
    const response = await authFetch(request.clone());
    return res.send(response);
  } catch {
    await queueMutation(request);
    const body = await request.clone().json();
    return res.json({
      success: true,
      data: {
        id: body.id || crypto.randomUUID(),
        title: body.title || "",
        autoTitle: body.autoTitle ?? true,
        parentId: body.parentId ?? null,
        order: body.order ?? 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  }
});

// Handle move/reorder operations
app.post("/api/pages/{id}/move", async (req, res) => {
  const request = req._request;

  // If online, try the network but fall back to queueing on failure
  try {
    const response = await authFetch(request.clone());
    return res.send(response);
  } catch {
    await queueMutation(request);
    return res.json({ success: true });
  }
});

app.post("/api/pages/{id}/reorder", async (req, res) => {
  const request = req._request;

  // If online, try the network but fall back to queueing on failure
  try {
    const response = await authFetch(request.clone());
    return res.send(response);
  } catch {
    await queueMutation(request);
    return res.json({ success: true });
  }
});

// Catch-all for other API mutations (POST/PUT/DELETE)
app.post("/api/{path+}", async (req, res) => {
  const request = req._request;

  try {
    return res.send(await authFetch(request.clone()));
  } catch {
    await queueMutation(request);
    return res.json({ success: true });
  }
});

app.put("/api/{path+}", async (req, res) => {
  const request = req._request;

  try {
    return res.send(await authFetch(request.clone()));
  } catch {
    await queueMutation(request);
    return res.json({ success: true });
  }
});

app.delete("/api/{path+}", async (req, res) => {
  const request = req._request;

  try {
    return res.send(await authFetch(request.clone()));
  } catch {
    await queueMutation(request);
    return res.json({ success: true });
  }
});

// Pass through other API GET requests to network
app.get("/api/{path+}", async (req, res) => {
  try {
    return res.send(await authFetch(req._request.clone()));
  } catch {
    return res.json({ success: false }, { status: 503 });
  }
});

// Navigation handler - catch-all for non-API requests
// This handles SPA navigation with offline fallback
app.get("*", async (req, res) => {
  const request = req._request;

  // Only handle navigation requests (HTML pages)
  if (request.mode !== "navigate") {
    // Let it pass through to network
    return res.fetch(request);
  }

  const pathname = new URL(request.url).pathname;
  // Don't handle API routes (already handled above, but just in case)
  if (pathname.startsWith("/api/")) {
    return res.fetch(request);
  }

  // Network-first for navigation to ensure fresh index.html with correct asset hashes
  // Falls back to cached index.html on any network failure for offline support
  // The recovery script in index.html handles stale cached assets
  try {
    const response = await authFetch(request.clone());
    if (response.ok) {
      // Update the offline fallback cache with fresh index.html
      const cache = await caches.open("offline-fallback");
      await cache.put("/index.html", response.clone());
      return res.send(response);
    }
    // Non-OK response (4xx, 5xx) - still return it so browser/recovery can handle
    return res.send(response);
  } catch {
    // Network failed - serve cached index.html for offline support
    // If cached assets are stale, the recovery script in index.html will handle it
    const cachedIndex = await getOfflineIndexHtml();
    return res.send(cachedIndex);
  }
});
