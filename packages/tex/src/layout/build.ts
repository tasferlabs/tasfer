/**
 * The layout engine: math AST → box tree. Faithfully ports the relevant TeX /
 * KaTeX (MIT) algorithms — inter-atom spacing, super/subscript shifts (TeXbook
 * Rule 18), and fractions (Rule 15) — but expresses every dimension in absolute
 * root em (size multiplier baked in), so a `sigma` constant used in a shift is
 * converted to root em the same way a glyph is: value × style.sizeMultiplier.
 */
import {
  type AtomClass,
  SPACINGS,
  TIGHT_SPACINGS,
} from "../data/constants.ts";
import {
  atomClassOf,
  type FontVariant,
  resolveFontVariant,
} from "../data/fontMetrics.ts";
import type { SigmaName } from "../data/constants.ts";
import type { Node } from "../parse/ast.ts";
import { DISPLAY, SCRIPT, type Style, TEXT } from "../style.ts";
import {
  type Box,
  glyphBox,
  hbox,
  type HItem,
  type ListBox,
  listBox,
  pathBox,
  type PathCmd,
  type Placed,
  ruleBox,
} from "./box.ts";
import { chooseSurd, makeDelimiter, SIZE_TO_MAX_HEIGHT } from "./delimiter.ts";
import { SCRIPTSCRIPT } from "../style.ts";
import { mathSymbols } from "../data/symbols.ts";

interface Built {
  box: Box;
  klass: AtomClass;
  /** True when the box is a single symbol (TeX's "character box"). */
  isCharBox: boolean;
  /** Explicit space — suppresses inter-atom glue on both sides. */
  isSpace?: boolean;
}

/** A sigma/xi constant resolved to absolute root em at `style`'s size. */
function sig(style: Style, name: SigmaName): number {
  return style.metrics()[name] * style.sizeMultiplier;
}

// Big operators that stack their sub/superscripts as limits (in display style),
// keyed by the glyph char. Integrals (\int, \oint, …) are intentionally absent.
const LIMIT_OP_CHARS = new Set(
  [
    "\\coprod", "\\bigvee", "\\bigwedge", "\\biguplus", "\\bigcap", "\\bigcup",
    "\\prod", "\\sum", "\\bigotimes", "\\bigoplus", "\\bigodot", "\\bigsqcup",
  ]
    .map((n) => mathSymbols[n]?.char)
    .filter((c): c is string => !!c),
);

function isLimitOp(node: Node): node is Extract<Node, { type: "atom" }> {
  return (
    node.type === "atom" &&
    node.info.group === "op" &&
    LIMIT_OP_CHARS.has(node.info.char)
  );
}

/** Render a big-operator glyph (Size1, or Size2 in display), centered on the axis. */
function buildBigOp(
  info: { char: string },
  style: Style,
): { glyph: ReturnType<typeof glyphBox>; baseShift: number; slant: number } {
  const large = style.styleSize === 0; // display → larger glyph
  const font = large ? "Size2-Regular" : "Size1-Regular";
  const glyph = glyphBox(info.char, font, style.sizeMultiplier, null);
  const baseShift =
    (glyph.height - glyph.depth) / 2 - sig(style, "axisHeight");
  return { glyph, baseShift, slant: glyph.italic };
}

/**
 * Lay out a whole expression at `style`, returning its single box. An optional
 * `font` forces the glyph face for every letter inside (set by `\mathbb` etc.).
 */
export function buildExpression(
  nodes: Node[],
  style: Style,
  font?: FontVariant,
): ListBox {
  const built = nodes.map((n) => buildNode(n, style, font));
  const items: HItem[] = [];
  for (let i = 0; i < built.length; i++) {
    if (i > 0 && !built[i - 1].isSpace && !built[i].isSpace) {
      const glue = interAtomGlue(built[i - 1].klass, built[i].klass, style);
      if (glue) items.push({ kern: glue });
    }
    items.push(built[i].box);
  }
  return hbox(items);
}

/** Glue (root em) between two adjacent atom classes at `style`. */
function interAtomGlue(left: AtomClass, right: AtomClass, style: Style): number {
  const table = style.isTight() ? TIGHT_SPACINGS : SPACINGS;
  const mu = table[left]?.[right];
  if (!mu) return 0;
  // mu → em uses the style's cssEmPerMu, then × multiplier for root em.
  return mu * style.metrics().cssEmPerMu * style.sizeMultiplier;
}

function buildNode(node: Node, style: Style, font?: FontVariant): Built {
  switch (node.type) {
    case "atom": {
      // Big operators (∑ ∫ ∏ …) render larger and centered on the axis.
      if (node.info.group === "op" && !font) {
        const { glyph, baseShift } = buildBigOp(node.info, style);
        const box = listBox([{ box: glyph, dx: 0, dy: baseShift }], {
          width: glyph.width,
          span: node.span,
        });
        return { box, klass: "mop", isCharBox: true };
      }
      // An enclosing font command (`\mathbb`, …) overrides the resolved face.
      const variant = font ?? resolveFontVariant(node.info);
      const box = glyphBox(
        node.info.char,
        variant,
        style.sizeMultiplier,
        node.span,
      );
      return { box, klass: atomClassOf(node.info.group), isCharBox: true };
    }
    case "ord": {
      const box = buildExpression(node.body, style, font);
      box.span = node.span;
      const isCharBox =
        node.body.length === 1 && buildNode(node.body[0], style, font).isCharBox;
      return { box, klass: "mord", isCharBox };
    }
    case "supsub":
      return buildSupSub(node, style);
    case "frac":
      return buildFrac(node, style);
    case "sqrt":
      return buildSqrt(node, style);
    case "leftright":
      return buildLeftRight(node, style);
    case "sizeddelim":
      return buildSizedDelim(node, style);
    case "accent":
      return buildAccent(node, style);
    case "overunder":
      return buildOverUnder(node, style);
    case "array":
      return buildArray(node, style);
    case "opname":
      return buildOpName(node, style);
    case "mathfont":
      return buildMathFont(node, style);
    case "not":
      return buildNot(node, style);
    case "text":
      return buildText(node, style);
    case "mclass":
      return buildMClass(node, style);
    case "stack":
      return buildStack(node, style);
    case "boxed":
      return buildBoxed(node, style);
    case "phantom":
      return buildPhantom(node, style);
    case "style":
      return buildStyleNode(node, style);
    case "infix": {
      // An unresolved infix marker (no operands) — render nothing.
      return { box: listBox([], { width: 0 }), klass: "mord", isCharBox: false };
    }
    case "space":
      return {
        box: listBox([], { width: node.width * style.sizeMultiplier }),
        klass: "mord",
        isCharBox: false,
        isSpace: true,
      };
    case "unknown":
      return buildUnknown(node, style);
  }
}

