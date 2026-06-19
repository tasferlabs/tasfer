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
import { iterateAllChars } from "./sync/char-runs";

export interface InlineMathSpan {
  startIndex: number;
  endIndex: number;
  latex: string;
}

export function getInlineMathSpans(block: Block): InlineMathSpan[] {
  if (!isTextualBlock(block)) return [];

  // Resolve the span's tagged endpoints *tolerantly*: a format span anchors to
  // exact char IDs, but those chars can be tombstoned (deleting a chip's leading
  // char makes `startCharId` a tombstone) while interior chars survive. Matching
  // the render path (`isCharInSpan` finds the anchor over ALL chars, not just
  // visible ones), we key off document-order ordinals so a span resolves to its
  // surviving visible chars instead of vanishing when an endpoint is deleted.
  const ordinal = new Map<string, number>(); // char id → document-order position
  const visibleOrd: number[] = []; // ordinal of each visible char, ascending
  const visibleChars: string[] = []; // visible chars, to recover the LaTeX
  let ord = 0;
  for (const { id, char, deleted } of iterateAllChars(block.charRuns)) {
    ordinal.set(id, ord);
    if (!deleted) {
      visibleOrd.push(ord);
      visibleChars.push(char);
    }
    ord++;
  }

  const spans: InlineMathSpan[] = [];
  for (const span of block.formats) {
    if (span.format.type !== "math") continue;
    const startOrd = ordinal.get(span.startCharId);
    const endOrd = ordinal.get(span.endCharId);
    if (startOrd === undefined || endOrd === undefined) continue;

    // Visible chars whose ordinal falls within the (possibly tombstoned)
    // endpoint range [startOrd, endOrd]. `visibleOrd` ascends, so the first such
    // index opens the span and the last closes it.
    let startIndex = -1;
    let endIndex = -1;
    for (let vi = 0; vi < visibleOrd.length; vi++) {
      if (visibleOrd[vi] < startOrd) continue;
      if (visibleOrd[vi] > endOrd) break;
      if (startIndex === -1) startIndex = vi;
      endIndex = vi;
    }
    if (startIndex === -1) continue; // every char in the span is deleted

    // Caret-edge range is [startIndex, endIndex + 1): startIndex before the
    // first surviving char, endIndex + 1 after the last.
    spans.push({
      startIndex,
      endIndex: endIndex + 1,
      latex: visibleChars.slice(startIndex, endIndex + 1).join(""),
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
