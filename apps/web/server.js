import express from "express";
import basicAuth from "express-basic-auth";
import { createProxyMiddleware } from "http-proxy-middleware";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 4000;
const API_URL = process.env.API_URL || "http://localhost:3000";
const LIVE_URL = process.env.LIVE_URL || "http://localhost:8080";

// In production with Traefik, skip auth and proxy (Traefik handles routing)
const USE_PROXY = process.env.USE_PROXY !== "false";

// Health check endpoint (for Traefik/Swarm)
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Basic auth (only for local dev without Traefik)
// PWA assets are excluded so the app can be installed without auth
const publicAssets = ["/manifest.json", "/favicon.png", "/icon-192.png", "/icon-512.png", "/health"];
if (USE_PROXY && process.env.AUTH_USER && process.env.AUTH_PASS) {
  const auth = basicAuth({
    users: { [process.env.AUTH_USER]: process.env.AUTH_PASS },
    challenge: true,
    realm: "Cypher",
  });
  app.use((req, res, next) => {
    if (publicAssets.includes(req.path)) return next();
    auth(req, res, next);
  });
}

// Proxy setup (only for local dev without Traefik)
let apiProxy, wsProxy;
if (USE_PROXY) {
  // Proxy API requests
  apiProxy = createProxyMiddleware({
    target: API_URL,
    changeOrigin: true,
    pathFilter: "/api",
    logger: console,
  });
  app.use(apiProxy);

  // Create WebSocket proxy
  wsProxy = createProxyMiddleware({
    target: LIVE_URL,
    changeOrigin: true,
    ws: true,
  });
  app.use("/ws", wsProxy);
}

// Serve static files from dist
app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback - serve index.html for navigation requests only
// Don't serve index.html for asset requests (they should 404 if not found)
app.use((req, res) => {
  // Check if this looks like a static asset request
  const isAssetRequest = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json)$/i.test(req.path);

  if (isAssetRequest) {
    // Asset not found - return 404 instead of index.html
    res.status(404).send('Not found');
    return;
  }

  // Navigation request - serve index.html for SPA routing
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (USE_PROXY) {
    console.log(`API proxy: ${API_URL}`);
    console.log(`Live proxy: ${LIVE_URL}`);
  } else {
    console.log(`Proxy disabled (Traefik mode)`);
  }
});

// Handle WebSocket upgrade requests (only for local dev)
if (USE_PROXY && wsProxy) {
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/ws")) {
      wsProxy.upgrade?.(req, socket, head);
    }
  });
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[web] Received SIGTERM, shutting down...");
  server.close(() => {
    console.log("[web] Server closed");
    process.exit(0);
  });
});
