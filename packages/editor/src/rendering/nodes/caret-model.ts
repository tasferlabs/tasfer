/**
 * CaretModel — how a node or mark's structured inline content behaves under the
 * caret: an inline-math chip, a `\command`, a mention, a date pill — anything the
 * caret must treat as more than a run of plain characters.
 *
 * Designed so the *common* case is one declarative method and nothing else:
 * return {@link CaretModel.atomicSpans} (the text ranges that are indivisible
 * units) and the engine derives stepping, word-navigation and whole-unit delete
 * from them. A mention / date / badge / emoji never writes a line of caret math.
 *
 * The remaining members are escape hatches for content the caret *enters and
 * navigates internally* (math: a fraction's numerator ↔ denominator, a command
 * token's slots) — `move` overrides caret motion, `deleteUnit` overrides what a
 * delete removes, `transformInput` rewrites what gets typed. They are the rare
 * case; most extensions leave them unset.
 *
 * Declared once and shared by both {@link import("./Node").Node.caret} and
 * {@link import("../marks/Mark").Mark.caret} (the inline analogue), so the two
 * never drift. All offsets are block-text indices. (The *effect* half of editing
 * structured content — materializing an incomplete construct after an edit — is
 * not here: it's the `TEXT_INPUTTED` action a node/mark observes in
 * `registerActions`.)
 */

import type { Block } from "../../serlization/loadPage";
import type { CaretDeleteUnit, TypedInputTransform } from "../../state-types";

/** Structural block currency accepted by a node's caret model. */
export interface CaretBlock {
  readonly type: string;
}

/** A half-open run of block text, `[start, end)`. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * A single caret motion the engine asks a {@link CaretModel.move} to resolve.
 * `char*`/`word*` are the horizontal arrow / word-jump granularities; `up`/`down`
 * are vertical motion *within* the content (e.g. between a fraction's rows).
 */
export type CaretMotion =
  | "charLeft"
  | "charRight"
  | "wordLeft"
  | "wordRight"
  | "up"
  | "down";

export interface CaretModel<B extends CaretBlock = Block> {
  /**
   * The ranges of the block's text that are **atomic units**: the caret steps
   * over them as one stop, a delete on an edge removes the whole span, and
   * word-navigation snaps to their edges. This is the declarative common case —
   * implement just this and the engine derives {@link move} / {@link deleteUnit}
   * for you. Return `[]` when the block currently has none.
   */
  atomicSpans?(block: B): readonly TextSpan[];

  /**
   * Snap a non-collapsed range SELECTION `[anchor, focus]` (both block-text
   * indices) so it never partially covers a connected construct, while staying
   * LEVEL-AWARE — a selection lives at the deepest nesting level its two endpoints
   * share, and only constructs *below* that level are atomic. Selecting within a
   * fraction's numerator stays inside it; dragging across its two slots escalates
   * to the whole `\frac`; at the top level the fraction is one unit. `focusEdge`
   * is the direction the focus travelled (`"end"` = rightward/grow, `"start"` =
   * leftward/shrink), used to decide whether a construct the focus entered is
   * taken in or dropped. Returns the adjusted indices, or `null` to leave the
   * range untouched (plain text, or nothing to snap). Distinct from
   * {@link atomicSpans}: the caret may rest inside a construct to edit it — this
   * governs only where a selection may end.
   */
  selectionRange?(
    block: B,
    anchor: number,
    focus: number,
    focusEdge: "start" | "end",
  ): { anchor: number; focus: number } | null;

  /**
   * Override caret motion for content the caret descends *into* (the spans above
   * are opaque — this is for genuinely 2-D / structured content like math).
   * Return the next caret index for `motion`, or `null` to fall back to the
   * span-derived step (horizontal) or to leave the block via line navigation
   * (vertical). Unifies what would otherwise be separate step / vertical-step /
   * word-step hooks behind one {@link CaretMotion}.
   */
  move?(block: B, index: number, motion: CaretMotion): number | null;

  /**
   * Override the editing unit a delete at the caret removes — a multi-part
   * construct (selected first, deleted on the next press) vs a leaf (deleted
   * now); see {@link CaretDeleteUnit}. `null` for a plain character delete.
   * Unset, a delete on an {@link atomicSpans} edge removes the whole span.
   */
  deleteUnit?(
    block: B,
    index: number,
    dir: "backward" | "forward",
  ): CaretDeleteUnit | null;

  /**
   * Rewrite a typed string before it is inserted at `index` and/or veto
   * inline-markdown for this keystroke, or `null` to insert it verbatim (see
   * {@link TypedInputTransform}). Lets atomic content keep itself well-formed —
   * e.g. inline math inserts a command-separating space so `\oint` + `x` becomes
   * `\oint x`, and suppresses `$`/`*` markdown inside a chip.
   */
  transformInput?(
    block: B,
    index: number,
    input: string,
  ): TypedInputTransform | null;
}
