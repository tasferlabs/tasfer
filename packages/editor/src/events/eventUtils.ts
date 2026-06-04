import {
  CLICK_DISTANCE_THRESHOLD,
  SELECTION_HANDLE_TOUCH_TARGET,
} from "../constants";
import { getBlockHeight, imageCache, invalidateBlockCache } from "../renderer";
import {
  getCursorDocumentCoords,
  scrollToMakeCursorVisible,
} from "../selection";
import { getEditorStyles } from "../styles";
import type { Operation } from "../sync/sync";
import { getClock, getPageId, nextId } from "../sync/sync";
import type { EditorState, ViewportState } from "../types";
import type { Block } from "@/deserializer/loadPage";

export function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
}
/**
 * Helper function to detect if mouse is hovering over an image block
 */

export function getImageBlockAtPoint(
  x: number,
  y: number,
  state: EditorState,
  viewport: ViewportState,
): {
  blockIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const styles = getEditorStyles();
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  // Iterate through visible blocks to find which one we're over
  const visibleBlocks = state.view.visibleBlocks;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const visibleBlock = visibleBlocks[visibleIdx];

    const blockHeight = getBlockHeight(
      visibleBlock,
      maxWidth,
      styles,
      visibleIdx === 0,
    );

    // Special handling for first block image covers that bleed into padding
    const isFirstBlock = visibleIdx === 0;
    const isImage = visibleBlock.type === "image";

    // Get image width early to determine if it should bleed
    const imageWidth = isImage ? (visibleBlock.width ?? "full") : "full";
    const shouldBleed = isFirstBlock && isImage && imageWidth === "full";

    // For first block image covers that bleed, check from the top of the viewport (adjusted for padding)
    const checkStartY = shouldBleed
      ? currentY - styles.canvas.paddingTop
      : currentY;

    // Check if y is within this block's bounds (accounting for padding bleed)
    if (y >= checkStartY && y < currentY + blockHeight) {
      // Check if this is an image cover block
      if (isImage) {
        const { height: defaultImageHeight, placeholderHeight } =
          styles.blocks.image.dimensions;

        // Image properties already calculated above
        const imageHeight = visibleBlock.height ?? defaultImageHeight;
        const objectFit = visibleBlock.objectFit ?? "cover";

        // Calculate container dimensions based on width setting
        let displayWidth: number;
        let displayHeight: number;
        let displayX: number;

        if (imageWidth === "full") {
          // Full width: edge-to-edge (ignoring padding)
          displayWidth =
            maxWidth + styles.canvas.paddingLeft + styles.canvas.paddingRight;
          displayX = 0;
          displayHeight = visibleBlock.url ? imageHeight : placeholderHeight;
        } else {
          // Custom width: respect padding and constrain to container
          const requestedWidth = imageWidth;
          displayWidth = Math.min(requestedWidth, maxWidth);
          displayX = styles.canvas.paddingLeft + (maxWidth - displayWidth) / 2; // Center the image

          // Adjust height proportionally if width was constrained
          // This ensures images resized on desktop don't get distorted on mobile
          if (visibleBlock.url && displayWidth < requestedWidth) {
            // Width was constrained - adjust height proportionally
            const widthRatio = displayWidth / requestedWidth;
            displayHeight = imageHeight * widthRatio;
          } else {
            displayHeight = visibleBlock.url ? imageHeight : placeholderHeight;
          }
        }

        // Use the shouldBleed flag calculated earlier
        const adjustedY = shouldBleed
          ? currentY - styles.canvas.paddingTop
          : currentY;
        const adjustedHeight = displayHeight;

        // Check if mouse is within the container area
        if (
          x >= displayX &&
          x < displayX + displayWidth &&
          y >= adjustedY &&
          y < adjustedY + adjustedHeight
        ) {
          // For contain mode, we need to calculate the actual image bounds
          let finalX = displayX;
          let finalY = adjustedY;
          let finalWidth = displayWidth;
          let finalHeight = adjustedHeight;

          if (objectFit === "contain" && visibleBlock.url) {
            // Try to get the cached image to calculate actual bounds
            const cachedImage = imageCache.get(visibleBlock.url);
            if (cachedImage && cachedImage.complete) {
              const imgAspectRatio =
                cachedImage.naturalWidth / cachedImage.naturalHeight;
              const containerAspectRatio = displayWidth / adjustedHeight;

              if (imgAspectRatio > containerAspectRatio) {
                // Image is wider than container - fit to width
                finalHeight = displayWidth / imgAspectRatio;
                finalY = adjustedY + (adjustedHeight - finalHeight) / 2;
              } else {
                // Image is taller than container - fit to height
                finalWidth = adjustedHeight * imgAspectRatio;
                finalX = displayX + (displayWidth - finalWidth) / 2;
              }
            }
          }

          return {
            blockIndex: visibleBlock.originalIndex,
            x: finalX,
            y: finalY,
            width: finalWidth,
            height: finalHeight,
          };
        }
      }
      // If we found the block but it's not an image or not over the image area, return null
      return null;
    }

    currentY += blockHeight;
  }

  return null;
}
/**
 * Helper function to detect if mouse/touch is over a line block
 */

