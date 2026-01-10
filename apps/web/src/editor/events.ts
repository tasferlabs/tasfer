import type { Block } from "../deserializer/loadPage";
import { isNotImageBlock, isListBlock } from "../deserializer/loadPage";
import { SLASH_COMMANDS } from "./SlashCommandMenu";
import { copySelectionToClipboard, pasteFromClipboardEvent } from "./clipboard";
import {
  applySlashCommand,
  deleteForward,
  deleteSelectedText,
  deleteText,
  deleteTextRangeInFormattedContent,
  deleteWordBackward,
  deleteWordForward,
  extendSelectionEnd,
  extendSelectionHome,
  extendSelectionWordLeft,
  extendSelectionWordRight,
  getSelectionRange,
  indentListItem,
  insertText,
  moveToLineEnd,
  moveToLineStart,
  moveToNextWord,
  moveToPreviousWord,
  outdentListItem,
  selectAll,
  selectLineAtPosition,
  selectWordAtPosition,
  splitBlock,
  toggleBold,
  toggleTodoChecked,
} from "./commands";
import {
  CLICK_DISTANCE_THRESHOLD,
  CONTEXT_MENU_DURATION,
  DOUBLE_CLICK_TIME,
  EDGE_SCROLL_ACCELERATION_RATE,
  EDGE_SCROLL_MAX_SPEED,
  EDGE_SCROLL_SPEED,
  EDGE_SCROLL_THRESHOLD,
  MOVEMENT_THRESHOLD,
  SCROLLBAR_HOLD_DURATION,
  SCROLLBAR_TOUCH_BUFFER,
  SELECTION_HANDLE_TOUCH_TARGET,
  TAP_DISTANCE_THRESHOLD,
  TAP_MAX_DURATION,
} from "./constants";
import { getBlockHeight, imageCache, invalidateBlockCache } from "./renderer";
import { getEditorStyles, getTextStyle } from "./styles";
import { getCurrentFontFamily, getFontMetrics } from "./fonts";
import { getFormattedTextDirection } from "./rtl";
import {
  applyMomentum,
  endScrollbarDrag,
  isPointInScrollbar,
  isPointInThumb,
  startScrollbarDrag,
  updateScrollFromThumbDrag,
  updateScrollFromTrackClick,
  updateScrollFromWheel,
  updateScrollbarFadeOpacity,
  updateScrollbarHover,
} from "./scrollbar";
import {
  getCursorCoordinates,
  getLinkAtPosition,
  getTextPositionFromViewport,
  scrollToMakeCursorVisible,
} from "./selection";
import {
  clearAutoCreatedParagraph,
  clearSelection,
  closeActiveMenu,
  closeSlashCommand,
  extendSelectionDown,
  extendSelectionLeft,
  extendSelectionPageDown,
  extendSelectionPageUp,
  extendSelectionRight,
  extendSelectionUp,
  generateBlockId,
  getBlockTextContent,
  getBlockTextLength,
  moveCursorDown,
  moveCursorLeft,
  moveCursorPageDown,
  moveCursorPageUp,
  moveCursorRight,
  moveCursorToPosition,
  moveCursorUp,
  openContextMenu,
  openSlashCommand,
  selectContextMenuItem,
  setActiveMenu,
  startSelection,
  updateContextMenuHover,
  updateCursor,
  updateFocus,
  updateMode,
  updateSelectionFocus,
  updateSlashCommandFilter,
  updateSlashCommandSelection,
} from "./state";
import type {
  EditorState,
  KeyboardEvent,
  MouseEvent,
  ViewportState,
} from "./types";
import { recordUndo, redoState, undoState } from "./undo";

function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
}

/**
 * Helper function to detect if mouse is hovering over an image block
 */
