/**
 * cypher-tex ⇆ KaTeX comparison suite for big operators and their scripts.
 *
 * `oracle.test.ts` pins general layout dimensions but historically skipped the
 * integral family entirely — which let a cluster of operator bugs ship: cyclic
 * integrals (`\oiint`/`\oiiint`) rendered as bare subscripts (the ∯/∰ glyphs
 * are absent from the fonts), the axis recentering leaked ~0.001em into bare
 * operator metrics, and the script stagger ignored the operator's italic. This
 * suite compares us to KaTeX across the *whole* operator family, on both axes:
 *
 *  - Vertical: height/depth against KaTeX's own computed tree (`__renderToDomTree`).
 *  - Horizontal: the sub/superscript stagger against the operator's italic
 *    correction — KaTeX renders that as `margin-right: italic` on the op glyph
 *    plus `margin-left: -italic` on the subscript, so the superscript sits one
 *    italic to the right of the subscript. The h/d oracle is blind to this.
 *
 * KaTeX is a devDependency used only by the tests, never at runtime.
 */
import katexDefault from "katex";
import { describe, expect, it } from "vitest";

import { layoutMath } from "../index";
import { parse } from "../parse/parser";
import { buildExpression } from "./build";
import { DISPLAY } from "../style";
import type { Box } from "./box";

const katex = katexDefault as unknown as {
  __renderToDomTree(
    expr: string,
    opts: { displayMode: boolean; throwOnError: boolean },
  ): { height: number; depth: number };
};

// Every built-in big operator, including the multi- and cyclic integrals whose
// glyphs the engine has to synthesize (∬/∭ + an overlaid oval for ∯/∰).
const OPERATORS = [
  "\\int", "\\iint", "\\iiint", "\\oint", "\\oiint", "\\oiiint",
  "\\sum", "\\prod", "\\coprod", "\\bigcup", "\\bigcap", "\\bigoplus", "\\bigwedge",
];

// Each operator is exercised bare and under the script shapes that stress the
// Rule-18 drops and the italic stagger.
const SCRIPTS = ["", "_a", "^b", "_a^b", "_{\\partial\\Omega}", "_{i=0}^{n}"];

const CORPUS = OPERATORS.flatMap((op) => SCRIPTS.map((s) => op + s)).concat([
  // The reported regressions, in their natural context.
  "\\int_{0}^{\\infty} e^{-x^2}\\, dx",
  "\\oint_{\\partial\\Omega} \\mathbf{F}\\cdot d\\mathbf{r}",
  "\\iint_{\\Omega} (\\nabla\\times\\mathbf{F})\\cdot d\\mathbf{A}",
  "\\oiint_{\\partial V} \\mathbf{E}\\cdot d\\mathbf{A}",
  "\\sum_{n=1}^{\\infty}\\frac{1}{n^2}",
]);

describe("operator layout matches KaTeX vertical metrics", () => {
  for (const dm of [true, false] as const) {
    for (const expr of CORPUS) {
      it(`${dm ? "[display] " : ""}${expr}`, () => {
        const tree = katex.__renderToDomTree(expr, {
          displayMode: dm,
          throwOnError: false,
        });
        const mine = layoutMath(expr, { fontSize: 1, displayMode: dm });
        expect(mine.height).toBeCloseTo(tree.height, 3);
        expect(mine.depth).toBeCloseTo(tree.depth, 3);
      });
    }
  }
});

/** The italic correction of `op`'s display glyph, read straight off the box. */
function opItalic(op: string): number {
  const root = parse(op);
  const nodes = root.type === "ord" ? root.body : [root];
  const box = buildExpression(nodes, DISPLAY) as Box;
  let italic = 0;
  const visit = (b: Box) => {
    if (b.type === "list") {
      if (b.italic) italic = b.italic;
      b.children.forEach((c) => visit(c.box));
    }
  };
  visit(box);
  return italic;
}

/** Absolute x of the first glyph matching `char` in a laid-out expression. */
function glyphX(expr: string, char: string, displayMode: boolean): number | null {
  const box = layoutMath(expr, { fontSize: 1, displayMode }).box;
  let found: number | null = null;
  const visit = (b: Box, x: number) => {
    if (found !== null) return;
    if (b.type === "glyph" && b.char === char) found = x;
    else if (b.type === "list") b.children.forEach((c) => visit(c.box, x + c.dx));
  };
  visit(box, 0);
  return found;
}

describe("operator scripts stagger by the italic, like KaTeX", () => {
  // KaTeX emits `margin-right: italic` on the op and `margin-left: -italic` on
  // the subscript, so sup.x − sub.x === italic. Integrals lean hard (italic ≈
  // 0.44); limit-style ops (\sum) barely lean (italic ≈ 0) and so don't stagger.
  const cases: [string, string, string, string][] = [
    // expr, sup char, sub char, op
    ["\\int_a^b", "b", "a", "\\int"],
    ["\\oint_a^b", "b", "a", "\\oint"],
    ["\\iint_a^b", "b", "a", "\\iint"],
    ["\\iiint_a^b", "b", "a", "\\iiint"],
    ["\\oiint_a^b", "b", "a", "\\oiint"],
  ];
  for (const [expr, sup, sub, op] of cases) {
    it(expr, () => {
      const italic = opItalic(op);
      expect(italic).toBeGreaterThan(0.3); // integrals genuinely lean
      const bx = glyphX(expr, sup, true)!;
      const ax = glyphX(expr, sub, true)!;
      expect(bx - ax).toBeCloseTo(italic, 3);
    });
  }
});

describe("multi-integral scripts clear the WHOLE operator", () => {
  // The stagger test above only pins the gap between the scripts, not their
  // absolute position — which is how a real bug shipped: KaTeX's fontMetricsData
  // lists ∬/∭ with a SINGLE integral's width, so the scripts landed in the
  // middle of the (two/three-sign) glyph instead of past its right edge. KaTeX
  // flows these by the glyph's true DOM advance; we pin the subscript to that
  // true advance per size, and assert it strictly grows as integral signs are
  // added (the guard that catches a regression back to the single-glyph width).
  const SUB_X_DISPLAY: Record<string, number> = {
    "\\int_a^b": 0.556, // Size2 ∫ advance
    "\\iint_a^b": 1.084, // ∬ — two signs
    "\\iiint_a^b": 1.592, // ∭ — three signs
    "\\oiint_a^b": 1.084, // cyclic double draws ∬ underneath
    "\\oiiint_a^b": 1.592, // cyclic triple draws ∭ underneath
  };
  for (const [expr, expected] of Object.entries(SUB_X_DISPLAY)) {
    it(`${expr} subscript sits at the operator's right edge`, () => {
      expect(glyphX(expr, "a", true)!).toBeCloseTo(expected, 2);
    });
  }

  it("subscript x grows monotonically ∫ < ∬ < ∭", () => {
    const one = glyphX("\\int_a^b", "a", true)!;
    const two = glyphX("\\iint_a^b", "a", true)!;
    const three = glyphX("\\iiint_a^b", "a", true)!;
    expect(two).toBeGreaterThan(one + 0.3);
    expect(three).toBeGreaterThan(two + 0.3);
  });
});
