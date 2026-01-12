import { isTextualBlock } from "@/deserializer/loadPage";
import type { Operation, HLC } from "../sync";
import {
  toggleTodoChecked,
  selectLineAtPosition,
  selectWordAtPosition,
} from "../actions/commands";
import { DOUBLE_CLICK_TIME, EDGE_SCROLL_THRESHOLD } from "../constants";
import {
  autoScrollState,
  clearScrollPress,
  scrollbarPressState
} from "./eventsState";
import {
  getImageBlockAtPoint,
  startImageDrag,
  getLineBlockAtPoint,
  isWithinClickDistance,
  updateImageDrag,
  isTouchDevice,
  getDragHandleAtPoint,
  endImageDrag,
  cancelImageDrag,
} from "./eventUtils";
import { getCurrentFontFamily, getFontMetrics } from "../fonts";
import { getBlockHeight, imageCache } from "../renderer";
import { getTextDirection } from "../rtl";
import {
  isPointInScrollbar,
  isPointInThumb,
  startScrollbarDrag,
  updateScrollFromTrackClick,
  updateScrollFromThumbDrag,
  updateScrollbarHover,
  endScrollbarDrag,
  updateScrollFromWheel,
} from "../scrollbar";
import {
  getTextPositionFromViewport,
  getLinkAtPosition,
  getCursorCoordinates,
} from "../selection";
import {
  getBlockTextContent,
  closeSlashCommand,
  closeActiveMenu,
  updateFocus,
  clearAutoCreatedParagraph,
  setActiveMenu,
  updateCursor,
  updateSelectionFocus,
  updateMode,
  clearSelection,
  startSelection,
} from "../state";
import { getEditorStyles, getTextStyle } from "../styles";
import { stopAutoScroll, startAutoScroll } from "./touchEvents";
import type { EditorState, ViewportState, MouseEvent } from "../types";

// Helper function to detect and handle checkbox clicks for todo list items

