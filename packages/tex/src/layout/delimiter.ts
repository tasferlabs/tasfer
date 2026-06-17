/**
 * Stretchy & sized delimiters. Ported from KaTeX's delimiter.ts (MIT): pick the
 * smallest glyph that covers the required height from a size sequence (small
 * Main-Regular → large Size1..4 → an extensible stack), then center it on the
 * math axis. The extensible middle is a single repeat glyph scaled vertically
 * (KaTeX stretches an SVG path; on canvas we just scale the glyph).
 */
import { mathSymbols } from "../data/symbols.ts";
import { type FontVariant, getCharacterMetrics } from "../data/fontMetrics.ts";
import {
  SCRIPT,
  SCRIPTSCRIPT,
  type Style,
  TEXT,
} from "../style.ts";
import {
  type Box,
  glyphBox,
  type GlyphBox,
  listBox,
  type Placed,
  scaledGlyph,
} from "./box.ts";

const LAP = 0.008; // overlap between stacked pieces, in em
export const SIZE_TO_MAX_HEIGHT = [0, 1.2, 1.8, 2.4, 3.0];

const STACK_LARGE = new Set([
  "(", "\\lparen", ")", "\\rparen",
  "[", "\\lbrack", "]", "\\rbrack",
  "\\{", "\\lbrace", "\\}", "\\rbrace",
  "\\lfloor", "\\rfloor", "⌊", "⌋",
  "\\lceil", "\\rceil", "⌈", "⌉",
  "\\surd",
]);
// Delimiters not in STACK_LARGE or STACK_NEVER always stack (SEQ_ALWAYS).
const STACK_NEVER = new Set([
  "<", ">", "\\langle", "\\rangle", "/", "\\backslash", "\\lt", "\\gt",
]);

type Delim =
  | { type: "small"; style: Style }
  | { type: "large"; size: 1 | 2 | 3 | 4 }
  | { type: "stack" };

const SMALL_TEXT: Delim = { type: "small", style: TEXT };
const SMALL_SCRIPT: Delim = { type: "small", style: SCRIPT };
const SMALL_SS: Delim = { type: "small", style: SCRIPTSCRIPT };
const L1: Delim = { type: "large", size: 1 };
const L2: Delim = { type: "large", size: 2 };
const L3: Delim = { type: "large", size: 3 };
const L4: Delim = { type: "large", size: 4 };
const STACK: Delim = { type: "stack" };

const SEQ_NEVER: Delim[] = [SMALL_SS, SMALL_SCRIPT, SMALL_TEXT, L1, L2, L3, L4];
const SEQ_ALWAYS: Delim[] = [SMALL_SS, SMALL_SCRIPT, SMALL_TEXT, STACK];
const SEQ_LARGE: Delim[] = [SMALL_SS, SMALL_SCRIPT, SMALL_TEXT, L1, L2, L3, L4, STACK];

function glyphChar(s: string): string {
  return mathSymbols[s]?.char ?? s;
}

function delimFont(d: Delim): FontVariant {
  if (d.type === "small") return "Main-Regular";
  if (d.type === "large") return (`Size${d.size}-Regular`) as FontVariant;
  return "Size4-Regular";
}

interface HD {
  height: number;
  depth: number;
}

function metricHD(char: string, font: FontVariant): HD {
  const m = getCharacterMetrics(char, font, 1);
  if (!m) return { height: 0, depth: 0 };
  return { height: m.height, depth: m.depth };
}

/** Normalize the angle-bracket aliases used in delimiter context. */
function normalize(delim: string): string {
  if (delim === "<" || delim === "\\lt" || delim === "⟨") return "\\langle";
  if (delim === ">" || delim === "\\gt" || delim === "⟩") return "\\rangle";
  return delim;
}

/** Pick the surd size (small / large-n / stack) that covers `minHeight`. */
export function chooseSurd(
  minHeight: number,
  style: Style,
): { type: "small" } | { type: "large"; size: number } | { type: "stack" } {
  return traverse("\\surd", minHeight, SEQ_LARGE, style);
}

