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
 * One caret move that the editor asks {@link CaretModel.move} to resolve.
 * `charLeft` and `charRight` are the arrow keys. `wordLeft` and `wordRight` are
 * word jumps. `up` and `down` move between rows inside the content, such as a
 * fraction's top and bottom.
 */
export type CaretMotion =
  "charLeft" | "charRight" | "wordLeft" | "wordRight" | "up" | "down";

/**
 * Tells the editor how the caret behaves around content that is more than plain
 * characters, such as a mention, a date pill or an inline formula. Most nodes
 * and marks only implement `atomicSpans`, the text ranges the caret treats as
 * one unit. The other methods are for content the caret can move around inside.
 *
 * ```ts
 * class MentionMark extends Mark {
 *   // ...
 *   readonly caret: CaretModel = {
 *     // block-text ranges of each mention (your own lookup)
 *     atomicSpans: (block) => mentionRanges(block),
 *   };
 * }
 * ```
 */
export interface CaretModel<B extends CaretBlock = Block> {
  /**
   * The parts of the block's text that the caret treats as one unit. The caret
   * steps over each one in a single move. Word jumps stop at its edges. A
   * delete at its edge removes the whole span. Ranges are block-text indices.
   *
   * Most nodes and marks only need this method. The editor works out caret
   * moves and deletes from it, so you do not need {@link CaretModel.move} or
   * {@link CaretModel.deleteUnit}. Return `[]` when the block has none right
   * now.
   */
  atomicSpans?(block: B): readonly TextSpan[];

  /**
   * Adjusts a selection so it never covers only part of a construct. `anchor`
   * and `focus` are block-text indices. The selection stays at the deepest
   * level both ends share. Take a fraction as an example. A selection inside
   * its top part stays there. A selection across its top and bottom grows to
   * the whole fraction. At the top level, the fraction counts as one unit.
   *
   * `focusEdge` is the way the focus moved: `"end"` for rightward or growing,
   * `"start"` for leftward or shrinking. It decides whether a construct the
   * focus entered is taken in or left out.
   *
   * Returns the new indices, or `null` to keep the selection as it is. Unlike
   * {@link CaretModel.atomicSpans}, this does not keep the caret out of a
   * construct. It only limits where a selection can end.
   */
  selectionRange?(
    block: B,
    anchor: number,
    focus: number,
    focusEdge: "start" | "end",
  ): { anchor: number; focus: number } | null;

  /**
   * Moves the caret inside content it can enter, such as from a fraction's top
   * to its bottom. Atomic spans have no inside, so this is not for them. Return
   * the next caret index for `motion`, or `null` to use the default. By
   * default, left and right step over atomic spans, and up and down leave the
   * block for the line above or below.
   */
  // One method with a CaretMotion argument replaces what would otherwise be
  // separate step, vertical-step and word-step hooks.
  move?(block: B, index: number, motion: CaretMotion): number | null;

  /**
   * Decides what a delete at the caret removes. Return a
   * {@link CaretDeleteUnit} with the range. Set `isConstruct` to `true` for a
   * construct with several parts: the first press selects it and the next press
   * deletes it. With `false`, the range is deleted right away. Return `null`
   * for a plain one-character delete.
   *
   * Without this method, a delete at the edge of a
   * {@link CaretModel.atomicSpans} range removes the whole span.
   */
  deleteUnit?(
    block: B,
    index: number,
    dir: "backward" | "forward",
  ): CaretDeleteUnit | null;

  /**
   * Changes what gets typed at `index` before it goes in. Return a
   * {@link TypedInputTransform} to replace the text, to skip inline markdown
   * for this keystroke, or to move where the text or the caret lands. Return an
   * empty `input` to drop the keystroke. Return `null` to insert the text as
   * typed.
   *
   * For example, a formula chip could add a space so `\oint` then `x` becomes
   * `\oint x`, or stop `$` from turning into markdown inside it.
   */
  transformInput?(
    block: B,
    index: number,
    input: string,
  ): TypedInputTransform | null;
}
