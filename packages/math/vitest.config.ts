import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The engine is a peer dependency; tests run against its source so this
      // package never needs a prior `npm run build` in the editor package.
      "@tasfer/editor": resolve(import.meta.dirname, "../editor/src"),
      "@tasfer/tex": resolve(import.meta.dirname, "../tex/src"),
      "@shared": resolve(import.meta.dirname, "../../shared"),
    },
  },
  test: {
    environment: "node",
    // The engine's module-init code expects minimal DOM stubs (styles, canvas
    // measurement) before any test module loads — the same setup the editor
    // package uses.
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    // The convergence fuzz cases run hundreds of ops across several peers.
    testTimeout: 30_000,
  },
});
