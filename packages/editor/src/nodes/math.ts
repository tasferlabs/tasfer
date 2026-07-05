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
import { isTouchDevice } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
// All math layout goes through the host-wired entry so `\text{…}` characters the
// math fonts can't render (CJK, …) are measured/typeset via the host font.
import { layoutMathHost as layoutMath } from "./tex-host";
import {
  backslashFusesWith as texBackslashFusesWith,
  balanceBraces as texBalanceBraces,
  breakpoints as texBreakpoints,
  canRenderMathChar,
  caretRect as texCaretRect,
  type CaretStop,
  caretStops as texCaretStops,
  caretVertical as texCaretVertical,
  escapeTypedBrace as texEscapeTypedBrace,
  hitTest as texHitTest,
  isInsideConstruct as texIsInsideConstruct,
  isRedundantSpace as texIsRedundantSpace,
  isValidLatex,
  type MathLayout,
  type MathUnit,
  type MatrixContext,
  matrixContextAt as texMatrixContextAt,
  type MatrixEditResult,
  matrixResize as texMatrixResize,
  type MatrixTextEdit,
  needsCommandSeparator as texNeedsCommandSeparator,
  normalizeLatex as texNormalizeLatex,
  pendingCommandRange as texPendingCommandRange,
  resolveSelectionRange as texResolveSelectionRange,
  scriptAttachOffset as texScriptAttachOffset,
  selectionRects as texSelectionRects,
  spanAtPoint as texSpanAtPoint,
  toSVG,
  typedBraceSkipsCloser as texTypedBraceSkipsCloser,
  unitAfter as texUnitAfter,
  unitAt as texUnitAt,
  unitBefore as texUnitBefore,
} from "@cypherkit/tex";

export { isValidLatex };
export type { MathUnit, MatrixContext, MatrixEditResult, MatrixTextEdit };

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
 * Whether the caret at source `offset` sits on the `dir` edge of a math source —
 * i.e. there is no further caret stop in that direction, so stepping `dir` would
 * leave the formula. `latex`/`offset` are source-relative: a block equation's
 * whole LaTeX with the block offset, or an inline chip's own LaTeX with the
 * chip-local offset. Mirrors the boundary {@link mathCaretStep} hits (both key
 * off {@link mathCaretOffsets} + `pickStop`), so a host can grey out a
 * step-left/right control exactly when that step would exit the math.
 */
export function mathSourceAtEdge(
  latex: string,
  offset: number,
  dir: "left" | "right",
): boolean {
  return pickStop(mathCaretOffsets(latex), offset, dir) === null;
}

/**
 * The tabular construct (`matrix`/`pmatrix`/`cases`/`aligned`/`array`/…) enclosing
 * `offset` in a math source, and the `(row, col)` of the cell the caret sits in —
 * or null when the caret is not inside a grid. `latex`/`offset` are source-
 * relative like {@link mathSourceAtEdge}: a block equation's whole LaTeX with the
 * block offset, or an inline chip's own LaTeX with the chip-local offset. A host
 * uses this to decide whether to offer the matrix row/column controls.
 */
export function mathMatrixContext(
  latex: string,
  offset: number,
): MatrixContext | null {
  return texMatrixContextAt(latex, offset);
}

/**
 * The source rewrite that resizes the grid enclosing `offset` to `rows` × `cols`,
 * or null when the caret is not inside one. Returns a `{ start, end }` span into
 * `latex` to replace with `text`, plus the `caret` offset to place afterward —
 * all source-relative (add a chip's `startIndex` for inline math). Growing adds
 * empty cells; shrinking trims from the bottom/right; the grid never drops below
 * 1×1.
 */
