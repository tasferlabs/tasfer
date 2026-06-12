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
 * concern — see `getInlineMathDims`/`getInlineMathImage` in `./math`.)
 */

import { getCursorDocumentCoords } from "./selection";
import type { Block } from "./serlization/loadPage";
import type { EditorState, EditorStyles, ViewportState } from "./state-types";
import { isTextualBlock } from "./sync/block-registry";
import { iterateVisibleChars } from "./sync/char-runs";

/**
 * An inline-math chip resolved to visible-character indices. `[startIndex,
 * endIndex)` is the caret-edge range: `startIndex` sits before the first LaTeX
 * char, `endIndex` after the last. `latex` is the chip's source text.
 */
export interface InlineMathSpan {
  startIndex: number;
  endIndex: number;
  latex: string;
}

/**
 * Resolve every inline-math chip in a block to its visible-index range. This is
 * the single source of truth the navigation helpers below build on, so they all
 * agree on each chip's boundaries. Returns an empty array for non-textual
 * blocks (which carry no formats).
 */
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
 * Inline math is a single atomic chip — the caret may not sit inside it. If a
 * candidate visible-index landed inside a chip, snap it out to the chip boundary
 * in the requested logical direction. Returns the original index when it did not
 * fall inside a chip.
 */
export function snapInlineMathPosition(
  block: Block,
  textIndex: number,
  direction: "left" | "right",
): number {
  for (const span of getInlineMathSpans(block)) {
    if (textIndex > span.startIndex && textIndex < span.endIndex) {
      return direction === "left" ? span.startIndex : span.endIndex;
    }
  }
  return textIndex;
}

/**
 * If a cursor move went from one boundary of an inline-math chip to the opposite
 * boundary (i.e. the snap fired and we crossed the chip), return the chip. Used
 * to open the inline-math editor popover when arrow-keying inbound.
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
