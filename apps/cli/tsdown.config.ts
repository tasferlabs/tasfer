import { resolve } from "node:path";
import { defineConfig } from "tsdown";

/**
 * The CLI is a bundle, not a library: it inlines the platform layer it shares
 * with the app (`apps/web/src/platform`) plus the `@tasfer/*` sources, so a
 * self-hoster installs one artifact with no workspace around it.
 *
 * Native and server-only dependencies stay external — `better-sqlite3` because
 * it is a prebuilt binary, `node-datachannel` because it is optional and must
 * fail at `import()` rather than at bundle time.
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  clean: true,
  sourcemap: true,
  deps: {
    neverBundle: [
      "better-sqlite3",
      "node-datachannel",
      "node-datachannel/polyfill",
    ],
  },
  alias: {
    "@tasfer/editor": resolve(import.meta.dirname, "../../packages/editor/src"),
    "@tasfer/tex": resolve(import.meta.dirname, "../../packages/tex/src"),
    "@tasfer/provider-core": resolve(
      import.meta.dirname,
      "../../packages/provider-core/src",
    ),
    "@shared": resolve(import.meta.dirname, "../../shared"),
    "@": resolve(import.meta.dirname, "../web/src"),
  },
  outputOptions: {
    // Entry only — a shared chunk is imported, never executed.
    banner: (chunk) => (chunk.isEntry ? "#!/usr/bin/env node" : ""),
  },
});
