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

export interface InlineMathSpan {
  startIndex: number;
  endIndex: number;
  /** The run's flat text — a structured chip's single anchor char. */
  text: string;
}

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
 * If a caret move from `prevTextIndex` to `newTextIndex` stepped across an
 * inline-math chip (between its opposite boundaries), return that span; else
 * null. Used to open the inline-math editor when an arrow key crosses a chip.
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
