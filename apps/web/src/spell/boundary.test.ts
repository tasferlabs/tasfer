import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * apps/cli bundles `src/platform/engine.ts` and `src/lib/spaceExport.ts` for
 * Node. Nothing reachable from them may pull in the spell service layer (a
 * Worker, localStorage and React) or the spell package. This walks their
 * static import graph over relative and alias imports.
 */

const SRC = resolve(__dirname, "..");
const SHARED = resolve(__dirname, "../../../../shared");
const ROOTS = ["platform/engine.ts", "lib/spaceExport.ts"];
const FORBIDDEN = (spec: string) =>
  spec === "@tasfer/spell" ||
  spec.startsWith("@tasfer/spell/") ||
  spec === "@/spell" ||
  spec.startsWith("@/spell/");

const IMPORT_RE =
  /(?:^|[^\w$])(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiers(source: string): string[] {
  const out: string[] = [];
  // Strip block and line comments so commented-out imports do not count.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2]);
  return out;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = resolve(SRC, spec.slice(2));
  else if (spec.startsWith("@shared/")) base = resolve(SHARED, spec.slice(8));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // bare package import: checked by name only
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function walk(root: string): { files: Set<string>; violations: string[] } {
  const files = new Set<string>();
  const violations: string[] = [];
  const stack = [root];
  while (stack.length) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const spec of specifiers(source)) {
      if (FORBIDDEN(spec)) violations.push(`${file} imports ${spec}`);
      const next = resolveLocal(file, spec);
      if (next && /\.(ts|tsx)$/.test(next)) stack.push(next);
    }
  }
  return { files, violations };
}

describe("CLI-bundled modules stay clear of the spell layer", () => {
  for (const rootRel of ROOTS) {
    it(`${rootRel} does not reach @/spell or @tasfer/spell`, () => {
      const root = resolve(SRC, rootRel);
      expect(existsSync(root)).toBe(true);
      const { files, violations } = walk(root);
      expect(files.size).toBeGreaterThan(1);
      expect(violations).toEqual([]);
      for (const f of files)
        expect(f.startsWith(resolve(SRC, "spell"))).toBe(false);
    });
  }

  it("the scanner itself sees imports", () => {
    expect(
      specifiers(
        `import x from "./a";\nimport type { T } from "@/b";\nexport * from "../c";\nconst y = import("@/d");\n// import z from "./nope";\n`,
      ),
    ).toEqual(["./a", "@/b", "../c", "@/d"]);
  });
});
