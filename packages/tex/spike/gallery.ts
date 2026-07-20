/**
 * Shared content + layout + paint for the @tasfer/tex capability gallery.
 *
 * Platform-agnostic: it only ever touches a `CanvasRenderingContext2D`-shaped
 * object, so the same code drives both the browser demo (`main.ts`) and the
 * Node PNG generator (`render.ts`).
 */
import { layoutMath, paintMath } from "../src/index.ts";

interface Entry {
  /** LaTeX source. */
  tex: string;
  /** Render in display style (default) or inline text style. */
  inline?: boolean;
}

interface Section {
  title: string;
  blurb?: string;
  entries: Entry[];
}

export const SECTIONS: Section[] = [
  {
    title: "Atoms, symbols & Greek",
    blurb: "~2200 named symbols, math-italic letters, digits.",
    entries: [
      { tex: "f(x) = ax^2 + bx + c" },
      { tex: "\\alpha\\beta\\gamma\\delta\\epsilon\\zeta\\eta\\theta\\lambda\\mu\\pi\\sigma\\phi\\omega" },
      { tex: "\\Gamma\\Delta\\Theta\\Lambda\\Xi\\Pi\\Sigma\\Phi\\Psi\\Omega" },
      { tex: "\\forall x \\in \\mathbb{R} \\;\\; \\exists\\, \\varepsilon > 0" },
      { tex: "a \\leq b \\neq c \\geq d \\approx e \\equiv f \\sim g \\propto h" },
      { tex: "p \\Rightarrow q \\Leftrightarrow r \\to s \\mapsto t \\leftarrow u" },
      { tex: "A \\cup B \\cap C \\subseteq D \\supset E \\setminus F \\oplus G \\otimes H" },
    ],
  },
  {
    title: "Inter-atom spacing & spacing commands",
    blurb: "Binary / relation / operator spacing + \\quad \\, \\; etc.",
    entries: [
      { tex: "a+b-c \\times d \\div e \\cdot f \\pm g \\mp h" },
      { tex: "x \\quad y \\qquad z \\, w \\; v \\: u \\! t" },
      { tex: "\\sin\\theta \\cos\\theta \\tan\\theta \\log x \\ln y \\exp z \\gcd(a,b)" },
    ],
  },
  {
    title: "Super- & subscripts",
    blurb: "TeXbook Rule 18 — dual-script clamp and arbitrary nesting.",
    entries: [
      { tex: "x^2 \\quad x_i \\quad x_i^2 \\quad x^{2^{2^{2}}}" },
      { tex: "a_{i,j}^{(k)} + b_{n+1}^{m-1}" },
      { tex: "e^{i\\pi} + 1 = 0" },
      { tex: "{}^{14}_{6}\\mathrm{C} \\qquad \\sum_{k=0}^{n} k = \\frac{n(n+1)}{2}", inline: true },
    ],
  },
  {
    title: "Fractions & the style cascade",
    blurb: "\\frac (Rule 15), nested, with display→text→script→scriptscript shrink.",
    entries: [
      { tex: "\\frac{1}{2} + \\frac{3}{4} = \\frac{5}{4}" },
      { tex: "\\frac{a + \\frac{b}{c}}{d - \\frac{e}{f}}" },
      { tex: "\\frac{\\partial^2 u}{\\partial x^2} + \\frac{\\partial^2 u}{\\partial y^2} = 0" },
      { tex: "\\frac{1}{1 + \\frac{1}{1 + \\frac{1}{1 + \\frac{1}{x}}}}" },
    ],
  },
  {
    title: "Radicals",
    blurb: "\\sqrt and \\sqrt[n]{…} — a stretching vector path scaled to the radicand.",
    entries: [
      { tex: "\\sqrt{2} \\quad \\sqrt{x^2 + y^2} \\quad \\sqrt[3]{x} \\quad \\sqrt[n]{\\frac{a}{b}}" },
      { tex: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}" },
      { tex: "\\sqrt{1 + \\sqrt{1 + \\sqrt{1 + \\sqrt{1 + x}}}}" },
      { tex: "\\phi = \\frac{1 + \\sqrt{5}}{2}" },
    ],
  },
  {
    title: "Delimiters — stretchy & sized",
    blurb: "\\left…\\right auto-size + \\big \\Big \\bigg \\Bigg for ( ) [ ] { } floors, ceilings, bars.",
    entries: [
      { tex: "\\left( \\frac{a}{b} \\right) \\left[ \\frac{c}{d} \\right] \\left\\{ \\frac{e}{f} \\right\\}" },
      { tex: "\\left( \\frac{\\frac{a}{b}}{\\frac{c}{d}} \\right)" },
      { tex: "\\Bigg( \\bigg( \\Big( \\big( ( x ) \\big) \\Big) \\bigg) \\Bigg)" },
      { tex: "\\left\\lfloor \\frac{n}{2} \\right\\rfloor \\left\\lceil \\frac{n}{2} \\right\\rceil \\left| \\frac{x}{y} \\right|" },
    ],
  },
  {
    title: "Big operators with limits",
    blurb: "\\sum \\prod \\bigcup stack limits in display; \\int \\oint keep side scripts.",
    entries: [
      { tex: "\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}" },
      { tex: "\\prod_{k=1}^{n} k = n! \\qquad \\bigcup_{i \\in I} A_i \\quad \\bigcap_{j} B_j" },
      { tex: "\\int_{0}^{\\infty} e^{-x^2}\\, dx = \\frac{\\sqrt{\\pi}}{2}" },
      { tex: "\\oint_{\\partial \\Omega} \\mathbf{F} \\cdot d\\mathbf{r} = \\iint_{\\Omega} (\\nabla \\times \\mathbf{F}) \\cdot d\\mathbf{A}" },
      { tex: "\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1" },
    ],
  },
  {
    title: "Accents",
    blurb: "\\hat \\bar \\vec \\tilde \\dot \\acute … over a base.",
    entries: [
      { tex: "\\hat{a} \\bar{b} \\vec{c} \\tilde{d} \\dot{e} \\ddot{f} \\acute{g} \\grave{h} \\check{i}" },
      { tex: "\\vec{v} = \\hat{x}\\, v_x + \\hat{y}\\, v_y + \\hat{z}\\, v_z" },
      { tex: "\\dot{x} = \\frac{dx}{dt} \\qquad \\ddot{x} = \\frac{d^2 x}{dt^2}" },
    ],
  },
  {
    title: "Putting it together",
    blurb: "Real-world formulas exercising many features at once.",
    entries: [
      { tex: "i\\hbar \\frac{\\partial}{\\partial t} \\Psi = \\hat{H} \\Psi" },
      { tex: "\\mathcal{L} = \\frac{1}{2} m \\dot{q}^2 - V(q)" },
      { tex: "f(x) = \\sum_{n=0}^{\\infty} \\frac{f^{(n)}(a)}{n!} (x - a)^n" },
      { tex: "\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0} \\qquad \\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}" },
      { tex: "P(A \\mid B) = \\frac{P(B \\mid A)\\, P(A)}{P(B)}" },
    ],
  },
];

