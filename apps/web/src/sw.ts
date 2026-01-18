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
  event.respondWith(
    (async () => {
      const response = await app.handleRequest(event.request);
      if (response) return response;
      // No route matched, pass through to network
      return fetch(event.request);
    })()
  );
});

console.log("[SW] Service worker script loaded");

// Activate immediately on install, and cache index.html as a guaranteed fallback
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // Cache index.html with a known key for offline fallback
      const cache = await caches.open("offline-fallback");
      await cache.add(new Request("/index.html", { cache: "reload" }));

      // self.skipWaiting();
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

// Helper to get cached index.html for offline navigation
async function getOfflineIndexHtml(): Promise<Response> {
  // 1. Check our dedicated offline-fallback cache first
  const fallbackCache = await caches.open("offline-fallback");
  const fallback = await fallbackCache.match("/index.html");
  if (fallback) return fallback;

  // 2. Try Workbox's precache
  const precached = await matchPrecache("/index.html");
  if (precached) return precached;

  // Last resort
  return new Response(
    "<!DOCTYPE html><html><body><h1>Offline</h1><p>Please reconnect.</p></body></html>",
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
    const response = await fetch(request.clone());

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
    const response = await fetch(request.clone());

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
    const response = await fetch(request.clone());
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
    const response = await fetch(request.clone());
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
    const response = await fetch(request.clone());
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
    const response = await fetch(request.clone());
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
    const response = await fetch(request.clone());
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
    const response = await fetch(request.clone());
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
    return res.send(await fetch(request.clone()));
  } catch {
    await queueMutation(request);
    return res.json({ success: true });
  }
});

app.put("/api/{path+}", async (req, res) => {
  const request = req._request;

  try {
    return res.send(await fetch(request.clone()));
  } catch {
    await queueMutation(request);
    return res.json({ success: true });
  }
});

app.delete("/api/{path+}", async (req, res) => {
  const request = req._request;

  try {
    return res.send(await fetch(request.clone()));
  } catch {
    await queueMutation(request);
    return res.json({ success: true });
  }
});

// Pass through other API GET requests to network
app.get("/api/{path+}", async (req, res) => {
  try {
    return res.send(await fetch(req._request.clone()));
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

  // For SPA navigation, use cache-first with network update
  // This ensures fast offline loading while keeping content fresh when online
  const cachedIndex = await getOfflineIndexHtml();

  return res.send(cachedIndex);
});