/** `\left( … \right)` — delimiters auto-sized to the enclosed content. */
function buildLeftRight(
  node: Extract<Node, { type: "leftright" }>,
  style: Style,
): Built {
  const inner = buildExpression(node.body, style);
  const box = wrapDelimiters(inner, node.left, node.right, style, node.span);
  return { box, klass: "minner", isCharBox: false };
}

/**
 * Surround `inner` with auto-sized delimiters (TeX's make_left_right): the fence
 * is sized to the content's reach from the math axis. Shared by `\left…\right`
 * and the delimited matrix environments (`pmatrix`, `cases`, …).
 */
function wrapDelimiters(
  inner: ListBox,
  left: string,
  right: string,
  style: Style,
  span: Node["span"] | null,
): ListBox {
  const axisHeight = sig(style, "axisHeight");
  const delimiterFactor = 901;
  const delimiterExtend = 5.0 / style.metrics().ptPerEm;
  const maxDist = Math.max(inner.height - axisHeight, inner.depth + axisHeight);
  const totalHeight = Math.max(
    (maxDist / 500) * delimiterFactor,
    2 * maxDist - delimiterExtend,
  );

  const l = makeDelimiter(left, totalHeight, style, true);
  const r = makeDelimiter(right, totalHeight, style, true);
  return hbox([l, inner, r], { klass: "minner", span });
}

/** Manually sized delimiter (`\big(`). */
function buildSizedDelim(
  node: Extract<Node, { type: "sizeddelim" }>,
  style: Style,
): Built {
  const box = makeDelimiter(
    node.delim,
    SIZE_TO_MAX_HEIGHT[node.size],
    style,
    false,
  );
  return { box, klass: node.mclass, isCharBox: false };
}

/** A single-glyph accent placed over its (cramped) base. */
function buildAccent(
  node: Extract<Node, { type: "accent" }>,
  style: Style,
): Built {
  if (node.stretchy) return buildStretchyAccent(node, style);
  const baseBuilt = buildNode(node.base, style.cramp());
  const base = baseBuilt.box;
  const info = mathSymbols[node.label];
  // `\vec`'s glyph (U+20D7) is a zero-advance COMBINING mark: the font paints it
  // to the left of the pen, so positioning it like a spacing accent drops the
  // arrow onto the previous atom. Draw it as a vector path instead (the same
  // canvas-native approach as the surd), so it sits centered over the base.
  const accent =
    node.label === "\\vec"
      ? vecPath(style.sizeMultiplier)
      : glyphBox(info?.char ?? "", "Main-Regular", style.sizeMultiplier, null);

  const clearance = Math.min(base.height, sig(style, "xHeight"));
  const skew =
    baseBuilt.isCharBox && base.type === "glyph" ? base.skew : 0;
  const dx = (base.width - accent.width) / 2 + skew;
  // Accent sits just above the base, dipping `clearance` below the base's top.
  const dy = -(base.height - clearance) - accent.depth;

  const box = listBox(
    [
      { box: base, dx: 0, dy: 0 },
      { box: accent, dx, dy },
    ],
    { width: base.width, klass: "mord", span: node.span },
  );
  return { box, klass: "mord", isCharBox: false };
}

/**
 * A stretchy accent (`\widehat`, `\widetilde`) drawn as a canvas path spanning
 * the whole base width. KaTeX stretches an SVG; we draw the chevron/wave
 * directly. Vertical extent approximates KaTeX's width-tiered height to within a
 * few hundredths of an em (not pinned to the strict oracle).
 */
function buildStretchyAccent(
  node: Extract<Node, { type: "accent" }>,
  style: Style,
): Built {
  const base = buildNode(node.base, style.cramp()).box;
  const m = style.sizeMultiplier;
  const w = Math.max(base.width, 0.3 * m);
  const isHat = node.label === "\\widehat";
  // The accent grows with the base width (KaTeX tiers it across 4 glyph sizes);
  // a gentle linear fit approximates that to within a few hundredths of an em.
  const accH = isHat
    ? Math.min(0.34 * m, 0.205 * m + 0.06 * w)
    : Math.min(0.32 * m, 0.235 * m + 0.04 * w);
  const t = 0.044 * m; // stroke thickness

  const accent = isHat ? widehatPath(w, accH, t) : widetildePath(w, accH, t);
  const dx = (base.width - w) / 2;
  // Accent baseline sits at the base's top; its path rises by `accH`.
  const dy = -base.height;
  const box = listBox(
    [
      { box: base, dx: 0, dy: 0 },
      { box: accent, dx, dy },
    ],
    { width: base.width, klass: "mord", span: node.span },
  );
  return { box, klass: "mord", isCharBox: false };
}