function traverse(delim: string, height: number, seq: Delim[], style: Style): Delim {
  const start = Math.min(2, 3 - style.styleSize);
  for (let i = start; i < seq.length; i++) {
    const d = seq[i];
    if (d.type === "stack") break;
    const { height: h, depth } = metricHD(glyphChar(delim), delimFont(d));
    let hd = h + depth;
    if (d.type === "small") hd *= d.style.sizeMultiplier;
    if (hd > height) return d;
  }
  return seq[seq.length - 1];
}

/** Re-center a single delimiter glyph on the math axis. */
function centerGlyph(g: GlyphBox, axisHeight: number): Box {
  const total = g.height + g.depth;
  const newHeight = total / 2 + axisHeight;
  // Shift the glyph baseline so its vertical center lands on the axis.
  const dy = g.height - newHeight;
  return listBox([{ box: g, dx: 0, dy }], { width: g.width });
}

/** A plain (non-centered) glyph delimiter at the given face. */
function singleGlyph(
  delim: string,
  font: FontVariant,
  sizeMult: number,
  center: boolean,
  axisHeight: number,
): Box {
  const g = glyphBox(glyphChar(delim), font, sizeMult, null);
  return center ? centerGlyph(g, axisHeight) : g;
}

/**
 * Build a delimiter sized to `targetHeight` (em) at `style`. `center` (for
 * `\left`/`\right`) re-centers on the axis; sized delimiters (`\big`) don't.
 */
export function makeDelimiter(
  delim: string,
  targetHeight: number,
  style: Style,
  center: boolean,
): Box {
  delim = normalize(delim);
  if (delim === "." || delim === "") {
    // A null delimiter occupies nulldelimiterspace (0.12em) and draws nothing.
    return listBox([], { width: 0.12 });
  }

  const seq = STACK_NEVER.has(delim)
    ? SEQ_NEVER
    : STACK_LARGE.has(delim)
      ? SEQ_LARGE
      : SEQ_ALWAYS;
  const chosen = traverse(delim, targetHeight, seq, style);
  const axisHeight = style.metrics().axisHeight * style.sizeMultiplier;

  if (chosen.type === "small") {
    return singleGlyph(
      delim,
      "Main-Regular",
      chosen.style.sizeMultiplier,
      center,
      axisHeight,
    );
  }
  if (chosen.type === "large") {
    return singleGlyph(delim, delimFont(chosen), 1, center, axisHeight);
  }
  return makeStacked(delim, targetHeight, axisHeight);
}

interface StackParts {
  top: string;
  middle: string | null;
  bottom: string;
  repeat: string;
  font: FontVariant;
}

/** Glyph pieces and font for an extensible delimiter (KaTeX's big switch). */
function stackParts(delim: string): StackParts {
  const size4: FontVariant = "Size4-Regular";
  const size1: FontVariant = "Size1-Regular";
  switch (delim) {
    case "\\uparrow":
      return { top: "\\uparrow", repeat: "⏐", bottom: "⏐", middle: null, font: size1 };
    case "\\Uparrow":
      return { top: "\\Uparrow", repeat: "‖", bottom: "‖", middle: null, font: size1 };
    case "\\downarrow":
      return { top: "⏐", repeat: "⏐", bottom: "\\downarrow", middle: null, font: size1 };
    case "\\Downarrow":
      return { top: "‖", repeat: "‖", bottom: "\\Downarrow", middle: null, font: size1 };
    case "\\updownarrow":
      return { top: "\\uparrow", repeat: "⏐", bottom: "\\downarrow", middle: null, font: size1 };
    case "\\Updownarrow":
      return { top: "\\Uparrow", repeat: "‖", bottom: "\\Downarrow", middle: null, font: size1 };
    case "|": case "\\lvert": case "\\rvert": case "\\vert":
      return { top: "∣", repeat: "∣", bottom: "∣", middle: null, font: size1 };
    case "\\|": case "\\lVert": case "\\rVert": case "\\Vert":
      return { top: "∥", repeat: "∥", bottom: "∥", middle: null, font: size1 };
    case "[": case "\\lbrack":
      return { top: "⎡", repeat: "⎢", bottom: "⎣", middle: null, font: size4 };
    case "]": case "\\rbrack":
      return { top: "⎤", repeat: "⎥", bottom: "⎦", middle: null, font: size4 };
    case "\\lfloor": case "⌊":
      return { top: "⎢", repeat: "⎢", bottom: "⎣", middle: null, font: size4 };
    case "\\rfloor": case "⌋":
      return { top: "⎥", repeat: "⎥", bottom: "⎦", middle: null, font: size4 };
    case "\\lceil": case "⌈":
      return { top: "⎡", repeat: "⎢", bottom: "⎢", middle: null, font: size4 };
    case "\\rceil": case "⌉":
      return { top: "⎤", repeat: "⎥", bottom: "⎥", middle: null, font: size4 };
    case "(": case "\\lparen":
      return { top: "⎛", repeat: "⎜", bottom: "⎝", middle: null, font: size4 };
    case ")": case "\\rparen":
      return { top: "⎞", repeat: "⎟", bottom: "⎠", middle: null, font: size4 };
    case "\\{": case "\\lbrace":
      return { top: "⎧", middle: "⎨", bottom: "⎩", repeat: "⎪", font: size4 };
    case "\\}": case "\\rbrace":
      return { top: "⎫", middle: "⎬", bottom: "⎭", repeat: "⎪", font: size4 };
    case "\\lgroup": case "⟮":
      return { top: "⎧", bottom: "⎩", repeat: "⎪", middle: null, font: size4 };
    case "\\rgroup": case "⟯":
      return { top: "⎫", bottom: "⎭", repeat: "⎪", middle: null, font: size4 };
    case "\\lmoustache": case "⎰":
      return { top: "⎧", bottom: "⎭", repeat: "⎪", middle: null, font: size4 };
    case "\\rmoustache": case "⎱":
      return { top: "⎫", bottom: "⎩", repeat: "⎪", middle: null, font: size4 };
    default:
      return { top: delim, repeat: delim, bottom: delim, middle: null, font: size1 };
  }
}