export function handleTodoCheckboxClick(
  state: EditorState,
  canvasX: number,
  canvasY: number,
  viewport: ViewportState
): { state: EditorState; ops: Operation[] } | null {
  const styles = getEditorStyles();
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  // Iterate through blocks to find which one was clicked
  // Break early once we pass the visible area
  for (
    let blockIndex = 0;
    blockIndex < state.document.page.blocks.length;
    blockIndex++
  ) {
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
        const blockText = isTextualBlock(block)
          ? getBlockTextContent(block)
          : "";
        const isRTL = getTextDirection(blockText) === "rtl";

        // Calculate marker width to match rendering logic
        const markerWidth =
          styles.list.numbered.minWidth + styles.list.marker.textGap;
        const adjustedMaxWidth = maxWidth - indentOffset - markerWidth;

        // Position checkbox based on text direction
        let checkboxX: number;
        if (isRTL) {
          // RTL: checkbox is in marker area on the right side
          // markerX = paddingLeft + indentOffset + adjustedMaxWidth
          checkboxX =
            styles.canvas.paddingLeft + indentOffset + adjustedMaxWidth + 2;
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
          const result = toggleTodoChecked(state, blockIndex, state.crdt);
          return { state: result.state, ops: result.ops };
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
export function handleMouseDown(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  containerRect: { left: number; top: number },
  visibility: { start: number; end: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  stopAutoScroll();

  // Ignore right-click - it will be handled by contextmenu event
  // This prevents clearing selection when right-clicking
  if (event.button === 2) {
    return { state, ops };
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
        // Open the link in a new tab using native bridge on mobile apps
        if (window.IOSBridge?.postMessage) {
          window.IOSBridge.postMessage({
            action: "open-url",
            url: linkData.url,
          });
        } else if (window.AndroidBridge?.openUrl) {
          window.AndroidBridge.openUrl(linkData.url);
        } else {
          window.open(linkData.url, "_blank", "noopener,noreferrer");
        }
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
        return { state, ops };
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
        state: {
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
        },
        ops,
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
        state: {
          ...state,
          view: {
            ...state.view,
            scrollbar: {
              ...state.view.scrollbar,
              lastInteraction: Date.now(),
            },
          },
        },
        ops,
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
        return { state: dragState, ops };
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
          return { state, ops };
        }

        // Open the image upload menu at the click position
        return {
          state: setActiveMenu(state, {
            type: "imageUpload",
            blockIndex: imageBlock.blockIndex,
            x: canvasX,
            y: canvasY,
          }),
          ops,
        };
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

      return { state: updateMode(newState, "edit"), ops };
    }
  }

  // Check if clicking on a line block
  const lineBlock = getLineBlockAtPoint(canvasX, canvasY, state, viewport);
  if (lineBlock) {
    const block = state.document.page.blocks[lineBlock.blockIndex];
    if (block.type === "line") {
      // Select the line block (same as image block behavior)
      const linePosition = { blockIndex: lineBlock.blockIndex, textIndex: 0 };

      let newState = updateCursor(state, linePosition);

      // Create a selection that spans the entire line block
      if (event.shiftKey && state.document.selection) {
        // Extend selection to include this line block
        newState = updateSelectionFocus(newState, linePosition);
      } else {
        // Select just this line block (match image block selection behavior)
        newState = {
          ...newState,
          document: {
            ...newState.document,
            selection: {
              anchor: linePosition,
              focus: linePosition,
              isForward: true,
              isCollapsed: false,
              lastUpdate: Date.now(),
            },
          },
        };
      }

      return { state: updateMode(newState, "edit"), ops };
    }
  }

  // Check if we have a visual block (image/line) selected but clicked outside its container
  if (
    !imageBlock &&
    !lineBlock &&
    state.document.selection &&
    !state.document.selection.isCollapsed
  ) {
    const { anchor, focus } = state.document.selection;
    // Check if this is a visual block selection (anchor and focus at same position on an image/line block)
    if (
      anchor.blockIndex === focus.blockIndex &&
      anchor.textIndex === focus.textIndex
    ) {
      const selectedBlock = state.document.page.blocks[anchor.blockIndex];
      if (
        selectedBlock &&
        (selectedBlock.type === "image" || selectedBlock.type === "line")
      ) {
        // We have a visual block selected, but clicked outside it - clear the selection
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
    return { state: updateMode(clearedState, "edit"), ops };
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
      return { state: updateMode(newState, "edit"), ops };
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
      return { state: updateMode(clearedState, "edit"), ops };
    }
    // Keep active selection and just switch to edit mode
    return { state: updateMode(state, "edit"), ops };
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

      return { state: updateMode(newState, "edit"), ops };
    }
  }

  // Track click for double/triple click detection
  const currentTime = Date.now();
  const currentPosition = { x: canvasX, y: canvasY };

  let isMultiClick = false;
  let clickCount = 1;

  if (
    state.view.clickTracker.lastClickPosition &&
    currentTime - state.view.clickTracker.lastClickTime <= DOUBLE_CLICK_TIME &&
    isWithinClickDistance(
      currentPosition,
      state.view.clickTracker.lastClickPosition
    )
  ) {
    clickCount = state.view.clickTracker.count + 1;
    isMultiClick = true;
  }

  // Update state with new click tracker info
  state = {
    ...state,
    view: {
      ...state.view,
      clickTracker: {
        count: clickCount,
        lastClickTime: currentTime,
        lastClickPosition: currentPosition,
      },
    },
  };

  // Handle triple-click: always select line (even inside selection)
  if (isMultiClick && clickCount >= 3) {
    return { state: selectLineAtPosition(state, position), ops };
  }

  // Handle double-click: select word
  if (isMultiClick && clickCount === 2) {
    return { state: selectWordAtPosition(state, position), ops };
  }

  // Set cursor position
  let newState = updateCursor(state, position);

  // If shift is held, extend selection; otherwise start new selection
  if (event.shiftKey && state.document.selection) {
    newState = updateSelectionFocus(newState, position);
  } else {
    newState = startSelection(newState, position);
    newState = updateMode(newState, "select");
  }

  return { state: newState, ops };
}
export function handleMouseMove(
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
    const { blockIndex, handle } = state.ui.imageDrag;
    const block = state.document.page.blocks[blockIndex];

    // Check if we should allow auto-scroll for bottom edge
    // Only block scrolling down if: bottom handle + near bottom edge + image at max height
    let shouldBlockBottomScroll = false;
    const objectFit =
      block.type === "image" ? block.objectFit ?? "cover" : "cover";
    if (
      handle === "bottom" &&
      objectFit === "cover" &&
      block.type === "image" &&
      block.url
    ) {
      const cachedImage = imageCache.get(block.url);
      if (cachedImage && cachedImage.complete) {
        const imgAspectRatio =
          cachedImage.naturalWidth / cachedImage.naturalHeight;
        const containerWidth =
          typeof block.width === "number" ? block.width : viewport.width;
        const maxHeightForRatio = containerWidth / imgAspectRatio;
        // Use startHeight + delta to get current effective height
        const currentHeight =
          state.ui.imageDrag.startHeight +
          (canvasY - state.ui.imageDrag.startY);
        const isAtMaxHeight = currentHeight >= maxHeightForRatio - 1;
        const isNearBottomEdge =
          canvasY > viewport.height - EDGE_SCROLL_THRESHOLD ||
          canvasY > viewport.height;
        shouldBlockBottomScroll = isAtMaxHeight && isNearBottomEdge;
      }
    }

    // Check for edge scrolling during image drag
    const isNearTopEdge = canvasY < EDGE_SCROLL_THRESHOLD || canvasY < 0;
    const isNearBottomEdge =
      canvasY > viewport.height - EDGE_SCROLL_THRESHOLD ||
      canvasY > viewport.height;
    const isNearEdge = isNearTopEdge || isNearBottomEdge;

    // Allow scroll if near edge, but block bottom scroll if image is at max
    if (isNearEdge && !(shouldBlockBottomScroll && isNearBottomEdge)) {
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
              textIndex: linkData.startIndex,
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
                startIndex: linkData.startIndex,
                endIndex: linkData.endIndex,
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
export function handleMouseUp(
  state: EditorState,
  _viewport: ViewportState,
  _event: MouseEvent,
  _visibility: { start: number; end: number },
  crdtContext: { pageId: string; idGen: () => string; clock: () => HLC }
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  stopAutoScroll();

  // Clean up scrollbar press state
  if (scrollbarPressState) {
    clearScrollPress();
  }

  if (state.view.scrollbar.isDragging) {
    return {
      state: {
        ...state,
        view: {
          ...state.view,
          scrollbar: endScrollbarDrag(state.view.scrollbar),
        },
      },
      ops,
    };
  }

  // End image drag if active
  if (state.ui.imageDrag) {
    const result = endImageDrag(state, crdtContext);
    return result;
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
    return { state: updateMode(newState, "edit"), ops };
  }

  return { state, ops };
}
export function handlePointerCancel(state: EditorState): EditorState {
  stopAutoScroll();

  // Clean up scrollbar press state
  if (scrollbarPressState) {
    clearScrollPress();
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
export function handleWheel(
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
