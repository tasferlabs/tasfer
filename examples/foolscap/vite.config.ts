import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";

// The @tasfer/* packages are consumed as raw TypeScript source (no build
// step), exactly like apps/web. Their own transitive deps (defuddle, lowlight,
// katex) resolve from packages/*/node_modules via Vite's filesystem walk.
const repoRoot = resolve(__dirname, "../..");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@tasfer/editor": resolve(repoRoot, "packages/editor/src"),
      "@tasfer/tex": resolve(repoRoot, "packages/tex/src"),
      "@tasfer/react": resolve(repoRoot, "packages/react/src"),
      // editor's source imports the repo-root shared invariant helper.
      "@shared": resolve(repoRoot, "shared"),
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 4010,
    // Allow Vite to serve the aliased package source (and its node_modules)
    // from outside this app's root.
    fs: { allow: [repoRoot] },
  },
});
