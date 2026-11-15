/**
 * Feedback for a touch selection handle crossing a piece a range takes whole
 * or not at all — a √ inside a formula.
 *
 * The node widens a range to whole constructs: once the finger is anywhere
 * inside the √, the range covers all of it and the handle waits at its far
 * edge until the finger leaves. Here that crossing is tracked instead: the
 * handle is drawn under the finger, the part of the √ the finger has covered
 * is filled up to it, and the √ counts as selected only once the finger is
 * past its middle — the same rule as a letter.
 *
 * Generic: it reads the widening from the range's `unsnapped` ends, which any
 * node's resolver leaves behind, so nothing here knows about maths.
 */

import {
  getContentPointDocumentCoords,
  getContentSelectionDocumentGeometry,
} from "../selection";
import type {
  EditorState,
  HandleCrossing,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import {
  contentPointsEqual,
  updateContentSelection,
} from "../structured-selection";

/**
 * Apply the crossing to a range the held handle just moved: `x` is the
 * finger on the handle's text row, in viewport space. Before the piece's
 * middle the range stops at the piece's near edge; past it, the node's
 * widened range stands. The crossing (or null) is stored on the handle drag.
 */
export function crossWidenedPiece(
  state: EditorState,
  x: number,
  viewport: ViewportState,
  visibility?: VisibleBlockRange,
): EditorState {
  const { state: next, crossing } = resolveCrossing(
    state,
    x,
    viewport,
    visibility,
  );
  const drag = next.ui.selectionHandleDrag;
  if (!drag || (!crossing && !drag.crossing)) return next;
  return {
    ...next,
    ui: { ...next.ui, selectionHandleDrag: { ...drag, crossing } },
  };
}

function resolveCrossing(
  state: EditorState,
  x: number,
  viewport: ViewportState,
  visibility?: VisibleBlockRange,
): { state: EditorState; crossing: HandleCrossing | null } {
  const none = { state, crossing: null };
  const selection = state.document.contentSelection;
  const raw = selection?.unsnapped;
  // Only the moving end widened: the finger is inside a piece the range had
  // to take whole. (A widened fixed end is a range leaving a piece, not
  // crossing one.)
  if (
    !selection ||
    !raw ||
    !contentPointsEqual(raw.anchor, selection.anchor) ||
    contentPointsEqual(raw.focus, selection.focus)
  ) {
    return none;
  }

  // The widened end is the piece's far edge. Its near edge is where the same
  // widening lands when the range runs the other way, from the far edge to
  // the finger.
  const far = selection.focus;
  const near = updateContentSelection(state, {
    anchor: far,
    focus: raw.focus,
    lastUpdate: Date.now(),
  }).document.contentSelection?.focus;
  if (
    !near ||
    contentPointsEqual(near, far) ||
    contentPointsEqual(near, raw.focus)
  ) {
    return none;
  }

  const nearAt = getContentPointDocumentCoords(
    near,
    state,
    viewport,
    undefined,
    visibility,
  );
  const farAt = getContentPointDocumentCoords(
    far,
    state,
    viewport,
    undefined,
    visibility,
  );
  if (!nearAt || !farAt) return none;
  // Both edges on one line; a piece split over two lines has no middle.
  if (Math.abs(nearAt.y - farAt.y) > Math.max(nearAt.height, farAt.height) / 2)
    return none;
  const width = Math.abs(farAt.x - nearAt.x);
  if (width < 1) return none;

  const finger = Math.min(
    Math.max(x, Math.min(nearAt.x, farAt.x)),
    Math.max(nearAt.x, farAt.x),
  );
  const counted = Math.abs(finger - nearAt.x) * 2 >= width;
  // The widened range is never empty here, so its node can say how strongly
  // it fills its highlight.
  const opacity = getContentSelectionDocumentGeometry(
    state,
    viewport,
    undefined,
    visibility,
  )?.opacity;
  const crossing: HandleCrossing = {
    x: finger,
    nearX: nearAt.x,
    y: nearAt.y,
    height: nearAt.height,
    counted,
    near,
    ...(opacity === undefined ? {} : { opacity }),
  };
  if (counted) return { state, crossing };
  return {
    state: updateContentSelection(state, {
      anchor: selection.anchor,
      focus: near,
      lastUpdate: Date.now(),
    }),
    crossing,
  };
}
