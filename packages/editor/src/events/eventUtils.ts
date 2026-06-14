import {
  CLICK_DISTANCE_THRESHOLD,
  SELECTION_HANDLE_TOUCH_TARGET,
} from "../constants";
import { AtomicNode, getDragHandleAtPoint } from "../rendering/nodes";
import {
  getBlockHeight,
  imageCache,
  invalidateBlockCache,
} from "../rendering/renderer";
import {
  getCursorDocumentCoords,
  scrollToMakeCursorVisible,
} from "../selection";
import type { Block } from "../serlization/loadPage";
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

    return {
      ...state,
      ui: {
        ...state.ui,
        imageDrag: {
          blockIndex: imageBlock.blockIndex,
          handle: clickedHandle,
          startX: canvasX,
          startY: canvasY,
          startWidth,
          startHeight,
          startObjectFit: objectFit,
        },
      },
    };
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
  if (!state.ui.imageDrag) {
    return state;
  }

  const {
    blockIndex,
    handle,
    startX,
    startY,
    startWidth,
    startHeight,
    startObjectFit,
  } = state.ui.imageDrag;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return state;

  if (block.type !== "image") {
    return state;
  }

  const styles = getEditorStyles(state);
  const deltaX = canvasX - startX;
  const deltaY = canvasY - startY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const snapThreshold = 20; // pixels to snap to padding

  let newWidth: number | "full" = startWidth;
  let newHeight = startHeight;
  let newObjectFit: "cover" | "contain" = startObjectFit;

  if (handle === "left" || handle === "right") {
    // Horizontal resize
    const widthDelta = handle === "left" ? -deltaX * 2 : deltaX * 2; // multiply by 2 because we resize from center
    const { minWidth: constraintMinWidth } = styles.imageResize.constraints;

    if (startWidth === "full") {
      // Start from full width
      const currentWidth = viewport.width;
      newWidth = Math.max(constraintMinWidth, currentWidth + widthDelta);

      // Check if we should snap to padding (transitioning to contained)
      if (Math.abs(newWidth - maxWidth) < snapThreshold) {
        newWidth = maxWidth;
        newObjectFit = "contain";
      } else if (newWidth < maxWidth - snapThreshold) {
        // Definitely in contain mode
        newObjectFit = "contain";
      } else if (newWidth > maxWidth) {
        // If width exceeds document width (maxWidth), stay in cover mode
        newWidth = "full";
        newObjectFit = "cover";
      } else if (newWidth >= viewport.width - 10) {
        // Snap back to full if close
        newWidth = "full";
        newObjectFit = "cover";
      }
    } else {
      // Already in custom width mode
      newWidth = Math.max(
        constraintMinWidth,
        Math.min(viewport.width, (startWidth as number) + widthDelta),
      );

      // Check if we should snap back to full width
      if (newWidth >= viewport.width - snapThreshold) {
        newWidth = "full";
        newObjectFit = "cover";
      } else if (
        newWidth >= maxWidth - snapThreshold &&
        newWidth <= maxWidth + snapThreshold
      ) {
        // Snap to padding width
        newWidth = maxWidth;
        newObjectFit = "contain";
      } else if (newWidth > maxWidth) {
        // If width exceeds document width (maxWidth), convert to cover
        newWidth = "full";
        newObjectFit = "cover";
      } else {
        // Remain in contain mode
        newObjectFit = "contain";
      }
    }

    // In contain mode, calculate height based on image aspect ratio to avoid jumps
    // Apply minWidth constraint to prevent over-resizing of wide images
    if (
      newObjectFit === "contain" &&
      typeof newWidth === "number" &&
      block.url
    ) {
      const cachedImage = imageCache.get(block.url);
      if (cachedImage && cachedImage.complete) {
        const imgAspectRatio =
          cachedImage.naturalWidth / cachedImage.naturalHeight;

        // Ensure width doesn't go below minimum (already enforced above, but keep for clarity)
        newWidth = Math.max(newWidth, constraintMinWidth);

        // Calculate height based on width and aspect ratio
        newHeight = newWidth / imgAspectRatio;
      }
    }
  } else if (handle === "bottom" && startObjectFit === "cover") {
    // Vertical resize (only in cover mode)
    // In cover mode, we enforce minimum height
    const { minHeight: constraintMinHeight } = styles.imageResize.constraints;
    const calculatedHeight = Math.max(
      constraintMinHeight,
      startHeight + deltaY,
    );

    // Cap height based on image aspect ratio to prevent over-resizing
    if (block.url) {
      const cachedImage = imageCache.get(block.url);
      if (cachedImage && cachedImage.complete) {
        const imgAspectRatio =
          cachedImage.naturalWidth / cachedImage.naturalHeight;

        // Calculate the current container width
        const containerWidth =
          typeof startWidth === "number" ? startWidth : viewport.width;

        // For portrait images (tall), cap the height so it doesn't exceed the image's natural ratio
        // This prevents excessive cropping when the image is resized too tall
        const maxHeightForRatio = containerWidth / imgAspectRatio;

        // Cap the height at the image's natural ratio relative to container width
        newHeight = Math.min(calculatedHeight, maxHeightForRatio);

        // Ensure we don't go below minimum height
        newHeight = Math.max(newHeight, constraintMinHeight);
      } else {
        newHeight = calculatedHeight;
      }
    } else {
      newHeight = calculatedHeight;
    }
  }

  // Update the block with new dimensions
  const updatedBlock: Block = {
    ...block,
    width: newWidth,
    height: newHeight,
    objectFit: newObjectFit,
  };

  // Invalidate the block height cache since dimensions changed
  invalidateBlockCache(updatedBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    document: {
      ...state.document,
      page: { ...state.document.page, blocks: newBlocks },
    },
  };
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
  if (!state.ui.imageDrag) {
    return { state, ops: [] };
  }

  const ops: Operation[] = [];
  const { blockIndex, startWidth, startHeight, startObjectFit } =
    state.ui.imageDrag;
  const block = state.document.page.blocks[blockIndex];

  if (block && block.type === "image") {
    const blockId = block.id;

    // Create operations only for fields that changed during the drag.
    // Compare final values with original values from when drag started.
    // Guard against `undefined`: a defensive resize math edge case could leave
    // a dimension unset, and emitting `value: undefined` serializes to a
    // value-less block_set that `applyBlockSet`/`validateField` reject on every
    // peer — leaving the local editor's image silently desynced (it reflows to
    // its default size, jumping the content below it). Never emit such an op.
    if (block.width !== startWidth && block.width !== undefined) {
      ops.push({
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId,
        field: "width",
        value: block.width,
      });
    }

    if (block.height !== startHeight && block.height !== undefined) {
      ops.push({
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId,
        field: "height",
        value: block.height,
      });
    }

    if (block.objectFit !== startObjectFit && block.objectFit !== undefined) {
      ops.push({
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId,
        field: "objectFit",
        value: block.objectFit,
      });
    }
  }

  const finalState = {
    ...state,
    ui: {
      ...state.ui,
      imageDrag: null,
    },
  };

  return { state: finalState, ops };
}
/**
 * Cancel an image drag resize operation (without recording undo)
 * @param state Current editor state
 * @returns Updated state with imageDrag cleared
 */
export function cancelImageDrag(state: EditorState): EditorState {
  if (!state.ui.imageDrag) {
    return state;
  }

  return {
    ...state,
    ui: {
      ...state.ui,
      imageDrag: null,
    },
  };
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
