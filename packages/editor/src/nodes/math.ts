/**
 * Math rendering adapter — backed by `@cypherkit/tex`, the canvas-native LaTeX
 * engine. Replaces the former MathJax pipeline (SVG → bitmap → drawImage): the
 * engine lays out a formula synchronously from a metric data table and paints it
 * straight onto the canvas with `fillText`/`fillRect`, so there is no async
 * render, no per-color bitmap cache, and no 3.5 MB bundle.
 *
 * The block/inline nodes paint directly via `layoutMath` + `paintMath` (see
 * `MathNode`/`MathMark`); this module exposes only the small surface the rest of
 * the editor needs: inline dimensions (for line layout), an SVG string (for the
 * React edit overlay and HTML export), and a validity check.
 */
import { getInlineMathSpans, type InlineMathSpan } from "../inline-math-spans";
import type { CaretMotion } from "../rendering/nodes/caret-model";
import type { Block } from "../serlization/loadPage";
import type {
  CaretDeleteUnit,
  CaretScratch,
  ContentMaterialization,
  TypedInputTransform,
} from "../state-types";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import {
  caretRect as texCaretRect,
  caretStops as texCaretStops,
  caretVertical as texCaretVertical,
  hitTest as texHitTest,
  isValidLatex,
  layoutMath,
  type MathUnit,
  needsCommandSeparator as texNeedsCommandSeparator,
  normalizeLatex as texNormalizeLatex,
  pendingCommandRange as texPendingCommandRange,
  toSVG,
  unitAfter as texUnitAfter,
  unitBefore as texUnitBefore,
} from "@cypherkit/tex";

export { isValidLatex };
export type { MathUnit };

// ─── Caret / edit model ──────────────────────────────────────────────────────
//
// The math-specific answers behind the generic caret/edit seam (see the hooks on
// Node/Mark). MathNode wires these for a block equation (the block's char-run
// text IS the LaTeX) and MathMark for an inline chip (the chip's visible chars
// ARE its LaTeX, so a chip-local offset is `blockIndex − span.startIndex`). They
// live here so ALL math editing stays funneled through this one adapter rather
// than scattered across `selection`/`actions`. Each is pure over its block.

/** Inline font size for the vertical-nav layout. Geometry is size-invariant, so
 * the returned source offset doesn't depend on the exact value. */
const INLINE_NAV_FONT_SIZE = 18;

/** The block's full LaTeX source (its visible char-run text). Only the math
 * block branch calls this; a non-textual block (no char runs) has none. */
function blockLatex(block: Block): string {
  return "charRuns" in block ? getVisibleTextFromRuns(block.charRuns) : "";
}

/** The inline-math chip covering `index` per `mode`, or null. */
function chipAt(
  block: Block,
  index: number,
  mode: "leftEdge" | "rightEdge" | "inside",
): InlineMathSpan | null {
  for (const span of getInlineMathSpans(block)) {
    if (mode === "leftEdge" && index === span.startIndex) return span;
    if (mode === "rightEdge" && index === span.endIndex) return span;
    if (mode === "inside" && index > span.startIndex && index < span.endIndex)
      return span;
  }
  return null;
}

function pickStop(
  stops: number[],
  origin: number,
  dir: "left" | "right",
): number | null {
  return dir === "right"
    ? (stops.find((o) => o > origin) ?? null)
    : (stops
        .slice()
        .reverse()
        .find((o) => o < origin) ?? null);
}

/**
 * The next legal caret index stepping `dir` from `index` in math content — a
 * block equation, or an inline-math chip the caret is inside (or entering from
 * the edge in the travel direction). Math commands/constructs are atomic for the
 * caret (a command's glyphs all carry its whole span, so `\int` stops only at its
 * edges), so this snaps over a whole token raw ±1 stepping would land *inside*.
 * Returns `null` in plain text (caller does its ±1) — including stepping off a
 * chip's far edge into the surrounding text.
 */