function getImageBlockAtPoint(
  x: number,
  y: number,
  state: EditorState,
  viewport: ViewportState
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

  // Iterate through blocks to find which one we're over
  for (
    let blockIndex = 0;
    blockIndex < state.document.page.blocks.length;
    blockIndex++
  ) {
    const block = state.document.page.blocks[blockIndex];
    const blockHeight = getBlockHeight(block, maxWidth, styles, blockIndex);

    // Special handling for first block image covers that bleed into padding
    const isFirstBlock = blockIndex === 0;
    const isImage = block.type === "image";

    // Get image width early to determine if it should bleed
    const imageWidth = isImage ? block.width ?? "full" : "full";
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
        const imageHeight = block.height ?? defaultImageHeight;
        const objectFit = block.objectFit ?? "cover";

        // Calculate container dimensions based on width setting
        let displayWidth: number;
        let displayHeight: number;
        let displayX: number;

        if (imageWidth === "full") {
          // Full width: edge-to-edge (ignoring padding)
          displayWidth =
            maxWidth + styles.canvas.paddingLeft + styles.canvas.paddingRight;
          displayX = 0;
          displayHeight = block.url ? imageHeight : placeholderHeight;
        } else {
          // Custom width: respect padding and constrain to container
          const requestedWidth = imageWidth;
          displayWidth = Math.min(requestedWidth, maxWidth);
          displayX = styles.canvas.paddingLeft + (maxWidth - displayWidth) / 2; // Center the image

          // Adjust height proportionally if width was constrained
          // This ensures images resized on desktop don't get distorted on mobile
          if (block.url && displayWidth < requestedWidth) {
            // Width was constrained - adjust height proportionally
            const widthRatio = displayWidth / requestedWidth;
            displayHeight = imageHeight * widthRatio;
          } else {
            displayHeight = block.url ? imageHeight : placeholderHeight;
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

          if (objectFit === "contain" && block.url) {
            // Try to get the cached image to calculate actual bounds
            const cachedImage = imageCache.get(block.url);
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
            blockIndex,
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
function getDragHandleAtPoint(
  x: number,
  y: number,
  imageX: number,
  imageY: number,
  imageWidth: number,
  imageHeight: number,
  objectFit: "cover" | "contain" = "cover",
  extraTolerance: number = 4
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
function startImageDrag(
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
  extraTolerance: number = 4
): EditorState | null {
  const block = state.document.page.blocks[imageBlock.blockIndex];
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
    extraTolerance
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
function updateImageDrag(
  state: EditorState,
  viewport: ViewportState,
  canvasX: number,
  canvasY: number
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
        Math.min(viewport.width, (startWidth as number) + widthDelta)
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
      startHeight + deltaY
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
 * @returns Updated state with imageDrag cleared and undo recorded
 */
function endImageDrag(state: EditorState): EditorState {
  if (!state.ui.imageDrag) {
    return state;
  }

  // Record undo for the image resize operation
  const finalState = recordUndo(state);
  return {
    ...finalState,
    ui: {
      ...finalState.ui,
      imageDrag: null,
    },
  };
}

/**
 * Cancel an image drag resize operation (without recording undo)
 * @param state Current editor state
 * @returns Updated state with imageDrag cleared
 */
function cancelImageDrag(state: EditorState): EditorState {
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
function ensureCursorVisible(
  newState: EditorState,
  oldState: EditorState,
  viewport: ViewportState,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): void {
  if (
    newState !== oldState &&
    newState.document.cursor &&
    updateViewportCallback
  ) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }
}

function isWithinClickDistance(
  pos1: { x: number; y: number },
  pos2: { x: number; y: number },
  threshold: number = CLICK_DISTANCE_THRESHOLD
): boolean {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  return Math.sqrt(dx * dx + dy * dy) <= threshold;
}

function isPositionWithinSelection(
  state: EditorState,
  position: { blockIndex: number; textIndex: number }
): boolean {
  if (!state.document.selection) return false;

  const { anchor, focus } = state.document.selection;

  const selStart =
    anchor.blockIndex < focus.blockIndex ||
    (anchor.blockIndex === focus.blockIndex &&
      anchor.textIndex <= focus.textIndex)
      ? anchor
      : focus;
  const selEnd = selStart === anchor ? focus : anchor;

  if (
    selStart.blockIndex === selEnd.blockIndex &&
    selStart.textIndex === selEnd.textIndex
  ) {
    return false;
  }

  if (
    position.blockIndex < selStart.blockIndex ||
    position.blockIndex > selEnd.blockIndex
  ) {
    return false;
  }

  if (
    position.blockIndex === selStart.blockIndex &&
    position.textIndex < selStart.textIndex
  ) {
    return false;
  }

  if (
    position.blockIndex === selEnd.blockIndex &&
    position.textIndex >= selEnd.textIndex
  ) {
    return false;
  }

  return true;
}

/**
 * Helper function to get selection handle positions for touch detection.
 * Returns the positions of both anchor and focus handles.
 */
function getSelectionHandlePositions(
  state: EditorState,
  viewport: ViewportState
): {
  anchor: { x: number; y: number; height: number; isTop: boolean } | null;
  focus: { x: number; y: number; height: number; isTop: boolean } | null;
} | null {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) {
    return null;
  }

  const anchorCoords = getCursorCoordinates(selection.anchor, state, viewport);
  const focusCoords = getCursorCoordinates(selection.focus, state, viewport);

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
function getSelectionHandleAtPoint(
  touchX: number,
  touchY: number,
  state: EditorState,
  viewport: ViewportState
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
      Math.pow(touchX - x, 2) + Math.pow(touchY - circleY, 2)
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
      Math.pow(touchX - x, 2) + Math.pow(touchY - circleY, 2)
    );
    if (distance <= touchTargetRadius) {
      return "focus";
    }
  }

  return null;
}

export function handleEvents(
  state: EditorState,
  viewport: ViewportState,
  visibility: { start: number; end: number },
  events: Event[],
  documentHeight: number,
  containerRect: { left: number; top: number },
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  clipboardData?: { html: string; text: string } | null
): EditorState {
  // Check for scrollbar long-press (iOS-style: hold to activate)
  if (scrollbarPressState && !state.view.scrollbar.isDragging) {
    const timeSinceStart = Date.now() - scrollbarPressState.startTime;

    if (timeSinceStart >= SCROLLBAR_HOLD_DURATION) {
      // Activate scrollbar drag after holding
      if (touchState) {
        touchState.isScrollbarDrag = true;
      }

      // Haptic feedback when scrollbar activates (iOS-style)
      triggerHapticFeedback();

      state = {
        ...state,
        view: {
          ...state.view,
          scrollbar: startScrollbarDrag(
            state.view.scrollbar,
            scrollbarPressState.canvasY,
            viewport,
            documentHeight
          ),
        },
      };
    }
  }

  // Check for long press trigger (independent of touchmove events)
  if (
    touchState &&
    !touchState.isLongPress &&
    !touchState.hasMoved &&
    !touchState.isScrollbarDrag &&
    !state.ui.imageDrag && // Don't open context menu if we're dragging an image
    !state.ui.selectionHandleDrag // Don't open context menu if we're dragging a selection handle
  ) {
    const timeSinceStart = Date.now() - touchState.startTime;
    if (timeSinceStart >= CONTEXT_MENU_DURATION) {
      touchState.isLongPress = true;

      const position = getTextPositionFromViewport(
        touchState.currentTouchX,
        touchState.currentTouchY,
        state,
        viewport,
        visibility
      );

      // Long press behavior depends on whether touching selected text
      if (touchState.isTouchingSelection) {
        // On selected text: show context menu immediately
        if (position) {
          if (!state.document.selection) {
            state = updateCursor(state, position);
          }
        }

        // Clear link hover tooltip and slash menu when opening context menu
        state = closeActiveMenu({
          ...state,
          ui: {
            ...state.ui,
            isHoveringLinkWithModifier: false,
          },
        });

        state = openContextMenu(
          state,
          touchState.currentTouchX,
          touchState.currentTouchY
        );
      } else {
        // On non-selected text: prepare for drag selection (don't show menu yet)
        // If they drag, selection will start. If they release, menu shows in touchend
        if (position) {
          state = updateCursor(state, position);
        }
        
        // Clear other menus
        state = closeActiveMenu({
          ...state,
          ui: {
            ...state.ui,
            isHoveringLinkWithModifier: false,
          },
        });
      }
    }
  }

  // Apply auto-scroll and selection update during long press
  if (autoScrollState.isActive && touchState?.isLongPress) {
    // Current touch coordinates are already adjusted relative to container in handleTouchMove
    const touch = {
      clientY: touchState.currentTouchY,
      clientX: touchState.currentTouchX,
    };

    const elapsedTime = Date.now() - autoScrollState.startTime;
    const timeBasedMultiplier = Math.min(
      Math.pow(EDGE_SCROLL_ACCELERATION_RATE, elapsedTime / 1000),
      EDGE_SCROLL_MAX_SPEED / EDGE_SCROLL_SPEED
    );
    autoScrollState.currentSpeedMultiplier = timeBasedMultiplier;

    let autoScrollDelta = 0;

    if (touch.clientY < 0) {
      const distance = Math.abs(touch.clientY);
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta =
        -EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (touch.clientY < EDGE_SCROLL_THRESHOLD) {
      const proximity = 1 - touch.clientY / EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = -EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    } else if (touch.clientY > viewport.height) {
      const distance = touch.clientY - viewport.height;
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta =
        EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (touch.clientY > viewport.height - EDGE_SCROLL_THRESHOLD) {
      const proximity =
        (touch.clientY - (viewport.height - EDGE_SCROLL_THRESHOLD)) /
        EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    }

    if (autoScrollDelta !== 0 && updateViewportCallback) {
      const maxScroll = documentHeight - viewport.height;
      const newScrollY = Math.max(
        0,
        Math.min(maxScroll, viewport.scrollY + autoScrollDelta)
      );

      if (newScrollY !== viewport.scrollY) {
        updateViewportCallback({ scrollY: newScrollY });
      }
    }

    const position = getTextPositionFromViewport(
      touch.clientX,
      touch.clientY,
      state,
      viewport,
      { start: 0, end: state.document.page.blocks.length - 1 }
    );

    if (position) {
      if (state.ui.mode !== "select") {
        state = updateCursor(state, position);
        state = startSelection(state, position);
        state = updateMode(state, "select");
      } else {
        state = updateSelectionFocus(state, position);
        state = updateCursor(state, position);
      }
    }

    state = {
      ...state,
      view: {
        ...state.view,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
    };
  } else if (autoScrollState.isActive && state.ui.mode === "select") {
    // Apply auto-scroll for mouse selection
    const elapsedTime = Date.now() - autoScrollState.startTime;
    const timeBasedMultiplier = Math.min(
      Math.pow(EDGE_SCROLL_ACCELERATION_RATE, elapsedTime / 1000),
      EDGE_SCROLL_MAX_SPEED / EDGE_SCROLL_SPEED
    );
    autoScrollState.currentSpeedMultiplier = timeBasedMultiplier;

    let autoScrollDelta = 0;
    const mouseY = autoScrollState.lastMouseY;

    if (mouseY < 0) {
      const distance = Math.abs(mouseY);
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta =
        -EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (mouseY < EDGE_SCROLL_THRESHOLD) {
      const proximity = 1 - mouseY / EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = -EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    } else if (mouseY > viewport.height) {
      const distance = mouseY - viewport.height;
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta =
        EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (mouseY > viewport.height - EDGE_SCROLL_THRESHOLD) {
      const proximity =
        (mouseY - (viewport.height - EDGE_SCROLL_THRESHOLD)) /
        EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    }

    if (autoScrollDelta !== 0 && updateViewportCallback) {
      const maxScroll = documentHeight - viewport.height;
      const newScrollY = Math.max(
        0,
        Math.min(maxScroll, viewport.scrollY + autoScrollDelta)
      );

      if (newScrollY !== viewport.scrollY) {
        updateViewportCallback({ scrollY: newScrollY });
      }
    }

    // Update selection based on new scroll position
    const position = getTextPositionFromViewport(
      autoScrollState.lastMouseX,
      autoScrollState.lastMouseY,
      state,
      viewport,
      visibility // Use current visibility which might be slightly stale but acceptable for one frame
    );

    if (position) {
      state = updateSelectionFocus(state, position);
      state = updateCursor(state, position);
    }
  } else if (autoScrollState.isActive && state.ui.selectionHandleDrag) {
    // Apply auto-scroll for selection handle drag (touch)
    const elapsedTime = Date.now() - autoScrollState.startTime;
    const timeBasedMultiplier = Math.min(
      Math.pow(EDGE_SCROLL_ACCELERATION_RATE, elapsedTime / 1000),
      EDGE_SCROLL_MAX_SPEED / EDGE_SCROLL_SPEED
    );
    autoScrollState.currentSpeedMultiplier = timeBasedMultiplier;

    let autoScrollDelta = 0;
    const touchY = autoScrollState.lastMouseY;

    if (touchY < 0) {
      const distance = Math.abs(touchY);
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta =
        -EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (touchY < EDGE_SCROLL_THRESHOLD) {
      const proximity = 1 - touchY / EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = -EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    } else if (touchY > viewport.height) {
      const distance = touchY - viewport.height;
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta =
        EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (touchY > viewport.height - EDGE_SCROLL_THRESHOLD) {
      const proximity =
        (touchY - (viewport.height - EDGE_SCROLL_THRESHOLD)) /
        EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    }

    if (autoScrollDelta !== 0 && updateViewportCallback) {
      const maxScroll = documentHeight - viewport.height;
      const newScrollY = Math.max(
        0,
        Math.min(maxScroll, viewport.scrollY + autoScrollDelta)
      );

      if (newScrollY !== viewport.scrollY) {
        updateViewportCallback({ scrollY: newScrollY });
      }
    }

    // Update selection based on new scroll position
    const position = getTextPositionFromViewport(
      autoScrollState.lastMouseX,
      autoScrollState.lastMouseY,
      state,
      viewport,
      { start: 0, end: state.document.page.blocks.length - 1 }
    );

    if (position && state.document.selection) {
      const { handleType } = state.ui.selectionHandleDrag;
      const { anchor, focus } = state.document.selection;

      let newAnchor = anchor;
      let newFocus = focus;

      if (handleType === "anchor") {
        newAnchor = position;
      } else {
        newFocus = position;
      }

      const isForward =
        newAnchor.blockIndex < newFocus.blockIndex ||
        (newAnchor.blockIndex === newFocus.blockIndex &&
          newAnchor.textIndex <= newFocus.textIndex);

      const isCollapsed =
        newAnchor.blockIndex === newFocus.blockIndex &&
        newAnchor.textIndex === newFocus.textIndex;

      state = {
        ...state,
        document: {
          ...state.document,
          selection: {
            anchor: newAnchor,
            focus: newFocus,
            isForward,
            isCollapsed,
            lastUpdate: Date.now(),
          },
          cursor: {
            position: handleType === "anchor" ? newAnchor : newFocus,
            lastUpdate: Date.now(),
          },
        },
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }
  }

  // Apply momentum scrolling if active (even when no events)
  // But not in locked mode
  if (state.view.momentum.isActive && state.ui.mode !== "locked") {
    const momentumResult = applyMomentum(
      viewport.scrollY,
      state.view.momentum,
      documentHeight,
      viewport.height
    );

    if (updateViewportCallback && momentumResult.scrollY !== viewport.scrollY) {
      updateViewportCallback({ scrollY: momentumResult.scrollY });
    }

    state = {
      ...(state.ui.activeMenu.type === "linkHover"
        ? closeActiveMenu(state)
        : state),
      view: {
        ...state.view,
        momentum: momentumResult.momentumState,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
      ui: {
        ...state.ui,
        isHoveringLinkWithModifier: false,
        imageHover: null,
      },
    };
  }

  if (events.length === 0) {
    // Update scrollbar fade opacity even when no events
    state = {
      ...state,
      view: {
        ...state.view,
        scrollbar: updateScrollbarFadeOpacity(state.view.scrollbar),
      },
    };
    return state;
  }

  while (events.length > 0) {
    const event = events[0];
    switch (event.type) {
      case "contextmenu":
        state = handleContextMenu(
          state,
          viewport,
          event as unknown as MouseEvent,
          containerRect,
          visibility
        );
        break;
      case "mousedown":
        if (isTouchDevice()) {
          break;
        }
        state = handleMouseDown(
          state,
          viewport,
          event as unknown as MouseEvent,
          containerRect,
          visibility,
          documentHeight,
          updateViewportCallback
        );
        break;
      case "mousemove":
        if (isTouchDevice()) {
          break;
        }
        state = handleMouseMove(
          state,
          viewport,
          event as unknown as MouseEvent,
          containerRect,
          visibility,
          documentHeight,
          updateViewportCallback
        );
        break;
      case "mouseup":
        if (isTouchDevice()) {
          break;
        }
        state = handleMouseUp(
          state,
          viewport,
          event as unknown as MouseEvent,
          visibility
        );
        break;
      case "pointercancel":
        // Only cancel on pointercancel (not on leave)
        state = handlePointerCancel(state);
        break;
      case "keydown":
        state = handleKeyDown(state, viewport, event, updateViewportCallback);
        break;
      case "paste":
        state = handlePaste(
          state,
          event as ClipboardEvent,
          viewport,
          updateViewportCallback,
          clipboardData
        );
        break;
      case "wheel":
        if (isTouchDevice()) {
          break;
        }
        state = handleWheel(
          state,
          viewport,
          event as WheelEvent,
          documentHeight,
          updateViewportCallback
        );
        break;
      case "touchstart":
        state = handleTouchStart(
          state,
          viewport,
          event as TouchEvent,
          containerRect,
          documentHeight
        );
        break;
      case "touchmove":
        state = handleTouchMove(
          state,
          viewport,
          event as TouchEvent,
          containerRect,
          documentHeight,
          updateViewportCallback
        );
        break;
      case "touchend":
        state = handleTouchEnd(
          state,
          viewport,
          event as TouchEvent,
          containerRect
        );
        break;
      case "touchcancel":
        // Cancel touch interaction
        state = handleTouchCancel(state);
        break;
      case "compositionstart":
        state = handleCompositionStart(state, event as CompositionEvent);
        break;
      case "compositionupdate":
        state = handleCompositionUpdate(state, event as CompositionEvent);
        break;
      case "compositionend":
        state = handleCompositionEnd(
          state,
          event as CompositionEvent,
          viewport,
          updateViewportCallback
        );
        break;
    }

    events.shift();
  }

  // Update scrollbar fade opacity
  state = {
    ...state,
    view: {
      ...state.view,
      scrollbar: updateScrollbarFadeOpacity(state.view.scrollbar),
    },
  };

  return state;
}

function handleContextMenu(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  containerRect: { left: number; top: number },
  visibility: { start: number; end: number }
): EditorState {
  event.preventDefault();

  // Don't open context menu if we're dragging an image
  if (state.ui.imageDrag) {
    return state;
  }

  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  const position = getTextPositionFromViewport(
    canvasX,
    canvasY,
    state,
    viewport,
    visibility
  );

  // Always open context menu at click position if we have a valid position
  // Preserve existing selection for copy/cut operations
  if (position) {
    // Only update cursor/clear selection if there's no selection active
    // This preserves "Select All" and other selections when right-clicking
    if (!state.document.selection) {
      state = updateCursor(state, position);
    }

    // Clear link hover tooltip and slash menu when opening context menu
    state = {
      ...state,
      ui: {
        ...state.ui,
        isHoveringLinkWithModifier: false,
      },
    };

    state = openContextMenu(state, canvasX, canvasY);
  }

  return state;
}

function handlePaste(
  state: EditorState,
  event: ClipboardEvent,
  viewport: ViewportState,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  clipboardData?: { html: string; text: string } | null
): EditorState {
  // Prevent default paste behavior
  event.preventDefault();

  // If editor is not focused, ignore paste
  if (!state.view.isFocused) {
    return state;
  }

  // Block paste during composition - let IME handle input
  if (state.ui.composition?.isComposing) {
    return state;
  }

  // Use the tracked pasteAsPlainText flag (set during keydown)
  // Paste as plain text
  const newState = pasteFromClipboardEvent(state, event, clipboardData);
  if (!newState) {
    return state;
  }

  // Scroll to make the cursor (end of pasted content) visible
  if (newState.document.cursor && updateViewportCallback) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }

  return newState;
}

// Helper function to detect and handle checkbox clicks for todo list items
function handleTodoCheckboxClick(
  state: EditorState,
  canvasX: number,
  canvasY: number,
  viewport: ViewportState
): EditorState | null {
  const styles = getEditorStyles();
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth = viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  
  // Iterate through blocks to find which one was clicked
  // Break early once we pass the visible area
  for (let blockIndex = 0; blockIndex < state.document.page.blocks.length; blockIndex++) {
    const block = state.document.page.blocks[blockIndex];
    const blockHeight = getBlockHeight(block, maxWidth, styles, blockIndex);

    // Check if click is within this block's Y bounds
    if (canvasY >= currentY && canvasY < currentY + blockHeight) {
      // Check if this is a todo list item
      if (block.type === "todo_list") {
        const indent = block.indent || 0;
        const indentOffset = indent * styles.list.indent.size;
        const checkboxSize = styles.list.todo.checkboxSize;

        // Detect if this is RTL text
        const isRTL = getFormattedTextDirection(block.content) === "rtl";

        // Calculate marker width to match rendering logic
        const markerWidth = styles.list.numbered.minWidth + styles.list.marker.textGap;
        const adjustedMaxWidth = maxWidth - indentOffset - markerWidth;

        // Position checkbox based on text direction
        let checkboxX: number;
        if (isRTL) {
          // RTL: checkbox is in marker area on the right side
          // markerX = paddingLeft + indentOffset + adjustedMaxWidth
          checkboxX = styles.canvas.paddingLeft + indentOffset + adjustedMaxWidth + 2;
        } else {
          // LTR: checkbox is in marker area on the left side
          // markerX = paddingLeft + indentOffset
          checkboxX = styles.canvas.paddingLeft + indentOffset + 2;
        }

        // Get font metrics for proper vertical alignment
        const textStyle = getTextStyle(styles, block.type);
        const fontFamily = getCurrentFontFamily();
        const fontMetrics = getFontMetrics(
          textStyle.fontSize,
          textStyle.fontWeight,
          fontFamily
        );
        const checkboxY = currentY + fontMetrics.ascent - checkboxSize + 2;

        // Check if click is within checkbox bounds (add some padding for easier clicking)
        const clickPadding = 4;
        if (
          canvasX >= checkboxX - clickPadding &&
          canvasX <= checkboxX + checkboxSize + clickPadding &&
          canvasY >= checkboxY - clickPadding &&
          canvasY <= checkboxY + checkboxSize + clickPadding
        ) {
          // Toggle the checkbox
          const newState = recordUndo(state);
          return toggleTodoChecked(newState, blockIndex);
        }
      }

      // Not a checkbox click, return null to continue normal processing
      return null;
    }

    // Break early if we've passed the visible area
    if (currentY > viewport.height) {
      break;
    }

    currentY += blockHeight;
  }
  
  return null;
}

function handleMouseDown(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  containerRect: { left: number; top: number },
  visibility: { start: number; end: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  stopAutoScroll();

  // Ignore right-click - it will be handled by contextmenu event
  // This prevents clearing selection when right-clicking
  if (event.button === 2) {
    return state;
  }

  // Close slash command menu on mouse click
  if (state.ui.activeMenu.type === "slashCommand") {
    state = closeSlashCommand(state);
  }

  // Track if any menu was open (we'll use this to prevent reopening on same click)
  const wasMenuOpen = state.ui.activeMenu.type !== "none";
  const previousMenu = state.ui.activeMenu;

  // Close any active menu on mouse click (will be reopened below if needed)
  if (wasMenuOpen) {
    state = closeActiveMenu(state);
  }

  state = updateFocus(state, true);

  // Clear auto-created paragraph tracking on mouse click
  state = clearAutoCreatedParagraph(state);

  state = {
    ...state,
    view: {
      ...state.view,
      momentum: {
        velocity: 0,
        lastTime: Date.now(),
        isActive: false,
      },
    },
  };

  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  // Check for click on todo checkbox
  const checkboxClickResult = handleTodoCheckboxClick(
    state,
    canvasX,
    canvasY,
    viewport
  );
  if (checkboxClickResult) {
    return checkboxClickResult;
  }

  // Check for Ctrl/Command+Click on link to open it
  const isCtrlOrCmd = event.ctrlKey || event.metaKey;
  if (isCtrlOrCmd) {
    const position = getTextPositionFromViewport(
      canvasX,
      canvasY,
      state,
      viewport,
      visibility
    );

    if (position) {
      const linkData = getLinkAtPosition(position, state);
      if (linkData) {
        // Open the link in a new tab
        window.open(linkData.url, "_blank", "noopener,noreferrer");
        // Clear any link hover state
        state = {
          ...state,
          ui: {
            ...state.ui,
            activeMenu: { type: "none" },
            isHoveringLinkWithModifier: false,
          },
        };
        // Don't continue with normal click behavior - just return
        return state;
      }
    }
  }

  // Check if clicking on scrollbar
  if (isPointInScrollbar(canvasX, canvasY, viewport, documentHeight)) {
    // Check if clicking on thumb
    if (
      isPointInThumb(
        canvasX,
        canvasY,
        viewport,
        documentHeight,
        state.view.scrollbar
      )
    ) {
      return {
        ...state,
        view: {
          ...state.view,
          scrollbar: startScrollbarDrag(
            state.view.scrollbar,
            canvasY,
            viewport,
            documentHeight
          ),
        },
      };
    } else {
      // Clicking on track - page scroll
      const newScrollY = updateScrollFromTrackClick(
        canvasY,
        viewport,
        documentHeight,
        state.view.scrollbar
      );
      if (updateViewportCallback) {
        updateViewportCallback({ scrollY: newScrollY });
      }
      return {
        ...state,
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }
  }

  // Check if clicking on an image cover block (including placeholders)
  const imageBlock = getImageBlockAtPoint(canvasX, canvasY, state, viewport);
  if (imageBlock) {
    const block = state.document.page.blocks[imageBlock.blockIndex];
    if (block.type === "image") {
      // Check if clicking on a drag handle and start drag if applicable
      const dragState = startImageDrag(state, imageBlock, canvasX, canvasY);
      if (dragState) {
        return dragState;
      }

      // If it's a placeholder (no URL), open the upload menu immediately
      if (!block.url) {
        // Don't reopen if we just closed the menu for this same block
        if (
          wasMenuOpen &&
          previousMenu.type === "imageUpload" &&
          previousMenu.blockIndex === imageBlock.blockIndex
        ) {
          // Just keep it closed
          return state;
        }

        // Open the image upload menu at the click position
        return setActiveMenu(state, {
          type: "imageUpload",
          blockIndex: imageBlock.blockIndex,
          x: canvasX,
          y: canvasY,
        });
      }
      // If it has an image, select the image block (same as arrow key behavior)
      // Position at the start of the image block (textIndex 0)
      const imagePosition = { blockIndex: imageBlock.blockIndex, textIndex: 0 };

      let newState = updateCursor(state, imagePosition);

      // Create a selection that spans the entire image block
      if (event.shiftKey && state.document.selection) {
        // Extend selection to include this image
        newState = updateSelectionFocus(newState, imagePosition);
      } else {
        // Select just this image block (match arrow key selection behavior)
        newState = {
          ...newState,
          document: {
            ...newState.document,
            selection: {
              anchor: imagePosition,
              focus: imagePosition,
              isForward: true,
              isCollapsed: false,
              lastUpdate: Date.now(),
            },
          },
        };
      }

      return updateMode(newState, "edit");
    }
  }

  // Check if we have an image selected but clicked outside its container
  if (
    !imageBlock &&
    state.document.selection &&
    !state.document.selection.isCollapsed
  ) {
    const { anchor, focus } = state.document.selection;
    // Check if this is an image selection (anchor and focus at same position on an image block)
    if (
      anchor.blockIndex === focus.blockIndex &&
      anchor.textIndex === focus.textIndex
    ) {
      const selectedBlock = state.document.page.blocks[anchor.blockIndex];
      if (selectedBlock && selectedBlock.type === "image") {
        // We have an image selected, but clicked outside it - clear the selection
        state = clearSelection(state);
      }
    }
  }

  // Check if clicking in top padding area
  const styles = getEditorStyles();
  const isClickInTopPadding =
    canvasY < styles.canvas.paddingTop - viewport.scrollY;

  // If clicking in top padding, clear selection
  if (isClickInTopPadding) {
    const clearedState = clearSelection(state);
    return updateMode(clearedState, "edit");
  }

  // Check if clicking in left/right padding area
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const isClickInLeftPadding = canvasX < styles.canvas.paddingLeft;
  const isClickInRightPadding = canvasX > styles.canvas.paddingLeft + maxWidth;

  // If clicking in left/right padding, position cursor at start/end of line and clear selection
  if (isClickInLeftPadding || isClickInRightPadding) {
    const paddingPosition = getTextPositionFromViewport(
      canvasX,
      canvasY,
      state,
      viewport,
      visibility
    );

    if (paddingPosition) {
      let newState = clearSelection(state);
      newState = updateCursor(newState, paddingPosition);
      return updateMode(newState, "edit");
    }
  }

  const position = getTextPositionFromViewport(
    canvasX,
    canvasY,
    state,
    viewport,
    visibility
  );

  // If clicking in padding/outside editor area, preserve active selections
  if (!position) {
    // Only clear selection if it's collapsed or doesn't exist
    if (!state.document.selection || state.document.selection.isCollapsed) {
    const clearedState = clearSelection(state);
    return updateMode(clearedState, "edit");
    }
    // Keep active selection and just switch to edit mode
    return updateMode(state, "edit");
  }

  // If clicking below all blocks, check if last block is an image and select it
  const lastBlockIndex = state.document.page.blocks.length - 1;
  if (lastBlockIndex >= 0 && position.blockIndex === lastBlockIndex) {
    const lastBlock = state.document.page.blocks[lastBlockIndex];

    // Calculate if click is below the last block's content
    // Use pre-computed documentHeight instead of iterating through all blocks
    const totalContentHeight = documentHeight + styles.canvas.paddingTop;
    const isClickBelowContent = canvasY > totalContentHeight - viewport.scrollY;

    // If clicking below content and last block is an image, select it
    if (isClickBelowContent && lastBlock.type === "image") {
      const imagePosition = { blockIndex: lastBlockIndex, textIndex: 0 };
      let newState = updateCursor(state, imagePosition);

      // Select the image block
      newState = {
        ...newState,
        document: {
          ...newState.document,
          selection: {
            anchor: imagePosition,
            focus: imagePosition,
            isForward: true,
            isCollapsed: false,
            lastUpdate: Date.now(),
          },
        },
      };

      return updateMode(newState, "edit");
    }
  }

  // Track click for double/triple click detection
  const currentTime = Date.now();
  const currentPosition = { x: canvasX, y: canvasY };

  let isMultiClick = false;

  if (
    state.view.clickTracker.lastClickPosition &&
    currentTime - state.view.clickTracker.lastClickTime <= DOUBLE_CLICK_TIME &&
    isWithinClickDistance(
      currentPosition,
      state.view.clickTracker.lastClickPosition
    )
  ) {
    state.view.clickTracker.count++;
    isMultiClick = true;
  } else {
    state.view.clickTracker.count = 1;
  }

  state.view.clickTracker.lastClickTime = currentTime;
  state.view.clickTracker.lastClickPosition = currentPosition;

  // Handle triple-click: always select line (even inside selection)
  if (isMultiClick && state.view.clickTracker.count >= 3) {
    return selectLineAtPosition(state, position);
  }

  // // If clicking inside a selection (single or double click), don't reset it (Apple Notes behavior)
  // if (isPositionWithinSelection(state, position)) {
  //   return state;
  // }

  // Handle double-click: select word
  if (isMultiClick && state.view.clickTracker.count === 2) {
    return selectWordAtPosition(state, position);
  }

  // Set cursor position
  let newState = updateCursor(state, position);

  // If shift is held, extend selection; otherwise start new selection
  if (event.shiftKey && state.document.selection) {
    newState = updateSelectionFocus(newState, position);
  } else {
    // Start selection at cursor position
    newState = startSelection(newState, position);
    newState = updateMode(newState, "select");
  }

  return newState;
}

function handleMouseMove(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  containerRect: { left: number; top: number },
  visibility: { start: number; end: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  if (state.view.scrollbar.isDragging) {
    const newScrollY = updateScrollFromThumbDrag(
      canvasY,
      viewport,
      documentHeight,
      state.view.scrollbar
    );
    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }
    // Clear link hover overlay when scrolling via scrollbar
    return {
      ...state,
      ui: {
        ...state.ui,
        isHoveringLinkWithModifier: false,
        imageHover: null,
      },
    };
  }

  // iOS-style: Only show hover when over the thumb itself
  const isOverScrollbarThumb = isPointInThumb(
    canvasX,
    canvasY,
    viewport,
    documentHeight,
    state.view.scrollbar
  );
  state = {
    ...state,
    view: {
      ...state.view,
      scrollbar: updateScrollbarHover(
        state.view.scrollbar,
        isOverScrollbarThumb
      ),
    },
  };

  // Handle image drag resize
  if (state.ui.imageDrag) {
    return updateImageDrag(state, viewport, canvasX, canvasY);
  }

  // Check for image hover (desktop only, not in select mode, and not during image drag)
  if (!isTouchDevice() && state.ui.mode !== "select") {
    const imageBlock = getImageBlockAtPoint(canvasX, canvasY, state, viewport);

    if (imageBlock) {
      // Get the block to check its object-fit mode
      const block = state.document.page.blocks[imageBlock.blockIndex];
      const objectFit =
        block.type === "image" ? block.objectFit ?? "cover" : "cover";

      // Check if hovering over a drag handle
      const hoveredHandle = getDragHandleAtPoint(
        canvasX,
        canvasY,
        imageBlock.x,
        imageBlock.y,
        imageBlock.width,
        imageBlock.height,
        objectFit
      );

      // Mouse is over an image block - set imageHover state (not a blocking menu)
      state = {
        ...state,
        ui: {
          ...state.ui,
          imageHover: {
            blockIndex: imageBlock.blockIndex,
            x: imageBlock.x,
            y: imageBlock.y,
            width: imageBlock.width,
            height: imageBlock.height,
            hoveredHandle,
          },
        },
      };
    } else if (state.ui.imageHover !== null) {
      // Clear image hover state
      state = {
        ...state,
        ui: {
          ...state.ui,
          imageHover: null,
        },
      };
    }
  }

  if (state.ui.mode !== "select") {
    // Check for link hover when not selecting (desktop only)
    // Don't show tooltip if Ctrl/Command key is held (user wants to click to open)
    const isCtrlOrCmd = event.ctrlKey || event.metaKey;

    // If Ctrl/Command is held and we have a link hover showing, clear it
    if (isCtrlOrCmd && state.ui.activeMenu.type === "linkHover") {
      state = closeActiveMenu(state);
      return state;
    }

    // Don't show link hover when any menu is open (except for linkHover)
    if (
      state.ui.activeMenu.type !== "none" &&
      state.ui.activeMenu.type !== "linkHover"
    ) {
      return state;
    }

    if (!isTouchDevice()) {
      const position = getTextPositionFromViewport(
        canvasX,
        canvasY,
        state,
        viewport,
        visibility
      );

      let isOverLink = false;

      if (position) {
        const linkData = getLinkAtPosition(position, state);
        if (linkData) {
          isOverLink = true;
          // If Ctrl/Command is held, show pointer cursor but no tooltip
          if (isCtrlOrCmd) {
            state = closeActiveMenu(state);
            state = {
              ...state,
              ui: {
                ...state.ui,
                isHoveringLinkWithModifier: true,
              },
            };
          } else {
            // Normal hover - show tooltip
            // Calculate screen coordinates for tooltip at the link's start position
            const linkStartPos = {
              blockIndex: position.blockIndex,
              textIndex: linkData.start,
            };
            const linkCoords = getCursorCoordinates(
              linkStartPos,
              state,
              viewport
            );

            if (linkCoords) {
              // Position tooltip below the start of the link text
              // linkCoords.y is in document coordinates, so we need to subtract scrollY to get viewport coordinates
              const stateWithMenu = setActiveMenu(state, {
                type: "linkHover",
                position,
                url: linkData.url,
                text: linkData.text,
                x: linkCoords.x + containerRect.left,
                y:
                  linkCoords.y -
                  viewport.scrollY +
                  linkCoords.height +
                  containerRect.top,
                segmentIndex: linkData?.segmentIndex,
              });

              state = {
                ...stateWithMenu,
                ui: {
                  ...stateWithMenu.ui,
                  isHoveringLinkWithModifier: false,
                },
              };
            }
          }
        }
      }

      // Handle clearing linkHover when not over a link
      if (!isOverLink) {
        if (state.ui.activeMenu.type === "linkHover") {
          // Check if mouse is over the tooltip area before clearing
          const tooltipHeight = 120;
          const tooltipWidth = 300;
          const menu = state.ui.activeMenu;

          const isOverTooltip =
            event.x >= menu.x &&
            event.x <= menu.x + tooltipWidth &&
            event.y >= menu.y &&
            event.y <= menu.y + tooltipHeight;

          if (!isOverTooltip) {
            // Clear link hover
            state = closeActiveMenu(state);
          }
        }

        // Clear modifier state if not over a link
        if (state.ui.isHoveringLinkWithModifier) {
          state = {
            ...state,
            ui: {
              ...state.ui,
              isHoveringLinkWithModifier: false,
            },
          };
        }
      }
    } else if (
      state.ui.activeMenu.type === "linkHover" ||
      state.ui.isHoveringLinkWithModifier
    ) {
      // Clear link hover on touch devices
      state = closeActiveMenu(state);
      state = {
        ...state,
        ui: { ...state.ui, isHoveringLinkWithModifier: false },
      };
    }

    return state;
  }

  const position = getTextPositionFromViewport(
    canvasX,
    canvasY,
    state,
    viewport,
    visibility
  );

  if (!position) return state;

  let newState = updateSelectionFocus(state, position);
  newState = updateCursor(newState, position);

  const isNearEdge =
    canvasY < EDGE_SCROLL_THRESHOLD ||
    canvasY > viewport.height - EDGE_SCROLL_THRESHOLD ||
    canvasY < 0 ||
    canvasY > viewport.height;

  if (isNearEdge) {
    if (!autoScrollState.isActive) {
      startAutoScroll();
    }

    // Update stored mouse position for auto-scroll loop
    autoScrollState.lastMouseX = canvasX;
    autoScrollState.lastMouseY = canvasY;

    // We let handleEvents loop handle the actual scrolling to support
    // scrolling while the mouse is stationary at the edge.
  } else {
    if (autoScrollState.isActive) {
      stopAutoScroll();
    }
  }

  return newState;
}

function handleMouseUp(
  state: EditorState,
  _viewport: ViewportState,
  _event: MouseEvent,
  _visibility: { start: number; end: number }
): EditorState {
  stopAutoScroll();

  // Clean up scrollbar press state
  if (scrollbarPressState) {
    scrollbarPressState = null;
  }

  if (state.view.scrollbar.isDragging) {
    return {
      ...state,
      view: {
        ...state.view,
        scrollbar: endScrollbarDrag(state.view.scrollbar),
      },
    };
  }

  // End image drag if active
  if (state.ui.imageDrag) {
    return endImageDrag(state);
  }

  if (state.ui.mode === "select") {
    // Clear initialBoundary when finishing selection
    let newState = state;
    if (state.document.selection?.initialBoundary) {
      newState = {
        ...state,
        document: {
          ...state.document,
          selection: state.document.selection
            ? {
                ...state.document.selection,
                initialBoundary: undefined,
              }
            : null,
        },
      };
    }
    return updateMode(newState, "edit");
  }

  return state;
}

function handlePointerCancel(state: EditorState): EditorState {
  stopAutoScroll();

  // Clean up scrollbar press state
  if (scrollbarPressState) {
    scrollbarPressState = null;
  }

  if (state.view.scrollbar.isDragging) {
    state = {
      ...state,
      view: {
        ...state.view,
        scrollbar: endScrollbarDrag(state.view.scrollbar),
      },
    };
  }

  // Cancel image drag if active
  if (state.ui.imageDrag) {
    state = cancelImageDrag(state);
  }

  if (state.ui.mode === "select") {
    state = updateMode(state, "edit");
  }

  return state;
}

function handleKeyDown(
  state: EditorState,
  viewport: ViewportState,
  event: Event,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  const keyEvent = event as unknown as KeyboardEvent;
  const key = keyEvent.key;
  const code = keyEvent.code;
  const isCtrl = keyEvent.ctrlKey || keyEvent.metaKey;

  // In locked mode, block all operations
  if (state.ui.mode === "locked") {
    return state;
  }

  // If editor is not focused, ignore keyboard input
  if (!state.view.isFocused) {
    return state;
  }

  // Block most operations during composition - let IME handle input
  if (state.ui.composition?.isComposing) {
    // Block undo/redo
    if (isCtrl && (code === "KeyZ" || code === "KeyY")) {
      return state;
    }
    // Block cut operation
    if (isCtrl && code === "KeyX") {
      return state;
    }
    // Block text input keys - let IME handle all text input
    if (
      key === "Backspace" ||
      key === "Delete" ||
      key === "Enter" ||
      key === " " ||
      key === "Space"
    ) {
      return state;
    }
    // Block regular character input during composition
    if (
      key.length === 1 &&
      !keyEvent.ctrlKey &&
      !keyEvent.altKey &&
      !keyEvent.metaKey
    ) {
      return state;
    }
  }

  // Undo/Redo - handle these first, even if slash command is open
  // Use code instead of key for keyboard layout independence
  if (isCtrl && code === "KeyZ" && !keyEvent.shiftKey) {
    const newState = undoState(state);
    ensureCursorVisible(newState, state, viewport, updateViewportCallback);
    return newState;
  }
  if (isCtrl && (code === "KeyY" || (keyEvent.shiftKey && code === "KeyZ"))) {
    const newState = redoState(state);
    ensureCursorVisible(newState, state, viewport, updateViewportCallback);
    return newState;
  }

  // Select All
  if (isCtrl && code === "KeyA") {
    return selectAll(state);
  }

  // Bold
  if (isCtrl && code === "KeyB") {
    // Only record undo if there's a selection (actual document change)
    const hasSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    return toggleBold(hasSelection ? recordUndo(state) : state);
  }

  // Tab - indent/outdent list items
  if (key === "Tab") {
    if (state.document.cursor) {
      const { blockIndex } = state.document.cursor.position;
      const block = state.document.page.blocks[blockIndex];
      
      if (isListBlock(block)) {
        if (keyEvent.shiftKey) {
          // Shift+Tab: outdent
          const newState = outdentListItem(recordUndo(state));
          ensureCursorVisible(newState, state, viewport, updateViewportCallback);
          return newState;
        } else {
          // Tab: indent
          const newState = indentListItem(recordUndo(state));
          ensureCursorVisible(newState, state, viewport, updateViewportCallback);
          return newState;
        }
      }
    }
    // For non-list blocks, return state without preventing default
    return state;
  }

  // Copy
  if (isCtrl && code === "KeyC") {
    // Don't prevent default - allow browser's copy to work as fallback
    // But also handle our custom copy with formatting
    copySelectionToClipboard(state).catch((err) => {
      console.error("Copy failed:", err);
    });
    return state;
  }

  // Cut
  if (isCtrl && code === "KeyX") {
    const range = getSelectionRange(state);
    if (range) {
      // Copy to clipboard first
      copySelectionToClipboard(state).catch((err) => {
        console.error("Cut (copy) failed:", err);
      });
      // Then delete the selected text
      const newState = deleteSelectedText(recordUndo(state));
      ensureCursorVisible(newState, state, viewport, updateViewportCallback);
      return newState;
    }
    return state;
  }

  // Handle slash command menu navigation
  if (state.ui.activeMenu.type === "slashCommand") {
    const slashMenu = state.ui.activeMenu;
    const filteredCommands = slashMenu.filter
      ? SLASH_COMMANDS.filter(
          (cmd) =>
            cmd.label.toLowerCase().includes(slashMenu.filter.toLowerCase()) ||
            cmd.description
              .toLowerCase()
              .includes(slashMenu.filter.toLowerCase()) ||
            cmd.keywords?.some((keyword) =>
              keyword.toLowerCase().startsWith(slashMenu.filter.toLowerCase())
            )
        )
      : SLASH_COMMANDS;

    switch (key) {
      case "ArrowLeft":
      case "ArrowRight":
        // Close slash menu on left/right arrow and continue to normal arrow key handling
        state = closeSlashCommand(state);
        break;
      case "ArrowDown":
        if (filteredCommands.length > 0) {
          const newIndex = Math.min(
            slashMenu.selectedIndex + 1,
            filteredCommands.length - 1
          );
          return updateSlashCommandSelection(state, newIndex);
        }
        return state;
      case "ArrowUp":
        const newIndex = Math.max(slashMenu.selectedIndex - 1, 0);
        return updateSlashCommandSelection(state, newIndex);
      case "Enter":
        if (filteredCommands.length > 0 && state.document.cursor) {
          const selectedCommand = filteredCommands[slashMenu.selectedIndex];
          const newState = applySlashCommand(
            recordUndo(state),
            selectedCommand
          );
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return newState;
        }
        return closeSlashCommand(state);
      case "Escape":
        // Close slash command and remove the "/" character
        if (state.document.cursor) {
          const { blockIndex, textIndex } = slashMenu;
          const block = state.document.page.blocks[blockIndex];

          // Image cover blocks shouldn't have slash commands, but guard anyway
          if (block.type === "image") {
            return closeSlashCommand(state);
          }

          // Remove the "/" and filter text, preserving formatting
          const newContent = deleteTextRangeInFormattedContent(
            block.content,
            textIndex - 1, // Remove the "/"
            state.document.cursor.position.textIndex // Remove up to cursor (the filter text)
          );

          const newBlock: Block = {
            ...block,
            content: newContent,
          };

          const newBlocks = [...state.document.page.blocks];
          newBlocks[blockIndex] = newBlock;
          const newPage = { ...state.document.page, blocks: newBlocks };

          let newState: EditorState = {
            ...state,
            document: { ...state.document, page: newPage },
          };
          newState = closeSlashCommand(newState);
          newState = moveCursorToPosition(newState, blockIndex, textIndex - 1);

          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return newState;
        }
        return closeSlashCommand(state);
      case "Backspace":
        // If at the start of filter, close menu
        if (
          state.document.cursor &&
          state.ui.activeMenu.type === "slashCommand" &&
          state.document.cursor.position.textIndex <=
            state.ui.activeMenu.textIndex
        ) {
          // Close menu and delete the slash character - no recordUndo needed since deleteText already records
          const newState = closeSlashCommand(deleteText(recordUndo(state)));
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return newState;
        }
        // Otherwise update filter - deleteText handles recordUndo internally
        if (
          state.document.cursor &&
          state.ui.activeMenu.type === "slashCommand"
        ) {
          const slashMenu = state.ui.activeMenu;
          const newState = deleteText(recordUndo(state));
          if (newState.document.cursor) {
            const block = newState.document.page.blocks[slashMenu.blockIndex];
            const text = getBlockTextContent(block);
            const filter = text.slice(
              slashMenu.textIndex,
              newState.document.cursor.position.textIndex
            );
            const finalState = updateSlashCommandFilter(newState, filter);
            ensureCursorVisible(
              finalState,
              state,
              viewport,
              updateViewportCallback
            );
            return finalState;
          }
        }
        return state;
      default:
        // Handle typing to filter commands (including spaces)
        if (
          key.length === 1 &&
          !keyEvent.ctrlKey &&
          !keyEvent.altKey &&
          !keyEvent.metaKey &&
          state.ui.activeMenu.type === "slashCommand"
        ) {
          const slashMenu = state.ui.activeMenu;
          // insertText handles recordUndo internally
          const newState = insertText(recordUndo(state), key);
          if (newState.document.cursor) {
            const block = newState.document.page.blocks[slashMenu.blockIndex];
            const text = getBlockTextContent(block);
            const filter = text.slice(
              slashMenu.textIndex,
              newState.document.cursor.position.textIndex
            );
            const finalState = updateSlashCommandFilter(newState, filter);
            ensureCursorVisible(
              finalState,
              state,
              viewport,
              updateViewportCallback
            );
            return finalState;
          }
          return newState;
        }
        return state;
    }
  }

  let newState = state;

  // Prevent navigation keys during composition (IME input)
  // These keys are used by the IME to navigate candidate characters
  const navigationKeys = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
  ];
  if (state.ui.composition?.isComposing && navigationKeys.includes(key)) {
    return state;
  }

  // Navigation & selection
  switch (key) {
    case "ArrowLeft":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (isCtrl && keyEvent.shiftKey) {
        newState = extendSelectionWordLeft(newState);
      } else if (keyEvent.shiftKey) {
        newState = extendSelectionLeft(newState);
      } else {
        // Check if we're on an image at the start of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const isFirstBlock = state.document.cursor.position.blockIndex === 0;

          if (isFirstBlock && currentBlock?.type === "image") {
            // Create a new paragraph above the image
            const newParagraph: Block = {
              id: generateBlockId(),
              type: "paragraph",
              content: [{ content: "" }],
            };

            const newBlocks = [newParagraph, ...state.document.page.blocks];
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
            };
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, 0, 0);
            break;
          }
        }

        // Check if we should remove an auto-created paragraph (RTL: left = forward)
        if (state.ui.autoCreatedParagraph && state.document.cursor) {
          const { blockIndex, blockId } = state.ui.autoCreatedParagraph;
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];

          // Check if cursor is on the auto-created paragraph and it's RTL and empty
          if (
            state.document.cursor.position.blockIndex === blockIndex &&
            currentBlock?.id === blockId &&
            currentBlock.type === "paragraph" &&
            isNotImageBlock(currentBlock) &&
            getBlockTextContent(currentBlock) === "" &&
            getFormattedTextDirection(currentBlock.content) === "rtl"
          ) {
            // Remove the auto-created paragraph and move to the image below
            const newBlocks = state.document.page.blocks.filter(
              (_, i) => i !== blockIndex
            );
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
              ui: {
                ...state.ui,
                autoCreatedParagraph: null,
              },
            };
            // Move cursor to the image that was below
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, 0, 0);

            // Select the image block
            if (newState.document.page.blocks[0]?.type === "image") {
              newState = {
                ...newState,
                document: {
                  ...newState.document,
                  selection: {
                    anchor: { blockIndex: 0, textIndex: 0 },
                    focus: { blockIndex: 0, textIndex: 0 },
                    isForward: true,
                    isCollapsed: false,
                    lastUpdate: Date.now(),
                  },
                },
              };
            }
            break;
          }
        }

        // If there's a selection, check if it's an image block selection
        const range = getSelectionRange(newState);
        const isImageSelection =
          range &&
          state.document.page.blocks[range.start.blockIndex]?.type ===
            "image" &&
          range.start.blockIndex === range.end.blockIndex;

        if (range && !isImageSelection) {
          // Regular text selection - move to the start of it
          newState = moveCursorToPosition(
            clearSelection(newState),
            range.start.blockIndex,
            range.start.textIndex
          );
        } else if (isCtrl) {
          newState = moveToPreviousWord(clearSelection(newState));
        } else {
          newState = moveCursorLeft(clearSelection(newState));
        }

        // If we moved to an image block, select it; otherwise leave just cursor
        if (newState.document.cursor) {
          const targetBlock =
            newState.document.page.blocks[
              newState.document.cursor.position.blockIndex
            ];
          if (targetBlock && targetBlock.type === "image") {
            const imagePosition = {
              blockIndex: newState.document.cursor.position.blockIndex,
              textIndex: 0,
            };
            newState = {
              ...newState,
              document: {
                ...newState.document,
                selection: {
                  anchor: imagePosition,
                  focus: imagePosition,
                  isForward: true,
                  isCollapsed: false,
                  lastUpdate: Date.now(),
                },
              },
            };
          }

          // Clear auto-created paragraph tracking only if we moved away from it
          if (
            state.ui.autoCreatedParagraph &&
            newState.document.cursor &&
            newState.document.cursor.position.blockIndex !==
              state.ui.autoCreatedParagraph.blockIndex
          ) {
            newState = clearAutoCreatedParagraph(newState);
          }
        }
      }
      break;
    case "ArrowRight":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (isCtrl && keyEvent.shiftKey) {
        newState = extendSelectionWordRight(state);
      } else if (keyEvent.shiftKey) {
        newState = extendSelectionRight(newState);
      } else {
        // Check if we're on an image at the end of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const isLastBlock =
            state.document.cursor.position.blockIndex ===
            state.document.page.blocks.length - 1;

          if (isLastBlock && currentBlock?.type === "image") {
            // Create a new paragraph below the image
            const newParagraph: Block = {
              id: generateBlockId(),
              type: "paragraph",
              content: [{ content: "" }],
            };

            const newBlocks = [...state.document.page.blocks, newParagraph];
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
            };
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, newBlocks.length - 1, 0);
            break;
          }
        }

        // Check if we should remove an auto-created paragraph (LTR: right = forward)
        if (state.ui.autoCreatedParagraph && state.document.cursor) {
          const { blockIndex, blockId } = state.ui.autoCreatedParagraph;
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];

          // Check if cursor is on the auto-created paragraph and it's LTR and empty
          if (
            state.document.cursor.position.blockIndex === blockIndex &&
            currentBlock?.id === blockId &&
            currentBlock.type === "paragraph" &&
            isNotImageBlock(currentBlock) &&
            getBlockTextContent(currentBlock) === "" &&
            getFormattedTextDirection(currentBlock.content) === "ltr"
          ) {
            // Remove the auto-created paragraph and move to the image below
            const newBlocks = state.document.page.blocks.filter(
              (_, i) => i !== blockIndex
            );
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
              ui: {
                ...state.ui,
                autoCreatedParagraph: null,
              },
            };
            // Move cursor to the image that was below
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, 0, 0);

            // Select the image block
            if (newState.document.page.blocks[0]?.type === "image") {
              newState = {
                ...newState,
                document: {
                  ...newState.document,
                  selection: {
                    anchor: { blockIndex: 0, textIndex: 0 },
                    focus: { blockIndex: 0, textIndex: 0 },
                    isForward: true,
                    isCollapsed: false,
                    lastUpdate: Date.now(),
                  },
                },
              };
            }
            break;
          }
        }

        // If there's a selection, check if it's an image block selection
        const range = getSelectionRange(newState);
        const isImageSelection =
          range &&
          state.document.page.blocks[range.end.blockIndex]?.type === "image" &&
          range.start.blockIndex === range.end.blockIndex;

        if (range && !isImageSelection) {
          // Regular text selection - move to the end of it
          newState = moveCursorToPosition(
            clearSelection(newState),
            range.end.blockIndex,
            range.end.textIndex
          );
        } else if (isCtrl) {
          newState = moveToNextWord(clearSelection(newState));
        } else {
          newState = moveCursorRight(clearSelection(newState));
        }

        // If we moved to an image block, select it; otherwise leave just cursor
        if (newState.document.cursor) {
          const targetBlock =
            newState.document.page.blocks[
              newState.document.cursor.position.blockIndex
            ];
          if (targetBlock && targetBlock.type === "image") {
            const imagePosition = {
              blockIndex: newState.document.cursor.position.blockIndex,
              textIndex: 0,
            };
            newState = {
              ...newState,
              document: {
                ...newState.document,
                selection: {
                  anchor: imagePosition,
                  focus: imagePosition,
                  isForward: true,
                  isCollapsed: false,
                  lastUpdate: Date.now(),
                },
              },
            };
          }

          // Clear auto-created paragraph tracking only if we moved away from it
          if (
            state.ui.autoCreatedParagraph &&
            newState.document.cursor &&
            newState.document.cursor.position.blockIndex !==
              state.ui.autoCreatedParagraph.blockIndex
          ) {
            newState = clearAutoCreatedParagraph(newState);
          }
        }
      }
      break;
    case "ArrowUp":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionUp(newState, viewport);
      } else {
        // Check if we're on an image at the start of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const isFirstBlock = state.document.cursor.position.blockIndex === 0;

          if (isFirstBlock && currentBlock?.type === "image") {
            // Create a new paragraph above the image
            const newParagraph: Block = {
              id: generateBlockId(),
              type: "paragraph",
              content: [{ content: "" }],
            };

            const newBlocks = [newParagraph, ...state.document.page.blocks];
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
              ui: {
                ...state.ui,
                autoCreatedParagraph: {
                  blockIndex: 0,
                  blockId: newParagraph.id,
                },
              },
            };
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, 0, 0);
            break;
          }
        }

        // Clear selection and move cursor
        newState = moveCursorUp(clearSelection(newState), viewport);

        // If we moved to an image block, select it; otherwise leave just cursor
        if (newState.document.cursor) {
          const targetBlock =
            newState.document.page.blocks[
              newState.document.cursor.position.blockIndex
            ];
          if (targetBlock && targetBlock.type === "image") {
            const imagePosition = {
              blockIndex: newState.document.cursor.position.blockIndex,
              textIndex: 0,
            };
            newState = {
              ...newState,
              document: {
                ...newState.document,
                selection: {
                  anchor: imagePosition,
                  focus: imagePosition,
                  isForward: true,
                  isCollapsed: false,
                  lastUpdate: Date.now(),
                },
              },
            };
          }

          // Clear auto-created paragraph tracking only if we moved away from it
          if (
            state.ui.autoCreatedParagraph &&
            newState.document.cursor &&
            newState.document.cursor.position.blockIndex !==
              state.ui.autoCreatedParagraph.blockIndex
          ) {
            newState = clearAutoCreatedParagraph(newState);
          }
        }
      }
      break;
    case "ArrowDown":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionDown(newState, viewport);
      } else {
        // Check if we should remove an auto-created paragraph
        if (state.ui.autoCreatedParagraph && state.document.cursor) {
          const { blockIndex, blockId } = state.ui.autoCreatedParagraph;
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];

          // If cursor is on the auto-created paragraph and it's still empty
          if (
            state.document.cursor.position.blockIndex === blockIndex &&
            currentBlock?.id === blockId &&
            currentBlock.type === "paragraph" &&
            isNotImageBlock(currentBlock) &&
            getBlockTextContent(currentBlock) === ""
          ) {
            // Remove the auto-created paragraph and move to the image below
            const newBlocks = state.document.page.blocks.filter(
              (_, i) => i !== blockIndex
            );
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
              ui: {
                ...state.ui,
                autoCreatedParagraph: null,
              },
            };
            // Move cursor to the image that was below
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, 0, 0);

            // Select the image block
            if (newState.document.page.blocks[0]?.type === "image") {
              newState = {
                ...newState,
                document: {
                  ...newState.document,
                  selection: {
                    anchor: { blockIndex: 0, textIndex: 0 },
                    focus: { blockIndex: 0, textIndex: 0 },
                    isForward: true,
                    isCollapsed: false,
                    lastUpdate: Date.now(),
                  },
                },
              };
            }
            break;
          }
        }

        // Check if we're on an image at the end of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const isLastBlock =
            state.document.cursor.position.blockIndex ===
            state.document.page.blocks.length - 1;

          if (isLastBlock && currentBlock?.type === "image") {
            // Create a new paragraph below the image
            const newParagraph: Block = {
              id: generateBlockId(),
              type: "paragraph",
              content: [{ content: "" }],
            };

            const newBlocks = [...state.document.page.blocks, newParagraph];
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
            };
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, newBlocks.length - 1, 0);
            break;
          }
        }

        // Clear selection and move cursor
        newState = moveCursorDown(clearSelection(newState), viewport);

        // If we moved to an image block, select it; otherwise leave just cursor
        if (newState.document.cursor) {
          const targetBlock =
            newState.document.page.blocks[
              newState.document.cursor.position.blockIndex
            ];
          if (targetBlock && targetBlock.type === "image") {
            const imagePosition = {
              blockIndex: newState.document.cursor.position.blockIndex,
              textIndex: 0,
            };
            newState = {
              ...newState,
              document: {
                ...newState.document,
                selection: {
                  anchor: imagePosition,
                  focus: imagePosition,
                  isForward: true,
                  isCollapsed: false,
                  lastUpdate: Date.now(),
                },
              },
            };
          }

          // Clear auto-created paragraph tracking only if we moved away from it
          if (
            state.ui.autoCreatedParagraph &&
            newState.document.cursor &&
            newState.document.cursor.position.blockIndex !==
              state.ui.autoCreatedParagraph.blockIndex
          ) {
            newState = clearAutoCreatedParagraph(newState);
          }
        }
      }
      break;
    case "PageUp":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionPageUp(newState, viewport);
      } else {
        newState = moveCursorPageUp(clearSelection(state), viewport);
      }
      break;
    case "PageDown":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionPageDown(newState, viewport);
      } else {
        newState = moveCursorPageDown(clearSelection(state), viewport);
      }
      break;
    case "Home":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionHome(newState, isCtrl);
      } else {
        if (isCtrl) {
          newState = moveCursorToPosition(clearSelection(state), 0, 0);
        } else {
          newState = moveToLineStart(clearSelection(state));
        }
      }
      break;
    case "End":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionEnd(newState, isCtrl);
      } else {
        if (isCtrl) {
          newState = moveCursorToPosition(
            clearSelection(state),
            state.document.page.blocks.length - 1,
            getBlockTextLength(
              state.document.page.blocks[state.document.page.blocks.length - 1]
            )
          );
        } else {
          newState = moveToLineEnd(clearSelection(state));
        }
      }
      break;
    case "Escape":
      return clearSelection(state);
    case "Backspace":
      if (isCtrl) {
        newState = deleteWordBackward(recordUndo(state));
      } else {
        newState = deleteText(recordUndo(state));
      }
      // Clear auto-created paragraph tracking on delete
      newState = clearAutoCreatedParagraph(newState);
      break;
    case "Delete":
      if (isCtrl) {
        newState = deleteWordForward(recordUndo(state));
      } else {
        newState = deleteForward(recordUndo(state));
      }
      // Clear auto-created paragraph tracking on delete
      newState = clearAutoCreatedParagraph(newState);
      break;
    case "Enter":
      newState = splitBlock(recordUndo(state));
      // Clear auto-created paragraph tracking on enter
      newState = clearAutoCreatedParagraph(newState);
      break;
    case " ":
    case "Space":
      newState = insertText(recordUndo(state), " ");
      // Clear auto-created paragraph tracking on space (already cleared in insertText, but for safety)
      newState = clearAutoCreatedParagraph(newState);
      break;
    default:
      // Check if typing "/" at the start of a block (only on desktop)
      if (
        key === "/" &&
        !isTouchDevice() &&
        state.document.cursor &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey
      ) {
        const { blockIndex } = state.document.cursor.position;

        // Allow slash command anywhere in paragraphs and headings
        const newState = insertText(recordUndo(state), "/");
        if (newState.document.cursor) {
          const finalState = openSlashCommand(
            newState,
            blockIndex,
            newState.document.cursor.position.textIndex
          );
          ensureCursorVisible(
            finalState,
            state,
            viewport,
            updateViewportCallback
          );
          return finalState;
        }
        return newState;
      }

      if (
        key.length === 1 &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey
      ) {
        newState = insertText(recordUndo(state), key);
        break;
      }
      return state;
  }

  if (
    newState !== state &&
    newState.document.cursor &&
    updateViewportCallback
  ) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }

  return newState;
}

