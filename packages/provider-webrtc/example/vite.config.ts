import { resolve } from "node:path";
import { defineConfig } from "vite";

// All three @cypherkit packages ship raw TypeScript source — no build step. We
// alias each bare import to its package `src`, exactly like apps/web does.
export default defineConfig({
  resolve: {
    alias: {
      "@cypherkit/editor": resolve(__dirname, "../../editor/src"),
      "@cypherkit/provider-core": resolve(__dirname, "../../provider-core/src"),
      "@cypherkit/provider-webrtc": resolve(__dirname, "../src"),
    },
  },
  server: {
    port: 4300,
  },
});