export function mathCaretStep(
  block: Block,
  index: number,
  dir: "left" | "right",
): number | null {
  if (block.type === "math") {
    return pickStop(mathCaretOffsets(blockLatex(block)), index, dir);
  }
  for (const span of getInlineMathSpans(block)) {
    const inside =
      dir === "right"
        ? index >= span.startIndex && index < span.endIndex
        : index > span.startIndex && index <= span.endIndex;
    if (!inside) continue;
    const local = pickStop(
      mathCaretOffsets(span.latex),
      index - span.startIndex,
      dir,
    );
    return local == null ? null : span.startIndex + local;
  }
  return null;
}

/**
 * Vertical caret motion one row `dir` *within* math content (a fraction's
 * numerator ↔ denominator, a base ↔ its script), or `null` when there is no row
 * beyond `index` — the caller then leaves the formula via ordinary line nav.
 */
export function mathCaretVerticalStep(
  block: Block,
  index: number,
  dir: "up" | "down",
): number | null {
  if (block.type === "math") {
    return getBlockMathOffsetVertical(blockLatex(block), index, dir);
  }
  const span = chipAt(block, index, "inside");
  if (!span) return null;
  const local = getInlineMathOffsetVertical(
    span.latex,
    INLINE_NAV_FONT_SIZE,
    index - span.startIndex,
    dir,
  );
  return local === null ? null : span.startIndex + local;
}

/**
 * Pull a word-navigation `target` out of the middle of a math token: a block
 * equation is one "word" (jump to its near/far edge — 0 or its length); a target
 * strictly inside an inline chip clamps to the chip edge in travel direction.
 * Returns `null` when `target` isn't inside math content (caller uses it as-is).
 */
export function mathCaretTokenClamp(
  block: Block,
  target: number,
  dir: "left" | "right",
): number | null {
  if (block.type === "math") {
    return dir === "right" ? blockLatex(block).length : 0;
  }
  const span = chipAt(block, target, "inside");
  if (!span) return null;
  return dir === "right" ? span.endIndex : span.startIndex;
}

/**
 * Resolve a unified {@link CaretMotion} for math content — the one `move` the
 * `CaretModel` exposes, routing each motion to the corresponding step helper
 * (horizontal token-step, word-step to a chip edge, vertical row-step). Shared
 * by MathNode (block equations) and MathMark (inline chips).
 */
export function mathCaretMove(
  block: Block,
  index: number,
  motion: CaretMotion,
): number | null {
  switch (motion) {
    case "charLeft":
      return mathCaretStep(block, index, "left");
    case "charRight":
      return mathCaretStep(block, index, "right");
    case "wordLeft":
      return mathCaretTokenClamp(block, index, "left");
    case "wordRight":
      return mathCaretTokenClamp(block, index, "right");
    case "up":
      return mathCaretVerticalStep(block, index, "up");
    case "down":
      return mathCaretVerticalStep(block, index, "down");
  }
}

/**
 * The math editing unit adjacent to the caret to delete/select. In a block
 * equation it's the unit before/after the caret. In a chip it's the chip's own
 * unit — including the unit at the chip's first/last char, which deletes just
 * that unit and leaves the rest of the chip a valid span (`getInlineMathSpans`
 * resolves endpoints tolerantly, so dropping a leading/trailing anchor char no
 * longer strands the rest). The one whole-chip case is the caret sitting just
 * past the chip, where it's atomic from outside. `null` when the caret isn't in
 * math content.
 */
export function mathDeleteUnit(
  block: Block,
  index: number,
  dir: "backward" | "forward",
): CaretDeleteUnit | null {
  const asUnit = (u: MathUnit): CaretDeleteUnit => ({
    from: u.start,
    to: u.end,
    isConstruct: u.isConstruct,
  });

  if (dir === "backward") {
    if (index <= 0) return null;
    if (block.type === "math") {
      const u = mathUnitBefore(blockLatex(block), index);
      return u ? asUnit(u) : null;
    }
    const rightEdge = chipAt(block, index, "rightEdge");
    if (rightEdge)
      return {
        from: rightEdge.startIndex,
        to: rightEdge.endIndex,
        isConstruct: false,
      };
    const inside = chipAt(block, index, "inside");
    if (inside) {
      const u = mathUnitBefore(inside.latex, index - inside.startIndex);
      if (u) {
        return {
          from: inside.startIndex + u.start,
          to: inside.startIndex + u.end,
          isConstruct: u.isConstruct,
        };
      }
    }
    return null;
  }

  // forward
  if (block.type === "math") {
    const u = mathUnitAfter(blockLatex(block), index);
    return u ? asUnit(u) : null;
  }
  const leftEdge = chipAt(block, index, "leftEdge");
  if (leftEdge)
    return {
      from: leftEdge.startIndex,
      to: leftEdge.endIndex,
      isConstruct: false,
    };
  const inside = chipAt(block, index, "inside");
  if (inside) {
    const u = mathUnitAfter(inside.latex, index - inside.startIndex);
    if (u) {
      return {
        from: inside.startIndex + u.start,
        to: inside.startIndex + u.end,
        isConstruct: u.isConstruct,
      };
    }
  }
  return null;
}