function handleWheel(
  state: EditorState,
  viewport: ViewportState,
  event: WheelEvent,
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  // In locked mode, block scrolling
  if (state.ui.mode === "locked") {
    return state;
  }

  // Stop momentum when using wheel
  state = {
    ...state,
    view: {
      ...state.view,
      momentum: {
        velocity: 0,
        lastTime: Date.now(),
        isActive: false,
      },
    },
  };

  const { scrollY, scrollbarState } = updateScrollFromWheel(
    event.deltaY,
    viewport,
    documentHeight,
    state.view.scrollbar
  );

  if (updateViewportCallback) {
    updateViewportCallback({ scrollY });
  }

  // Clear link hover overlay when scrolling
  return {
    ...state,
    view: {
      ...state.view,
      scrollbar: scrollbarState,
    },
    ui: {
      ...state.ui,
      activeMenu: { type: "none" },
      isHoveringLinkWithModifier: false,
      imageHover: null,
    },
  };
}

// Touch state storage (needs to be outside functions to persist between events)
let touchState: {
  startY: number;
  startScrollY: number;
  lastY: number;
  lastTime: number;
  velocityY: number;
  velocityHistory: Array<{ velocity: number; time: number }>;
  isScrollbarDrag: boolean;
  startX: number;
  startTime: number;
  isLongPress: boolean;
  hasMoved: boolean;
  currentTouchX: number;
  currentTouchY: number;
  isTouchingSelection: boolean;
  isTwoFingerScroll?: boolean;
} | null = null;

