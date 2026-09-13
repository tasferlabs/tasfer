import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The engine is a peer dependency; tests run against its source so this
      // package never needs a prior `npm run build` in the editor package.
      "@tasfer/editor": resolve(import.meta.dirname, "../editor/src"),
      "@shared": resolve(import.meta.dirname, "../../shared"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