/**
 * Rewrite a typed char in math content: insert a space before a letter typed
 * right after a complete command (`\oint`+`x` → `\oint x`, never the unknown
 * `\ointx`), and — inside an inline chip — flag that inline-markdown must be
 * suppressed (a stray `$`/`*` can't reinterpret the formula). `null` outside math
 * or when nothing needs doing.
 */
export function mathTransformTypedInput(
  block: Block,
  index: number,
  input: string,
): TypedInputTransform | null {
  let latex: string | null = null;
  let offset = index;
  let insideChip = false;
  if (block.type === "math") {
    latex = blockLatex(block);
  } else {
    const chip = chipAt(block, index, "inside");
    if (chip) {
      latex = chip.latex;
      offset = index - chip.startIndex;
      insideChip = true;
    }
  }
  if (latex === null) return null;
  const out =
    input.length === 1 && mathNeedsCommandSeparator(latex, offset, input)
      ? " " + input
      : input;
  if (insideChip) return { input: out, suppressMarkdown: true };
  // Block equation: only contribute when the separator actually changed the input.
  return out === input ? null : { input: out };
}

/**
 * The caret-anchored scratch arming literal command rendering when the caret sits
 * at the trailing edge of a control word being typed in math content, else `null`.
 * Read back via `isCaretScratchActive`. Purely cosmetic.
 */
export function mathArmScratch(
  block: Block,
  index: number,
): CaretScratch | null {
  let latex: string | null = null;
  let offset = index;
  if (block.type === "math") {
    latex = blockLatex(block);
  } else {
    const chip = chipAt(block, index, "inside");
    if (chip) {
      latex = chip.latex;
      offset = index - chip.startIndex;
    }
  }
  if (latex === null || !mathPendingCommandRange(latex, offset)) return null;
  return { type: "math", blockId: block.id, offset: index };
}

/**
 * Materialize any incomplete construct an edit at `index` just created into its
 * canonical placeholder form — typing `\frac` fills in `\frac{}{}` and drops the
 * caret in the numerator, the same shape the `\` command menu inserts. The braces
 * are real source text (so each slot gets a distinct, navigable caret offset);
 * the host applies the returned inserts as CRDT ops within the same edit, keeping
 * collaborators consistent. `null` when nothing needs filling (the common case)
 * or the caret isn't in math content. Idempotent — a fully-braced formula is left
 * alone, so this never fights a user typing braces manually.
 */
export function mathMaterializeAfterInput(
  block: Block,
  index: number,
): ContentMaterialization | null {
  if (block.type === "math") {
    const n = texNormalizeLatex(blockLatex(block));
    if (!n.changed) return null;
    return { inserts: n.inserts, caret: n.mapCaret(index) };
  }
  // Inline chip: the caret is inside the chip (or just past its last char after
  // typing). The chip's visible chars ARE its LaTeX, so map chip-local offsets
  // back to block indices via the chip's start.
  for (const span of getInlineMathSpans(block)) {
    if (index <= span.startIndex || index > span.endIndex) continue;
    const local = index - span.startIndex;
    const n = texNormalizeLatex(span.latex);
    if (!n.changed) return null;
    return {
      inserts: n.inserts.map((i) => ({
        at: span.startIndex + i.at,
        text: i.text,
      })),
      caret: span.startIndex + n.mapCaret(local),
    };
  }
  return null;
}