// ── Layout geometry (CSS px) ────────────────────────────────────────────────
export const PAGE_W = 1100;
const PAD_X = 40;
const MATH_FONT = 24; // px per em for display math
const ROW_PAD = 22; // vertical breathing room around each row's math
const SECTION_GAP = 34;
const SECTION_TITLE_H = 30;
const SECTION_BLURB_H = 20;
const HEADER_H = 92; // banner above the gallery

const TITLE_FONT = "600 17px sans-serif";
const BLURB_FONT = "13px sans-serif";
const BANNER_TITLE_FONT = "600 22px sans-serif";
const BANNER_SUB_FONT = "14px sans-serif";

const INK = "#1a1a2e";
const TITLE_COLOR = "#3730a3";
const BLURB_COLOR = "#6b7280";
const RULE_COLOR = "#eceef1";
const BANNER_SUB_COLOR = "#6b7280";

/** Minimal structural subset of the 2D context this module relies on. */
type Ctx = CanvasRenderingContext2D;

interface PlacedEntry {
  entry: Entry;
  layout: ReturnType<typeof layoutMath>;
  top: number;
  height: number;
}
interface PlacedSection {
  section: Section;
  top: number;
  rows: PlacedEntry[];
}

export function buildLayout(): { placed: PlacedSection[]; totalH: number } {
  const placed: PlacedSection[] = [];
  let y = HEADER_H + 16;
  for (const section of SECTIONS) {
    const secTop = y;
    y += SECTION_TITLE_H;
    if (section.blurb) y += SECTION_BLURB_H;
    y += 8;
    const rows: PlacedEntry[] = [];
    for (const entry of section.entries) {
      const layout = layoutMath(entry.tex, {
        displayMode: !entry.inline,
        fontSize: MATH_FONT,
      });
      const mathH = layout.height + layout.depth;
      const rowH = Math.max(mathH, 24) + ROW_PAD;
      rows.push({ entry, layout, top: y, height: rowH });
      y += rowH;
    }
    placed.push({ section, top: secTop, rows });
    y += SECTION_GAP;
  }
  return { placed, totalH: y + 24 };
}

export function paintGallery(
  ctx: Ctx,
  placed: PlacedSection[],
  totalH: number,
): void {
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // Background + banner.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAGE_W, totalH);
  ctx.fillStyle = INK;
  ctx.font = BANNER_TITLE_FONT;
  ctx.fillText("@tasfer/tex — canvas-native LaTeX", PAD_X, 44);
  ctx.font = BANNER_SUB_FONT;
  ctx.fillStyle = BANNER_SUB_COLOR;
  ctx.fillText(
    "Laid out by the TeX box-and-glue engine, painted straight onto canvas with fillText / fillRect — no DOM, no SVG.",
    PAD_X,
    70,
  );
  ctx.fillStyle = RULE_COLOR;
  ctx.fillRect(PAD_X, HEADER_H, PAGE_W - 2 * PAD_X, 1);

  for (const ps of placed) {
    let ty = ps.top + 20;
    ctx.font = TITLE_FONT;
    ctx.fillStyle = TITLE_COLOR;
    ctx.fillText(ps.section.title, PAD_X, ty);
    if (ps.section.blurb) {
      ty += SECTION_BLURB_H;
      ctx.font = BLURB_FONT;
      ctx.fillStyle = BLURB_COLOR;
      ctx.fillText(ps.section.blurb, PAD_X, ty);
    }

    for (const row of ps.rows) {
      ctx.fillStyle = RULE_COLOR;
      ctx.fillRect(PAD_X, row.top, PAGE_W - 2 * PAD_X, 1);

      const mathH = row.layout.height + row.layout.depth;
      const rowCenter = row.top + row.height / 2;
      const baseline = rowCenter - mathH / 2 + row.layout.height;

      paintMath(ctx, row.layout, PAD_X, baseline, { color: INK });
    }
  }
}
