/**
 * Inline-math span detection — the leaf core of inline-math chip handling.
 *
 * Inline math is stored as a run of LaTeX characters tagged with the "math"
 * format but treated as a single atomic chip. `getInlineMathSpans` resolves a
 * block's chips to caret-edge ranges; `getCrossedInlineMathSpan` reports when a
 * caret move stepped across a chip's boundaries.
 *
 * A thin math-specific filter over the mark-agnostic `resolveMarkRuns` in the
 * core, and as dependency-light as that module is, so `MathMark` can import it
 * during construction without a load-order cycle. The richer, geometry-aware
 * helpers (`getInlineMathAtPosition`, snapping) live in `../inline-math`, which
 * builds on this module.
 */

import { resolveMarkRuns } from "@tasfer/editor/mark-runs";
import type { Block } from "@tasfer/editor/serlization/loadPage";

/**
 * One inline formula in a block's text: the text index where it starts, the
 * index where it ends, and the text stored in between.
 *
 * @group Structured content
 */
export interface InlineMathSpan {
  startIndex: number;
  endIndex: number;
  /**
   * The formula's text in the block. For an older formula this is its LaTeX.
   * For a structured formula it is one placeholder character, not the LaTeX.
   */
  text: string;
}

/**
 * List every inline formula in a block, with where each one starts and ends
 * in the block's text. Use it to find the formula next to the caret or inside
 * a selection.
 *
 * @group Structured content
 */
export function getInlineMathSpans(block: Block): InlineMathSpan[] {
  return resolveMarkRuns(block)
    .filter((r) => r.name === "math")
    .map((r) => ({
      startIndex: r.startIndex,
      endIndex: r.endIndex,
      text: r.text,
    }));
}

/**
 * Returns the inline formula that a caret move from `prevTextIndex` to
 * `newTextIndex` jumped over, from one edge to the other. Returns `null` if the
 * move did not cross one. Use it to open your formula editor when an arrow key
 * steps over a formula.
 */
export function getCrossedInlineMathSpan(
  block: Block,
  prevTextIndex: number,
  newTextIndex: number,
): InlineMathSpan | null {
  for (const span of getInlineMathSpans(block)) {
    if (
      (prevTextIndex === span.startIndex && newTextIndex === span.endIndex) ||
      (prevTextIndex === span.endIndex && newTextIndex === span.startIndex)
    ) {
      return span;
    }
  }
  return null;
}
