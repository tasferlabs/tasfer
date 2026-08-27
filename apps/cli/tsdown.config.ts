import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsdown";

/**
 * The CLI is a bundle, not a library: it inlines the platform layer it shares
 * with the app (`apps/web/src/platform`) plus the `@tasfer/*` sources, so a
 * self-hoster installs one artifact with no workspace around it.
 *
 * The two native modules stay external in both builds — a prebuilt `.node` is
 * not something a bundler can inline. A source checkout resolves them from
 * apps/cli/node_modules; the release archive ships them beside the executable
 * (see `scripts/build-binary.mjs`), and `src/host/native.ts` is what finds
 * them either way.
 */
// The CLI ships at the app's version — see scripts/release/cli-version.mjs.
const { appVersion } = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../version.json"), "utf8"),
);

/** Loaded from the release archive's `node_modules`, never bundled. */
const NATIVE = [
  "better-sqlite3",
  "node-datachannel",
  "node-datachannel/polyfill",
];

const shared = {
  platform: "node" as const,
  target: "node22",
  dts: false,
  clean: true,
  sourcemap: true,
  // The one version the binary reports and updates against, from /version.json.
  define: {
    __TASFER_CLI_VERSION__: JSON.stringify(appVersion),
  },
  alias: {
    "@tasfer/editor": resolve(import.meta.dirname, "../../packages/editor/src"),
    "@tasfer/math": resolve(import.meta.dirname, "../../packages/math/src"),
    "@tasfer/code": resolve(import.meta.dirname, "../../packages/code/src"),
    "@tasfer/tex": resolve(import.meta.dirname, "../../packages/tex/src"),
    "@tasfer/provider-core": resolve(
      import.meta.dirname,
      "../../packages/provider-core/src",
    ),
    "@shared": resolve(import.meta.dirname, "../../shared"),
    "@": resolve(import.meta.dirname, "../web/src"),
  },
};

export default defineConfig([
  // Source runs and `npm link`: ESM, resolving its dependencies from
  // node_modules the ordinary way.
  {
    ...shared,
    entry: ["src/main.ts"],
    format: ["esm"],
    outDir: "dist",
    deps: { neverBundle: NATIVE },
    outputOptions: { banner: "#!/usr/bin/env node" },
  },
  // The release binary's input. Node's SEA embeds exactly one CommonJS script
  // and its `require` serves built-ins only, so everything but the two native
  // modules has to be inside this file.
  {
    ...shared,
    entry: ["src/main.ts"],
    format: ["cjs"],
    outDir: "dist-sea",
    deps: {
      neverBundle: NATIVE,
      alwaysBundle: [/^(?!better-sqlite3$|node-datachannel(\/|$))/],
    },
    outputOptions: { inlineDynamicImports: true },
  },
]);