/** A chevron (`\widehat`) spanning [0,w], peaking `h` above its baseline. */
function widehatPath(w: number, h: number, t: number): Box {
  const cmds: PathCmd[] = [
    ["M", 0, 0],
    ["L", w / 2, -h],
    ["L", w, 0],
  ];
  return pathBox(cmds, { width: w, height: h, depth: 0 }, t);
}

/** A wave (`\widetilde`) spanning [0,w], within `h` of its baseline. */
function widetildePath(w: number, h: number, t: number): Box {
  const cmds: PathCmd[] = [
    ["M", 0, -h * 0.4],
    ["L", w * 0.28, -h],
    ["L", w * 0.5, -h * 0.45],
    ["L", w * 0.72, 0],
    ["L", w, -h * 0.55],
  ];
  return pathBox(cmds, { width: w, height: h, depth: 0 }, t);
}

/**
 * `\overline` / `\underline` (a full-width vinculum) and `\overbrace` /
 * `\underbrace` (a stretchy horizontal brace) over or under the body. Heights
 * match KaTeX: an over/underline adds 5·ruleThickness (gap 3·rt + rule + a
 * final rt kern); a brace adds 0.1 em of kern + a 0.548 em brace.
 */
function buildOverUnder(
  node: Extract<Node, { type: "overunder" }>,
  style: Style,
): Built {
  const isOver = node.kind === "overline" || node.kind === "overbrace";
  // `\overline` builds its body cramped (TeX); the others use the plain style.
  const inner = buildNode(
    node.body,
    node.kind === "overline" ? style.cramp() : style,
  ).box;

  const rt = sig(style, "defaultRuleThickness");
  const children: Placed[] = [{ box: inner, dx: 0, dy: 0 }];
  let height = inner.height;
  let depth = inner.depth;

  if (node.kind === "overline" || node.kind === "underline") {
    const gap = 3 * rt;
    if (isOver) {
      // Rule `gap` above the body top; box reaches a further `rt` above it.
      children.push({ box: ruleBox(inner.width, rt), dx: 0, dy: -(inner.height + gap) });
      height = inner.height + 5 * rt;
    } else {
      children.push({ box: ruleBox(inner.width, rt), dx: 0, dy: inner.depth + gap + rt });
      depth = inner.depth + 5 * rt;
    }
  } else {
    // Brace: 0.1 em kern between body and brace, then a 0.548 em brace.
    const kern = 0.1 * style.sizeMultiplier;
    const braceH = 0.548 * style.sizeMultiplier;
    const w = inner.width;
    if (isOver) {
      const brace = bracePath(w, braceH, false);
      children.push({ box: brace, dx: 0, dy: -(inner.height + kern) });
      height = inner.height + kern + braceH;
    } else {
      const brace = bracePath(w, braceH, true);
      children.push({ box: brace, dx: 0, dy: inner.depth + kern });
      depth = inner.depth + kern + braceH;
    }
  }

  const box = listBox(children, { width: inner.width, klass: "mord", span: node.span });
  const out: Box = { ...box, height, depth };
  // Braces become an `mop`-ish inner so a trailing `^{label}` sits above them.
  return { box: out, klass: "mord", isCharBox: false };
}

/**
 * A horizontal brace spanning [0,w] within `h` of its baseline. `down` points
 * the central spike downward (`\underbrace`); otherwise upward (`\overbrace`).
 * Drawn as a stroked polyline — a stylized brace, height/depth exact.
 */
function bracePath(w: number, h: number, down: boolean): Box {
  const s = down ? 1 : -1; // sign of the "up" direction in box coords
  const mid = w / 2;
  const lobe = Math.min(0.18 * w, 0.25);
  const cmds: PathCmd[] = [
    ["M", 0, 0],
    ["L", lobe, s * -h * 0.5],
    ["L", mid - lobe, s * -h * 0.5],
    ["L", mid, s * -h],
    ["L", mid + lobe, s * -h * 0.5],
    ["L", w - lobe, s * -h * 0.5],
    ["L", w, 0],
  ];
  const t = 0.05;
  return down
    ? pathBox(cmds, { width: w, height: 0, depth: h }, t)
    : pathBox(cmds, { width: w, height: h, depth: 0 }, t);
}

/** Per-environment layout configuration. */
interface EnvConfig {
  cellStyle: Style;
  align: "c" | "l" | "alternate" | "colspec";
  /** LaTeX `\arraystretch` — scales the row baseline-to-baseline distance. */
  arraystretch: number;
  /** AMS multiline envs (`aligned`, `gathered`) add `\jot` between rows. */
  addJot: boolean;
  colGap: number; // visual column separation (not metric-critical)
  left?: string;
  right?: string;
}

function envConfig(env: string): EnvConfig {
  const base: EnvConfig = {
    cellStyle: TEXT,
    align: "c",
    arraystretch: 1,
    addJot: false,
    colGap: 0.7,
  };
  switch (env) {
    case "pmatrix": return { ...base, left: "(", right: ")" };
    case "bmatrix": return { ...base, left: "[", right: "]" };
    case "Bmatrix": return { ...base, left: "\\{", right: "\\}" };
    case "vmatrix": return { ...base, left: "|", right: "|" };
    case "Vmatrix": return { ...base, left: "\\Vert", right: "\\Vert" };
    case "cases":
    case "rcases":
      return {
        ...base, align: "l", arraystretch: 1.2, colGap: 1.0,
        left: env === "rcases" ? "." : "\\{",
        right: env === "rcases" ? "\\}" : ".",
      };
    case "dcases":
    case "drcases":
      return {
        ...base, cellStyle: DISPLAY, align: "l", arraystretch: 1.2, colGap: 1.0,
        left: env === "drcases" ? "." : "\\{",
        right: env === "drcases" ? "\\}" : ".",
      };
    case "aligned":
    case "align":
    case "align*":
    case "aligned*":
      return { ...base, cellStyle: DISPLAY, align: "alternate", addJot: true, colGap: 0 };
    case "gathered":
    case "gather":
    case "gather*":
      return { ...base, cellStyle: DISPLAY, align: "c", addJot: true };
    case "array":
    case "subarray":
      return { ...base, align: "colspec" };
    case "smallmatrix":
      return { ...base, cellStyle: SCRIPT, arraystretch: 0.5, colGap: 0.5 };
    case "matrix":
    default:
      return base;
  }
}

