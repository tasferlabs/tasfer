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
} from "./inline-math-spans";
import { getCursorDocumentCoords } from "./selection";
import type { Block } from "./serlization/loadPage";
import type { EditorState, EditorStyles, ViewportState } from "./state-types";
import { isTextualBlock } from "./sync/block-registry";

// Re-export the leaf span helpers so existing importers keep their `./inline-math`
// entry point (the spans moved to `./inline-math-spans` to stay import-cycle-safe
// for `MathMark`; see that file's header).
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
 * When `pointer` is supplied, boundary positions are disambiguated by geometry:
 * `textIndex` alone can't tell "end of preceding text" from "start of chip"
 * (especially for single-char chips), so the pointer's x is checked against the
 * chip's rendered x-range.
 */
export function getInlineMathAtPosition(
  blockIndex: number,
  textIndex: number,
  state: EditorState,
  mode: "inside" | "any" = "inside",
  pointer?: { x: number; viewport: ViewportState; styles?: EditorStyles },
): {
  blockId: string;
  startIndex: number;
  endIndex: number;
  latex: string;
} | null {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return null;
  if (!isTextualBlock(block)) return null;

  for (const span of getInlineMathSpans(block)) {
    const { startIndex: spanStart, endIndex: spanEnd } = span;

    let insideHit =
      mode === "any"
        ? textIndex >= spanStart && textIndex <= spanEnd
        : textIndex > spanStart && textIndex < spanEnd;

    // Boundary disambiguation for single-char chips (and any case where
    // textIndex sits on a chip boundary): textIndex alone can't tell "end of
    // preceding text" from "start of chip". When pointer x is provided, verify
    // the click landed within the chip's rendered x-range.
    if (
      !insideHit &&
      mode === "inside" &&
      pointer &&
      (textIndex === spanStart || textIndex === spanEnd)
    ) {
      const startCoords = getCursorDocumentCoords(
        { blockIndex, textIndex: spanStart },
        state,
        pointer.viewport,
        pointer.styles,
      );
      const endCoords = getCursorDocumentCoords(
        { blockIndex, textIndex: spanEnd },
        state,
        pointer.viewport,
        pointer.styles,
      );
      if (
        startCoords &&
        endCoords &&
        startCoords.y === endCoords.y &&
        pointer.x >= startCoords.x &&
        pointer.x <= endCoords.x
      ) {
        insideHit = true;
      }
    }

    if (insideHit) {
      return { blockId: block.id, ...span };
    }
  }

  return null;
}
