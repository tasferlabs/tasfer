/**
 * Inline-math span detection — the leaf core of inline-math chip handling.
 *
 * Inline math is stored as a run of LaTeX characters tagged with the "math"
 * format but treated as a single atomic chip. `getInlineMathSpans` resolves a
 * block's chips to caret-edge ranges; `getCrossedInlineMathSpan` reports when a
 * caret move stepped across a chip's boundaries.
 *
 * Kept deliberately dependency-light (block-registry + char-runs only) so it can
 * be imported by `MathMark` without dragging in the `selection` → `state-utils`
 * → registry import chain — `MathMark` is constructed while that chain is still
 * initializing, so importing it there would be a load-order cycle. The richer,
 * geometry-aware helpers (`getInlineMathAtPosition`, snapping) live in
 * `./inline-math`, which builds on this module.
 */

import type { Block } from "./serlization/loadPage";
import { isTextualBlock } from "./sync/block-registry";
import { iterateVisibleChars } from "./sync/char-runs";

export interface InlineMathSpan {
  startIndex: number;
  endIndex: number;
  latex: string;
}

export function getInlineMathSpans(block: Block): InlineMathSpan[] {
  if (!isTextualBlock(block)) return [];

  // Build a visible-index view of the block's chars: index → id (to locate the
  // span's tagged start/end chars) and index → char (to recover the LaTeX).
  const visibleIds: string[] = [];
  const visibleChars: string[] = [];
  for (const { id, char } of iterateVisibleChars(block.charRuns)) {
    visibleIds.push(id);
    visibleChars.push(char);
  }

  const spans: InlineMathSpan[] = [];
  for (const span of block.formats) {
    if (span.format.type !== "math") continue;
    const startIdx = visibleIds.indexOf(span.startCharId);
    const endIdx = visibleIds.indexOf(span.endCharId);
    if (startIdx === -1 || endIdx === -1) continue;

    // Caret-edge range is [startIdx, endIdx + 1): startIdx before the first
    // char, endIdx + 1 after the last.
    spans.push({
      startIndex: startIdx,
      endIndex: endIdx + 1,
      latex: visibleChars.slice(startIdx, endIdx + 1).join(""),
    });
  }
  return spans;
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
