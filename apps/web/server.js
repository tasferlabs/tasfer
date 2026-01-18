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

// Basic auth (enabled when AUTH_USER and AUTH_PASS are set)
// PWA assets are excluded so the app can be installed without auth
const publicAssets = ["/manifest.json", "/favicon.png", "/icon-192.png", "/icon-512.png"];
if (process.env.AUTH_USER && process.env.AUTH_PASS) {
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

// Proxy API requests
const apiProxy = createProxyMiddleware({
  target: API_URL,
  changeOrigin: true,
  pathFilter: "/api",
  logger: console,
});
app.use(apiProxy);

// Create WebSocket proxy
const wsProxy = createProxyMiddleware({
  target: LIVE_URL,
  changeOrigin: true,
  ws: true,
});
app.use("/ws", wsProxy);

// Serve static files from dist
app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback - serve index.html for all other routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`API proxy: ${API_URL}`);
  console.log(`Live proxy: ${LIVE_URL}`);
});

// Handle WebSocket upgrade requests
server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/ws")) {
    wsProxy.upgrade?.(req, socket, head);
  }
});
