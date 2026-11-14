import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import { WebSocketServer, type WebSocket } from "ws";

// The @tasfer/* packages are consumed as raw TypeScript source, like the other
// examples.
const repoRoot = resolve(__dirname, "../..");

// A relay for step 4, served by the dev server at ws://localhost:4030/relay.
// It follows the contract in packages/provider-relay/src/transport.ts: group
// sockets by the `room` query param, and forward every frame to everyone else
// in that room.
function localRelay(): Plugin {
  return {
    name: "first-editor-local-relay",
    configureServer(server) {
      const rooms = new Map<string, Set<WebSocket>>();
      const wss = new WebSocketServer({ noServer: true });

      server.httpServer?.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/relay")) return;
        const room = url.searchParams.get("room") ?? "";

        wss.handleUpgrade(req, socket, head, (ws) => {
          const peers = rooms.get(room) ?? new Set<WebSocket>();
          rooms.set(room, peers);
          peers.add(ws);

          ws.on("message", (data, isBinary) => {
            for (const peer of peers) {
              if (peer !== ws && peer.readyState === peer.OPEN) {
                peer.send(data, { binary: isBinary });
              }
            }
          });
          ws.on("close", () => {
            peers.delete(ws);
            if (peers.size === 0) rooms.delete(room);
          });
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react({ exclude: [/\/node_modules\//, /fontMetricsData\.js$/] }),
    localRelay(),
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@tasfer/editor": resolve(repoRoot, "packages/editor/src"),
      "@tasfer/tex": resolve(repoRoot, "packages/tex/src"),
      "@tasfer/react": resolve(repoRoot, "packages/react/src"),
      "@tasfer/provider-core": resolve(repoRoot, "packages/provider-core/src"),
      "@tasfer/provider-relay": resolve(repoRoot, "packages/provider-relay/src"),
      "@shared": resolve(repoRoot, "shared"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        react: resolve(__dirname, "react.html"),
      },
    },
  },
  server: {
    port: 4030,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
});