let autoScrollState: {
  isActive: boolean;
  startTime: number;
  currentSpeedMultiplier: number;
  lastMouseX: number;
  lastMouseY: number;
} = {
  isActive: false,
  startTime: 0,
  currentSpeedMultiplier: 1,
  lastMouseX: 0,
  lastMouseY: 0,
};

// Touch tap tracking for double/triple tap detection (similar to clickTracker)
let touchTapTracker: {
  lastTapTime: number;
  lastTapPosition: { x: number; y: number } | null;
  count: number;
} = {
  lastTapTime: 0,
  lastTapPosition: null,
  count: 0,
};

// Scrollbar long-press state for iOS-style behavior
let scrollbarPressState: {
  isPressingThumb: boolean;
  startTime: number;
  canvasX: number;
  canvasY: number;
} | null = null;

/**
 * Trigger haptic feedback through native bridges
 */
function triggerHapticFeedback(
  style: "light" | "medium" | "heavy" = "heavy"
): void {
  try {
    // iOS native bridge
    if (window.IOSBridge?.postMessage) {
      window.IOSBridge.postMessage({ action: "haptic", style });
      return;
    }

    // Android native bridge
    if (window.AndroidBridge?.haptic) {
      window.AndroidBridge.haptic(style);
      return;
    }

    // Fallback: Standard Vibration API (works on Android Chrome web, not in WebView usually)
    if ("vibrate" in navigator) {
      const duration = style === "light" ? 10 : style === "medium" ? 20 : 50;
      navigator.vibrate(duration);
    }
  } catch (e) {
    // Silently fail if haptics not supported
    console.debug("Haptic feedback not supported:", e);
  }
}

