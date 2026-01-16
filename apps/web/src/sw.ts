/// <reference lib="webworker" />
/// <reference types="@types/serviceworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import {
  CacheFirst,
  NetworkFirst,
  StaleWhileRevalidate,
} from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare let self: ServiceWorkerGlobalScope;

console.log("[SW] Service worker script loaded");

// Log when SW installs
self.addEventListener("install", () => {
  console.log("[SW] Installing...");
});

// Log when SW activates
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating, claiming clients...");
  event.waitUntil(self.clients.claim());
});

// Debug: Log ALL fetch events (first handler, runs before Workbox)
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  console.log("[SW] Fetch intercepted:", event.request.method, url.pathname);
});

// Precache static assets (injected by vite-plugin-pwa at build time)
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

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

// Listen for skip waiting message from client
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
