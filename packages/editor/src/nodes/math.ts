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
import {
  caretRect as texCaretRect,
  caretStops as texCaretStops,
  caretVertical as texCaretVertical,
  hitTest as texHitTest,
  isInsideConstruct as texIsInsideConstruct,
  isRedundantSpace as texIsRedundantSpace,
  isValidLatex,
  layoutMath,
  type MathUnit,
  needsCommandSeparator as texNeedsCommandSeparator,
  normalizeLatex as texNormalizeLatex,
  pendingCommandRange as texPendingCommandRange,
  toSVG,
  unitAfter as texUnitAfter,
  unitAt as texUnitAt,
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
 * longer strands the rest). A caret resting on a chip's outer edge (just past it
 * on Backspace, just before it on Delete) enters the chip and removes its
 * adjacent unit too — a chip is edited one unit at a time, never deleted whole
 * from outside. `null` when the caret isn't in math content.
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
      const u = mathUnitBefore(blockLatex(block), index);
      return u ? asUnit(u) : null;
    }
    // Inside the chip: erase the unit before the caret.
    const inside = chipAt(block, index, "inside");
    if (inside) {
      return chipUnit(
        inside,
        mathUnitBefore(inside.latex, index - inside.startIndex),
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
    const u = mathUnitAfter(blockLatex(block), index);
    return u ? asUnit(u) : null;
  }
  // Inside the chip: erase the unit after the caret.
  const inside = chipAt(block, index, "inside");
  if (inside) {
    return chipUnit(
      inside,
      mathUnitAfter(inside.latex, index - inside.startIndex),
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
 *
 * `caret` is the post-insert caret, so the freshly-typed char is at `caret − 1`.
 * Returns the block range `[from, to)` to (re-)mark as math (the whole grown
 * chip), plus an optional `separatorAt` block position where a single space must
 * be inserted first so a letter typed right after a trailing command becomes a
 * new atom (`\oint` + `x` → `\oint x`, never the unknown `\ointx`); when present
 * the caller inserts that space, then marks `[from, to + 1)`. `null` when the
 * just-typed char isn't a non-space sitting at a chip edge (block equations never
 * apply — their chars are all math already).
 */
export function mathJoinAtEdgeAfterInput(
  block: Block,
  caret: number,
): { from: number; to: number; separatorAt?: number } | null {
  if (block.type === "math" || caret <= 0 || !("charRuns" in block))
    return null;
  const typed = caret - 1;
  const ch = getVisibleTextFromRuns(block.charRuns)[typed];
  if (ch === undefined || ch === " ") return null;

  for (const span of getInlineMathSpans(block)) {
    // Right edge: the char landed just past the chip's last marked char.
    if (span.endIndex === typed) {
      return mathNeedsCommandSeparator(span.latex, span.latex.length, ch)
        ? { from: span.startIndex, to: caret, separatorAt: span.endIndex }
        : { from: span.startIndex, to: caret };
    }
    // Left edge: the char landed just before the chip's first marked char (the
    // insert pushed the marked run right, so the chip now starts at the caret).
    if (span.startIndex === caret) {
      return { from: typed, to: span.endIndex };
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
  return texHitTest(l, localX, localY, {
    placeholderTargetSize: isTouchDevice() ? 44 : 24,
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