/**
 * Source range of a command being typed right at `caret` (`\al` heading to
 * `\alpha`), or null. The renderer paints glyphs in this range in normal text
 * color instead of the red "unknown command" placeholder — the command is in
 * progress, not yet an error. Wraps the tex resolver so math edits stay funneled
 * through this adapter.
 */
export function mathPendingCommandRange(
  latex: string,
  caret: number,
): { start: number; end: number } | null {
  return texPendingCommandRange(latex, caret);
}

/**
 * Whether typing `char` at `offset` in a math source should be separated from a
 * preceding command by a space — so a letter typed right after a complete
 * operator (`\oint` + `x`) becomes a new atom (`\oint x` → ∮x) instead of
 * corrupting it into the unknown `\ointx`. Wraps the tex resolver so the editor
 * keeps funneling math edits through this adapter. Returns false while a command
 * is still being typed (so `\in`→`\infty` etc. are never interrupted).
 */
export function mathNeedsCommandSeparator(
  latex: string,
  offset: number,
  char: string,
): boolean {
  return texNeedsCommandSeparator(latex, offset, char);
}

/**
 * The editing unit adjacent to a caret at `offset` in a LaTeX source (a math
 * block's whole text, or a chip's) — the `[start, end)` range the editor turns
 * into a selection. A multi-part construct (`isConstruct`) is selected first; a
 * plain leaf (a character, `\sin`) is deleted outright. Wraps the tex resolver so
 * the editor's edit actions stay funneled through this adapter rather than
 * importing `@cypherkit/tex` directly. `null` at the source boundary.
 */
export function mathUnitBefore(latex: string, offset: number): MathUnit | null {
  return texUnitBefore(latex, offset);
}

export function mathUnitAfter(latex: string, offset: number): MathUnit | null {
  return texUnitAfter(latex, offset);
}

/**
 * The legal caret source offsets within a LaTeX string, sorted ascending — the
 * positions the caret may rest at. A multi-character command (`\int`, `\sin`)
 * lays out as glyphs that all carry the *whole* command's span, so it yields
 * stops only at its edges, never between its letters: stepping the caret over
 * these (rather than ±1 through the raw source) is what keeps a command atomic,
 * so it can never be split into `\in` by a delete or `\inxt` by a keystroke. The
 * source boundaries `0` and `latex.length` are always included so the caret can
 * sit before/after the whole equation (and step out to an adjacent block).
 */
export function mathCaretOffsets(latex: string): number[] {
  const set = new Set<number>([0, latex.length]);
  if (latex) {
    const l = layoutMath(latex, { fontSize: 16, displayMode: false });
    for (const stop of texCaretStops(l)) set.add(stop.offset);
  }
  return [...set].sort((a, b) => a - b);
}

export interface InlineMathDims {
  width: number;
  height: number;
  /** Distance the formula hangs below the text baseline, in CSS pixels. */
  depthBelowBaseline: number;
}

/**
 * Inline math dimensions in CSS pixels for a font size. Synchronous and exact
 * (metrics are a data table, not an async measurement). Returns null for empty
 * input.
 */
export function getInlineMathDims(
  latex: string,
  fontSize: number,
  literalRange?: { start: number; end: number },
): InlineMathDims | null {
  if (!latex) return null;
  const l = layoutMath(latex, { fontSize, displayMode: false, literalRange });
  return {
    width: l.width,
    height: l.height + l.depth,
    depthBelowBaseline: l.depth,
  };
}

/**
 * Live-edit bridge — map between a caret offset into a chip's LaTeX source and a
 * horizontal pixel position within the rendered formula. The chip's visible
 * characters ARE its LaTeX source (see {@link getInlineMathSpans}), so a caret
 * offset here is just `blockTextIndex − spanStart`. This is what lets the editor
 * place a real caret *inside* an inline-math chip instead of treating it as one
 * atomic unit. Both wrap `@cypherkit/tex`'s caret primitives; layout is cached
 * by `getInlineMathDims`'s metric cache, so re-laying out per call is cheap.
 */

/**
 * X position (CSS px, from the chip's left edge) of the caret for source
 * `offset` (0 … latex.length). Returns 0 for empty input / no caret stops.
 */
