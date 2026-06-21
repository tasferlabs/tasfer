/**
 * Numeric correctness oracle: our layout's height/depth must match KaTeX's own
 * computed tree for the same input, to within rounding. This pins the TeX
 * layout algorithms we ported (inter-atom spacing, Rule 18 super/subscripts,
 * Rule 15 fractions) against the reference implementation. KaTeX is a
 * devDependency used only here — never at runtime.
 */
import katexDefault from "katex";
import { describe, expect, it } from "vitest";

import { layoutMath } from "../index";

// `__renderToDomTree` is a KaTeX internal (not in its public types) that returns
// the built tree with numeric `height`/`depth` in em — exactly our oracle.
const katex = katexDefault as unknown as {
  __renderToDomTree(
    expr: string,
    opts: { displayMode: boolean; throwOnError: boolean },
  ): { height: number; depth: number };
};

const CORPUS = [
  "x",
  "x^2",
  "x_i",
  "x^2_i",
  "x_i^2",
  "a_i",
  "2x+1",
  "x^2+y^2",
  "\\alpha\\beta\\gamma",
  "\\frac{a}{b}",
  "\\frac{1}{2}",
  "\\frac{x+1}{y-2}",
  "a^{b^c}",
  "a_{b_c}",
  "x = \\frac{1}{1+x}",
  "1+2+3",
  "a < b",
  "\\frac{a+b}{c}^2",
  "p^2_3 + q",
  "\\alpha^2 + \\beta_i",
  // Phase 2: delimiters, radicals, accents.
  "\\left(\\frac{a}{b}\\right)",
  "\\left[\\frac{1}{2}\\right]",
  "\\left|x\\right|",
  "\\left\\{a\\right\\}",
  "\\left(\\frac{1}{1+\\frac{1}{2}}\\right)",
  "\\bigl(x\\bigr)",
  "\\Big[y\\Big]",
  "\\sqrt{x}",
  "\\sqrt{2}",
  "\\sqrt{x^2+y^2}",
  "\\sqrt{\\frac{a}{b}}",
  "\\hat{x}",
  "\\bar{y}",
  "1 + \\sqrt{2} \\times \\left(a+b\\right)",
  // Spacing commands.
  "a \\quad b",
  "x \\, y \\; z",
  // Phase 3: over/underline + bare braces (text style).
  "\\overline{x}",
  "\\overline{x+y}",
  "\\underline{x}",
  "\\underline{a+b}",
  "\\overline{\\frac{a}{b}}",
  "\\overbrace{x+y}",
  "\\underbrace{a+b+c}",
  // Named operators, font/alphabet commands, and \not.
  "\\sin x",
  "\\cos\\theta + \\tan\\theta",
  "\\log x + \\ln y",
  "\\lim_{x\\to 0} \\frac{\\sin x}{x}",
  "\\mathrm{abc}",
  "\\mathbf{F} = m\\mathbf{a}",
  "\\mathbb{R} \\subseteq \\mathbb{C}",
  "\\mathcal{L}",
  "\\mathsf{xy} + \\mathtt{z}",
  "a \\neq b",
  "x \\not= y",
  // Common-math tier: fraction family, text, atom-class, stacking, boxed,
  // phantom, style switches, modulo, dots, spacing — all pinned to KaTeX.
  "\\dfrac{a}{b}",
  "\\tfrac{x+1}{y}",
  "\\binom{n}{k}",
  "\\dbinom{n}{k}",
  "\\cfrac{a}{b}",
  "{n \\choose k}",
  "{a \\over b}",
  "{a \\atop b}",
  "\\text{abc}",
  "\\text{a b}",
  "\\textbf{hi} + \\texttt{yz}",
  "\\operatorname{lcm}(a,b)",
  "a + \\cdots + b",
  "a \\mathbin{\\star} b",
  "a \\bmod b",
  "x \\pmod{n}",
  "\\overset{a}{b}",
  "\\underset{a}{b}",
  "\\stackrel{a}{=}",
  "\\boxed{x}",
  "\\boxed{x+y}",
  "\\phantom{xy}z",
  "\\vphantom{x}a",
  "\\mathstrut a",
  "\\textstyle\\sum x",
  "\\scriptstyle x",
  "A \\iff B",
  "\\N \\subseteq \\R",
];

