import {
  CLICK_DISTANCE_THRESHOLD,
  SELECTION_HANDLE_TOUCH_TARGET,
} from "../constants";
import { isTouchDevice, isTouchOnlyDevice } from "../node-shared";
import { AtomicNode } from "../rendering/nodes";
import { getBlockHeight } from "../rendering/renderer";
import {
  getSelectionHandleCoords,
  isNodeSelection,
  scrollToMakeCursorVisible,
} from "../selection";
import type {
  EditorState,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import { getEditorStyles } from "../styles";

export { isTouchDevice, isTouchOnlyDevice };

/**
 * Find the atomic (void/embed) block under a viewport point, dispatched through
 * the node registry: each AtomicNode reports its own interactive box via
 * `hitTestBox`, so new atomic block types are hit-testable without touching the
 * event layer. Pass `type` to only match a specific block type (e.g. "image").
 */
export function getAtomicBlockAtPoint(
  x: number,
  y: number,
  state: EditorState,
  viewport: ViewportState,
  type?: string,
  visibility?: VisibleBlockRange,
): {
  blockIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const styles = getEditorStyles(state);
  let currentY =
    visibility?.startY ?? styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  const visibleBlocks = state.view.visibleBlocks;

  const startIndex = visibility?.start ?? 0;
  for (
    let visibleIdx = startIndex;
    visibleIdx < visibleBlocks.length;
    visibleIdx++
  ) {
    const block = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      state.nodes,
      state.marks,
      block,
      maxWidth,
      styles,
      visibleIdx === 0,
    );

    const node = state.nodes.get(block.type);
    const hit =
      node instanceof AtomicNode
        ? node.hitTestBox(
            {
              block,
              blockIndex: block.originalIndex,
              maxWidth,
              isFirst: visibleIdx === 0,
              styles,
              marks: state.marks,
            },
            { x: styles.canvas.paddingLeft, y: currentY },
            { x, y },
          )
        : null;

    // The interactive box may bleed above the flow box (first full-width
    // image), so the y-range check starts at whichever is higher.
    const top = hit ? Math.min(currentY, hit.y) : currentY;
    if (y >= top && y < currentY + blockHeight) {
      if (hit && (!type || block.type === type)) {
        return { blockIndex: block.originalIndex, ...hit };
      }
      // Found the block under the point, but it is not a matching atomic hit.
      return null;
    }

    currentY += blockHeight;
  }

  return null;
}

// The image-resize-handle drag wrappers (startImageHandleDrag, … ) moved to
// `nodes/ImageNode.ts`, where they live with the node + the drag actions they
// dispatch. Importers now pull them from `../rendering/nodes`.

/**
 * Helper function to scroll viewport to make cursor visible after state changes
 * @param newState The new editor state
 * @param oldState The previous editor state
 * @param viewport Current viewport state
 * @param updateViewportCallback Callback to update the viewport scroll position
 */
export function ensureCursorVisible(
  newState: EditorState,
  oldState: EditorState,
  viewport: ViewportState,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  visibility?: VisibleBlockRange,
): void {
  if (
    newState !== oldState &&
    newState.document.cursor &&
    updateViewportCallback
  ) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport,
      undefined,
      visibility,
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }
}

export function isWithinClickDistance(
  pos1: { x: number; y: number },
  pos2: { x: number; y: number },
  threshold: number = CLICK_DISTANCE_THRESHOLD,
): boolean {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  return Math.sqrt(dx * dx + dy * dy) <= threshold;
}
/**
 * Helper function to get selection handle positions for touch detection.
 * Returns the positions of both anchor and focus handles.
 */
