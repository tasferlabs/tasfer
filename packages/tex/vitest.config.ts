import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../../shared"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The generator writes a vendored source file; it's a tool, not a test.
    // Run it explicitly: `npx vitest run src/data/__gen__/generate.test.ts`.
    exclude: ["**/__gen__/**", "node_modules/**"],
  },
});
