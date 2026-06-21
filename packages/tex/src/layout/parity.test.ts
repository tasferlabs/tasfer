/**
 * Comprehensive cypher-tex ⇆ KaTeX rendering-parity matrix.
 *
 * `oracle.test.ts` grew construct-by-construct and checks each expression in a
 * single mode; `katex-compare.test.ts` drills into the big-operator family. This
 * file is the *breadth* counterpart: one entry per supported construct family
 * (every node type in `parse/ast.ts` and every command table in the parser),
 * each pinned to KaTeX's own computed tree — and, where it makes sense, in BOTH
 * display and text style, since fractions, scripts, big operators and delimiters
 * all lay out differently between the two.
 *
 * The vertical metrics (height/depth) are KaTeX's only numeric output — its tree
 * has no top-level `width` (horizontal layout is CSS), so width parity is pinned
 * separately in `katex-compare.test.ts`/`placement.test.ts` via render margins.
 * Here we additionally assert width is finite and positive across the matrix,
 * which is the cheap guard that catches a construct collapsing to nothing.
 *
 * A handful of constructs KaTeX renders by tiering glyphs or stretching SVG that
 * we approximate on canvas (stretchy accents, stretchy braces); those can't be
 * pinned to KaTeX numerically and live in the SANE block at the bottom with the
 * weaker contract (finite, positive, monotone-in-base-width) — the same split
 * `oracle.test.ts` already makes for `\widehat`.
 *
 * KaTeX is a devDependency used only by the tests, never at runtime.
 */
import katexDefault from "katex";
import { describe, expect, it } from "vitest";

import { layoutMath } from "../index";

const katex = katexDefault as unknown as {
  __renderToDomTree(
    expr: string,
    opts: { displayMode: boolean; throwOnError: boolean },
  ): { height: number; depth: number };
};

type Mode = "text" | "display";
const BOTH: Mode[] = ["text", "display"];

/** A construct family: a label plus the expressions and modes that exercise it. */
interface Family {
  readonly name: string;
  readonly exprs: readonly string[];
  /** Modes to check; defaults to both text and display. */
  readonly modes?: readonly Mode[];
  /**
   * Decimal places for the height/depth comparison (default 3 ≈ 0.0005 em). A
   * few deeply-nested constructs accumulate sub-0.005 (sub-pixel) rounding
   * against KaTeX's internal bookkeeping and are pinned at 2 places instead —
   * documented per family, never to paper over a real gap.
   */
  readonly digits?: number;
}

