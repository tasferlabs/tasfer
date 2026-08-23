/**
 * Inline-math span navigation.
 *
 * Inline math is stored as a run of LaTeX characters tagged with the "math"
 * format, but is treated as a single atomic chip by the editor: the caret snaps
 * to a chip's boundaries rather than landing inside it, clicks/hovers open the
 * inline-math editor instead of placing a cursor in the source, etc.
 *
 * Every helper here resolves chips through one core — `getInlineMathSpans` — so
 * caret movement, snapping, hit-testing, and edge detection all agree on where a
 * chip's boundaries fall. (Rendering inline math to glyphs is a separate
 * concern — see `getInlineMathDims` in `./math` and the `MathMark` painter.)
 */

import {
  getCrossedInlineMathSpan,
  getInlineMathSpans,
  type InlineMathSpan,
} from "./spans";
import type { Block } from "@tasfer/editor/serlization/loadPage";
import type { EditorState } from "@tasfer/editor/state-types";
import { isTextualBlock } from "@tasfer/editor/sync/block-registry";

// Re-export the leaf span helpers so existing importers keep their `./inline-math`
// entry point (the spans live in `./math/spans` to stay import-cycle-safe for
// `MathMark`; see that file's header).
export { getCrossedInlineMathSpan, getInlineMathSpans, type InlineMathSpan };

/**
 * Find the inline-math chip covering a caret position. `mode` controls which
 * positions count as covered:
 * - "leftEdge":  position exactly at the chip start
 * - "rightEdge": position exactly at the chip end
 * - "inside":    position strictly between the chip's boundaries
 */
export function findInlineMathSpan(
  block: Block,
  position: number,
  mode: "leftEdge" | "rightEdge" | "inside",
): InlineMathSpan | null {
  for (const span of getInlineMathSpans(block)) {
    if (mode === "leftEdge" && position === span.startIndex) return span;
    if (mode === "rightEdge" && position === span.endIndex) return span;
    if (
      mode === "inside" &&
      position > span.startIndex &&
      position < span.endIndex
    ) {
      return span;
    }
  }
  return null;
}

/**
 * Find the inline-math chip at a position within a block, addressed by block
 * index against the editor state. The chip is treated as a single atomic unit —
 * the cursor should snap to either boundary rather than land inside it.
 *
 * `mode` controls inclusivity at the boundaries:
 * - "inside": treat positions strictly between [startIndex+1, endIndex-1] as
 *             inside (positions at the edges return null — cursor is fine there)
 * - "any":    return the chip if the index is anywhere within [startIndex,
 *             endIndex]
 *
 * A position alone cannot say which side of a boundary the POINTER is on — a
 * chip is one anchor char, so its edges are shared with the surrounding text.
 * Callers that need that answer hit-test the chip itself (see
 * `Node.contentSelectionFromPoint`) rather than probing caret geometry here.
 */
export function getInlineMathAtPosition(
  blockIndex: number,
  textIndex: number,
  state: EditorState,
  mode: "inside" | "any" = "inside",
): {
  blockId: string;
  startIndex: number;
  endIndex: number;
  text: string;
} | null {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return null;
  if (!isTextualBlock(block)) return null;

  for (const span of getInlineMathSpans(block)) {
    const { startIndex: spanStart, endIndex: spanEnd } = span;
    const hit =
      mode === "any"
        ? textIndex >= spanStart && textIndex <= spanEnd
        : textIndex > spanStart && textIndex < spanEnd;
    if (hit) return { blockId: block.id, ...span };
  }

  return null;
}