// Display-style cases (big-operator limits stack above/below).
const DISPLAY_CORPUS = [
  "\\sum_{i=1}^{n} i",
  "\\prod_{k}^{m}",
  "\\sum x_i",
  "\\sum_{i=1}^{n} \\frac{1}{i^2}",
  "\\bigcup_{i} A_i",
  // Phase 3: environments. Height/depth are pinned by the array strut model
  // (arstrut 0.7/0.3 × arraystretch × 12pt baselineskip, centered on the axis).
  "\\begin{matrix}x\\end{matrix}",
  "\\begin{matrix}a&b\\\\c&d\\end{matrix}",
  "\\begin{matrix}a\\\\b\\\\c\\end{matrix}",
  "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
  "\\begin{bmatrix}1&0\\\\0&1\\end{bmatrix}",
  "\\begin{vmatrix}a&b\\\\c&d\\end{vmatrix}",
  "\\begin{Bmatrix}a&b\\\\c&d\\end{Bmatrix}",
  "\\begin{Vmatrix}a&b\\\\c&d\\end{Vmatrix}",
  "\\begin{pmatrix}a\\\\b\\\\c\\end{pmatrix}",
  "\\begin{cases}a\\\\b\\end{cases}",
  "\\begin{cases}a&x>0\\\\b&x<0\\end{cases}",
  "\\begin{aligned}a&=b\\\\c&=d\\end{aligned}",
  "\\begin{aligned}a&=b\\\\c&=d\\\\e&=f\\end{aligned}",
  "\\begin{array}{lc}a&b\\\\c&d\\end{array}",
  // Limit-style operators stack their scripts in display.
  "\\lim_{x\\to 0} \\frac{\\sin x}{x}",
  "\\max_{i} a_i",
  "\\gcd(a,b)",
  "\\binom{n}{k}",
  "\\dbinom{n}{k}",
  "\\operatorname*{argmax}_{x} f(x)",
];

// Text-style environments (smallmatrix uses script-style cells).
const TEXT_ENV_CORPUS = ["\\begin{smallmatrix}a&b\\\\c&d\\end{smallmatrix}"];

describe("layout matches KaTeX vertical metrics", () => {
  for (const expr of CORPUS) {
    it(`${expr}`, () => {
      const tree = katex.__renderToDomTree(expr, {
        displayMode: false,
        throwOnError: false,
      });
      const mine = layoutMath(expr, { fontSize: 1 });
      expect(mine.height).toBeCloseTo(tree.height, 3);
      expect(mine.depth).toBeCloseTo(tree.depth, 3);
    });
  }

  for (const expr of DISPLAY_CORPUS) {
    it(`[display] ${expr}`, () => {
      const tree = katex.__renderToDomTree(expr, {
        displayMode: true,
        throwOnError: false,
      });
      const mine = layoutMath(expr, { fontSize: 1, displayMode: true });
      expect(mine.height).toBeCloseTo(tree.height, 3);
      expect(mine.depth).toBeCloseTo(tree.depth, 3);
    });
  }

  for (const expr of TEXT_ENV_CORPUS) {
    it(`${expr}`, () => {
      const tree = katex.__renderToDomTree(expr, {
        displayMode: false,
        throwOnError: false,
      });
      const mine = layoutMath(expr, { fontSize: 1 });
      expect(mine.height).toBeCloseTo(tree.height, 3);
      expect(mine.depth).toBeCloseTo(tree.depth, 3);
    });
  }
});

// Stretchy accents are approximated (KaTeX tiers them across glyph sizes); we
// don't pin them to KaTeX exactly, only assert they render finite, positive
// metrics that grow with the base width — the user-visible contract.
describe("stretchy accents render sanely", () => {
  for (const expr of ["\\widehat{x}", "\\widehat{abc}", "\\widetilde{x}", "\\widetilde{abcdef}"]) {
    it(`${expr}`, () => {
      const m = layoutMath(expr, { fontSize: 16 });
      expect(Number.isFinite(m.height)).toBe(true);
      expect(m.height).toBeGreaterThan(0);
      expect(m.width).toBeGreaterThan(0);
    });
  }
  it("wider base ⇒ taller hat", () => {
    const narrow = layoutMath("\\widehat{x}", { fontSize: 16 });
    const wide = layoutMath("\\widehat{abcdef}", { fontSize: 16 });
    expect(wide.height).toBeGreaterThan(narrow.height);
  });
});

// Labeled braces and an invalid/never-throw smoke net for the new constructs.
describe("Phase 3 constructs never throw", () => {
  for (const expr of [
    "\\overbrace{x}^{n}",
    "\\underbrace{x}_{k}",
    "\\begin{matrix}a&b\\\\c\\end{matrix}", // ragged
    "\\begin{cases}a", // missing \end
    "\\begin{array}{rl}1&2\\end{array}",
    "\\begin{matrix}\\end{matrix}", // empty
    "\\overline{}",
  ]) {
    it(`${expr}`, () => {
      expect(() => layoutMath(expr, { fontSize: 16, displayMode: true })).not.toThrow();
    });
  }
});
