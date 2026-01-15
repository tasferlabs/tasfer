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

// Helper to queue mutation and return synthetic response
async function queueMutationAndRespond(request: Request): Promise<Response> {
  try {
    // Clone request to read body
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

    // Return synthetic success response
    return new Response(
      JSON.stringify({
        success: true,
        queued: true,
        message: "Queued for sync when online",
      }),
      {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch {
    // If we can't read the body, return an error
    return new Response(
      JSON.stringify({
        success: false,
        error: "Failed to queue mutation",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
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

// Claim clients on activation
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
