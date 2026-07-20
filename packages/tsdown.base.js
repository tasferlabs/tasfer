/**
 * Shared build configuration for every `@tasfer/*` package.
 *
 * The packages all ship the same way: dual ESM + CJS with `.d.ts` types, built
 * with tsdown (Rolldown). We build in *unbundle* mode — one output file per
 * source file, preserving the directory structure — so each package's
 * deep-import surface (its `"./*"` subpath exports, e.g.
 * `@tasfer/editor/state-types`) keeps resolving after the build instead of
 * collapsing into a single bundle.
 *
 * Runtime dependencies and peer dependencies are externalized automatically by
 * tsdown (read from each package's package.json), so only the package's own
 * `src/` is emitted.
 *
 * Plain `.js` (not `.ts`) so tsdown's default config loader can import it
 * directly from each package's `tsdown.config.ts` without an extra loader flag.
 *
 * @typedef {object} LibOptions
 * @property {Record<string, string>} [alias] Extra alias entries. Used to inline
 *   repo-local source that is NOT a published package — e.g. editor maps
 *   `@shared` to the repo-root `shared/` folder so the invariant helper is
 *   bundled into its dist.
 * @property {string[]} [exclude] Extra entry globs (typically `"!…"` negations)
 *   appended to the defaults.
 * @property {string} [dtsTsconfig] Absolute path to an alternate tsconfig for
 *   declaration emit only. Packages that inline repo-root `shared/` source must
 *   point this at the repo-root `tsconfig.dts.json`: TypeScript 7's native
 *   compiler only emits declarations for files under the dts project's root
 *   directory, so the project must be rooted above `shared/`.
 *
 * @param {LibOptions} [opts]
 * @returns {import("tsdown").UserConfig}
 */
export function libConfig(opts = {}) {
  return {
    // One output per source file (unbundle) — keeps the "./*" deep-import
    // surface intact. Tests and generated/spike fixtures are never shipped.
    entry: [
      "src/**/*.ts",
      "src/**/*.tsx",
      "!src/**/*.test.ts",
      "!src/**/*.test.tsx",
      "!src/**/__fuzz__/**",
      "!src/**/__spike__/**",
      "!src/**/__gen__/**",
      ...(opts.exclude ?? []),
    ],
    format: ["esm", "cjs"],
    dts: opts.dtsTsconfig ? { tsconfig: opts.dtsTsconfig } : true,
    unbundle: true,
    clean: true,
    sourcemap: true,
    alias: opts.alias,
  };
}
