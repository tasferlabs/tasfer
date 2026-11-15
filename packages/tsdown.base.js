import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
    hooks: {
      "build:done": (ctx) =>
        writeDeprecatedDeclarations(ctx?.options?.cwd ?? process.cwd()),
    },
  };
}

/**
 * The deprecated re-export files (`src/deprecated/*.ts`) put `@deprecated` on
 * each name, so an editor strikes through an import that still uses it. The
 * declaration emit drops those tags, so their `.d.mts` / `.d.cts` are written
 * from the source instead, with each path pointed at the built declaration it
 * re-exports. A package without `src/deprecated` is left alone.
 *
 * @param {string} cwd The package directory.
 */
function writeDeprecatedDeclarations(cwd) {
  const srcDir = join(cwd, "src/deprecated");
  const outDir = join(cwd, "dist/deprecated");
  if (!existsSync(srcDir)) return;
  for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(srcDir, name), "utf8");
    for (const ext of ["mjs", "cjs"]) {
      const text = source.replace(/from "([^"]+)"/g, (whole, spec) => {
        // `@shared/*` is inlined into the package's own dist/shared/.
        if (spec.startsWith("@shared/")) {
          return `from "../shared/${spec.slice("@shared/".length)}.${ext}"`;
        }
        if (!spec.startsWith(".")) return whole;
        const target = resolve(srcDir, spec);
        const built = existsSync(target + ".ts")
          ? `${spec}.${ext}`
          : `${spec}/index.${ext}`;
        return `from "${built}"`;
      });
      writeFileSync(
        join(outDir, name.replace(/\.ts$/, `.d.${ext[0]}ts`)),
        text,
      );
    }
  }
  pointEntriesAtDeprecated(cwd, srcDir);
}

/**
 * An entry such as `src/index.ts` takes the old names in with
 * `export * from "./deprecated/root"`. Its emitted declaration lists every
 * name in one `export { … }` instead, pointing each old name at the module
 * that declares it, which carries no `@deprecated`. This takes those names out
 * of the list and puts the `export *` back, so they resolve through the
 * deprecated file and its tags.
 *
 * @param {string} cwd The package directory.
 * @param {string} srcDir The package's `src/deprecated` directory.
 */
function pointEntriesAtDeprecated(cwd, srcDir) {
  const src = join(cwd, "src");
  const star = /^export \* from "\.\/deprecated\/([\w-]+)";$/m;
  for (const file of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
    const match = star.exec(readFileSync(join(src, file), "utf8"));
    if (!match) continue;
    const names = deprecatedNames(srcDir, match[1]);
    for (const ext of ["mjs", "cjs"]) {
      const dts = join(cwd, "dist", file.replace(/\.ts$/, `.d.${ext[0]}ts`));
      if (!existsSync(dts)) continue;
      const reexport = `export * from "./deprecated/${match[1]}.${ext}";`;
      let text = readFileSync(dts, "utf8");
      if (text.includes(reexport)) continue;
      text = text.replace(/^export \{([^}]*)\};$/gm, (_, list) => {
        const kept = list
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .filter(
            (item) =>
              !names.has(
                item
                  .split(/\s+as\s+/)
                  .pop()
                  .replace(/^type\s+/, ""),
              ),
          );
        return `export { ${kept.join(", ")} };`;
      });
      writeFileSync(dts, `${text.trimEnd()}\n${reexport}\n`);
    }
  }
}

/**
 * Every name a deprecated file exports, following its own `export * from`.
 *
 * @param {string} srcDir The package's `src/deprecated` directory.
 * @param {string} name The file's name, without `.ts`.
 * @returns {Set<string>}
 */
function deprecatedNames(srcDir, name) {
  const source = readFileSync(join(srcDir, `${name}.ts`), "utf8").replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
    "",
  );
  const names = new Set();
  for (const [, list] of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const item of list.split(",")) {
      const id = item
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop();
      if (id) names.add(id);
    }
  }
  for (const [, id] of source.matchAll(
    /export\s+(?:type|interface|class|function|const)\s+(\w+)/g,
  )) {
    names.add(id);
  }
  for (const [, inner] of source.matchAll(/export \* from "\.\/([\w-]+)";/g)) {
    for (const id of deprecatedNames(srcDir, inner)) names.add(id);
  }
  return names;
}
