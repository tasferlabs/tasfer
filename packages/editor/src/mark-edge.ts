/**
 * Mark edges — the two caret stops where an inline mark starts or ends.
 *
 * Where the marks on the character before the caret differ from the marks on
 * the character after it, one screen position is really two places to type:
 * attached to the text before ("before" side) or to the text after ("after"
 * side). Typing takes the marks of the side the caret is on, and the arrow keys
 * step between the two sides before they move — the same "keep typing until you
 * arrow out" rule an inline formula follows, applied to every flat mark.
 *
 * The side lives in `ui.activeMarksMode`, the same slot a Ctrl+B toggle uses:
 * "inherit" is the before side (typing continues the text behind the caret),
 * and an explicit set equal to the after side's marks is the after side. So the
 * toolbar, typing, and the Ctrl+B override all read one value, and any caret
 * move that resets the toggle (a click, Home/End, up/down) lands on the before
 * side for free.
 *
 * Structured marks (an inline formula) are left out: a chip owns its own caret
 * and is entered and left through its own navigation.
 */

import type { Block, Mark } from "./serlization/loadPage";
import type { EditorState } from "./state-types";
import { isTextualBlock } from "./sync/block-registry";
import { getVisibleLengthFromRuns } from "./sync/char-runs";
import { getFormatsAtCharPosition } from "./sync/crdt-utils";
import { areMarksEqual, markKey } from "./sync/mark-spans";

/** Which neighbouring text the caret belongs to at a mark edge. */
export type MarkEdgeSide = "before" | "after";

/** The flat marks on either side of a caret offset that sits on a mark edge. */
export interface MarkEdge {
  readonly before: readonly Mark[];
  readonly after: readonly Mark[];
}

/** Flat (non-structured) marks, one per identity, in a stable order. */
function flatMarks(state: EditorState, marks: readonly Mark[]): Mark[] {
  const byKey = new Map<string, Mark>();
  for (const mark of marks) {
    if (state.schema.structuredMark(mark.type)) continue;
    byKey.set(markKey(mark), mark);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, mark]) => mark);
}

/** Whether any of `marks` is a structured mark (an inline formula's anchor). */
function hasStructuredMark(
  state: EditorState,
  marks: readonly Mark[],
): boolean {
  return marks.some((mark) => state.schema.structuredMark(mark.type));
}

/** Whether two mark sets hold the same marks, ignoring order and repeats. */
export function sameMarkSet(a: readonly Mark[], b: readonly Mark[]): boolean {
  return (
    a.every((mark) => b.some((other) => areMarksEqual(mark, other))) &&
    b.every((mark) => a.some((other) => areMarksEqual(mark, other)))
  );
}

/**
 * The mark edge at `textIndex` in `block`, or null when the text on both sides
 * carries the same flat marks (no edge: there is only one place to type).
 */
export function markEdgeAt(
  state: EditorState,
  block: Block | undefined,
  textIndex: number,
): MarkEdge | null {
  if (!block || block.deleted || !isTextualBlock(block)) return null;
  const length = getVisibleLengthFromRuns(block.charRuns);
  const rawBefore =
    textIndex > 0
      ? getFormatsAtCharPosition(block.charRuns, block.formats, textIndex)
      : [];
  const rawAfter =
    textIndex < length
      ? getFormatsAtCharPosition(block.charRuns, block.formats, textIndex + 1)
      : [];
  // Beside a formula the chip owns the caret stops (it is entered and left by
  // its own navigation), so a second, flat stop there would double them.
  if (
    hasStructuredMark(state, rawBefore) ||
    hasStructuredMark(state, rawAfter)
  ) {
    return null;
  }
  const before = flatMarks(state, rawBefore);
  const after = flatMarks(state, rawAfter);
  return sameMarkSet(before, after) ? null : { before, after };
}

/**
 * The flat marks text typed at `textIndex` continues from the character before
 * it — what the "before" side (inherit mode) types with.
 */
export function inheritedTypingMarks(
  state: EditorState,
  block: Block,
  textIndex: number,
): Mark[] {
  if (!isTextualBlock(block) || textIndex <= 0) return [];
  return flatMarks(
    state,
    getFormatsAtCharPosition(block.charRuns, block.formats, textIndex),
  );
}

/**
 * The caret's side of the mark edge it sits on, or null when it is not on an
 * edge — no caret, a held selection, a nested (structured) caret, or a Ctrl+B
 * toggle that matches neither side.
 */
export function caretMarkEdgeSide(
  state: EditorState,
): { edge: MarkEdge; side: MarkEdgeSide } | null {
  const cursor = state.document.cursor;
  if (!cursor || state.document.contentSelection) return null;
  const selection = state.document.selection;
  if (selection && !selection.isCollapsed) return null;
  const { blockIndex, textIndex } = cursor.position;
  const edge = markEdgeAt(
    state,
    state.document.page.blocks[blockIndex],
    textIndex,
  );
  if (!edge) return null;
  const mode = state.ui.activeMarksMode;
  if (mode.type === "inherit") return { edge, side: "before" };
  if (hasStructuredMark(state, mode.formats)) return null;
  if (sameMarkSet(mode.formats, edge.after)) return { edge, side: "after" };
  if (sameMarkSet(mode.formats, edge.before)) return { edge, side: "before" };
  return null;
}

/** `state` with the caret put on `side` of `edge`, without moving it. */
export function withMarkEdgeSide(
  state: EditorState,
  edge: MarkEdge,
  side: MarkEdgeSide,
): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      activeMarksMode:
        side === "before"
          ? { type: "inherit" }
          : { type: "explicit", formats: [...edge.after] },
    },
  };
}