export function getInlineMathCaretX(
  latex: string,
  fontSize: number,
  offset: number,
): number {
  if (!latex) return 0;
  const l = layoutMath(latex, { fontSize, displayMode: false });
  return texCaretRect(l, offset)?.x ?? 0;
}

/** Caret rectangle in a chip for `offset`. */
export interface InlineMathCaretRect {
  /** X from the chip's left edge, CSS px. */
  readonly x: number;
  /** Top of the caret relative to the chip baseline (negative = above), CSS px. */
  readonly top: number;
  /** Bottom of the caret relative to the chip baseline (positive = below), CSS px. */
  readonly bottom: number;
}

/**
 * Full caret geometry for source `offset` — its x AND its vertical extent at
 * that position, both relative to the chip (x from the left edge, top/bottom
 * from the baseline, +y down). This is what sizes the caret to the *row* it sits
 * on: short inside a subscript, tall across a fraction's numerator, instead of
 * spanning the whole text line. Returns null for empty input / no caret stops.
 */
export function getInlineMathCaretRect(
  latex: string,
  fontSize: number,
  offset: number,
  literalRange?: { start: number; end: number },
): InlineMathCaretRect | null {
  if (!latex) return null;
  const l = layoutMath(latex, { fontSize, displayMode: false, literalRange });
  const r = texCaretRect(l, offset);
  return r ? { x: r.x, top: r.top, bottom: r.bottom } : null;
}

/**
 * Source offset (0 … latex.length) nearest a point local to the chip — `localX`
 * is measured from the chip's left edge, `localY` from the text baseline (+y
 * down). For a single-row formula `localY` 0 (the baseline) suffices; vertical
 * disambiguation (e.g. clicking a fraction's denominator) lands in a later step.
 */
export function getInlineMathOffsetAtX(
  latex: string,
  fontSize: number,
  localX: number,
  localY = 0,
): number {
  if (!latex) return 0;
  const l = layoutMath(latex, { fontSize, displayMode: false });
  return texHitTest(l, localX, localY);
}

/**
 * Source offset one visual row up/down from `offset` inside a chip, keeping the
 * caret's column (`offset`'s own x). Returns null when the formula has no stop
 * in that direction — the caller then leaves the chip and does normal line
 * navigation. This is the vertical caret motion through stacked constructs (a
 * fraction's numerator ↔ denominator, a base ↔ its script).
 */
export function getInlineMathOffsetVertical(
  latex: string,
  fontSize: number,
  offset: number,
  dir: "up" | "down",
): number | null {
  if (!latex) return null;
  const l = layoutMath(latex, { fontSize, displayMode: false });
  const x = texCaretRect(l, offset)?.x ?? 0;
  return texCaretVertical(l, offset, dir, x);
}

/**
 * Source offset one visual row up/down from `offset` inside a block (display)
 * equation, keeping the caret's column. Same as {@link getInlineMathOffsetVertical}
 * but laid out in display mode (so big-operator limits stack and the script
 * shifts match what the block paints). Returns null when there is no stop in
 * that direction — the caller then exits the block to the adjacent line. The
 * font size only scales the geometry, so the returned offset is size-invariant.
 */
export function getBlockMathOffsetVertical(
  latex: string,
  offset: number,
  dir: "up" | "down",
): number | null {
  if (!latex) return null;
  const l = layoutMath(latex, { fontSize: 22, displayMode: true });
  const x = texCaretRect(l, offset)?.x ?? 0;
  return texCaretVertical(l, offset, dir, x);
}

/**
 * Render LaTeX to an SVG string (used by the React edit overlay's live preview
 * and by HTML export). `color` defaults to `currentColor` so the SVG inherits
 * the surrounding text color. The `<text>` elements reference the engine's font
 * families, which the host loads via `@cypherkit/tex`'s `loadFonts`.
 */
export function renderToSVG(
  latex: string,
  displayMode: boolean,
  fontSize = displayMode ? 22 : 18,
  color = "currentColor",
): string {
  const l = layoutMath(latex, { fontSize, displayMode });
  return toSVG(l, { color });
}
