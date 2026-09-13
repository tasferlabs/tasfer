/**
 * Package boundary: everything under src/ imports the editor only through its
 * public root and never pulls in React. These modules run in a Web Worker and
 * in Node, so a DOM- or React-shaped dependency would be a bug.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Module specifiers from static and dynamic imports and re-exports. */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  const staticRe = /\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s*["']([^"']+)["']/g;
  const dynamicRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, bareRe, dynamicRe]) {
    for (const m of source.matchAll(re)) out.push(m[1]);
  }
  return out;
}

const editorSubpathPrefix = "@tasfer/editor/";
const reactNames = ["react", "react-dom"];

describe("package boundary", () => {
  const files = sourceFiles(srcDir);

  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file.slice(srcDir.length)} imports only the public editor root and no React`, () => {
      const specifiers = specifiersOf(readFileSync(file, "utf8"));
      for (const spec of specifiers) {
        expect(
          spec.startsWith(editorSubpathPrefix),
          `${spec} is an editor subpath`,
        ).toBe(false);
        const base = spec.split("/")[0];
        expect(reactNames.includes(base), `${spec} pulls in React`).toBe(false);
      }
    });
  }
});
