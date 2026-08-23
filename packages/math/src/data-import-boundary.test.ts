/**
 * Worker-safety boundary of the `@tasfer/math/data` entry.
 *
 * The data entry is imported by SharedWorker persistence, reducers, and
 * markdown tooling. Its documented promise: installing math's data facets
 * never constructs MathNode/MathMark and never imports math's interactive
 * stack — in particular the tree-selection bridge, whose `@tasfer/tex`
 * ROOT import drags the layout/paint engine into every worker bundle (only
 * `@tasfer/tex/data` is worker-safe).
 *
 * Since math is its own package the walk stops at the `@tasfer/editor` edge,
 * so the engine modules it may reach are asserted by specifier instead.
 *
 * Nothing else enforces this — vitest stubs the DOM, so a creeping import
 * would fail no behavioral test. This walks the static RUNTIME import graph
 * from `math/data.ts` and asserts the interactive modules stay out.
 *
 * Deliberately NOT banned: the engine's own serialization reach. `data.ts` uses
 * `codecs/inline`, whose graph lazily resolves the compatibility schema and so
 * includes the built-in node/mark classes. That chain predates math, is
 * import-safe (no module-init canvas access; instances are built lazily), and
 * is shared by every consumer of the serializers — it is not weight this entry
 * adds. It sits behind the package edge now, so the walk never enters it.
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
const SRC_ROOT = HERE;
const ENTRY = resolve(HERE, "data.ts");

/** Interactive math stack — must never enter the data entry's closure. */
const BANNED_MODULES = [
  "tree-selection.ts",
  "input-controller.ts",
  "input-rules.ts",
  "tree-state.ts",
  "inline-tree-state.ts",
  "content-selection.ts",
  "math-extension.ts",
  "MathNode.ts",
  "MathMark.ts",
];

/**
 * Engine modules the data entry may reach. All are serialization or CRDT
 * plumbing; nothing here constructs a renderer or touches a canvas. Anything
 * outside this set (`rendering/*`, `actions/*`, `entries/*`, …) would drag the
 * interactive engine into a worker bundle.
 */
const ALLOWED_EDITOR_MODULES = [
  "@tasfer/editor/serlization/codecs/inline",
  "@tasfer/editor/serlization/tokenizer",
  "@tasfer/editor/sync/block-registry",
  "@tasfer/editor/sync/char-runs",
  "@tasfer/editor/sync/fractional-index",
  "@tasfer/editor/sync/id",
  "@tasfer/editor/sync/structured-content",
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
    // Sanity: the walk actually traversed the data closure rather than
    // stopping at the entry.
    expect(files.map((file) => relative(SRC_ROOT, file)).sort()).toEqual([
      "data.ts",
      "inline-structured.ts",
      "source.ts",
      "structured.ts",
      "tree-edit.ts",
    ]);

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

    const editorImports = [...bareSpecifiers]
      .filter((spec) => spec.startsWith("@tasfer/editor"))
      .sort();
    expect(editorImports).toEqual(ALLOWED_EDITOR_MODULES);
  });
});
