import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { libConfig } from "../tsdown.base.js";

const here = dirname(fileURLToPath(import.meta.url));

// `@shared/*` is repo-root shared source (not a published package), so it is
// inlined into this package's dist.
export default {
  ...libConfig({
    alias: {
      "@shared": resolve(here, "../../shared"),
    },
    dtsTsconfig: resolve(here, "../../tsconfig.dts.json"),
  }),
  hooks: {
    "build:done": writeDeprecatedDeclarations,
  },
};

/**
 * The deprecated entry points (`src/deprecated/*.ts`) put `@deprecated` on each
 * re-exported name, so an editor strikes through an import that still uses the
 * old path. The declaration bundler rewrites those files and drops the tags, so
 * their `.d.mts` / `.d.cts` are written from the source instead, with each
 * relative path pointed at the built declaration it re-exports.
 */
function writeDeprecatedDeclarations(): void {
  const srcDir = join(here, "src/deprecated");
  const outDir = join(here, "dist/deprecated");
  for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(srcDir, name), "utf8");
    for (const ext of ["mjs", "cjs"]) {
      const text = source.replace(/from "(\.[^"]+)"/g, (_, spec: string) => {
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
}