export function mathMatrixResize(
  latex: string,
  offset: number,
  rows: number,
  cols: number,
): MatrixEditResult | null {
  return texMatrixResize(latex, offset, rows, cols);
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
    // Prefer the equation's actual rendered layout off the block's render cache:
    // when it wrapped onto several rows, vertical motion must step between THOSE
    // rows (not a hypothetical single-row layout), so up/down walks a broken
    // equation line by line exactly as painted. Falls back to a fresh single-row
    // layout before the first paint has populated the cache.
    const cached = (
      block as { cachedLayout?: { mathLayout?: MathLayout | null } }
    ).cachedLayout;
    const ml = cached?.mathLayout;
    if (ml) {
      const x = texCaretRect(ml, index)?.x ?? 0;
      return texCaretVertical(ml, index, dir, x);
    }
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
 * The unit a backward delete acts on at `offset`, accounting for a command-
 * separator space. Normally just {@link mathUnitBefore}; but the separator space
 * in `\degree C` (or `\sin x`) is absorbed into the preceding command's token, so
 * it is a "dead" caret stop with no editing unit of its own. Deleting only that
 * space — the editor's generic fallback when no unit resolves — would weld the
 * control word onto the following letter (`\degree |C` → the unknown `\degreeC`).
 * Whenever that fusion would happen, take the whole command *together with* its
 * separator so the command stays atomic (`\degree |C` Backspace → `C`). An
 * ordinary inter-atom space (`a |b`) needs no separator, so it falls through to
 * the harmless fallback that merges them (`→ ab`).
 */
function separatorAwareUnitBefore(
  latex: string,
  offset: number,
): MathUnit | null {
  const u = mathUnitBefore(latex, offset);
  if (u) return u;
  if (
    offset > 0 &&
    latex[offset - 1] === " " &&
    mathNeedsCommandSeparator(latex, offset - 1, latex[offset] ?? "")
  ) {
    const cmd = mathUnitBefore(latex, offset - 1);
    if (cmd) return { start: cmd.start, end: offset, isConstruct: false };
  }
  return null;
}

/**
 * Forward counterpart of {@link separatorAwareUnitBefore}: a Delete sitting just
 * before a command-separator space takes the space together with the following
 * unit, so the preceding command can't fuse with it (`\degree| C` Delete →
 * `\degree`). Like the backward case, an ordinary inter-atom space is left to the
 * fallback (`a| b` Delete → `ab`).
 */
function separatorAwareUnitAfter(
  latex: string,
  offset: number,
): MathUnit | null {
  const u = mathUnitAfter(latex, offset);
  if (u) return u;
  if (
    latex[offset] === " " &&
    mathNeedsCommandSeparator(latex, offset, latex[offset + 1] ?? "")
  ) {
    const next = mathUnitAfter(latex, offset + 1);
    if (next) return { start: offset, end: next.end, isConstruct: false };
  }
  return null;
}

/**
 * The math editing unit adjacent to the caret to delete/select. In a block
 * equation it's the unit before/after the caret. In a chip it's the chip's own
 * unit — including the unit at the chip's first/last char, which deletes just
 * that unit and leaves the rest of the chip a valid span (`getInlineMathSpans`
 * resolves endpoints tolerantly, so dropping a leading/trailing anchor char no
 * longer strands the rest). A caret resting on a chip's outer edge (just past it
 * on Backspace, just before it on Delete) enters the chip and removes its
 * adjacent unit too — a chip is edited one unit at a time, never deleted whole
 * from outside. A command-separator space adjacent to the caret is deleted with
 * its command so it can never fuse into an unknown control word (see
 * {@link separatorAwareUnitBefore}). `null` when the caret isn't in math content.
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

  // A chip-local unit, re-based onto the surrounding block's coordinates.
  const chipUnit = (
    chip: InlineMathSpan,
    u: MathUnit | null,
  ): CaretDeleteUnit | null =>
    u
      ? {
          from: chip.startIndex + u.start,
          to: chip.startIndex + u.end,
          isConstruct: u.isConstruct,
        }
      : null;

  if (dir === "backward") {
    if (index <= 0) return null;
    if (block.type === "math") {
      const u = separatorAwareUnitBefore(blockLatex(block), index);
      return u ? asUnit(u) : null;
    }
    // Inside the chip: erase the unit before the caret.
    const inside = chipAt(block, index, "inside");
    if (inside) {
      return chipUnit(
        inside,
        separatorAwareUnitBefore(inside.latex, index - inside.startIndex),
      );
    }
    // Just past the chip's right edge: Backspace enters the chip and erases its
    // trailing unit — it is never deleted whole from outside.
    const edge = chipAt(block, index, "rightEdge");
    if (edge) return chipUnit(edge, chipTrailingUnit(edge.latex));
    return null;
  }

  // forward
  if (block.type === "math") {
    const u = separatorAwareUnitAfter(blockLatex(block), index);
    return u ? asUnit(u) : null;
  }
  // Inside the chip: erase the unit after the caret.
  const inside = chipAt(block, index, "inside");
  if (inside) {
    return chipUnit(
      inside,
      separatorAwareUnitAfter(inside.latex, index - inside.startIndex),
    );
  }
  // Just before the chip's left edge: Delete enters the chip and erases its
  // leading unit — it is never deleted whole from outside.
  const edge = chipAt(block, index, "leftEdge");
  if (edge) return chipUnit(edge, chipLeadingUnit(edge.latex));
  return null;
}

/**
 * The unit a Backspace at a chip's RIGHT edge removes — normally the chip's
 * trailing unit (`xy` → erase `y`). But a chip that is ITSELF one construct
 * (`\sqrt{a}`, `\frac{a}{b}`) must not be selected-then-deleted whole from
 * outside: that contradicts the chip model ("edited one unit at a time, never
 * deleted whole from outside"). So when the trailing unit is a construct
 * spanning the entire chip, drill in and chip off its innermost trailing leaf
 * (`a`) instead — the same leaf a Backspace just inside the chip would take.
 */
function chipTrailingUnit(latex: string): MathUnit | null {
  const u = mathUnitBefore(latex, latex.length);
  if (u && u.isConstruct && u.start === 0 && u.end === latex.length) {
    const stops = mathCaretOffsets(latex);
    const interior = stops[stops.length - 2]; // largest stop below the end
    if (interior !== undefined && interior > 0) {
      return mathUnitBefore(latex, interior) ?? u;
    }
  }
  return u;
}

/** The forward counterpart of {@link chipTrailingUnit} for the chip's LEFT edge. */
function chipLeadingUnit(latex: string): MathUnit | null {
  const u = mathUnitAfter(latex, 0);
  if (u && u.isConstruct && u.start === 0 && u.end === latex.length) {
    const stops = mathCaretOffsets(latex);
    const interior = stops[1]; // smallest stop above the start
    if (interior !== undefined && interior < latex.length) {
      return mathUnitAfter(latex, interior) ?? u;
    }
  }
  return u;
}

/**
 * A single code point the math fonts can't render but that IS real text (a
 * letter, number, punctuation, symbol or combining mark — CJK, kana, hangul,
 * emoji, …), so it belongs inside a `\text{…}` run rather than being dropped as
 * a latent math glyph. `ch` must be one code point (iterate the input with
 * `[...input]`). Control/format/whitespace code points are excluded.
 */
function isMathTextChar(ch: string): boolean {
  return !canRenderMathChar(ch) && /^[\p{L}\p{N}\p{P}\p{S}\p{M}]$/u.test(ch);
}

/**
 * Where to merge typed text into an existing `\text{…}` run at `offset` in
 * `latex`: the offset to insert at when the caret sits INSIDE a `\text{…}` body
 * or immediately after its closing brace, else `null` (caller emits a fresh
 * group). Braces nest, so the body scan tracks depth; an unterminated run
 * (mid-edit) extends to the source end.
 */
function textGroupInsertPoint(latex: string, offset: number): number | null {
  const marker = "\\text{";
  let from = 0;
  for (;;) {
    const start = latex.indexOf(marker, from);
    if (start === -1) return null;
    const bodyStart = start + marker.length;
    let depth = 1;
    let i = bodyStart;
    while (i < latex.length && depth > 0) {
      const c = latex[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const terminated = depth === 0;
    const braceEnd = i; // just past the closing `}` (or the source end)
    const bodyEnd = terminated ? i - 1 : i; // the `}` (or the end if unterminated)
    if (offset >= bodyStart && offset <= bodyEnd) return offset; // inside body
    if (terminated && offset === braceEnd) return bodyEnd; // just after `}`
    from = braceEnd;
  }
}

/**
 * Plan for wrapping typed text the math fonts can't render into a `\text{…}` run
 * at `offset` in `latex`, or `null` unless EVERY code point of `input` is such
 * text (see {@link isMathTextChar}) — so a single math keystroke or a mixed
 * insert falls through to the normal math path. Coordinates are the math
 * source's (chip-local for a chip); the caller maps them back to block indices.
 */
function planMathTextWrap(
  latex: string,
  offset: number,
  input: string,
): { input: string; insertAt: number; caret: number } | null {
  const cps = [...input];
  if (cps.length === 0 || !cps.every(isMathTextChar)) return null;
  const text = cps.join("");
  const merge = textGroupInsertPoint(latex, offset);
  if (merge !== null) {
    return { input: text, insertAt: merge, caret: merge + text.length };
  }
  const wrapped = `\\text{${text}}`;
  return { input: wrapped, insertAt: offset, caret: offset + wrapped.length };
}

/**
 * The interior offset of an EMPTY brace group the caret at `offset` sits
 * immediately AFTER (`…{}|` → the offset between its braces), or `null`. An empty
 * `{}` is always a placeholder slot — an empty super/subscript, radicand, or text
 * body — whose ghost box the user is meant to fill; typing or composing CONTENT
 * with the caret parked just past it (a stop that exists because the caret can
 * step out of the slot, and which sits visually almost on top of the interior for
 * a zero-width empty box) should drop that content INTO the slot, not on the
 * baseline beside it where it strands the empty box (`x^{}中`). Returns the
 * interior so the caller redirects the insertion there.
 */
function emptySlotInteriorBefore(latex: string, offset: number): number | null {
  return offset >= 2 && latex[offset - 1] === "}" && latex[offset - 2] === "{"
    ? offset - 1
    : null;
}

/**
 * Whether `input` is fillable CONTENT for {@link emptySlotInteriorBefore} — every
 * code point is renderable text (a letter/digit/CJK/emoji, wrapped or bare), not a
 * structural keystroke (`^` `_` `{` `}` `\`) that owns its own handling below (a
 * `^` typed at `x^{}|` must attach to `x`, never nest inside the empty slot).
 */
function isEmptySlotFillContent(input: string): boolean {
  const cps = [...input];
  return (
    cps.length > 0 &&
    cps.every(
      (ch) =>
        isMathTextChar(ch) || (canRenderMathChar(ch) && !"^_{}\\".includes(ch)),
    )
  );
}

/**
 * Rewrite a typed char in math content: wrap text the tex engine cannot render
 * as math (a CJK ideograph, kana, an emoji — otherwise a zero-width, caret-less
 * "latent" glyph) into a `\text{…}` run, drop the few remaining unrenderable
 * code points (control/format), insert a space before a letter typed right after
 * a complete command
 * (`\oint`+`x` → `\oint x`, never the unknown `\ointx`), escape a typed brace
 * to its literal form (`{` → `\{`, so the keystroke shows a brace glyph instead
 * of silently opening an invisible group — raw braces still pass through where
 * they're structural: completing a typed `\{`, opening a control word's
 * argument, closing a raw-opened group), redirect a script
 * (`^`/`_`) typed at the end of an accent's base or a super/subscript's filled
 * slot to just past the construct so it attaches as a whole (`\dot{x|}` + `^` →
 * `\dot{x}^`, not `\dot{x^{}}`; `x_{n|}` + `^` → `x_{n}^`, not `x_{n^{}}`), and — inside an inline
 * chip — flag that inline-markdown must be suppressed (a stray `$`/`*` can't
 * reinterpret the formula). `null` outside math or when nothing needs doing.
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
  const base = index - offset; // chip.startIndex (0 for a block equation)
  // The caret sits just past an EMPTY slot (`x^{}|`, `\sqrt{}|`) — content typed
  // or composed here fills the slot instead of landing on the baseline beside it
  // and stranding the empty placeholder box. Redirect the insertion into the
  // slot; CJK still wraps, so `x^{}|` + 中 → `x^{\text{中}}` and + a → `x^{a}`.
  // Structural keystrokes are excluded (see isEmptySlotFillContent) so a `^`
  // typed here still attaches to the base rather than nesting in the slot.
  const slot = emptySlotInteriorBefore(latex, offset);
  if (slot !== null && isEmptySlotFillContent(input)) {
    const wrap = planMathTextWrap(latex, slot, input);
    if (wrap) {
      return {
        input: wrap.input,
        insertAt: wrap.insertAt + base,
        caret: wrap.caret + base,
        ...(insideChip ? { suppressMarkdown: true } : {}),
      };
    }
    const renderable = [...input].filter(canRenderMathChar).join("");
    if (renderable.length > 0) {
      return {
        input: renderable,
        insertAt: slot + base,
        caret: slot + base + renderable.length,
        ...(insideChip ? { suppressMarkdown: true } : {}),
      };
    }
  }
  // Text the math fonts can't render (CJK, Japanese, …) is wrapped into a
  // `\text{…}` run — which the host font typesets (see `tex-host`) — instead of
  // being dropped. Fires only when the WHOLE insert is such text (the typical
  // IME commit); mixed math+text falls through to the math path below. When the
  // caret already sits in (or just after) a `\text{…}`, the chars merge into it.
  const textWrap = planMathTextWrap(latex, offset, input);
  if (textWrap) {
    return {
      input: textWrap.input,
      insertAt: textWrap.insertAt + base,
      caret: textWrap.caret + base,
      ...(insideChip ? { suppressMarkdown: true } : {}),
    };
  }
  // Discard unrenderable characters before they enter the document. Iterate by
  // code point so an astral char (emoji) is dropped whole, not split.
  const renderable = [...input].filter(canRenderMathChar).join("");
  if (renderable.length === 0) {
    // Every typed character is latent in math: swallow the keystroke (no op).
    return input.length === 0 ? null : { input: "" };
  }
  let out =
    renderable.length === 1 &&
    mathNeedsCommandSeparator(latex, offset, renderable)
      ? " " + renderable
      : renderable;
  // Typing the matching `}` when the group's auto-inserted closer already sits at
  // the caret (`\text{hi|}`, after the materializer closed the argument) steps
  // OVER that `}` instead of wedging in a literal `\}` — which would render a
  // stray brace (`\text{hi\}}` → "hi}"). No content changes; only the caret
  // advances past the existing closer, so natural `\text{hi}` typing stays clean.
  if (out === "}" && texTypedBraceSkipsCloser(latex, offset)) {
    const caret = index + 1; // just past the existing `}`
    return insideChip
      ? { input: "", suppressMarkdown: true, caret }
      : { input: "", caret };
  }
  // A typed brace means the visible character, not an invisible grouping token:
  // rewrite it to the escaped symbol unless it's structurally meant raw here
  // (see escapeTypedBrace). Only the single-char typing path — a multi-char
  // insert (IME commit, programmatic) is source text and keeps its braces.
  if (out === "{" || out === "}") {
    out = texEscapeTypedBrace(latex, offset, out) ?? out;
  }
  // A script typed at the end of an accent's base, or of a super/subscript's
  // filled slot, attaches to the whole construct: hop the insert past it so
  // `\dot{x|}` + `^` yields `\dot{x}^{…}` (the scripted accented atom, not the
  // accent expanding over the script) and `x_{n|}` + `^` yields `x_{n}^{…}` (the
  // matching script on the same base, not `x_{n^{…}}` nested in the subscript).
  // The base offset re-maps a chip-local target back to block coordinates.
  if (out === "^" || out === "_") {
    const attach = texScriptAttachOffset(latex, offset, out);
    const localAt = attach ?? offset;
    const insertAt = localAt + (index - offset);
    // A bare `^`/`_` typed BEFORE more content greedily binds the next atom as its
    // script (`aa|aaa` + `^` → `aa^aaa`, the 3rd `a` raised) — the source parses
    // as a filled slot, so the materializer never opens an empty box. When such an
    // atom follows (anything but the enclosing slot's `}` or the string's end),
    // emit the braced box `^{}` outright and drop the caret inside it, keeping the
    // following atoms as base siblings (`aa^{}aaa`, caret in the box). With nothing
    // to grab, keep the bare operator so the materializer opens the box and lands
    // the caret exactly as it does for a trailing script (`x|` + `^` → `x^{}`).
    const grabs = localAt < latex.length && latex[localAt] !== "}";
    if (grabs) {
      const boxed = out + "{}";
      const caret = insertAt + out.length + 1; // between the box's braces
      return insideChip
        ? { input: boxed, suppressMarkdown: true, insertAt, caret }
        : { input: boxed, insertAt, caret };
    }
    if (attach !== null) {
      return insideChip
        ? { input: out, suppressMarkdown: true, insertAt }
        : { input: out, insertAt };
    }
    if (insideChip) return { input: out, suppressMarkdown: true };
    return out === input ? null : { input: out };
  }
  // A bare `\` typed immediately before a structural token fuses with it into a
  // single escaped/structural command — the GLYPH, not the token — swallowing its
  // structural role: a grouping brace (`\frac{|}{}` + `\` → `\frac{\}{}`, the slot
  // runs to the source end and spawns a phantom `{}` beside the construct), a
  // matrix column separator (`a|&b` → `a\&b`, the `&` becomes a literal ampersand
  // and the two cells merge into one — the reported bug), a script operator
  // (`x|^2` → `x\^2`, the `2` de-scripts), a `\sqrt[…]` index bracket (`\sqrt[3|]`
  // → `\sqrt[3\]`, the index swallows the radicand), or a row break (`|\\` in a
  // matrix).
  // Insert a separating space so the `\` stays a lone command-intro and the token
  // keeps its role (`\frac{\ }{}`, `a\ &b` — balanced, no fusion), landing the
  // caret between them so command typing continues normally. The separator is
  // load-bearing only for the bare `\`: once a command letter follows (`\a&`) the
  // token no longer merges, and the leftover space is render-neutral — math mode
  // collapses it, exactly like the `\oint x` command separator, adding no caret
  // stop (dropped by mathRedundantSeparatorAfterInput once the command grows).
  if (out === "\\" && texBackslashFusesWith(latex, offset)) {
    const caret = index + 1; // between the `\` and the separating space
    return insideChip
      ? { input: "\\ ", suppressMarkdown: true, caret }
      : { input: "\\ ", caret };
  }
  if (insideChip) return { input: out, suppressMarkdown: true };
  // Block equation: only contribute when filtering or the separator changed input.
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
 * Auto-heal unbalanced grouping braces in the math content at `index` by
 * appending the missing closing `}` — the counterpart of {@link
 * mathMaterializeAfterInput}, run just before it so materialization then works on
 * balanced source. An unclosed `{` makes its group run to the end of the source,
 * swallowing every trailing offset so the caret can never sit *after* the
 * construct (nothing can be typed to its right); closing the group restores that
 * exit position. Render-neutral and idempotent (see {@link texBalanceBraces}) —
 * a no-op on the balanced source normal editing always produces, so it only ever
 * repairs pasted / imported LaTeX. The braces are real source text applied as
 * CRDT ops within the same edit. `null` when nothing needs closing or the caret
 * isn't in math content.
 *
 * Because the closers append at the source end, they shift no earlier offset, so
 * the caret keeps its position — it simply gains a reachable stop to its right.
 */
/**
 * `latex` with any unclosed grouping `{` closed — the string form of the
 * brace auto-heal, applied when LaTeX is *imported* (pasted `$$…$$` markdown /
 * HTML) so unbalanced source never enters the document and traps the caret past
 * the construct in the first place. Render-neutral and idempotent (see {@link
 * texBalanceBraces}); balanced input is returned unchanged.
 */
export function mathBalancedLatex(latex: string): string {
  const b = texBalanceBraces(latex);
  if (!b.changed) return latex;
  return b.inserts.reduce((s, i) => s + i.text, latex);
}

export function mathBalanceAfterInput(
  block: Block,
  index: number,
): ContentMaterialization | null {
  if (block.type === "math") {
    const latex = blockLatex(block);
    // Defer while a command is being typed at the caret: a bare `\` mid-edit
    // merges with a following `}` into the escaped literal `\}`, which transiently
    // unbalances the group (`\frac{J\|}{K}` ⌫ → `\frac{J\}{K}`, num now unclosed).
    // That residue is handled by command-entry scratch (it renders literally) and
    // resolves as the user finishes the command — healing it here would append a
    // stray `}` to a formula that's about to become balanced again. Once the
    // command commits and the caret moves off, the next edit heals normally.
    if (mathPendingCommandRange(latex, index)) return null;
    const b = texBalanceBraces(latex);
    if (!b.changed) return null;
    return { inserts: b.inserts, caret: index };
  }
  // Inline chip: the caret is inside the chip (or just past its last char after
  // typing). The chip's visible chars ARE its LaTeX; the closers land at the
  // chip's right edge — outside the math mark — so re-mark the grown chip so the
  // new braces join the formula instead of becoming plain text after it.
  for (const span of getInlineMathSpans(block)) {
    if (index <= span.startIndex || index > span.endIndex) continue;
    if (mathPendingCommandRange(span.latex, index - span.startIndex))
      return null;
    const b = texBalanceBraces(span.latex);
    if (!b.changed) return null;
    const inserted = b.inserts.reduce((sum, i) => sum + i.text.length, 0);
    return {
      inserts: b.inserts.map((i) => ({
        at: span.startIndex + i.at,
        text: i.text,
      })),
      caret: index,
      markRange: { from: span.startIndex, to: span.endIndex + inserted },
    };
  }
  return null;
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
    const inserted = n.inserts.reduce((sum, i) => sum + i.text.length, 0);
    return {
      inserts: n.inserts.map((i) => ({
        at: span.startIndex + i.at,
        text: i.text,
      })),
      caret: span.startIndex + n.mapCaret(local),
      // The braces can be inserted at the chip's right edge (e.g. `\frac` →
      // `\frac{}{}`), landing past the math mark's last char. Re-mark the whole
      // grown chip so the new slots join the formula instead of becoming plain
      // text after it.
      markRange: { from: span.startIndex, to: span.endIndex + inserted },
    };
  }
  return null;
}

/**
 * A space typed *inside* an inline-math chip breaks it in two: the chip up to
 * the space stays one formula, the space becomes ordinary text, and the rest
 * becomes a second chip — so `x|y` + Space reads as `x` ⎵ `y`, two separate
 * formulas. This resolves the block range of that just-typed space to strip the
 * "math" mark from (removing the mark over an interior char is exactly what
 * splits the run's span into two — see the reducer's format-removal path).
 *
 * Returns `null` — leaving the space as plain math source, so nothing visibly
 * happens — when the caret isn't in a chip, the prior char isn't a space, or the
 * space sits inside a multi-part construct (`\frac{a b}`): a construct can't be
 * divided, so its inner spaces are never split points. Block equations
 * (`block.type === "math"`) never split; their spaces are ordinary math source.
 *
 * `caret` is the post-insert caret, so the freshly-typed space is the char at
 * `caret − 1`; only that one space is ever a split candidate (a pre-existing
 * `\oint x` space stays put).
 */
export function mathSplitAfterInput(
  block: Block,
  caret: number,
): { from: number; to: number } | null {
  if (block.type === "math" || caret <= 0 || !("charRuns" in block))
    return null;
  const space = caret - 1;
  if (getVisibleTextFromRuns(block.charRuns)[space] !== " ") return null;
  for (const span of getInlineMathSpans(block)) {
    if (space < span.startIndex || space >= span.endIndex) continue;
    const local = space - span.startIndex;
    // Split only when both edges of the space are at the formula's top level —
    // a space bordering or inside a construct slot must not break the construct.
    if (
      texIsInsideConstruct(span.latex, local) ||
      texIsInsideConstruct(span.latex, local + 1)
    ) {
      return null;
    }
    return { from: space, to: space + 1 };
  }
  return null;
}

/**
 * Sentence punctuation that reads as prose when typed flush against a chip's
 * edge, so — like a space — it is left as plain text instead of being absorbed
 * into the formula (`$x^2$` + `.` → `$x^2$.`). These marks are essentially never
 * a meaningful leading/trailing math token. Brackets and parentheses are
 * deliberately EXCLUDED: they are common math delimiters, so their edge behavior
 * stays "extend the formula" and a user wanting them as prose leaves via a space.
 *
 * `.` and `,` are also number characters (`3.14`, `1,000`), which this rule
 * cannot see at the moment they are typed — the disambiguating signal is the
 * NEXT char. {@link mathAbsorbNumericPunctuationAfterInput} repairs that case
 * one keystroke later: a digit typed right after the ejected `.`/`,` pulls both
 * back into the formula.
 */
const EDGE_PROSE_PUNCTUATION = new Set([",", ".", ";", ":", "!", "?"]);

/**
 * A non-space char just typed at an inline chip's OUTER edge joins the formula.
 *
 * Typing at a chip's `startIndex`/`endIndex` inserts the char *outside* the math
 * mark — the mark covers `[startIndex, endIndex)`, so a char typed at either
 * boundary lands just before/after the marked run — which would otherwise leave
 * it as plain text abutting the chip. But a chip edge counts as INSIDE: re-mark
 * the chip to swallow the char so continued typing extends the same formula
 * (`x^2|` + `z` → `x^2z`, `|x^2` + `a` → `ax^2`). A SPACE never joins — it is the
 * "leave the formula" gesture at a boundary (one at the right edge ends the chip,
 * one at the left edge stays plain text before it), so those keep landing outside.
 * Sentence punctuation flush against an edge behaves the same way as a space (see
 * {@link EDGE_PROSE_PUNCTUATION}): `$x^2$` + `,` stays `$x^2$,`, not `$x^2,$`.
 *
 * `caret` is the post-insert caret, so the freshly-typed char is at `caret − 1`.
 * Returns the block range `[from, to)` to (re-)mark as math (the whole grown
 * chip), plus an optional `insert` — text the caller must splice in at a block
 * position first (extending `to` and the caret by its length) so the joined
 * char is well-formed math: a separator space when a letter lands right after a
 * trailing command (`\oint` + `x` → `\oint x`, never the unknown `\ointx`), or
 * the escaping `\` when a typed brace joins (it enters the formula as the
 * literal `\{`/`\}`, exactly as it would have typed inside — see
 * {@link mathTransformTypedInput}). `null` when the just-typed char isn't a
 * non-space sitting at a chip edge (block equations never apply — their chars
 * are all math already).
 */
export function mathJoinAtEdgeAfterInput(
  block: Block,
  caret: number,
): { from: number; to: number; insert?: { at: number; text: string } } | null {
  if (block.type === "math" || caret <= 0 || !("charRuns" in block))
    return null;
  const typed = caret - 1;
  const ch = getVisibleTextFromRuns(block.charRuns)[typed];
  if (ch === undefined || ch === " ") return null;
  // Sentence punctuation flush against a chip reads as prose ending/preceding the
  // formula, not a token of it — so, like a space, it must NOT be swallowed. This
  // is what lets a formula be followed immediately by a comma/period without the
  // punctuation vanishing into the math mark.
  if (EDGE_PROSE_PUNCTUATION.has(ch)) return null;

  for (const span of getInlineMathSpans(block)) {
    // Right edge: the char landed just past the chip's last marked char.
    if (span.endIndex === typed) {
      if (mathNeedsCommandSeparator(span.latex, span.latex.length, ch)) {
        return {
          from: span.startIndex,
          to: caret,
          insert: { at: span.endIndex, text: " " },
        };
      }
      return texEscapeTypedBrace(span.latex, span.latex.length, ch)
        ? {
            from: span.startIndex,
            to: caret,
            insert: { at: typed, text: "\\" },
          }
        : { from: span.startIndex, to: caret };
    }
    // Left edge: the char landed just before the chip's first marked char (the
    // insert pushed the marked run right, so the chip now starts at the caret).
    if (span.startIndex === caret) {
      return texEscapeTypedBrace(span.latex, 0, ch)
        ? { from: typed, to: span.endIndex, insert: { at: typed, text: "\\" } }
        : { from: typed, to: span.endIndex };
    }
  }
  return null;
}

/**
 * A digit typed right after a `.`/`,` that sits flush against a chip's right
 * edge pulls BOTH back into the formula: the punctuation was part of a number
 * all along.
 *
 * {@link mathJoinAtEdgeAfterInput} ejects edge `.`/`,` as prose because at that
 * keystroke the two readings — sentence punctuation (`$x^2$.`) vs. number
 * character (`$3.14$`) — are indistinguishable; only the NEXT char tells them
 * apart. Prose essentially never puts a digit hard against a period or comma
 * with no space, so a digit landing at `chipEnd + 1` retroactively resolves the
 * ejected punctuation as numeric: re-mark `[chipStart, caret)` so the chip
 * swallows the `.`/`,` and the digit together (`$3$` + `.` + `1` → `$3.1$`,
 * `$1$` + `,` + `0` → `$1,0$`). After the absorb the caret is back at the chip's
 * edge, so further digits extend the formula through the ordinary edge join.
 *
 * Only `.` and `,` qualify — the other {@link EDGE_PROSE_PUNCTUATION} marks are
 * not number characters, so a digit after `$x$;` stays prose. Returns the block
 * range to re-mark as math, or `null` when the just-typed char (at `caret − 1`)
 * isn't a digit sitting exactly one past a chip edge with `.`/`,` between
 * (block equations never apply — their chars are all math already). The result
 * shares {@link mathJoinAtEdgeAfterInput}'s shape so the caller applies either
 * identically; an absorb never needs an `insert` (a `.`/`,` after any trailing
 * token — even a control word — is already well-formed math).
 */
export function mathAbsorbNumericPunctuationAfterInput(
  block: Block,
  caret: number,
): { from: number; to: number; insert?: { at: number; text: string } } | null {
  if (block.type === "math" || caret < 2 || !("charRuns" in block)) return null;
  const text = getVisibleTextFromRuns(block.charRuns);
  const digit = text[caret - 1];
  if (digit === undefined || !/[0-9]/.test(digit)) return null;
  const punct = text[caret - 2];
  if (punct !== "." && punct !== ",") return null;
  for (const span of getInlineMathSpans(block)) {
    if (span.endIndex === caret - 2) {
      return { from: span.startIndex, to: caret };
    }
  }
  return null;
}

/**
 * A space just typed *into* a formula that carries no LaTeX meaning, planned for
 * deletion rather than being saved as dead source. The cases the {@link
 * mathSplitAfterInput} top-level split doesn't claim — a space inside a block
 * equation, or inside an inline chip's construct (`\frac{a }{b}`) — almost always
 * render identically with or without the space (math mode collapses inter-atom
 * whitespace), so persisting them just accumulates meaningless `\frac{a }{b}`
 * source. This resolves the block range `[from, to)` of such a redundant space to
 * delete, or `null` when there's nothing to drop.
 *
 * Returns `null` (keep the space) when the prior char isn't a just-typed space,
 * the caret isn't in math content, or the space is semantically load-bearing — a
 * control-word separator (`\sin x` → the unknown `\sinx` without it) or a literal
 * text-mode space (`\text{a b}`); {@link texIsRedundantSpace} draws that line by
 * comparing the parse with and without the space. The split and redundant-space
 * paths are mutually exclusive: a top-level inline space splits its chip and
 * never reaches here.
 *
 * `caret` is the post-insert caret, so the freshly-typed space is at `caret − 1`.
 */
export function mathRedundantSpaceAfterInput(
  block: Block,
  caret: number,
): { from: number; to: number } | null {
  if (caret <= 0 || !("charRuns" in block)) return null;
  const space = caret - 1;
  const text = getVisibleTextFromRuns(block.charRuns);
  if (text[space] !== " ") return null;

  // Resolve the formula the space landed in and the space's offset within that
  // source: the whole block for an equation, else the inline chip holding it.
  let latex: string;
  let local: number;
  if (block.type === "math") {
    latex = text;
    local = space;
  } else {
    const span = getInlineMathSpans(block).find(
      (s) => space >= s.startIndex && space < s.endIndex,
    );
    if (!span) return null;
    latex = span.latex;
    local = space - span.startIndex;
  }

  return texIsRedundantSpace(latex, local)
    ? { from: space, to: space + 1 }
    : null;
}

/**
 * Drop the command-entry separator once the command it guarded has grown enough
 * to no longer need it. When a bare `\` is typed immediately before a structural
 * grouping brace, {@link mathTransformTypedInput} inserts a `\ ` separator so the
 * `\` can't fuse with the brace into the escaped `\{`/`\}` (see there). That
 * separator is load-bearing ONLY while the command is a bare `\`: the instant a
 * command char follows (`\a}` no longer merges), the space becomes dead source
 * that would otherwise linger in the committed formula (`\frac{\alpha }{}`).
 *
 * Fires after ANY keystroke (not only a typed space, unlike {@link
 * mathRedundantSpaceAfterInput}): the trigger here is a command *letter* landing
 * in front of the separator. Resolves the block range `[from, to)` of a space
 * sitting immediately AFTER the caret and immediately BEFORE a `{`/`}` — the exact
 * shape of the separator during command typing (`\a| }` → the caret is just past
 * the letter, the space and the slot's brace follow) — when removing it is
 * parse-neutral ({@link texIsRedundantSpace}, which returns false while the `\` is
 * still bare because dropping the space then re-merges the brace). `null`
 * otherwise. Narrow by design: only a redundant space wedged between the caret and
 * a brace qualifies, so ordinary inter-atom spacing is never touched.
 *
 * `caret` is the post-insert caret, so the separator (if any) is at `caret`.
 */
export function mathRedundantSeparatorAfterInput(
  block: Block,
  caret: number,
): { from: number; to: number } | null {
  if (!("charRuns" in block)) return null;
  const text = getVisibleTextFromRuns(block.charRuns);
  if (text[caret] !== " ") return null;

  let latex: string;
  let local: number;
  if (block.type === "math") {
    latex = text;
    local = caret;
  } else {
    const span = getInlineMathSpans(block).find(
      (s) => caret >= s.startIndex && caret < s.endIndex,
    );
    if (!span) return null;
    latex = span.latex;
    local = caret - span.startIndex;
  }

  // The separator always sits flush before the structural token it protects (a
  // brace, `&`, script, or row break — see mathTransformTypedInput); requiring
  // that keeps this from disturbing any other (e.g. inter-atom) space near the
  // caret. `texBackslashFusesWith` at the following offset is exactly that set.
  if (!texBackslashFusesWith(latex, local + 1)) return null;

  return texIsRedundantSpace(latex, local)
    ? { from: caret, to: caret + 1 }
    : null;
}

/**
 * A run of inline chips that a delete left touching, planned for re-fusing into
 * one formula. `from`/`to` is the block range the run now spans; `separatorsAt`
 * are the block positions (ascending) where a single space must be inserted so
 * concatenation stays valid LaTeX — a chip ending in a control word fused with a
 * following letter would otherwise corrupt into one unknown command (`\sin` ⎵ `x`
 * → `\sinx`, not the intended `\sin x`). The host inserts those spaces, then
 * marks `[from, to + separatorsAt.length)` as math.
 */
export interface MathMergePlan {
  from: number;
  to: number;
  separatorsAt: number[];
}

/**
 * The inverse of {@link mathSplitAfterInput}: after a delete leaves inline chips
 * touching (the plain text that separated them is gone), plan how to fuse each
 * maximal run of now-adjacent chips (`endIndex === startIndex`) back into one
 * formula — so deleting the space between `x` ⎵ `y` re-merges them to `xy`, and
 * between `\sin` ⎵ `x` re-merges to a valid `\sin x` (a separator is reinserted).
 * `null` when nothing is adjacent (the common case).
 */
export function mathMergeAfterDelete(block: Block): MathMergePlan[] | null {
  const spans = getInlineMathSpans(block).sort(
    (a, b) => a.startIndex - b.startIndex,
  );
  const plans: MathMergePlan[] = [];
  let i = 0;
  while (i < spans.length) {
    let j = i;
    const separatorsAt: number[] = [];
    while (
      j + 1 < spans.length &&
      spans[j].endIndex === spans[j + 1].startIndex
    ) {
      // A control word now butting against a following letter needs a space
      // between them, or the two tokens fuse into one unknown command.
      if (
        mathNeedsCommandSeparator(
          spans[j].latex,
          spans[j].latex.length,
          spans[j + 1].latex[0] ?? "",
        )
      ) {
        separatorsAt.push(spans[j + 1].startIndex);
      }
      j++;
    }
    if (j > i) {
      plans.push({
        from: spans[i].startIndex,
        to: spans[j].endIndex,
        separatorsAt,
      });
    }
    i = j + 1;
  }
  return plans.length > 0 ? plans : null;
}

/**
 * After a delete in a block equation, the offset where a command-separator space
 * must be reinserted so the edit stays valid LaTeX, or null. Removing the content
 * between a control word and a following letter — e.g. backspacing the empty
 * subscript in `\int_{}a` down to `\inta` — welds them into one unknown command
 * that renders as raw red source. Reinserting the space keeps them two atoms
 * (`\int a` → ∫a). This is the delete-side counterpart of the insert path's
 * {@link mathNeedsCommandSeparator} guard (a letter typed after a complete command
 * gets a space) and of {@link mathMergeAfterDelete}'s guard for inline chips;
 * block equations, whose whole text is one LaTeX string with no chip spans, need
 * this direct check. `caret` is the post-delete caret offset (the weld point).
 */
export function mathSeparatorAfterDelete(
  block: Block,
  caret: number,
): number | null {
  if (block.type !== "math") return null;
  const latex = blockLatex(block);
  const next = latex[caret];
  if (next === undefined) return null;
  return mathNeedsCommandSeparator(latex, caret, next) ? caret : null;
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

/** A source range `[start, end)` in a LaTeX string. */
export interface MathSourceRange {
  start: number;
  end: number;
}

/**
 * The two `\command`-run ranges every math painter needs, derived once from the
 * caret. Block equations, inline chips, and the host's magnified overlay all need
 * the same pair, computed identically — this is the single source so they can't
 * drift (the three used to re-derive it independently):
 *
 *  - `pendingRange` — the half-typed command run the caret sits in (`\al`). The
 *    renderer paints its glyphs in normal text color instead of the red
 *    "unknown command" placeholder: the command is in progress, not an error.
 *    Present whenever the caret is inside such a run, regardless of edit mode.
 *  - `literalRange` — the run to lay out as literal SOURCE (`\al`, not the glyph),
 *    so the painted geometry matches the source the caret is stepping through.
 *    Set only while a command is *actively being entered* (`commandEntryActive`);
 *    merely resting the caret at the trailing edge of a COMPLETE command (`\eta`)
 *    must still render the glyph η. It is always a subset of `pendingRange`.
 *
 * `caretOffset` is the caret's offset into `latex` (chip-local for a chip), or
 * `null` when the caret isn't in this math content — both ranges are then
 * undefined.
 */
export interface MathCommandRanges {
  literalRange: MathSourceRange | undefined;
  pendingRange: MathSourceRange | undefined;
}

export function mathCommandRanges(
  latex: string,
  caretOffset: number | null,
  commandEntryActive: boolean,
): MathCommandRanges {
  const pendingRange =
    caretOffset != null
      ? (mathPendingCommandRange(latex, caretOffset) ?? undefined)
      : undefined;
  return {
    pendingRange,
    literalRange: commandEntryActive ? pendingRange : undefined,
  };
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
 * The structural unit a double-click / double-tap at `offset` selects — the
 * construct under the pointer, taken whole (a fraction's numerator glyph selects
 * the entire `\frac`, a script base the whole `x^{2}`), or a lone top-level token
 * (`\alpha`, a bare `a`). This is the selection counterpart to the delete-side
 * {@link mathUnitBefore}/{@link mathUnitAfter}: the pointer wants the whole thing
 * it's pointing at, not the single editable leaf a Backspace would chip off.
 * `null` for an empty formula.
 */
export function mathUnitAt(latex: string, offset: number): MathUnit | null {
  return texUnitAt(latex, offset);
}

/**
 * Snap a range SELECTION `[anchor, focus]` (block-text indices) so it never
 * partially covers a connected math construct, LEVEL-AWARELY — see
 * {@link CaretModel.selectionRange}. Returns adjusted indices, or `null` to leave
 * the range untouched.
 *
 * Handles both hosts behind the caret seam:
 * - a block equation (`block.type === "math"`, whose whole text IS the LaTeX) —
 *   resolves directly on the block offsets;
 * - an inline chip inside ordinary text — a chip is one atomic unit at the
 *   paragraph's level, so when both endpoints sit inside the SAME chip the range
 *   is resolved at that chip's LaTeX levels (re-based onto block coordinates),
 *   and otherwise any endpoint inside a chip snaps to the chip's edge (whole chip
 *   in/out), while endpoints in plain text stay put.
 */
export function mathSelectionRange(
  block: Block,
  anchor: number,
  focus: number,
  focusEdge: "start" | "end",
): { anchor: number; focus: number } | null {
  if (block.type === "math") {
    const latex = getVisibleTextFromRuns(block.charRuns);
    return texResolveSelectionRange(latex, anchor, focus, focusEdge);
  }
  const chipA = chipAt(block, anchor, "inside");
  const chipF = chipAt(block, focus, "inside");
  if (chipA && chipF && chipA.startIndex === chipF.startIndex) {
    // Both endpoints inside one chip: resolve at that chip's own LaTeX levels.
    const r = texResolveSelectionRange(
      chipA.latex,
      anchor - chipA.startIndex,
      focus - chipA.startIndex,
      focusEdge,
    );
    return {
      anchor: chipA.startIndex + r.anchor,
      focus: chipA.startIndex + r.focus,
    };
  }
  if (!chipA && !chipF) return null; // neither endpoint inside a chip
  // A chip is atomic at the block level: widen the anchor outward, snap the focus
  // by its travel direction; a plain-text endpoint is left where it is.
  const forward = anchor < focus;
  return {
    anchor: chipA ? (forward ? chipA.startIndex : chipA.endIndex) : anchor,
    focus: chipF
      ? focusEdge === "end"
        ? chipF.endIndex
        : chipF.startIndex
      : focus,
  };
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
 *
 * A space that separates a token from the next (`\partial z`, `x y`) renders
 * zero-width in math, so the two source offsets bracketing it — the trailing
 * edge of the token before and the leading edge of the glyph after — draw the
 * caret at the SAME point. Two source positions, one visual gap: a raw arrow-step
 * from one to the other looks frozen (the reported "press right twice to pass
 * `\partial`"). We keep only the LATER offset of such a coincident pair — the
 * start of the following glyph, where an insert lands cleanly (`\partial|z` →
 * `\partial xz`, not the command-corrupting `\partialx z`) and Backspace deletes
 * the gap.
 *
 * The collapse is deliberately narrow: it fires only for two non-boundary stops
 * at the identical `(x, y)`. A construct's outer BOUNDARY stop is a distinct
 * "beside the whole construct" rest even where it visually coincides with an
 * inner edge — the far edge of `\sqrt{a}` (past `}`) sits on the radicand's right
 * edge yet must stay reachable to step out — so a boundary never collapses. And
 * a same-column stop on a different ROW (the baseline after `x` vs the `2` up in
 * `x^{2}`) differs in `y`, so it stays too. Only truly invisible duplicates go.
 */
export function mathCaretOffsets(latex: string): number[] {
  if (!latex) return [0];
  const l = layoutMath(latex, { fontSize: 16, displayMode: false });
  // Every caret stop at each source offset. One offset can have several (a
  // multi-glyph command like `\sin` stops at each of its glyphs' edges).
  const stopsByOffset = new Map<number, CaretStop[]>();
  for (const stop of texCaretStops(l)) {
    const group = stopsByOffset.get(stop.offset);
    if (group) group.push(stop);
    else stopsByOffset.set(stop.offset, [stop]);
  }
  // The source boundaries are always legal, even when they carry no glyph edge
  // (an empty slot, a leading/trailing structural brace).
  if (!stopsByOffset.has(0)) stopsByOffset.set(0, []);
  if (!stopsByOffset.has(latex.length)) stopsByOffset.set(latex.length, []);

  const offsets = [...stopsByOffset.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i];
    const next = offsets[i + 1];
    // Drop an offset that is visually indistinguishable from the next one,
    // keeping the later (see above). Never drop a source boundary. Runs of
    // three+ coincident offsets collapse to the last.
    if (
      offset !== 0 &&
      offset !== latex.length &&
      next !== undefined &&
      coincidentCaret(stopsByOffset.get(offset)!, stopsByOffset.get(next)!)
    ) {
      continue;
    }
    out.push(offset);
  }
  return out;
}

/**
 * Whether two offsets draw the caret at the exact same point(s): equal stop
 * count, each `(x, y)` matching within a sub-pixel epsilon, and neither carrying
 * a construct-boundary stop (a boundary is a deliberately distinct rest — see
 * {@link mathCaretOffsets}). Empty stop sets (source boundaries) never coincide.
 */
function coincidentCaret(a: CaretStop[], b: CaretStop[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  if (a.some((s) => s.boundary) || b.some((s) => s.boundary)) return false;
  const key = (s: CaretStop) => s.x * 1e5 + s.y;
  const sa = [...a].sort((p, q) => key(p) - key(q));
  const sb = [...b].sort((p, q) => key(p) - key(q));
  return sa.every(
    (s, i) => Math.abs(s.x - sb[i].x) < 0.01 && Math.abs(s.y - sb[i].y) < 0.01,
  );
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
 * Source offsets within an inline chip's LaTeX where the line-wrapper may break
 * it across lines — the formula's top-level operator/relation breaks (see
 * `@cypherkit/tex`'s `breakpoints`). Empty when the chip has no top-level break
 * (a lone construct), so it stays atomic and overflows rather than splitting.
 */
export function getInlineMathBreakpoints(latex: string): number[] {
  return latex ? texBreakpoints(latex) : [];
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

/** One highlight rectangle for a selected sub-range inside a chip. */
export interface InlineMathSelectionRect {
  /** X from the chip's left edge, CSS px. */
  readonly x: number;
  /** Top relative to the chip baseline (negative = above), CSS px. */
  readonly top: number;
  /** Bottom relative to the chip baseline (positive = below), CSS px. */
  readonly bottom: number;
  /** Rect width, CSS px. */
  readonly width: number;
}

/**
 * Highlight rectangles for the selected source range `[start, end)` within a
 * chip — the selection analogue of {@link getInlineMathCaretRect}. Rects are
 * per visual row (x from the chip's left edge, top/bottom from the baseline, +y
 * down), so a sub-selection hugs just the selected row (a fraction's denominator
 * highlights the denominator, not the whole formula's height). Empty for empty
 * input or an empty range.
 */
export function getInlineMathSelectionRects(
  latex: string,
  fontSize: number,
  start: number,
  end: number,
  literalRange?: { start: number; end: number },
): InlineMathSelectionRect[] {
  if (!latex) return [];
  const l = layoutMath(latex, { fontSize, displayMode: false, literalRange });
  return texSelectionRects(l, start, end).map((r) => ({
    x: r.x,
    top: r.y,
    bottom: r.y + r.height,
    width: r.width,
  }));
}

/**
 * Source offset (0 … latex.length) nearest a point local to the chip — `localX`
 * is measured from the chip's left edge, `localY` from the text baseline (+y
 * down). For a single-row formula `localY` 0 (the baseline) suffices; vertical
 * disambiguation (e.g. clicking a fraction's denominator) lands in a later step.
 */
/**
 * The construct a double-click / double-tap at a chip-local point `(localX,
 * localY)` selects — the POINT-based counterpart to {@link mathUnitAt}, resolved
 * straight off the rendered box tree via {@link texSpanAtPoint}. This is what
 * makes an ATOMIC command chip (`\det`, `\sin`, `\lim`) selectable at all: such a
 * command has caret stops only at its two edges, so an offset resolved from the
 * tap lands on a chip boundary and the offset path can't see it — but the glyphs
 * carry the command's whole span, so a point lands inside it. `localX` is measured
 * from the chip's left edge, `localY` from the text baseline (+y down). Uses a
 * finger-sized target on touch. Returns null for an empty chip.
 */
export function getInlineMathWordRange(
  latex: string,
  fontSize: number,
  localX: number,
  localY: number,
  literalRange?: { start: number; end: number },
): { start: number; end: number } | null {
  if (!latex) return null;
  const l = layoutMath(latex, { fontSize, displayMode: false, literalRange });
  return texSpanAtPoint(l, localX, localY, {
    minTargetSize: isTouchDevice() ? 44 : 24,
  });
}

export function getInlineMathOffsetAtX(
  latex: string,
  fontSize: number,
  localX: number,
  localY = 0,
  // Finger-drag (magnifier) resolution: resolve to the nearest caret stop in 2-D
  // with row hysteresis, so vertical dragging descends smoothly between a
  // fraction's numerator/denominator without flipping on finger wobble. See
  // {@link import("@cypherkit/tex").HitTestOptions.drag}.
  drag = false,
  // The caret's CURRENT chip-local offset (for the hysteresis in drag mode), or
  // null when the caret is not already inside this chip.
  dragPrevOffset: number | null = null,
): number {
  if (!latex) return 0;
  const l = layoutMath(latex, { fontSize, displayMode: false });
  return texHitTest(l, localX, localY, {
    placeholderTargetSize: isTouchDevice() ? 44 : 24,
    drag,
    dragPrevOffset,
  });
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
