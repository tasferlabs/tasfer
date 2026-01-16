/// <reference lib="webworker" />
/// <reference types="@types/serviceworker" />
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  matchPrecache,
} from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import {
  CacheFirst,
  NetworkFirst,
  StaleWhileRevalidate,
} from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare let self: ServiceWorkerGlobalScope;

console.log("[SW] Service worker script loaded");

// Activate immediately on install, and cache index.html as a guaranteed fallback
self.addEventListener("install", (event) => {
  console.log("[SW] Installing...");
  event.waitUntil(
    (async () => {
      // Cache index.html with a known key for offline fallback
      const cache = await caches.open("offline-fallback");
      await cache.add(new Request("/index.html", { cache: "reload" }));
      console.log("[SW] Cached index.html for offline fallback");
      self.skipWaiting();
    })()
  );
});

// Claim clients immediately on activate
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating, claiming clients...");
  event.waitUntil(self.clients.claim());
});

// Precache static assets (injected by vite-plugin-pwa at build time)
// Must be called before matchPrecache can be used
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Handle navigation requests with offline fallback.
// This catches hard reloads where browser sends cache:'reload' mode.
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle navigation requests (HTML pages)
  if (request.mode !== "navigate") return;

  // Don't handle API routes
  if (new URL(request.url).pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      try {
        // Try network first
        const response = await fetch(request);
        return response;
      } catch {
        console.log("[SW] Network failed, serving cached index.html");

        // 1. Check our dedicated offline-fallback cache first
        const fallbackCache = await caches.open("offline-fallback");
        const fallback = await fallbackCache.match("/index.html");
        if (fallback) return fallback;

        // 2. Try Workbox's precache
        const precached = await matchPrecache("/index.html");
        if (precached) return precached;

        // 3. Search all caches manually
        const allCacheNames = await caches.keys();
        for (const cacheName of allCacheNames) {
          const cache = await caches.open(cacheName);
          const keys = await cache.keys();
          for (const key of keys) {
            if (key.url.includes("index.html")) {
              const match = await cache.match(key);
              if (match) return match;
            }
          }
        }

        // Last resort
        return new Response(
          "<!DOCTYPE html><html><body><h1>Offline</h1><p>Please reconnect.</p></body></html>",
          { headers: { "Content-Type": "text/html" } }
        );
      }
    })()
  );
});

// SPA navigation fallback for normal requests (handled by Workbox routing)
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//],
  })
);

// Cache page list with stale-while-revalidate
// Navigation should feel instant, but fresh data is preferred
registerRoute(
  ({ url }) => url.pathname === "/api/pages/list",
  new StaleWhileRevalidate({
    cacheName: "pages-list",
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 50,
        maxAgeSeconds: 86400, // 1 day
      }),
    ],
  })
);

// Cache individual pages with network-first
// Content should be fresh when online, cached when offline
registerRoute(
  ({ url }) => /^\/api\/pages\/[^/]+$/.test(url.pathname),
  new NetworkFirst({
    cacheName: "pages-data",
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 604800, // 7 days
      }),
    ],
    networkTimeoutSeconds: 3,
  })
);

// Cache images with cache-first (immutable by ID)
registerRoute(
  ({ url }) => /^\/api\/images\/[^/]+$/.test(url.pathname),
  new CacheFirst({
    cacheName: "images",
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 31536000, // 1 year
      }),
    ],
  })
);

// Cache locale files with stale-while-revalidate
// Translations should load instantly but update in background
registerRoute(
  ({ url }) => url.pathname.startsWith("/app/locales/"),
  new StaleWhileRevalidate({
    cacheName: "locales",
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 20,
        maxAgeSeconds: 2592000, // 30 days
      }),
    ],
  })
);

// Generate realistic API response for offline mutations
function generateSyntheticResponse(
  url: URL,
  method: string,
  body: Record<string, unknown>
): { success: boolean; data?: unknown; message?: string } {
  const pathname = url.pathname;

  // POST /api/pages/create
  if (pathname === "/api/pages/create" && method === "POST") {
    return {
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
    };
  }

  // PUT /api/pages/:id
  if (/^\/api\/pages\/[^/]+$/.test(pathname) && method === "PUT") {
    return {
      success: true,
      data: {
        id: pathname.split("/").pop(),
        ...body,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  // DELETE endpoints
  if (method === "DELETE") {
    return { success: true, message: "Deleted" };
  }

  // POST move/reorder
  if (/\/(move|reorder)$/.test(pathname) && method === "POST") {
    return { success: true, message: "OK" };
  }

  // Default fallback
  return { success: true };
}

// Helper to queue mutation and return synthetic response
async function queueMutationAndRespond(request: Request): Promise<Response> {
  try {
    const body = await request.clone().json();
    const url = new URL(request.url);

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

    // Return realistic 200 response so app doesn't know it's offline
    const responseBody = generateSyntheticResponse(url, request.method, body);
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Failed to queue mutation" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Handle offline mutations
// Queue PUT/POST/DELETE requests when offline or network fails
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept API mutation requests
  if (
    !url.pathname.startsWith("/api/") ||
    !["PUT", "POST", "DELETE"].includes(request.method)
  ) {
    return;
  }

  // Let Workbox handle GET requests
  if (request.method === "GET") {
    return;
  }

  // If definitely offline, queue immediately
  if (!navigator.onLine) {
    event.respondWith(queueMutationAndRespond(request));
    return;
  }

  // If online, try the network but fall back to queueing on failure
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request.clone());
        return response;
      } catch {
        // Network error - queue mutation for later
        return queueMutationAndRespond(request);
      }
    })()
  );
});