// Every supported construct, grouped by the AST node / parser table it drives.
// Kept exhaustive on purpose: when a node type or command table grows, its
// family here should grow with it so parity coverage never silently lags.
const FAMILIES: readonly Family[] = [
  {
    name: "atoms — letters, digits, punctuation",
    exprs: ["x", "Xy", "123", "a, b; c", "2x+1", "a < b > c", "f(x)=y"],
  },
  {
    name: "atoms — Greek",
    exprs: [
      "\\alpha\\beta\\gamma\\delta",
      "\\epsilon\\varepsilon\\theta\\vartheta",
      "\\lambda\\mu\\pi\\sigma\\phi\\varphi\\omega",
      "\\Gamma\\Delta\\Theta\\Lambda\\Sigma\\Phi\\Omega",
    ],
  },
  {
    name: "atoms — relations, binops, arrows",
    exprs: [
      "a \\le b \\ge c \\ne d",
      "a \\pm b \\mp c \\times d \\div e",
      "a \\cup b \\cap c \\subseteq d",
      "a \\to b \\rightarrow c \\Rightarrow d \\mapsto e",
      "a \\approx b \\equiv c \\sim d \\propto e",
      "\\forall x \\exists y \\in S",
    ],
  },
  {
    name: "atoms — dots",
    exprs: ["a + \\cdots + b", "1, \\ldots, n", "\\ddots", "a \\vdots b"],
  },
  {
    name: "supsub — scripts",
    exprs: [
      "x^2",
      "x_i",
      "x_i^2",
      "x^2_i",
      "a^{b^c}",
      "a_{b_c}",
      "x^{2n}_{i+1}",
      "{x^2}^3",
      "f''(x)",
      "x'",
    ],
  },
  {
    name: "frac — fraction family",
    exprs: [
      "\\frac{a}{b}",
      "\\frac{x+1}{y-2}",
      "\\frac{1}{1+\\frac{1}{2}}",
      "\\dfrac{a}{b}",
      "\\tfrac{a}{b}",
      "\\cfrac{a}{b}",
      "\\frac{a}{b}^2",
    ],
  },
  {
    name: "frac — binomials and infix",
    exprs: [
      "\\binom{n}{k}",
      "\\dbinom{n}{k}",
      "\\tbinom{n}{k}",
      "{n \\choose k}",
      "{a \\over b}",
      "{a \\atop b}",
      "{a \\brace b}",
      "{a \\brack b}",
    ],
  },
  {
    name: "sqrt — radicals",
    exprs: [
      "\\sqrt{x}",
      "\\sqrt{2}",
      "\\sqrt{x^2+y^2}",
      "\\sqrt{\\frac{a}{b}}",
      "\\sqrt[3]{x}",
      "\\sqrt[n]{x+1}",
      "\\sqrt{\\sqrt{x}}",
    ],
  },
  {
    name: "leftright — auto delimiters",
    exprs: [
      "\\left(\\frac{a}{b}\\right)",
      "\\left[\\frac{1}{2}\\right]",
      "\\left|x\\right|",
      "\\left\\{a\\right\\}",
      "\\left\\langle x \\right\\rangle",
      "\\left(\\frac{1}{1+\\frac{1}{2}}\\right)",
      "\\left.\\frac{a}{b}\\right|",
      "\\left\\lceil x \\right\\rceil",
      "\\left\\lfloor x \\right\\rfloor",
    ],
  },
  {
    name: "sizeddelim — manual sizing",
    exprs: [
      "\\bigl(x\\bigr)",
      "\\Big[y\\Big]",
      "\\biggl\\{z\\biggr\\}",
      "\\Bigg|w\\Bigg|",
      "\\bigm| a",
    ],
  },
  {
    name: "accent — non-stretchy",
    exprs: [
      "\\hat{x}",
      "\\bar{y}",
      "\\vec{v}",
      "\\dot{x}",
      "\\ddot{x}",
      "\\acute{a}",
      "\\grave{a}",
      "\\check{a}",
      "\\breve{a}",
      "\\tilde{n}",
      "\\mathring{a}",
    ],
  },
  {
    name: "overunder — rules",
    exprs: ["\\overline{x}", "\\overline{x+y}", "\\underline{x}", "\\underline{a+b}", "\\overline{\\frac{a}{b}}"],
  },
  {
    name: "array — matrices",
    exprs: [
      "\\begin{matrix}a&b\\\\c&d\\end{matrix}",
      "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
      "\\begin{bmatrix}1&0\\\\0&1\\end{bmatrix}",
      "\\begin{vmatrix}a&b\\\\c&d\\end{vmatrix}",
      "\\begin{Bmatrix}a&b\\\\c&d\\end{Bmatrix}",
      "\\begin{Vmatrix}a&b\\\\c&d\\end{Vmatrix}",
    ],
  },
  {
    name: "array — cases, aligned, array",
    exprs: [
      "\\begin{cases}a&x>0\\\\b&x<0\\end{cases}",
      "\\begin{aligned}a&=b\\\\c&=d\\end{aligned}",
      "\\begin{array}{lc}a&b\\\\c&d\\end{array}",
    ],
  },
  {
    name: "array — smallmatrix (script-style cells)",
    exprs: ["\\begin{smallmatrix}a&b\\\\c&d\\end{smallmatrix}"],
    modes: ["text"],
  },
  {
    name: "opname — named operators (side scripts)",
    exprs: [
      "\\sin x",
      "\\cos\\theta + \\tan\\theta",
      "\\log x + \\ln y",
      "\\exp(x)",
      "\\arcsin x",
      "\\operatorname{lcm}(a,b)",
    ],
  },
  {
    name: "opname — limit operators (stack in display)",
    exprs: [
      "\\lim_{x\\to 0} \\frac{\\sin x}{x}",
      "\\max_{i} a_i",
      "\\min_{j} b_j",
      "\\gcd(a,b)",
      "\\limsup_{n} x_n",
      "\\operatorname*{argmax}_{x} f(x)",
    ],
  },
  {
    name: "bigops — sums and products",
    exprs: [
      "\\sum_{i=1}^{n} i",
      "\\sum x_i",
      "\\prod_{k=1}^{m} a_k",
      "\\coprod_i X_i",
      "\\bigcup_{i} A_i",
      "\\bigcap_{i} A_i",
      "\\bigoplus_k V_k",
      "\\bigwedge_i p_i",
    ],
  },
  {
    name: "bigops — integral family",
    exprs: [
      "\\int_0^1 f",
      "\\int_{0}^{\\infty} e^{-x^2}\\, dx",
      "\\iint_D f",
      "\\iiint_V f",
      "\\oint_C \\mathbf{F}",
      "\\oiint_{\\partial V} \\mathbf{E}",
      "\\oiiint_S g",
    ],
  },
  {
    name: "mathfont — alphabets",
    exprs: [
      "\\mathrm{abc}",
      "\\mathbf{F}",
      "\\mathit{xy}",
      "\\mathbb{R} \\subseteq \\mathbb{C}",
      "\\mathcal{L}",
      "\\mathfrak{g}",
      "\\mathsf{xy}",
      "\\mathtt{z}",
      "\\mathscr{H}",
      "\\boldsymbol{\\alpha}",
    ],
  },
  {
    name: "text — text-mode runs",
    exprs: ["\\text{abc}", "\\text{a b}", "\\textbf{hi}", "\\textit{em}", "\\texttt{yz}", "\\textsf{ss}"],
  },
  {
    name: "mclass — atom-class overrides",
    exprs: ["a \\mathbin{\\star} b", "a \\mathrel{R} b", "\\mathop{X}_i", "a \\mathopen{|} b \\mathclose{|}", "\\mathinner{x}"],
  },
  {
    name: "stack — overset/underset/stackrel",
    exprs: ["\\overset{a}{b}", "\\underset{a}{b}", "\\stackrel{a}{=}", "\\overset{\\text{def}}{=}"],
  },
  {
    name: "boxed — framed",
    exprs: ["\\boxed{x}", "\\boxed{x+y}", "\\boxed{\\frac{a}{b}}"],
  },
  {
    name: "phantom — spacing tricks",
    exprs: ["\\phantom{xy}z", "\\vphantom{x}a", "\\hphantom{xy}z", "a\\smash{\\frac{b}{c}}d"],
  },
  {
    name: "style — explicit style switches",
    exprs: ["\\textstyle\\sum x", "\\displaystyle\\frac{a}{b}", "\\scriptstyle x", "\\scriptscriptstyle y"],
  },
  {
    name: "space — explicit spacing",
    exprs: ["a \\quad b", "a \\qquad b", "x \\, y \\; z", "x \\: y", "a \\! b", "a\\kern1em b", "a\\hspace{2em}b"],
  },
  {
    name: "not / mod / logic",
    exprs: ["a \\neq b", "x \\not= y", "a \\bmod b", "x \\pmod{n}", "a \\equiv b \\pmod{n}", "A \\iff B", "P \\implies Q"],
  },
  {
    name: "shortcuts — blackboard & aliases",
    // Only the shortcuts KaTeX also defines are pinned here; `\Q`/`\C` are engine
    // extensions KaTeX renders as errors, asserted separately below.
    exprs: ["\\N \\subseteq \\Z \\subseteq \\R", "\\R \\subset \\mathbb{C}", "x \\in \\emptyset", "a \\infty b"],
  },
  {
    name: "nesting — deep composition",
    exprs: [
      "\\left(\\frac{\\partial f}{\\partial x}\\right)^2",
      "e^{i\\pi} + 1 = 0",
      "\\sqrt{\\frac{1}{1+\\frac{1}{1+x}}}",
      "\\hat{\\vec{v}}",
    ],
  },
  {
    name: "nesting — scriptstyle radicals (pinned to 2 places)",
    // A radical whose radicand carries its own scripts, set in script style
    // (fraction num/den, a superscript), lands within ~0.0015 em (sub-pixel) of
    // KaTeX — the residual is KaTeX's internal surd `span.height` rounding, not a
    // layout disagreement, so these are pinned at 2 decimal places.
    exprs: [
      "\\frac{\\sqrt{a^2+b^2}}{\\sum_{i} x_i}",
      "x^{\\sqrt{a^2}}",
      "\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}",
    ],
    digits: 2,
  },
];