/**
 * Tabular environments. Cells are laid out into a grid (per-column max width),
 * each row clamped to a strut, then the whole stack is centered on the math
 * axis — so `height = totalHeight/2 + axis`, `depth = totalHeight/2 − axis`,
 * exactly as KaTeX. Delimited variants (`pmatrix`, `cases`, …) wrap the grid in
 * auto-sized fences.
 */
function buildArray(node: Extract<Node, { type: "array" }>, style: Style): Built {
  const cfg = envConfig(node.env);
  const cs = cfg.cellStyle;

  const cells: Box[][] = node.rows.map((row) =>
    row.map((cell) => buildNode(cell, cs).box),
  );
  const nCols = cells.reduce((m, r) => Math.max(m, r.length), 0);
  const colW: number[] = [];
  for (let c = 0; c < nCols; c++) {
    let w = 0;
    for (const r of cells) if (r[c]) w = Math.max(w, r[c].width);
    colW[c] = w;
  }
  // Column x-offsets (start of each column), separated by colGap.
  const colX: number[] = [];
  let x = 0;
  for (let c = 0; c < nCols; c++) {
    colX[c] = x;
    x += colW[c] + (c < nCols - 1 ? cfg.colGap : 0);
  }
  const totalWidth = x;

  // Per-row strut + baseline positions, building top→down from y = 0.
  // `\arraystretch` scales the baseline-to-baseline distance (12pt baselineskip);
  // the strut is 0.7/0.3 of that. AMS multiline envs add `\jot` between rows.
  const arrayskip = cfg.arraystretch * 1.2;
  const strutH = 0.7 * arrayskip;
  const strutD = 0.3 * arrayskip;
  const jot = 0.3;
  const rowInfo: { h: number; d: number; base: number }[] = [];
  let pos = 0;
  for (let r = 0; r < cells.length; r++) {
    let h = strutH;
    let d = strutD;
    for (const b of cells[r]) {
      h = Math.max(h, b.height);
      d = Math.max(d, b.depth);
    }
    if (cfg.addJot && r < cells.length - 1) d += jot;
    pos += h;
    rowInfo.push({ h, d, base: pos });
    pos += d;
  }
  const totalHeight = pos;
  const axis = sig(style, "axisHeight");
  const shift = totalHeight / 2 + axis; // center the stack on the axis

  const children: Placed[] = [];
  for (let r = 0; r < cells.length; r++) {
    const dyRow = rowInfo[r].base - shift;
    for (let c = 0; c < cells[r].length; c++) {
      const cell = cells[r][c];
      const dx = colX[c] + cellAlignOffset(cfg, node.colAlign, c, colW[c], cell.width);
      children.push({ box: cell, dx, dy: dyRow });
    }
  }

  let box = listBox(children, { width: totalWidth, klass: "mord", span: node.span });
  // listBox derives tight metrics from content; an empty/short array still
  // reports the centered strut extents.
  box = { ...box, height: totalHeight / 2 + axis, depth: totalHeight / 2 - axis };

  if (cfg.left !== undefined || cfg.right !== undefined) {
    const wrapped = wrapDelimiters(box, cfg.left ?? ".", cfg.right ?? ".", style, node.span);
    return { box: wrapped, klass: "minner", isCharBox: false };
  }
  return { box, klass: "mord", isCharBox: false };
}

/** Horizontal offset of a cell within its column, per the env's alignment. */
function cellAlignOffset(
  cfg: EnvConfig,
  colAlign: ReadonlyArray<"l" | "c" | "r"> | undefined,
  col: number,
  colWidth: number,
  cellWidth: number,
): number {
  let a: "l" | "c" | "r";
  if (cfg.align === "colspec") a = colAlign?.[col] ?? "c";
  else if (cfg.align === "alternate") a = col % 2 === 0 ? "r" : "l";
  else a = cfg.align === "l" ? "l" : "c";
  if (a === "l") return 0;
  if (a === "r") return colWidth - cellWidth;
  return (colWidth - cellWidth) / 2;
}

/** Build a node that's an argument/base, defaulting to an empty box if null. */
function buildOrEmpty(node: Node | null, style: Style): Built {
  if (node) return buildNode(node, style);
  const box = listBox([], { width: 0 });
  return { box, klass: "mord", isCharBox: false };
}

