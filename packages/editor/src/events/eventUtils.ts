import {
  CANCEL_IMAGE_DRAG,
  END_IMAGE_DRAG,
  START_IMAGE_DRAG,
  UPDATE_IMAGE_DRAG,
} from "../actions/input-commands";
import {
  CLICK_DISTANCE_THRESHOLD,
  SELECTION_HANDLE_TOUCH_TARGET,
} from "../constants";
import { AtomicNode, getDragHandleAtPoint } from "../rendering/nodes";
import { getBlockHeight } from "../rendering/renderer";
import {
  getCursorDocumentCoords,
  scrollToMakeCursorVisible,
} from "../selection";
import type { EditorState, ViewportState } from "../state-types";
import { getEditorStyles } from "../styles";
import type { Operation } from "../sync/sync";

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

/**
 * Start an image drag resize operation
 * @param state Current editor state
 * @param imageBlock The image block info from hit detection
 * @param canvasX X position relative to canvas
 * @param canvasY Y position relative to canvas
 * @param extraTolerance Extra tolerance for touch devices
 * @returns Updated state with imageDrag if drag started, or null if no drag handle was hit
 */

export function startImageDrag(
  state: EditorState,
  imageBlock: {
    blockIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
  },
  canvasX: number,
  canvasY: number,
  extraTolerance: number = 4,
): EditorState | null {
  const block = state.document.page.blocks[imageBlock.blockIndex];
  if (!block || block.deleted) return null;
  if (block.type !== "image") {
    return null;
  }

  const objectFit = block.objectFit ?? "cover";
  const clickedHandle = getDragHandleAtPoint(
    canvasX,
    canvasY,
    imageBlock.x,
    imageBlock.y,
    imageBlock.width,
    imageBlock.height,
    objectFit,
    extraTolerance,
  );

  if (clickedHandle && block.url) {
    // Start dragging the handle
    // Use the displayed dimensions (imageBlock.width/height) instead of stored dimensions (block.width/height)
    // This ensures that resizing works correctly on mobile when the image was resized on desktop
    // For 'full' width images, we keep them as 'full'
    const storedWidth = block.width ?? "full";
    const startWidth = storedWidth === "full" ? "full" : imageBlock.width;
    const startHeight = imageBlock.height;

    // The handle hit + start dimensions are pointer-derived; resolve them here
    // and hand the finished drag descriptor to START_IMAGE_DRAG.
    return state.commandBus.dispatchState(START_IMAGE_DRAG, state, {
      imageDrag: {
        blockIndex: imageBlock.blockIndex,
        handle: clickedHandle,
        startX: canvasX,
        startY: canvasY,
        startWidth,
        startHeight,
        startObjectFit: objectFit,
      },
    }).state;
  }

  return null;
}
/**
 * Update image dimensions during drag resize
 * @param state Current editor state
 * @param viewport Current viewport state
 * @param canvasX Current x position relative to canvas
 * @param canvasY Current y position relative to canvas
 * @returns Updated state with new image dimensions
 */

export function updateImageDrag(
  state: EditorState,
  viewport: ViewportState,
  canvasX: number,
  canvasY: number,
): EditorState {
  return state.commandBus.dispatchState(UPDATE_IMAGE_DRAG, state, {
    viewport,
    canvasX,
    canvasY,
  }).state;
}
/**
 * End an image drag resize operation
 * @param state Current editor state
 * @param crdtContext CRDT context for generating operations
 * @returns Updated state with imageDrag cleared and operations for the resize
 */

export function endImageDrag(state: EditorState): {
  state: EditorState;
  ops: Operation[];
} {
  return state.commandBus.dispatchState(END_IMAGE_DRAG, state);
}
/**
 * Cancel an image drag resize operation (without recording undo)
 * @param state Current editor state
 * @returns Updated state with imageDrag cleared
 */
export function cancelImageDrag(state: EditorState): EditorState {
  return state.commandBus.dispatchState(CANCEL_IMAGE_DRAG, state).state;
}
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