describe("construct parity — vertical metrics vs KaTeX", () => {
  for (const fam of FAMILIES) {
    describe(fam.name, () => {
      const digits = fam.digits ?? 3;
      for (const mode of fam.modes ?? BOTH) {
        const displayMode = mode === "display";
        for (const expr of fam.exprs) {
          it(`${mode === "display" ? "[display] " : ""}${expr}`, () => {
            const tree = katex.__renderToDomTree(expr, {
              displayMode,
              throwOnError: false,
            });
            const mine = layoutMath(expr, { fontSize: 1, displayMode });
            expect(mine.height).toBeCloseTo(tree.height, digits);
            expect(mine.depth).toBeCloseTo(tree.depth, digits);
          });
        }
      }
    });
  }
});

describe("construct parity — width is finite and positive", () => {
  // KaTeX exposes no top-level width, so this can't be pinned to it — but a
  // construct that collapses to zero (or NaN) width is a real bug a metric-only
  // oracle would miss. Every non-empty construct must advance the pen.
  for (const fam of FAMILIES) {
    for (const mode of fam.modes ?? BOTH) {
      const displayMode = mode === "display";
      for (const expr of fam.exprs) {
        it(`${mode === "display" ? "[display] " : ""}${expr}`, () => {
          const w = layoutMath(expr, { fontSize: 16, displayMode }).width;
          expect(Number.isFinite(w)).toBe(true);
          expect(w).toBeGreaterThan(0);
        });
      }
    }
  }
});