function startAutoScroll() {
  if (!autoScrollState.isActive) {
    autoScrollState.isActive = true;
    autoScrollState.startTime = Date.now();
    autoScrollState.currentSpeedMultiplier = 1;
  }
}

function stopAutoScroll() {
  autoScrollState.isActive = false;
  autoScrollState.startTime = 0;
  autoScrollState.currentSpeedMultiplier = 1;
}

export function isInLongPressMode(): boolean {
  return touchState?.isLongPress === true;
}

function handleTouchStart(
  state: EditorState,
  viewport: ViewportState,
  event: TouchEvent,
  containerRect: { left: number; top: number },
  documentHeight: number
): EditorState {
  // In locked mode, block touch interactions that might lead to scrolling
  if (state.ui.mode === "locked") {
    return state;
  }

  // Handle two-finger scroll
  if (event.touches.length === 2) {
    const touch1 = event.touches[0];
    const touch2 = event.touches[1];
    const currentTime = Date.now();
    
    // Calculate average position of both fingers
    const avgY = (touch1.clientY + touch2.clientY) / 2 - containerRect.top;
    
    touchState = {
      startY: avgY,
      startScrollY: viewport.scrollY,
      lastY: avgY,
      lastTime: currentTime,
      velocityY: 0,
      velocityHistory: [],
      isScrollbarDrag: false,
      startX: (touch1.clientX + touch2.clientX) / 2 - containerRect.left,
      startTime: currentTime,
      isLongPress: false,
      hasMoved: false,
      currentTouchX: (touch1.clientX + touch2.clientX) / 2 - containerRect.left,
      currentTouchY: avgY,
      isTouchingSelection: false,
      isTwoFingerScroll: true,
    };

    // Stop any ongoing momentum
    return {
      ...state,
      view: {
        ...state.view,
        momentum: {
          velocity: 0,
          lastTime: Date.now(),
          isActive: false,
        },
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
    };
  }

  if (event.touches.length === 1) {
    const touch = event.touches[0];
    const currentTime = Date.now();
    const canvasX = touch.clientX - containerRect.left;
    const canvasY = touch.clientY - containerRect.top;

    // iOS-style: Check if touching scrollbar thumb (requires hold to activate)
    // Use a larger buffer area for easier touch detection on mobile
    const isScrollbarThumbTouch = isPointInThumb(
      canvasX,
      canvasY,
      viewport,
      documentHeight,
      state.view.scrollbar,
      undefined, // Use default styles
      SCROLLBAR_TOUCH_BUFFER
    );

    // Check if touching a selection handle for mobile selection dragging
    const selectionHandle = getSelectionHandleAtPoint(canvasX, canvasY, state, viewport);
    if (selectionHandle && !isScrollbarThumbTouch) {
      // Start selection handle drag
      touchState = {
        startY: canvasY,
        startScrollY: viewport.scrollY,
        lastY: canvasY,
        lastTime: currentTime,
        velocityY: 0,
        velocityHistory: [],
        isScrollbarDrag: false,
        startX: canvasX,
        startTime: currentTime,
        isLongPress: false,
        hasMoved: false,
        currentTouchX: canvasX,
        currentTouchY: canvasY,
        isTouchingSelection: true, // We're on a selection
      };

      return {
        ...state,
        ui: {
          ...state.ui,
          selectionHandleDrag: {
            handleType: selectionHandle,
            startX: canvasX,
            startY: canvasY,
          },
        },
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
          momentum: {
            velocity: 0,
            lastTime: Date.now(),
            isActive: false,
          },
        },
      };
    }

    // Check if touching an image drag handle (with larger tolerance for touch)
    const imageBlock = getImageBlockAtPoint(canvasX, canvasY, state, viewport);
    const TOUCH_TOLERANCE = 12; // Larger tolerance for touch devices
    if (imageBlock && !isScrollbarThumbTouch) {
      const dragState = startImageDrag(
        state,
        imageBlock,
        canvasX,
        canvasY,
        TOUCH_TOLERANCE
      );
      if (dragState) {
        // Start image drag - initialize touch state but don't treat as scroll
        touchState = {
          startY: canvasY,
          startScrollY: viewport.scrollY,
          lastY: canvasY,
          lastTime: currentTime,
          velocityY: 0,
          velocityHistory: [],
          isScrollbarDrag: false,
          startX: canvasX,
          startTime: currentTime,
          isLongPress: false,
          hasMoved: false,
          currentTouchX: canvasX,
          currentTouchY: canvasY,
          isTouchingSelection: false,
        };

        return {
          ...dragState,
          view: {
            ...dragState.view,
            scrollbar: {
              ...dragState.view.scrollbar,
              lastInteraction: Date.now(),
            },
            momentum: {
              velocity: 0,
              lastTime: Date.now(),
              isActive: false,
            },
          },
        };
      }
    }

    // Check if touching within existing selection
    const position = getTextPositionFromViewport(
      canvasX,
      canvasY,
      state,
      viewport,
      { start: 0, end: state.document.page.blocks.length - 1 }
    );
    const isTouchingSelection = position
      ? isPositionWithinSelection(state, position)
      : false;

    // iOS-style: If touching scrollbar thumb, start hold timer (don't activate immediately)
    if (isScrollbarThumbTouch) {
      scrollbarPressState = {
        isPressingThumb: true,
        startTime: currentTime,
        canvasX,
        canvasY,
      };

      // Set up minimal touch state for scrollbar interaction
      touchState = {
        startY: canvasY,
        startScrollY: viewport.scrollY,
        lastY: canvasY,
        lastTime: currentTime,
        velocityY: 0,
        velocityHistory: [],
        isScrollbarDrag: false, // Not dragging yet, waiting for hold
        startX: canvasX,
        startTime: currentTime,
        isLongPress: false,
        hasMoved: false,
        currentTouchX: canvasX,
        currentTouchY: canvasY,
        isTouchingSelection: false,
      };
    } else {
      // Regular touch (not on scrollbar)
      touchState = {
        startY: canvasY,
        startScrollY: viewport.scrollY,
        lastY: canvasY,
        lastTime: currentTime,
        velocityY: 0,
        velocityHistory: [],
        isScrollbarDrag: false,
        startX: canvasX,
        startTime: currentTime,
        isLongPress: false,
        hasMoved: false,
        currentTouchX: canvasX,
        currentTouchY: canvasY,
        isTouchingSelection,
      };
    }

    // Stop any ongoing momentum
    state = {
      ...state,
      view: {
        ...state.view,
        momentum: {
          velocity: 0,
          lastTime: Date.now(),
          isActive: false,
        },
      },
    };
  }

  return {
    ...state,
    view: {
      ...state.view,
      scrollbar: {
        ...state.view.scrollbar,
        lastInteraction: Date.now(),
      },
    },
  };
}