/** TeXbook Rule 18 — super/subscripts. */
function buildSupSub(
  node: Extract<Node, { type: "supsub" }>,
  style: Style,
): Built {
  // Big operators (and limit-style named ops like \lim) stack their scripts as
  // limits in display style.
  if (node.base && style.styleSize === 0) {
    if (isLimitOp(node.base)) {
      const { glyph, baseShift, slant } = buildBigOp(node.base.info, style);
      return {
        box: stackLimits(glyph, baseShift, slant, node, style),
        klass: "mop",
        isCharBox: false,
      };
    }
    if (node.base.type === "opname" && node.base.limits) {
      const base = buildOpName(node.base, style).box;
      return { box: stackLimits(base, 0, 0, node, style), klass: "mop", isCharBox: false };
    }
  }

  const baseBuilt = buildOrEmpty(node.base, style);
  const base = baseBuilt.box;
  const { isCharBox } = baseBuilt;

  const supStyle = style.sup();
  const subStyle = style.sub();
  const supm = node.sup ? buildNode(node.sup, supStyle).box : null;
  const subm = node.sub ? buildNode(node.sub, subStyle).box : null;

  // Rule 18a — initial drops (only for non-character bases, e.g. a big group).
  let supShift = supm && !isCharBox ? base.height - sig(supStyle, "supDrop") : 0;
  let subShift = subm && !isCharBox ? base.depth + sig(subStyle, "subDrop") : 0;

  // Rule 18c — minimum superscript shift depends on the style.
  let minSupShift: number;
  if (style === DISPLAY) minSupShift = sig(style, "sup1");
  else if (style.cramped) minSupShift = sig(style, "sup3");
  else minSupShift = sig(style, "sup2");

  // scriptspace: a font-size-independent gap added after the scripts.
  const scriptspace = 0.05;
  // Subscripts aren't shifted by the base's italic correction; only a single
  // symbol base carries a meaningful italic to compensate for.
  const italic = isCharBox && base.type === "glyph" ? base.italic : 0;
  const xHeight = sig(style, "xHeight");

  const children: Placed[] = [{ box: base, dx: 0, dy: 0 }];
  let width = base.width;

  if (supm && subm) {
    supShift = Math.max(supShift, minSupShift, supm.depth + 0.25 * xHeight);
    subShift = Math.max(subShift, sig(style, "sub2"));

    const ruleWidth = sig(style, "defaultRuleThickness");
    const maxWidth = 4 * ruleWidth; // Rule 18e
    if (supShift - supm.depth - (subm.height - subShift) < maxWidth) {
      subShift = maxWidth - (supShift - supm.depth) + subm.height;
      const psi = 0.8 * xHeight - (supShift - supm.depth);
      if (psi > 0) {
        supShift += psi;
        subShift -= psi;
      }
    }
    children.push({ box: supm, dx: base.width, dy: -supShift });
    children.push({ box: subm, dx: base.width - italic, dy: subShift });
    width = base.width + Math.max(supm.width, subm.width - italic) + scriptspace;
  } else if (subm) {
    // Rule 18b
    subShift = Math.max(
      subShift,
      sig(style, "sub1"),
      subm.height - 0.8 * xHeight,
    );
    children.push({ box: subm, dx: base.width - italic, dy: subShift });
    width = base.width + (subm.width - italic) + scriptspace;
  } else if (supm) {
    // Rule 18c, d
    supShift = Math.max(supShift, minSupShift, supm.depth + 0.25 * xHeight);
    children.push({ box: supm, dx: base.width, dy: -supShift });
    width = base.width + supm.width + scriptspace;
  }

  const box = listBox(children, { width, klass: baseBuilt.klass, span: node.span });
  return { box, klass: baseBuilt.klass, isCharBox: false };
}

/**
 * Stack a sub/superscript as limits below/above a base box (display style) —
 * shared by big-operator glyphs (`\sum`) and limit-style named ops (`\lim`).
 * `baseShift`/`slant` are the big-op's axis shift and italic slant (0 for text).
 */
function stackLimits(
  base: Box,
  baseShift: number,
  slant: number,
  node: Extract<Node, { type: "supsub" }>,
  style: Style,
): Box {
  const opW = base.width;

  const sup = node.sup ? buildNode(node.sup, style.sup()).box : null;
  const sub = node.sub ? buildNode(node.sub, style.sub()).box : null;
  const big5 = sig(style, "bigOpSpacing5");

  const children: Placed[] = [{ box: base, dx: 0, dy: baseShift }];
  let height = base.height - baseShift;
  let depth = base.depth + baseShift;
  let width = opW;

  if (sup) {
    const kern = Math.max(
      sig(style, "bigOpSpacing1"),
      sig(style, "bigOpSpacing3") - sup.depth,
    );
    // sup baseline sits above the operator's top by `kern`.
    const dy = baseShift - base.height - kern - sup.depth;
    children.push({ box: sup, dx: (opW - sup.width) / 2 + slant, dy });
    height = Math.max(height, sup.height - dy) + big5;
    width = Math.max(width, sup.width);
  }
  if (sub) {
    const kern = Math.max(
      sig(style, "bigOpSpacing2"),
      sig(style, "bigOpSpacing4") - sub.height,
    );
    const dy = baseShift + base.depth + kern + sub.height;
    children.push({ box: sub, dx: (opW - sub.width) / 2 - slant, dy });
    depth = Math.max(depth, sub.depth + dy) + big5;
    width = Math.max(width, sub.width);
  }

  // Re-center children horizontally within the final width.
  const shifted = children.map((c) => ({
    ...c,
    dx: c.dx + (width - opW) / 2,
  }));
  const box = listBox(shifted, { width, span: node.span });
  // listBox derives tight height/depth; widen them to include bigOpSpacing5.
  return { ...box, height: Math.max(box.height, height), depth: Math.max(box.depth, depth) };
}

/**
 * A named math operator (`\sin`, `\log`, `\lim`) — the name set upright in the
 * roman font, classed `mop` so it gets operator spacing. Multi-letter names are
 * a plain glyph run (no inter-atom glue inside the name).
 */
function buildOpName(node: Extract<Node, { type: "opname" }>, style: Style): Built {
  const items: HItem[] = [];
  for (const ch of node.name) {
    items.push(glyphBox(ch, "Main-Regular", style.sizeMultiplier, node.span));
  }
  const box = hbox(items, { klass: "mop", span: node.span });
  return { box, klass: "mop", isCharBox: false };
}

