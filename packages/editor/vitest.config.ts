import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Installs the minimal DOM stubs the editor's module-init code expects
    // (styles, canvas measurement, mathjax) before any test module loads.
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    // The convergence fuzz cases run hundreds of ops across several peers.
    testTimeout: 30_000,
  },
});