function handleTouchMove(
  state: EditorState,
  viewport: ViewportState,
  event: TouchEvent,
  containerRect: { left: number; top: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  // In locked mode, block scrolling
  if (state.ui.mode === "locked") {
    return state;
  }

  // Handle transition from two-finger to single-finger (user lifted one finger)
  if (event.touches.length === 1 && touchState?.isTwoFingerScroll) {
    // User lifted one finger during two-finger scroll - end the scroll with momentum
    const avgVelocity = touchState.velocityY;
    const minMomentumVelocity = 0.1; // pixels per ms
    
    // Apply momentum if velocity is significant
    if (Math.abs(avgVelocity) > minMomentumVelocity) {
      const momentumMultiplier = 1.2;
      state = {
        ...state,
        view: {
          ...state.view,
          momentum: {
            velocity: avgVelocity * momentumMultiplier,
            lastTime: Date.now(),
            isActive: true,
          },
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }
    
    touchState = null;
    return state;
  }

  // Handle transition from single to two-finger scroll
  if (event.touches.length === 2 && touchState && !touchState.isTwoFingerScroll) {
    // User added a second finger - switch to two-finger scroll mode
    const touch1 = event.touches[0];
    const touch2 = event.touches[1];
    const currentTime = Date.now();
    const avgY = (touch1.clientY + touch2.clientY) / 2 - containerRect.top;
    
    touchState = {
      ...touchState,
      isTwoFingerScroll: true,
      startY: avgY,
      startScrollY: viewport.scrollY,
      lastY: avgY,
      lastTime: currentTime,
      velocityHistory: [], // Reset velocity history
      isLongPress: false, // Cancel long press
      hasMoved: true, // Mark as moved to prevent tap detection
    };
    
    // Stop any auto-scroll
    stopAutoScroll();
  }

  // Handle two-finger scroll
  if (event.touches.length === 2 && touchState?.isTwoFingerScroll) {
    event.preventDefault();
    const touch1 = event.touches[0];
    const touch2 = event.touches[1];
    const currentTime = Date.now();
    const deltaTime = currentTime - touchState.lastTime;
    
    // Skip if no time has passed
    if (deltaTime === 0) return state;
    
    // Calculate average position of both fingers
    const avgY = (touch1.clientY + touch2.clientY) / 2 - containerRect.top;
    
    // Calculate scroll delta
    const scrollDeltaY = touchState.lastY - avgY;
    
    // Calculate instantaneous velocity (pixels per millisecond)
    const instantVelocity = scrollDeltaY / deltaTime;
    
    // Track velocity for momentum
    if (Math.abs(instantVelocity) > 0.01) {
      touchState.velocityHistory.push({
        velocity: instantVelocity,
        time: currentTime,
      });
    }
    
    // Keep only last 150ms of velocity history
    touchState.velocityHistory = touchState.velocityHistory.filter(
      (v) => currentTime - v.time < 150
    );
    
    // Update velocity for momentum
    if (touchState.velocityHistory.length > 0) {
      const totalVelocity = touchState.velocityHistory.reduce(
        (sum, v) => sum + v.velocity,
        0
      );
      touchState.velocityY = totalVelocity / touchState.velocityHistory.length;
    }
    
    // Apply scroll with multiplier for responsive feel
    const touchScrollMultiplier = 1.5;
    const scrollDelta = (touchState.startY - avgY) * touchScrollMultiplier;
    
    // Update scroll position with boundaries
    const maxScroll = documentHeight - viewport.height;
    const newScrollY = Math.max(
      0,
      Math.min(maxScroll, touchState.startScrollY + scrollDelta)
    );
    
    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }
    
    touchState.lastY = avgY;
    touchState.lastTime = currentTime;
    
    // Clear any menus when scrolling
    return {
      ...state,
      view: {
        ...state.view,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
      ui: {
        ...state.ui,
        activeMenu: { type: "none" },
        isHoveringLinkWithModifier: false,
        imageHover: null,
      },
    };
  }

  if (event.touches.length === 1 && touchState) {
    event.preventDefault();
    const touch = event.touches[0];
    const currentTime = Date.now();
    const deltaTime = currentTime - touchState.lastTime;
    const canvasX = touch.clientX - containerRect.left;
    const canvasY = touch.clientY - containerRect.top;

    // Skip if no time has passed
    if (deltaTime === 0) return state;

    // Handle scrollbar drag
    if (touchState.isScrollbarDrag && state.view.scrollbar.isDragging) {
      const newScrollY = updateScrollFromThumbDrag(
        canvasY,
        viewport,
        documentHeight,
        state.view.scrollbar
      );
      if (updateViewportCallback) {
        updateViewportCallback({ scrollY: newScrollY });
      }
      // Clear link hover overlay when scrolling via scrollbar
      return {
        ...state,
        ui: {
          ...state.ui,
          activeMenu: { type: "none" },
          isHoveringLinkWithModifier: false,
          imageHover: null,
        },
      };
    }

    // Handle image drag resize (no auto-scroll - resize only)
    if (state.ui.imageDrag) {
      touchState.lastY = canvasY;
      touchState.lastTime = currentTime;

      return {
        ...updateImageDrag(state, viewport, canvasX, canvasY),
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }

    // Handle selection handle drag
    if (state.ui.selectionHandleDrag) {
      touchState.lastY = canvasY;
      touchState.lastTime = currentTime;
      touchState.currentTouchX = canvasX;
      touchState.currentTouchY = canvasY;

      // Check for edge scrolling during selection handle drag
      const isNearEdge =
        canvasY < EDGE_SCROLL_THRESHOLD ||
        canvasY > viewport.height - EDGE_SCROLL_THRESHOLD ||
        canvasY < 0 ||
        canvasY > viewport.height;

      if (isNearEdge) {
        if (!autoScrollState.isActive) {
          startAutoScroll();
        }
        autoScrollState.lastMouseX = canvasX;
        autoScrollState.lastMouseY = canvasY;
      } else {
        if (autoScrollState.isActive) {
          stopAutoScroll();
        }
      }

      // Get the new position based on touch location
      const newPosition = getTextPositionFromViewport(
        canvasX,
        canvasY,
        state,
        viewport,
        { start: 0, end: state.document.page.blocks.length - 1 }
      );

      if (newPosition && state.document.selection) {
        const { handleType } = state.ui.selectionHandleDrag;
        const { anchor, focus } = state.document.selection;

        let newAnchor = anchor;
        let newFocus = focus;

        if (handleType === "anchor") {
          // Dragging anchor - update anchor position, keep focus
          newAnchor = newPosition;
        } else {
          // Dragging focus - update focus position, keep anchor
          newFocus = newPosition;
        }

        // Determine if selection is now forward or backward
        const isForward =
          newAnchor.blockIndex < newFocus.blockIndex ||
          (newAnchor.blockIndex === newFocus.blockIndex &&
            newAnchor.textIndex <= newFocus.textIndex);

        // Check if selection is collapsed
        const isCollapsed =
          newAnchor.blockIndex === newFocus.blockIndex &&
          newAnchor.textIndex === newFocus.textIndex;

        state = {
          ...state,
          document: {
            ...state.document,
            selection: {
              anchor: newAnchor,
              focus: newFocus,
              isForward,
              isCollapsed,
              lastUpdate: Date.now(),
            },
            cursor: {
              position: handleType === "anchor" ? newAnchor : newFocus,
              lastUpdate: Date.now(),
            },
          },
        };
      }

      return {
        ...state,
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }

    // Check if we've moved significantly from start position
    const deltaX = Math.abs(canvasX - touchState.startX);
    const deltaY = Math.abs(canvasY - touchState.startY);
    const totalMovement = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Update current touch position for auto-scroll
    touchState.currentTouchX = canvasX;
    touchState.currentTouchY = canvasY;

    // If moved beyond threshold, mark as moved (cancels potential long press)
    if (!touchState.hasMoved && totalMovement > MOVEMENT_THRESHOLD) {
      touchState.hasMoved = true;

      // Cancel scrollbar press state if user moves (they're not trying to hold it)
      if (scrollbarPressState) {
        scrollbarPressState = null;
      }

      // Close all menus on movement
      if (state.ui.activeMenu.type !== "none") {
        state = closeActiveMenu(state);
      }
    }

    // Handle long press text selection mode
    if (touchState.isLongPress) {
      // If context menu is open, allow drag-and-release interaction
      // Don't start text selection - user might be dragging to menu item
      if (state.ui.activeMenu.type === "contextMenu") {
        touchState.lastY = canvasY;
        touchState.lastTime = currentTime;

        // Update hover state based on touch position
        const touch = event.touches[0];
        const element = document.elementFromPoint(touch.clientX, touch.clientY);
        let hoveredItemId: string | null = null;

        if (element) {
          const button = element.closest("button[data-context-menu-item-id]");
          if (button) {
            hoveredItemId = button.getAttribute("data-context-menu-item-id");
          }
        }

        // Update hover state if it changed
        const currentHoveredId = state.ui.activeMenu.hoveredItemId || null;
        if (hoveredItemId !== currentHoveredId) {
          state = updateContextMenuHover(state, hoveredItemId);
        }

        return state;
      }

      // Long pressed on non-selected text: enable drag selection
      if (!touchState.isTouchingSelection) {
        // Start selection mode if not already in it
        if (state.ui.mode !== "select") {
          const position = getTextPositionFromViewport(
            touchState.startX,
            touchState.startY,
            state,
            viewport,
            { start: 0, end: state.document.page.blocks.length - 1 }
          );
          
          if (position) {
            state = startSelection(state, position);
            state = updateMode(state, "select");
          }
        }
        
        if (!autoScrollState.isActive) {
          startAutoScroll();
        }

        touchState.lastY = canvasY;
        touchState.lastTime = currentTime;

        return {
          ...state,
          view: {
            ...state.view,
            scrollbar: {
              ...state.view.scrollbar,
              lastInteraction: Date.now(),
            },
          },
        };
      } else {
        // Long pressing on selection - don't start auto-scroll, just wait for touchend
        touchState.lastY = canvasY;
        touchState.lastTime = currentTime;
        return state;
      }
    }

    // Default: Handle scrolling
    const scrollDeltaY = touchState.lastY - canvasY;

    // Calculate instantaneous velocity (pixels per millisecond)
    const instantVelocity = scrollDeltaY / deltaTime;

    // Only track velocity if there's actual movement (avoid diluting with zeros)
    // This prevents touchmove events with no vertical movement from adding 0-velocity entries
    if (Math.abs(instantVelocity) > 0.01) {
      touchState.velocityHistory.push({
        velocity: instantVelocity,
        time: currentTime,
      });
    }

    // Keep only last 150ms of velocity history (increased from 100ms to be more reliable)
    touchState.velocityHistory = touchState.velocityHistory.filter(
      (v) => currentTime - v.time < 150
    );

    // Always update velocity for momentum (use average if history exists)
    if (touchState.velocityHistory.length > 0) {
      const totalVelocity = touchState.velocityHistory.reduce(
        (sum, v) => sum + v.velocity,
        0
      );
      touchState.velocityY = totalVelocity / touchState.velocityHistory.length;
      // console.log("touchState.velocityY", touchState.velocityY);
    }
    // Apply scroll speed multiplier for more responsive feel on mobile
    // 1.5x makes scrolling feel more direct and responsive
    const touchScrollMultiplier = 1.5;
    const scrollDelta = (touchState.startY - canvasY) * touchScrollMultiplier;

    // Update scroll position with hard boundaries
    const maxScroll = documentHeight - viewport.height;
    const newScrollY = Math.max(
      0,
      Math.min(maxScroll, touchState.startScrollY + scrollDelta)
    );

    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }

    touchState.lastY = canvasY;
    touchState.lastTime = currentTime;
  }

  // Clear link hover overlay when scrolling
  return {
    ...state,
    view: {
      ...state.view,
      scrollbar: {
        ...state.view.scrollbar,
        lastInteraction: Date.now(),
      },
    },
    ui: {
      ...state.ui,
      activeMenu: { type: "none" },
      isHoveringLinkWithModifier: false,
    },
  };
}

function handleTouchEnd(
  state: EditorState,
  viewport: ViewportState,
  _event: TouchEvent,
  _containerRect: { left: number; top: number }
): EditorState {
  stopAutoScroll();

  // Handle two-finger scroll end with momentum
  if (touchState?.isTwoFingerScroll) {
    const avgVelocity = touchState.velocityY;
    const minMomentumVelocity = 0.1; // pixels per ms
    
    // Apply momentum if velocity is significant
    if (Math.abs(avgVelocity) > minMomentumVelocity) {
      const momentumMultiplier = 1.2;
      state = {
        ...state,
        view: {
          ...state.view,
          momentum: {
            velocity: avgVelocity * momentumMultiplier,
            lastTime: Date.now(),
            isActive: true,
          },
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }
    
    touchState = null;
    return state;
  }

  // Clean up scrollbar press state (iOS-style hold)
  if (scrollbarPressState) {
    scrollbarPressState = null;
  }

  // End scrollbar drag if active
  if (state.view.scrollbar.isDragging) {
    state = {
      ...state,
      view: {
        ...state.view,
        scrollbar: endScrollbarDrag(state.view.scrollbar),
      },
    };
  }

  // End selection handle drag if active
  if (state.ui.selectionHandleDrag) {
    touchState = null;
    return {
      ...state,
      ui: {
        ...state.ui,
        selectionHandleDrag: null,
      },
      view: {
        ...state.view,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
    };
  }

  // End image drag if active
  if (state.ui.imageDrag) {
    touchState = null;
    return {
      ...endImageDrag(state),
      view: {
        ...state.view,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
    };
  }

  // Handle drag-and-release for context menu (power user feature)
  // Check if context menu is open and user is releasing (possibly over a menu item)
  if (state.ui.activeMenu.type === "contextMenu" && touchState?.isLongPress) {
    // Use the hoveredItemId from the state (already tracked during touchmove)
    const hoveredItemId = state.ui.activeMenu.hoveredItemId;

    if (hoveredItemId) {
      // User released on a menu item - mark it as selected
      // MountedEditor will detect this and execute the action
      state = selectContextMenuItem(state, hoveredItemId);
      touchState = null;
      return {
        ...state,
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    } else {
      // User released but not on a menu item - keep menu open for tapping
      // Just clean up touch state and return
      touchState = null;
      return {
        ...state,
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }
  }

  // If we were in long press mode
  if (touchState?.isLongPress) {
    if (touchState.isTouchingSelection) {
      // Long pressed on existing selection - context menu already shown, just cleanup
      touchState = null;
      return {
        ...state,
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    } else if (state.ui.mode === "select") {
      // Long press created a new selection (user dragged) - exit select mode
      // Clear initialBoundary when finishing selection
      if (state.document.selection?.initialBoundary) {
        state = {
          ...state,
          document: {
            ...state.document,
            selection: state.document.selection
              ? {
                  ...state.document.selection,
                  initialBoundary: undefined,
                }
              : null,
          },
        };
      }
      state = updateMode(state, "edit");
      touchState = null;

      return {
        ...state,
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    } else {
      // Long press on non-selected text but user didn't drag - show context menu now
      state = openContextMenu(
        state,
        touchState.currentTouchX,
        touchState.currentTouchY
      );
      touchState = null;
      return {
        ...state,
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }
  }

  // Detect tap: short duration and minimal movement
  const currentTime = Date.now();
  const isTap =
    touchState &&
    !touchState.isScrollbarDrag &&
    !touchState.hasMoved &&
    currentTime - touchState.startTime < TAP_MAX_DURATION;

  if (isTap && touchState) {
    const tapPosition = { x: touchState.startX, y: touchState.startY };

    // Track if image upload was open (we'll use this to prevent reopening on same tap)
    const wasImageUploadOpen = state.ui.activeMenu.type === "imageUpload";
    const wasImageUploadBlockIndex =
      state.ui.activeMenu.type === "imageUpload"
        ? state.ui.activeMenu.blockIndex
        : undefined;

    // Check if tapping in top padding area
    const styles = getEditorStyles();
    const isTapInTopPadding =
      tapPosition.y < styles.canvas.paddingTop - viewport.scrollY;

    // If tapping in top padding, clear selection
    if (isTapInTopPadding) {
      state = clearSelection(state);
      state = updateMode(state, "edit");
      // Close any active menu when tapping in padding
      if (state.ui.activeMenu.type === "contextMenu") {
        state = closeActiveMenu(state);
      }

      touchState = null;
      return {
        ...state,
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }

    // Check if tapping in left/right padding area
    const maxWidth =
      viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
    const isTapInLeftPadding = tapPosition.x < styles.canvas.paddingLeft;
    const isTapInRightPadding =
      tapPosition.x > styles.canvas.paddingLeft + maxWidth;

    // If tapping in left/right padding, position cursor at start/end of line and clear selection
    if (isTapInLeftPadding || isTapInRightPadding) {
      const paddingPosition = getTextPositionFromViewport(
        tapPosition.x,
        tapPosition.y,
        state,
        viewport,
        { start: 0, end: state.document.page.blocks.length - 1 }
      );

      if (paddingPosition) {
        state = clearSelection(state);
        state = updateCursor(state, paddingPosition);
        state = updateMode(state, "edit");
        // Close any active menu when tapping in padding
        if (state.ui.activeMenu.type === "contextMenu") {
          state = closeActiveMenu(state);
        }

        touchState = null;
        return {
          ...state,
          view: {
            ...state.view,
            scrollbar: {
              ...state.view.scrollbar,
              lastInteraction: Date.now(),
            },
          },
        };
      }
    }

    // Check for tap on todo checkbox
    const checkboxTapResult = handleTodoCheckboxClick(
      state,
      tapPosition.x,
      tapPosition.y,
      viewport
    );
    if (checkboxTapResult) {
      touchState = null;
      return checkboxTapResult;
    }

    // Get text position for cursor/selection
    const position = getTextPositionFromViewport(
      tapPosition.x,
      tapPosition.y,
      state,
      viewport,
      { start: 0, end: state.document.page.blocks.length - 1 }
    );

    // Check for multi-tap (double/triple) - use larger threshold for touch
    let isMultiTap = false;
    if (
      touchTapTracker.lastTapPosition &&
      currentTime - touchTapTracker.lastTapTime <= DOUBLE_CLICK_TIME &&
      isWithinClickDistance(
        tapPosition,
        touchTapTracker.lastTapPosition,
        TAP_DISTANCE_THRESHOLD
      )
    ) {
      touchTapTracker.count++;
      isMultiTap = true;
    } else {
      touchTapTracker.count = 1;
    }

    touchTapTracker.lastTapTime = currentTime;
    touchTapTracker.lastTapPosition = tapPosition;

    if (position) {
      // If tapping below all blocks, check if last block is an image and select it
      const lastBlockIndex = state.document.page.blocks.length - 1;
      if (lastBlockIndex >= 0 && position.blockIndex === lastBlockIndex) {
        const lastBlock = state.document.page.blocks[lastBlockIndex];

        // Calculate if tap is below the last block's content
        // Use pre-computed viewport.documentHeight instead of iterating through all blocks
        const totalContentHeight = viewport.documentHeight + styles.canvas.paddingTop;
        const isTapBelowContent =
          tapPosition.y > totalContentHeight - viewport.scrollY;

        // If tapping below content and last block is an image, select it
        if (isTapBelowContent && lastBlock.type === "image") {
          const imagePosition = { blockIndex: lastBlockIndex, textIndex: 0 };
          state = updateCursor(state, imagePosition);

          // Select the image block
          state = {
            ...state,
            document: {
              ...state.document,
              selection: {
                anchor: imagePosition,
                focus: imagePosition,
                isForward: true,
                isCollapsed: false,
                lastUpdate: Date.now(),
              },
            },
          };

          touchState = null;
          return {
            ...updateMode(state, "edit"),
            view: {
              ...state.view,
              scrollbar: {
                ...state.view.scrollbar,
                lastInteraction: Date.now(),
              },
            },
          };
        }
      }

      // Check if tapped on an image cover block
      const tappedBlock = state.document.page.blocks[position.blockIndex];
      if (tappedBlock && tappedBlock.type === "image") {
        // Verify the tap is actually within the image bounds, not just in the block
        const imageBlock = getImageBlockAtPoint(
          tapPosition.x,
          tapPosition.y,
          state,
          viewport
        );
        if (imageBlock) {
          // If it's a placeholder (no URL), open upload menu
          if (!tappedBlock.url) {
            // If the upload menu was already open for this same block, don't reopen it (let it stay closed)
            // This allows tapping on an open upload menu to close it
            if (
              wasImageUploadOpen &&
              wasImageUploadBlockIndex === position.blockIndex
            ) {
              // Close image upload popover and keep it closed
              touchState = null;
              return {
                ...closeActiveMenu(state),
                view: {
                  ...state.view,
                  scrollbar: {
                    ...state.view.scrollbar,
                    lastInteraction: Date.now(),
                  },
                },
              };
            }

            // Open image upload popover
            touchState = null;
            return {
              ...setActiveMenu(state, {
                type: "imageUpload",
                blockIndex: position.blockIndex,
                x: tapPosition.x,
                y: tapPosition.y,
              }),
              view: {
                ...state.view,
                scrollbar: {
                  ...state.view.scrollbar,
                  lastInteraction: Date.now(),
                },
              },
            };
          }

          // If it has an image, select the image block (same behavior as desktop)
          const imagePosition = {
            blockIndex: imageBlock.blockIndex,
            textIndex: 0,
          };

          // Close any active menu when selecting an image
          if (state.ui.activeMenu.type !== "none") {
            state = closeActiveMenu(state);
          }

          // Create a selection that spans the image block (same as arrow key behavior)
          state = moveCursorToPosition(state, imageBlock.blockIndex, 0);
          state = {
            ...state,
            document: {
              ...state.document,
              selection: {
                anchor: imagePosition,
                focus: imagePosition,
                isForward: true,
                isCollapsed: false,
                lastUpdate: Date.now(),
              },
            },
          };
          state = updateMode(state, "edit");

          touchState = null;
          return {
            ...state,
            view: {
              ...state.view,
              scrollbar: {
                ...state.view.scrollbar,
                lastInteraction: Date.now(),
              },
            },
          };
        }
      }

      // Check if we have an image selected but tapped outside its container
      if (
        tappedBlock?.type !== "image" &&
        state.document.selection &&
        !state.document.selection.isCollapsed
      ) {
        const { anchor, focus } = state.document.selection;
        // Check if this is an image selection (anchor and focus at same position on an image block)
        if (
          anchor.blockIndex === focus.blockIndex &&
          anchor.textIndex === focus.textIndex
        ) {
          const selectedBlock = state.document.page.blocks[anchor.blockIndex];
          if (selectedBlock && selectedBlock.type === "image") {
            // We have an image selected, but tapped outside it - clear the selection
            state = clearSelection(state);
          }
        }
      }

      // Close any active menu when tapping on non-image blocks
      if (state.ui.activeMenu.type !== "none") {
        state = closeActiveMenu(state);
      }

      // Handle triple-tap: always select line (even inside selection)
      if (isMultiTap && touchTapTracker.count >= 3) {
        state = selectLineAtPosition(state, position);
      }
      // If tapping inside a selection (single or double tap), don't reset it (Apple Notes behavior)
      else if (isPositionWithinSelection(state, position)) {
        // Keep selection but update cursor position
        state = updateCursor(state, position);
        // Close any active menu if open when tapping on selection
        if (state.ui.activeMenu.type === "contextMenu") {
          state = closeActiveMenu(state);
        }
      }
      // Handle double-tap: select word
      else if (isMultiTap && touchTapTracker.count === 2) {
        state = selectWordAtPosition(state, position);
        // Close any active menu when making new selection
        if (state.ui.activeMenu.type === "contextMenu") {
          state = closeActiveMenu(state);
        }
      }
      // Single tap outside selection: position cursor and close context menu
      else {
        state = clearSelection(state);
        state = updateCursor(state, position);
        state = updateMode(state, "edit");
        // Close any active menu when tapping outside
        if (state.ui.activeMenu.type === "contextMenu") {
          state = closeActiveMenu(state);
        }
      }
    } else {
      // Tapping outside editor area (padding/margins) - clear selection and close menus
      state = clearSelection(state);
      state = updateMode(state, "edit");
      if (state.ui.activeMenu.type === "contextMenu") {
        state = closeActiveMenu(state);
      }
    }

    touchState = null;
    return {
      ...state,
      view: {
        ...state.view,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
    };
  }

  // Implement momentum scrolling with the tracked velocity
  // Only apply momentum if NOT dragging scrollbar and NOT in long press mode
  if (touchState && !touchState.isScrollbarDrag && !touchState.isLongPress) {
    // Use the average velocity from recent history
    const avgVelocity = touchState.velocityY;

    // Only apply momentum if velocity is significant
    const minMomentumVelocity = 0.1; // pixels per ms
    if (Math.abs(avgVelocity) > minMomentumVelocity) {
      // Apply momentum multiplier for more natural feel
      // Higher values = more "throw" distance
      const momentumMultiplier = 1.2;
      state = {
        ...state,
        view: {
          ...state.view,
          momentum: {
            velocity: avgVelocity * momentumMultiplier,
            lastTime: Date.now(),
            isActive: true,
          },
        },
      };
    }
  }

  touchState = null;

  return {
    ...state,
    view: {
      ...state.view,
      scrollbar: {
        ...state.view.scrollbar,
        lastInteraction: Date.now(),
      },
    },
  };
}

function handleTouchCancel(state: EditorState): EditorState {
  stopAutoScroll();

  // End scrollbar drag if active
  if (state.view.scrollbar.isDragging) {
    state = {
      ...state,
      view: {
        ...state.view,
        scrollbar: endScrollbarDrag(state.view.scrollbar),
      },
    };
  }

  // End selection handle drag if active
  if (state.ui.selectionHandleDrag) {
    state = {
      ...state,
      ui: {
        ...state.ui,
        selectionHandleDrag: null,
      },
    };
  }

  // If we were in long press text selection mode, exit select mode
  if (touchState?.isLongPress && state.ui.mode === "select") {
    state = updateMode(state, "edit");
  }

  // Clear touch state
  touchState = null;

  return {
    ...state,
    view: {
      ...state.view,
      scrollbar: {
        ...state.view.scrollbar,
        lastInteraction: Date.now(),
      },
    },
  };
}

// Composition (IME) Event Handlers
function handleCompositionStart(
  state: EditorState,
  event: CompositionEvent
): EditorState {
  // If editor is not focused, ignore composition
  if (!state.view.isFocused) {
    return state;
  }

  // When composition starts, save the current cursor position
  if (!state.document.cursor) return state;

  // Delete any selected text first (like normal typing would)
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const range = getSelectionRange(state);
    if (range) {
      state = deleteSelectedText(state);
    }
  }

  // Store the starting position for composition
  if (!state.document.cursor) return state;
  const startPosition = state.document.cursor.position;

  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        isComposing: true,
        text: event.data || "",
        startPosition,
      },
    },
  };
}

function handleCompositionUpdate(
  state: EditorState,
  event: CompositionEvent
): EditorState {
  // If editor is not focused, ignore composition
  if (!state.view.isFocused) {
    return state;
  }

  if (!state.ui.composition) {
    // If composition wasn't started properly, start it now
    return handleCompositionStart(state, event);
  }

  // Don't insert text during composition - just track it
  // The actual text will be inserted on compositionend
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        ...state.ui.composition,
        text: event.data || "",
      },
    },
  };
}

function handleCompositionEnd(
  state: EditorState,
  event: CompositionEvent,
  viewport: ViewportState,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  // If editor is not focused, ignore composition
  if (!state.view.isFocused) {
    return state;
  }

  // Insert the final composed text
  const composedText = event.data || "";

  if (composedText && state.document.cursor) {
    // Insert the composed text at the cursor position
    state = insertText(recordUndo(state), composedText);

    // Scroll to make cursor visible
    if (state.document.cursor && updateViewportCallback) {
      const newScrollY = scrollToMakeCursorVisible(
        state.document.cursor.position,
        state,
        viewport
      );
      if (newScrollY !== null) {
        updateViewportCallback({ scrollY: newScrollY });
      }
    }
  }

  // Clear composition state
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: null,
    },
  };
}