/**
 * A font/alphabet command (`\mathbb{R}`, `\mathbf{F}`, …) — its body is built in
 * the requested face. The variant is inherited by the whole sub-expression, so
 * nested groups/scripts render in the same alphabet.
 */
function buildMathFont(
  node: Extract<Node, { type: "mathfont" }>,
  style: Style,
): Built {
  const box = buildExpression(asNodes(node.body), style, node.variant as FontVariant);
  box.span = node.span;
  return { box, klass: "mord", isCharBox: false };
}

/**
 * `\not` — strike a slash through the base atom (`\not=` ⇒ ≠), classed `mrel`.
 * KaTeX overlays a fixed-size combining solidus; we draw the equivalent diagonal
 * stroke as a canvas path, sized to match its height/depth (0.6944 / 0.1944 em).
 */
function buildNot(node: Extract<Node, { type: "not" }>, style: Style): Built {
  const base = buildNode(node.base, style).box;
  const m = style.sizeMultiplier;
  const top = -0.6944 * m;
  const bottom = 0.1944 * m;
  const cx = base.width / 2;
  const slash = pathBox(
    [
      ["M", cx + 0.14 * m, top],
      ["L", cx - 0.14 * m, bottom],
    ],
    { width: base.width, height: -top, depth: bottom },
    0.046 * m,
  );
  const box = listBox(
    [
      { box: base, dx: 0, dy: 0 },
      { box: slash, dx: 0, dy: 0 },
    ],
    { width: base.width, klass: "mrel", span: node.span },
  );
  return { box, klass: "mrel", isCharBox: false };
}

/** Unwrap an ord body to its node list (a single non-ord node ⇒ a singleton). */
function asNodes(node: Node): Node[] {
  return node.type === "ord" ? node.body : [node];
}

/** A text-mode run (`\text`, `\textbf`, …) — raw chars, spaces preserved. */
function buildText(node: Extract<Node, { type: "text" }>, style: Style): Built {
  const variant = node.variant as FontVariant;
  const items: HItem[] = [];
  for (const ch of node.text) {
    if (ch === " ") items.push({ kern: 0.333 * style.sizeMultiplier });
    else items.push(glyphBox(ch, variant, style.sizeMultiplier, node.span));
  }
  const box = hbox(items, { klass: "mord", span: node.span });
  return { box, klass: "mord", isCharBox: false };
}

/** An atom-class override (`\mathbin`, …). `\mathop` also centers on the axis. */
function buildMClass(node: Extract<Node, { type: "mclass" }>, style: Style): Built {
  const body = buildNode(node.body, style).box;
  if (node.mclass === "mop") {
    const shift = (body.height - body.depth) / 2 - sig(style, "axisHeight");
    const box = listBox([{ box: body, dx: 0, dy: shift }], { width: body.width, span: node.span });
    return { box, klass: "mop", isCharBox: false };
  }
  return { box: body, klass: node.mclass, isCharBox: false };
}

/** `\overset` / `\underset` / `\stackrel` — reuse the limit-stacking machinery. */
function buildStack(node: Extract<Node, { type: "stack" }>, style: Style): Built {
  const baseBuilt = buildNode(node.base, style);
  const base = baseBuilt.box;
  let baseShift = 0;
  let slant = 0;
  let klass: AtomClass;
  if (node.kind === "stackrel") {
    klass = "mrel";
    if (base.type === "glyph") {
      baseShift = (base.height - base.depth) / 2 - sig(style, "axisHeight");
      slant = base.italic;
    }
  } else {
    // \overset / \underset inherit the base's binary/relation spacing class.
    klass = baseBuilt.klass === "mrel" || baseBuilt.klass === "mbin" ? baseBuilt.klass : "mord";
  }
  const fake: Extract<Node, { type: "supsub" }> = {
    type: "supsub",
    base: null,
    sup: node.kind === "underset" ? null : node.script,
    sub: node.kind === "underset" ? node.script : null,
    span: node.span,
  };
  const box = stackLimits(base, baseShift, slant, fake, style);
  return { box, klass, isCharBox: false };
}

/** `\boxed` / `\fbox` — body inside a ruled frame (pad 0.3 em + 0.04 em rule). */
function buildBoxed(node: Extract<Node, { type: "boxed" }>, style: Style): Built {
  const body = buildNode(node.body, style).box;
  const m = style.sizeMultiplier;
  const pad = 0.3 * m;
  const rt = 0.04 * m;
  const grow = pad + rt; // 0.34 em — height & depth each grow by this
  const fullH = body.height + grow;
  const fullD = body.depth + grow;
  const totalW = body.width + 2 * grow;
  const children: Placed[] = [
    { box: body, dx: grow, dy: 0 },
    { box: ruleBox(totalW, rt), dx: 0, dy: -fullH + rt }, // top edge
    { box: ruleBox(totalW, rt), dx: 0, dy: fullD }, // bottom edge
    { box: ruleBox(rt, fullH, fullD), dx: 0, dy: 0 }, // left edge
    { box: ruleBox(rt, fullH, fullD), dx: totalW - rt, dy: 0 }, // right edge
  ];
  const box = listBox(children, { width: totalW, klass: "mord", span: node.span });
  return { box: { ...box, height: fullH, depth: fullD }, klass: "mord", isCharBox: false };
}

/** `\phantom` (invisible, full box) and its `h`/`v`/`smash` dimension variants. */
function buildPhantom(node: Extract<Node, { type: "phantom" }>, style: Style): Built {
  const body = buildNode(node.body, style).box;
  let width = body.width;
  let height = body.height;
  let depth = body.depth;
  let visible = false;
  switch (node.kind) {
    case "phantom": break; // keep all dimensions, paint nothing
    case "hphantom": height = 0; depth = 0; break;
    case "vphantom": width = 0; break;
    case "smash": height = 0; depth = 0; visible = true; break; // keep ink + width
  }
  const children: Placed[] = visible ? [{ box: body, dx: 0, dy: 0 }] : [];
  const box = listBox(children, { width, klass: "mord", span: node.span });
  return { box: { ...box, width, height, depth }, klass: "mord", isCharBox: false };
}