function getSelectionHandlePositions(
  state: EditorState,
  viewport: ViewportState,
  visibility?: VisibleBlockRange,
): {
  anchor: { x: number; y: number; height: number; isTop: boolean } | null;
  focus: { x: number; y: number; height: number; isTop: boolean } | null;
} | null {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed || isNodeSelection(selection)) {
    return null;
  }

  const styles = getEditorStyles(state);
  // Hit-testing must key off the SAME geometry the handles are drawn at (the
  // painted highlight's edges), or the grab target drifts from the visible ball.
  const isForward = selection.isForward;
  const anchorCoords = getSelectionHandleCoords(
    selection.anchor,
    isForward ? "start" : "end",
    state,
    viewport,
    styles,
    visibility,
  );
  const focusCoords = getSelectionHandleCoords(
    selection.focus,
    isForward ? "end" : "start",
    state,
    viewport,
    styles,
    visibility,
  );

  if (!anchorCoords || !focusCoords) {
    return null;
  }

  return {
    anchor: {
      x: anchorCoords.x,
      y: anchorCoords.y,
      height: anchorCoords.height,
      isTop: isForward,
    },
    focus: {
      x: focusCoords.x,
      y: focusCoords.y,
      height: focusCoords.height,
      isTop: !isForward,
    },
  };
}
/**
 * Detect if a touch point is on a selection handle.
 * Returns "anchor", "focus", or null if not on any handle.
 */

export function getSelectionHandleAtPoint(
  touchX: number,
  touchY: number,
  state: EditorState,
  viewport: ViewportState,
  visibility?: VisibleBlockRange,
): "anchor" | "focus" | null {
  const handlePositions = getSelectionHandlePositions(
    state,
    viewport,
    visibility,
  );
  if (!handlePositions) {
    return null;
  }

  const styles = getEditorStyles(state);
  const handleRadius = styles.selection.handles.size / 2;
  const stemHeight = styles.selection.handles.stemHeight;
  const touchTargetRadius = SELECTION_HANDLE_TOUCH_TARGET / 2;

  // The grabbable area covers the circular ball *and* the stem, which now spans
  // the full text height. We test both: a comfortable circle around the ball,
  // plus a widened band over the stem so the thin bar is easy to grab. When the
  // selection is short the two handles can overlap, so pick the nearest ball.
  const evaluate = (
    handle: "anchor" | "focus",
    pos: { x: number; y: number; height: number; isTop: boolean },
  ): { handle: "anchor" | "focus"; distance: number } | null => {
    const { x, y, height, isTop } = pos;
    const ballY = isTop
      ? y - stemHeight - handleRadius
      : y + height + stemHeight + handleRadius;

    const ballDistance = Math.sqrt(
      Math.pow(touchX - x, 2) + Math.pow(touchY - ballY, 2),
    );

    // 1) Ball: a comfortable circular target.
    let hit = ballDistance <= touchTargetRadius;

    // 2) Stem bar: the vertical bar runs the full text height; make that whole
    //    span grabbable with a horizontal band the width of the touch target.
    if (!hit) {
      const barTop = isTop ? y - stemHeight : y;
      const barBottom = isTop ? y + height : y + height + stemHeight;
      hit =
        touchX >= x - touchTargetRadius &&
        touchX <= x + touchTargetRadius &&
        touchY >= barTop &&
        touchY <= barBottom;
    }

    return hit ? { handle, distance: ballDistance } : null;
  };

  // Handle positions come back in document space, but the touch point and the
  // painted handles are in viewport space. Convert before hit-testing — without
  // this the hitbox is offset by scrollY whenever the document is scrolled, so
  // the touch misses the handle and falls through to the scroll gesture.
  const toViewport = (pos: {
    x: number;
    y: number;
    height: number;
    isTop: boolean;
  }) => ({ ...pos, y: pos.y - viewport.scrollY });

  const candidates = [
    handlePositions.anchor &&
      evaluate("anchor", toViewport(handlePositions.anchor)),
    handlePositions.focus &&
      evaluate("focus", toViewport(handlePositions.focus)),
  ].filter(
    (c): c is { handle: "anchor" | "focus"; distance: number } => c != null,
  );

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0].handle;
}
