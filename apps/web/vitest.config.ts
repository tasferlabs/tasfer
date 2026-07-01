import { resolve } from "path";
import { defineConfig } from "vitest/config";

// Standalone vitest config so tests don't pull in the PWA/Tailwind plugins from
// vite.config.ts. Aliases mirror vite.config.ts's `resolve.alias` (using an
// absolute src path rather than the root-relative "/src" that config uses).
export default defineConfig({
  resolve: {
    alias: {
      "@cypherkit/editor": resolve(__dirname, "../../packages/editor/src"),
      "@cypherkit/tex": resolve(__dirname, "../../packages/tex/src"),
      "@cypherkit/react": resolve(__dirname, "../../packages/react/src"),
      "@cypherkit/provider-core": resolve(
        __dirname,
        "../../packages/provider-core/src",
      ),
      "@": resolve(__dirname, "src"),
      "@shared": resolve(__dirname, "../../shared"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