// KaTeX tiers glyph sizes / stretches SVG for these; we approximate on canvas,
// so they get the weaker render-sanely contract instead of a numeric pin.
describe("approximated constructs render sanely (not pinned to KaTeX)", () => {
  const SANE = ["\\widehat{x}", "\\widehat{abc}", "\\widetilde{x}", "\\overbrace{x+y}", "\\underbrace{a+b+c}"];
  for (const expr of SANE) {
    for (const mode of BOTH) {
      const displayMode = mode === "display";
      it(`${mode === "display" ? "[display] " : ""}${expr}`, () => {
        const m = layoutMath(expr, { fontSize: 16, displayMode });
        expect(Number.isFinite(m.height)).toBe(true);
        expect(m.height).toBeGreaterThan(0);
        expect(m.depth).toBeGreaterThanOrEqual(0);
        expect(m.width).toBeGreaterThan(0);
      });
    }
  }
  it("stretchy accent/brace grows with base width", () => {
    const narrowHat = layoutMath("\\widehat{x}", { fontSize: 16 });
    const wideHat = layoutMath("\\widehat{abcdef}", { fontSize: 16 });
    expect(wideHat.width).toBeGreaterThan(narrowHat.width);
    const narrowBrace = layoutMath("\\overbrace{x}", { fontSize: 16 });
    const wideBrace = layoutMath("\\overbrace{abcdef}", { fontSize: 16 });
    expect(wideBrace.width).toBeGreaterThan(narrowBrace.width);
  });
});

// Engine extensions KaTeX doesn't define (`\Q`, `\C` blackboard shortcuts). KaTeX
// renders these as red error nodes, so they can't be pinned to it — we only
// assert our superset renders them sanely as their blackboard letters.
describe("engine extensions beyond KaTeX render sanely", () => {
  for (const expr of ["\\Q", "\\C", "\\Q \\subset \\C"]) {
    it(expr, () => {
      const m = layoutMath(expr, { fontSize: 16 });
      expect(Number.isFinite(m.height)).toBe(true);
      expect(m.height).toBeGreaterThan(0);
      expect(m.width).toBeGreaterThan(0);
    });
  }
});
