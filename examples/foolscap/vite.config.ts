import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";

// The @tasfer/* packages are consumed as raw TypeScript source (no build
// step), exactly like apps/web. Their own transitive deps (defuddle, lowlight,
// katex) resolve from packages/*/node_modules via Vite's filesystem walk.
const repoRoot = resolve(__dirname, "../..");

export default defineConfig({
  plugins: [
    // @tasfer/tex is aliased to source, which includes the generated ESM data
    // blob fontMetricsData.js. Vite 8's Oxc transform (which plugin-react
    // widens to `.js`) tries to load a tsconfig for it and fails; it needs no
    // transform, so exclude it while keeping the default node_modules skip.
    react({ exclude: [/\/node_modules\//, /fontMetricsData\.js$/] }),
  ],
  resolve: {
    // The aliased @tasfer/* source declares react as a peer, so its bare
    // react/react-dom imports must resolve to this app's copy. Vite 8/Rolldown
    // needs this explicit; it also prevents a duplicate React.
    dedupe: ["react", "react-dom"],
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
