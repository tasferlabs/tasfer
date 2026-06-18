import {
  CLICK_DISTANCE_THRESHOLD,
  SELECTION_HANDLE_TOUCH_TARGET,
} from "../constants";
import { AtomicNode } from "../rendering/nodes";
import { getBlockHeight } from "../rendering/renderer";
import {
  getCursorDocumentCoords,
  scrollToMakeCursorVisible,
} from "../selection";
import type { EditorState, ViewportState } from "../state-types";
import { getEditorStyles } from "../styles";

export function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
}
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
): {
  blockIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const styles = getEditorStyles(state);
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  const visibleBlocks = state.view.visibleBlocks;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
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
): {
  anchor: { x: number; y: number; height: number; isTop: boolean } | null;
  focus: { x: number; y: number; height: number; isTop: boolean } | null;
} | null {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) {
    return null;
  }

  const anchorCoords = getCursorDocumentCoords(
    selection.anchor,
    state,
    viewport,
  );
  const focusCoords = getCursorDocumentCoords(selection.focus, state, viewport);

  if (!anchorCoords || !focusCoords) {
    return null;
  }

  const isForward = selection.isForward;

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
): "anchor" | "focus" | null {
  const handlePositions = getSelectionHandlePositions(state, viewport);
  if (!handlePositions) {
    return null;
  }

  const styles = getEditorStyles(state);
  const handleSize = styles.selection.handles.size;
  const stemHeight = styles.selection.handles.stemHeight;
  const touchTargetRadius = SELECTION_HANDLE_TOUCH_TARGET / 2;

  // Check anchor handle
  if (handlePositions.anchor) {
    const { x, y, height, isTop } = handlePositions.anchor;
    // Calculate center of the circle part of the handle
    let circleY: number;
    if (isTop) {
      // Circle is above the line
      circleY = y - stemHeight - handleSize / 2;
    } else {
      // Circle is below the line
      circleY = y + height + stemHeight + handleSize / 2;
    }

    const distance = Math.sqrt(
      Math.pow(touchX - x, 2) + Math.pow(touchY - circleY, 2),
    );
    if (distance <= touchTargetRadius) {
      return "anchor";
    }
  }

  // Check focus handle
  if (handlePositions.focus) {
    const { x, y, height, isTop } = handlePositions.focus;
    // Calculate center of the circle part of the handle
    let circleY: number;
    if (isTop) {
      // Circle is above the line
      circleY = y - stemHeight - handleSize / 2;
    } else {
      // Circle is below the line
      circleY = y + height + stemHeight + handleSize / 2;
    }

    const distance = Math.sqrt(
      Math.pow(touchX - x, 2) + Math.pow(touchY - circleY, 2),
    );
    if (distance <= touchTargetRadius) {
      return "focus";
    }
  }

  return null;
}