export function getLineBlockAtPoint(
  x: number,
  y: number,
  state: EditorState,
  viewport: ViewportState,
): {
  blockIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const styles = getEditorStyles();
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  // Iterate through visible blocks to find which one we're over
  const visibleBlocks = state.view.visibleBlocks;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const visibleBlock = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      visibleBlock,
      maxWidth,
      styles,
      visibleIdx === 0,
    );

    // Check if y is within this block's bounds
    if (y >= currentY && y < currentY + blockHeight) {
      // Check if this is a line block
      if (visibleBlock.type === "line") {
        const lineStyles = styles.blocks.line;

        // Line block spans the full content width
        const displayX = styles.canvas.paddingLeft;
        const displayWidth = maxWidth;
        const displayY = currentY;
        const displayHeight = lineStyles.height;

        // Check if mouse is within the line block area
        if (
          x >= displayX &&
          x < displayX + displayWidth &&
          y >= displayY &&
          y < displayY + displayHeight
        ) {
          return {
            blockIndex: visibleBlock.originalIndex,
            x: displayX,
            y: displayY,
            width: displayWidth,
            height: displayHeight,
          };
        }
      }
      // If we found the block but it's not a line block or not over the line area, return null
      return null;
    }

    currentY += blockHeight;
  }

  return null;
}
export function getMathBlockAtPoint(
  x: number,
  y: number,
  state: EditorState,
  viewport: ViewportState,
): {
  blockIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const styles = getEditorStyles();
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  const visibleBlocks = state.view.visibleBlocks;

  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const visibleBlock = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      visibleBlock,
      maxWidth,
      styles,
      visibleIdx === 0,
    );

    if (y >= currentY && y < currentY + blockHeight) {
      if (visibleBlock.type === "math") {
        const displayX = styles.canvas.paddingLeft;
        const displayWidth = maxWidth;
        const displayY = currentY;
        const displayHeight = blockHeight;

        if (
          x >= displayX &&
          x < displayX + displayWidth &&
          y >= displayY &&
          y < displayY + displayHeight
        ) {
          return {
            blockIndex: visibleBlock.originalIndex,
            x: displayX,
            y: displayY,
            width: displayWidth,
            height: displayHeight,
          };
        }
      }
      return null;
    }

    currentY += blockHeight;
  }

  return null;
}

/**
 * Helper function to detect which drag handle (if any) is being hovered
 * @param x Mouse/touch x position relative to canvas
 * @param y Mouse/touch y position relative to canvas
 * @param imageX Image x position
 * @param imageY Image y position
 * @param imageWidth Image width
 * @param imageHeight Image height
 * @param objectFit The object-fit mode of the image
 * @param extraTolerance Additional tolerance for touch devices (default: 4 for mouse)
 * @returns The position of the hovered drag handle, or null if none
 */
export function getDragHandleAtPoint(
  x: number,
  y: number,
  imageX: number,
  imageY: number,
  imageWidth: number,
  imageHeight: number,
  objectFit: "cover" | "contain" = "cover",
  extraTolerance: number = 4,
): "left" | "right" | "bottom" | null {
  const styles = getEditorStyles();
  const { vertical, horizontal } = styles.imageResize.dragHandles;

  // Extra tolerance for easier hovering/tapping (pixels beyond the visible bar)
  const tolerance = extraTolerance;

  // Left vertical bar (centered vertically with specified length)
  const leftBarX = imageX + vertical.inset;
  const leftBarWidth = vertical.thickness;
  const leftBarY = imageY + (imageHeight - vertical.length) / 2; // Center vertically
  const leftBarHeight = vertical.length;

  if (
    x >= leftBarX - tolerance &&
    x <= leftBarX + leftBarWidth + tolerance &&
    y >= leftBarY &&
    y <= leftBarY + leftBarHeight
  ) {
    return "left";
  }

  // Right vertical bar (centered vertically with specified length)
  const rightBarX = imageX + imageWidth - vertical.inset - vertical.thickness;
  const rightBarWidth = vertical.thickness;
  const rightBarY = imageY + (imageHeight - vertical.length) / 2; // Center vertically
  const rightBarHeight = vertical.length;

  if (
    x >= rightBarX - tolerance &&
    x <= rightBarX + rightBarWidth + tolerance &&
    y >= rightBarY &&
    y <= rightBarY + rightBarHeight
  ) {
    return "right";
  }

  // Bottom horizontal bar (centered horizontally with specified length)
  // Only active in cover mode
  if (objectFit === "cover") {
    const bottomBarX = imageX + (imageWidth - horizontal.length) / 2; // Center horizontally
    const bottomBarWidth = horizontal.length;
    const bottomBarY =
      imageY + imageHeight - horizontal.inset - horizontal.thickness;
    const bottomBarHeight = horizontal.thickness;

    if (
      x >= bottomBarX &&
      x <= bottomBarX + bottomBarWidth &&
      y >= bottomBarY - tolerance &&
      y <= bottomBarY + bottomBarHeight + tolerance
    ) {
      return "bottom";
    }
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

  const styles = getEditorStyles();
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

    // Create operations only for fields that changed during the drag
    // Compare final values with original values from when drag started
    if (block.width !== startWidth) {
      ops.push({
        op: "block_set",
        id: nextId(),
        clock: getClock(),
        pageId: getPageId(),
        blockId,
        field: "width",
        value: block.width,
      });
    }

    if (block.height !== startHeight) {
      ops.push({
        op: "block_set",
        id: nextId(),
        clock: getClock(),
        pageId: getPageId(),
        blockId,
        field: "height",
        value: block.height,
      });
    }

    if (block.objectFit !== startObjectFit) {
      ops.push({
        op: "block_set",
        id: nextId(),
        clock: getClock(),
        pageId: getPageId(),
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

  const styles = getEditorStyles();
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