function makeStacked(delim: string, heightTotal: number, axisHeight: number): Box {
  const p = stackParts(delim);
  const topG = glyphBox(glyphChar(p.top), p.font, 1, null);
  const botG = glyphBox(glyphChar(p.bottom), p.font, 1, null);
  const repHD = metricHD(glyphChar(p.repeat), p.font);
  const repeatTotal = repHD.height + repHD.depth;
  const topTotal = topG.height + topG.depth;
  const botTotal = botG.height + botG.depth;

  let middleTotal = 0;
  let middleFactor = 1;
  let midG: GlyphBox | null = null;
  if (p.middle !== null) {
    midG = glyphBox(glyphChar(p.middle), p.font, 1, null);
    middleTotal = midG.height + midG.depth;
    middleFactor = 2;
  }

  const minHeight = topTotal + botTotal + middleTotal;
  const repeatCount = Math.max(
    0,
    Math.ceil((heightTotal - minHeight) / (middleFactor * repeatTotal)),
  );
  const realHeight = minHeight + repeatCount * middleFactor * repeatTotal;
  const depth = realHeight / 2 - axisHeight;

  const yBottom = depth; // bottom edge, baseline-relative (down +)
  const yTop = depth - realHeight; // top edge

  const children: Placed[] = [];
  // Top and bottom glyphs anchored to the extremes.
  children.push({ box: topG, dx: 0, dy: yTop + topG.height });
  children.push({ box: botG, dx: 0, dy: yBottom - botG.depth });

  const width = Math.max(topG.width, botG.width, midG?.width ?? 0);

  const fillRepeat = (regTop: number, regBot: number) => {
    const innerH = regBot - regTop;
    if (innerH <= 0 || repeatTotal <= 0) return;
    const yScale = innerH / repeatTotal;
    const rep = glyphBox(glyphChar(p.repeat), p.font, 1, null);
    const baseline = regTop + repHD.height * yScale;
    children.push({ box: scaledGlyph(rep, yScale), dx: 0, dy: baseline });
  };

  if (midG) {
    const yCenter = (yTop + yBottom) / 2;
    children.push({
      box: midG,
      dx: 0,
      dy: yCenter + (midG.height - midG.depth) / 2,
    });
    // Two repeat regions, between top↔middle and middle↔bottom.
    fillRepeat(yTop + topTotal - LAP, yCenter - middleTotal / 2 + LAP);
    fillRepeat(yCenter + middleTotal / 2 - LAP, yBottom - botTotal + LAP);
  } else {
    fillRepeat(yTop + topTotal - LAP, yBottom - botTotal + LAP);
  }

  return listBox(children, { width });
}