/** A style switch (`\displaystyle` …) — rebuild the body at the new style. */
function buildStyleNode(node: Extract<Node, { type: "style" }>, _style: Style): Built {
  const target =
    node.style === "display" ? DISPLAY
    : node.style === "text" ? TEXT
    : node.style === "script" ? SCRIPT
    : SCRIPTSCRIPT;
  const box = buildExpression(node.body, target);
  box.span = node.span;
  return { box, klass: "mord", isCharBox: false };
}

/**
 * TeXbook Rule 15 — the generalized fraction. Handles `\frac` plus the whole
 * family: `\dfrac`/`\tfrac` force the style, `\binom` drops the bar and wraps in
 * delimiters (Rule 15c for the bar-less shifts, 15e for the delimiter size),
 * `\cfrac` forces display + struts the numerator.
 */
function buildFrac(node: Extract<Node, { type: "frac" }>, style: Style): Built {
  const fstyle =
    node.forceStyle === "display" ? DISPLAY
    : node.forceStyle === "text" ? TEXT
    : style;
  const hasRule = node.hasRule !== false;

  let numm = buildNode(node.num, fstyle.fracNum()).box;
  const denm = buildNode(node.den, fstyle.fracDen()).box;

  // \cfrac struts the numerator so stacked continued fractions line up.
  if (node.continued) {
    const sm = fstyle.sizeMultiplier;
    numm = { ...numm, height: Math.max(numm.height, 0.85 * sm), depth: Math.max(numm.depth, 0.35 * sm) };
  }

  const ruleWidth = hasRule ? sig(fstyle, "defaultRuleThickness") : 0;
  const ruleSpacing = sig(fstyle, "defaultRuleThickness");
  const axisHeight = sig(fstyle, "axisHeight");
  const isDisplay = fstyle.styleSize === 0;

  let numShift: number;
  let denomShift: number;
  let clearance: number;
  if (isDisplay) {
    numShift = sig(fstyle, "num1");
    denomShift = sig(fstyle, "denom1");
    clearance = hasRule ? 3 * ruleSpacing : 7 * ruleSpacing;
  } else {
    denomShift = sig(fstyle, "denom2");
    if (hasRule) { numShift = sig(fstyle, "num2"); clearance = ruleSpacing; }
    else { numShift = sig(fstyle, "num3"); clearance = 3 * ruleSpacing; }
  }

  if (hasRule) {
    // Rule 15d — push numerator/denominator clear of the bar.
    if (numShift - numm.depth - (axisHeight + 0.5 * ruleWidth) < clearance) {
      numShift += clearance - (numShift - numm.depth - (axisHeight + 0.5 * ruleWidth));
    }
    if (axisHeight - 0.5 * ruleWidth - (denm.height - denomShift) < clearance) {
      denomShift += clearance - (axisHeight - 0.5 * ruleWidth - (denm.height - denomShift));
    }
  } else {
    // Rule 15c — bar-less: keep a minimum gap between num depth and denom height.
    const gap = numShift - numm.depth - (denm.height - denomShift);
    if (gap < clearance) {
      numShift += 0.5 * (clearance - gap);
      denomShift += 0.5 * (clearance - gap);
    }
  }

  const inner = Math.max(numm.width, denm.width);
  const children: Placed[] = [
    { box: numm, dx: (inner - numm.width) / 2, dy: -numShift },
    { box: denm, dx: (inner - denm.width) / 2, dy: denomShift },
  ];
  if (hasRule) {
    children.splice(1, 0, { box: ruleBox(inner, ruleWidth), dx: 0, dy: -axisHeight + ruleWidth / 2 });
  }
  let box: ListBox = listBox(children, { width: inner, klass: "mord", span: node.span });

  // Rule 15e — surrounding delimiters (\binom), else nulldelimiterspace.
  if (node.leftDelim || node.rightDelim) {
    const delimSize = isDisplay ? sig(fstyle, "delim1") : sig(fstyle, "delim2");
    const left = node.leftDelim ? makeDelimiter(node.leftDelim, delimSize, fstyle, true) : null;
    const right = node.rightDelim ? makeDelimiter(node.rightDelim, delimSize, fstyle, true) : null;
    const items: HItem[] = [];
    if (left) items.push(left); else items.push({ kern: 0.12 * fstyle.sizeMultiplier });
    items.push(box);
    if (right) items.push(right); else items.push({ kern: 0.12 * fstyle.sizeMultiplier });
    box = hbox(items, { klass: "mord", span: node.span });
  } else {
    const nd = 0.12 * fstyle.sizeMultiplier;
    box = hbox([{ kern: nd }, box, { kern: nd }], { klass: "mord", span: node.span });
  }
  return { box, klass: "mord", isCharBox: false };
}

/**
 * Square root (TeXbook radicals). Sizes the surd to the radicand exactly as
 * KaTeX does, then draws the surd as a stroked canvas path (KaTeX uses an SVG;
 * we own the canvas) so it stretches smoothly to any height. Matches KaTeX's
 * height/depth.
 */
