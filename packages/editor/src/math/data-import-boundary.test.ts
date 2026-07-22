/**
 * Worker-safety boundary of the `@tasfer/editor/math/data` entry.
 *
 * The data entry is imported by SharedWorker persistence, reducers, and
 * markdown tooling. Its documented promise: installing math's data facets
 * never constructs MathNode/MathMark and never imports math's interactive
 * stack — in particular the tree-selection bridge, whose `@tasfer/tex`
 * ROOT import drags the layout/paint engine into every worker bundle (only
 * `@tasfer/tex/data` is worker-safe).
 *
 * Nothing else enforces this — vitest stubs the DOM, so a creeping import
 * would fail no behavioral test. This walks the static RUNTIME import graph
 * from `math/data.ts` and asserts the interactive modules stay out.
 *
 * Deliberately NOT banned: the serialization core's own reach. `data.ts` uses
 * `codecs/inline`, and `loadPage`'s schema-optional default lazily resolves
 * the compatibility schema, whose module graph includes the built-in
 * node/mark classes. That chain predates math, is import-safe (no module-init
 * canvas access; instances are built lazily), and is shared by every consumer
 * of the serializers — it is not weight this entry adds.
 */

// Vitest executes this in Node, but the package's tsconfig deliberately has no
// Node type declarations (the library is host-independent), so the two Node
// builtins resolve untyped.
// @ts-expect-error -- no Node types in this browser-lib tsconfig
import { existsSync, readFileSync } from "node:fs";
// @ts-expect-error -- no Node types in this browser-lib tsconfig
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `__dirname` is CJS-only; derive this module's directory from its URL.
const HERE = decodeURIComponent(new URL(".", import.meta.url).pathname).replace(
  /\/$/,
  "",
);
const SRC_ROOT = resolve(HERE, "..");
const ENTRY = resolve(HERE, "data.ts");

/** Interactive math stack — must never enter the data entry's closure. */
const BANNED_MODULES = [
  "math/tree-selection.ts",
  "math/input-controller.ts",
  "math/input-rules.ts",
  "math/tree-state.ts",
  "math/inline-tree-state.ts",
  "math/content-selection.ts",
  "math-extension.ts",
  "nodes/MathNode.ts",
  "rendering/marks/MathMark.ts",
];

/**
 * Every RUNTIME import/export-from specifier in one module's source. The
 * package compiles with `verbatimModuleSyntax`, so exactly the statements
 * written as `import type` / `export type` are erased from the emitted
 * modules; every other import/export-from statement (including ones whose
 * braces carry inline `type` specifiers) survives as a runtime edge.
 */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const pattern =
    /(import|export)\s+(type\s)?[^"';]*?from\s*"([^"]+)"|import\s*"([^"]+)"/g;
  for (const match of source.matchAll(pattern)) {
    if (match[2]) continue; // `import type` / `export type` — erased at emit
    out.push(match[3] ?? match[4]);
  }
  return out;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, resolve(base, "index.ts")]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return null;
}

function walkClosure(entry: string): {
  files: string[];
  bareSpecifiers: Set<string>;
} {
  const visited = new Set<string>();
  const bareSpecifiers = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const spec of importSpecifiers(source)) {
      if (!spec.startsWith(".")) {
        bareSpecifiers.add(spec);
        continue;
      }
      const resolved = resolveRelative(file, spec);
      expect(
        resolved,
        `unresolvable import "${spec}" from ${relative(SRC_ROOT, file)}`,
      ).not.toBeNull();
      if (resolved) queue.push(resolved);
    }
  }
  return { files: [...visited], bareSpecifiers };
}

describe("math/data import boundary", () => {
  it("never reaches the interactive math stack or the tex root", () => {
    const { files, bareSpecifiers } = walkClosure(ENTRY);
    // Sanity: the walk actually traversed the data closure.
    expect(files.length).toBeGreaterThan(10);

    const banned = files
      .map((file) => relative(SRC_ROOT, file))
      .filter((file) => BANNED_MODULES.includes(file));
    expect(banned).toEqual([]);

    // The tex ROOT entry (and every other subpath — the package exposes a
    // "./*" wildcard export onto the same modules) pulls the layout/paint
    // engine into worker bundles; the data-only sub-entry is the ONLY tex
    // import allowed here.
    const texImports = [...bareSpecifiers].filter(
      (spec) => spec === "@tasfer/tex" || spec.startsWith("@tasfer/tex/"),
    );
    expect(texImports).toEqual(["@tasfer/tex/data"]);
  });
});