function buildSqrt(node: Extract<Node, { type: "sqrt" }>, style: Style): Built {
  const inner = buildNode(node.body, style.cramp()).box;
  const innerHeight = inner.height === 0 ? sig(style, "xHeight") : inner.height;

  const theta = style.metrics().sqrtRuleThickness * style.sizeMultiplier;
  const phi = style.styleSize === 0 ? sig(style, "xHeight") : theta;
  let lineClearance = theta + phi / 4;

  const minDelimHeight = innerHeight + inner.depth + lineClearance + theta;
  const img = surdImage(minDelimHeight, style);

  const delimDepth = img.texHeight - img.ruleWidth;
  if (delimDepth > innerHeight + inner.depth + lineClearance) {
    lineClearance =
      (lineClearance + delimDepth - innerHeight - inner.depth) / 2;
  }
  const imgShift = img.texHeight - innerHeight - lineClearance - img.ruleWidth;

  // The surd dips below the baseline by imgShift; its top horizontal stroke is
  // collinear with the vinculum (both at the radical's top, one ruleWidth tall),
  // so the surd path is drawn to the full radHeight — drawing it only to
  // surdHeight would leave its top a ruleWidth below the vinculum and show a
  // step ("crack") at the join. Matches KaTeX's radical height/depth.
  const surdHeight = img.texHeight - imgShift; // surd extent above baseline
  const radHeight = surdHeight + img.ruleWidth;
  const radDepth = Math.max(inner.depth, imgShift);
  const aw = img.advanceWidth;

  const children: Placed[] = [];
  // Surd drawn as a vector path in [0, aw] × [-radHeight, +imgShift]; its top
  // stroke sits flush with the vinculum centerline.
  children.push({
    box: surdPath(aw, radHeight, imgShift, img.ruleWidth),
    dx: 0,
    dy: 0,
  });
  // Vinculum over the radicand, flush with the radical top.
  children.push({
    box: ruleBox(inner.width, img.ruleWidth),
    dx: aw,
    dy: -radHeight + img.ruleWidth,
  });
  children.push({ box: inner, dx: aw, dy: 0 });

  let box = listBox(children, { width: aw + inner.width, klass: "mord", span: node.span });

  // Optional root index, in scriptscript style, tucked into the surd.
  if (node.index) {
    const rootm = buildNode(node.index, SCRIPTSCRIPT).box;
    const toShift = 0.6 * (radHeight - radDepth);
    const kern = 0.16; // \r@@t kern pulling the surd toward the index
    const placed: Placed[] = [
      { box: rootm, dx: 0, dy: -toShift },
      { box, dx: Math.max(0, rootm.width - kern), dy: 0 },
    ];
    box = listBox(placed, {
      width: Math.max(0, rootm.width - kern) + box.width,
      klass: "mord",
      span: node.span,
    });
  }
  return { box, klass: "mord", isCharBox: false };
}

/** Choose surd dimensions to cover `minHeight`, mirroring KaTeX's makeSqrtImage. */
function surdImage(
  minHeight: number,
  style: Style,
): { texHeight: number; ruleWidth: number; advanceWidth: number } {
  const rule = style.metrics().sqrtRuleThickness; // 0.04
  const choice = chooseSurd(minHeight, style);
  if (choice.type === "small") {
    // Within the small surd, pick the size multiplier by height (makeSqrtImage).
    const sizeMult = minHeight < 1.0 ? 1.0 : minHeight < 1.4 ? 0.7 : 1.0;
    return {
      texHeight: 1.0 / sizeMult,
      ruleWidth: rule * sizeMult,
      advanceWidth: 0.833 / sizeMult,
    };
  }
  if (choice.type === "large") {
    return {
      texHeight: SIZE_TO_MAX_HEIGHT[choice.size],
      ruleWidth: rule,
      advanceWidth: 1.0,
    };
  }
  // Tall: a single stretched surd.
  return { texHeight: minHeight, ruleWidth: rule, advanceWidth: 1.056 };
}

/** A radical-sign vector path filling [0, w] × [-height, depth]. */
function surdPath(
  w: number,
  height: number,
  depth: number,
  rule: number,
): Box {
  const topY = -height + rule / 2; // y of the vinculum centerline
  const cmds: PathCmd[] = [
    ["M", 0.0, -height * 0.4],
    ["L", 0.12 * w, -height * 0.32],
    ["L", 0.32 * w, depth - 0.02],
    ["L", 0.56 * w, topY],
    ["L", w, topY],
  ];
  return pathBox(cmds, { width: w, height, depth }, rule);
}

/**
 * Right-arrow accent (`\vec`), drawn as a stroked path rather than the font's
 * combining glyph. Sits in [0, w] × [-H, 0] so it places like any other accent
 * (height H above the baseline, no depth), at roughly a macron's elevation.
 */
function vecPath(sizeMult: number): Box {
  const w = 0.471 * sizeMult;
  const H = 0.62 * sizeMult; // top of the arrowhead above the baseline
  const t = 0.048 * sizeMult; // stroke thickness
  const rise = 0.085 * sizeMult; // arrowhead half-spread
  const back = 0.13 * sizeMult; // arrowhead barb length
  const yShaft = -(H - rise); // shaft centerline; head spans yShaft ± rise
  const cmds: PathCmd[] = [
    ["M", 0, yShaft],
    ["L", w, yShaft],
    ["M", w - back, yShaft - rise],
    ["L", w, yShaft],
    ["L", w - back, yShaft + rise],
  ];
  return pathBox(cmds, { width: w, height: H, depth: 0 }, t);
}

/** An unrecognized command — a visible red placeholder, never an error. */
function buildUnknown(
  node: Extract<Node, { type: "unknown" }>,
  style: Style,
): Built {
  const text = "\\" + node.name;
  const items: HItem[] = [];
  for (const ch of text) {
    items.push(
      glyphBox(ch, "Main-Regular", style.sizeMultiplier, node.span, "#c01616"),
    );
  }
  const box = hbox(items, { klass: "mord", span: node.span });
  return { box, klass: "mord", isCharBox: false };
}
