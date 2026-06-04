import {
  CONTEXT_MENU_DURATION,
  CURSOR_DRAG_ACTIVATION_DELAY,
  EDGE_SCROLL_ACCELERATION_RATE,
  EDGE_SCROLL_MAX_SPEED,
  EDGE_SCROLL_SPEED,
  EDGE_SCROLL_THRESHOLD,
  SCROLLBAR_HOLD_DURATION,
} from "../constants";
import { imageCache } from "../renderer";
import {
  applyMomentum,
  startScrollbarDrag,
  updateScrollbarFadeOpacity,
} from "../scrollbar";
import { isTextualBlock } from "@/deserializer/loadPage";
import { getCursorDocumentCoords, getTextPositionFromViewport } from "../selection";
import {
  closeActiveMenu,
  openContextMenu,
  startSelection,
  updateCursor,
  updateMode,
  updateSelectionFocus,
} from "../state";
import type { Operation } from "../sync/types";
import { getEditorStyles, getTextStyle } from "../styles";
import type { EditorState, MouseEvent, ViewportState } from "../types";
import {
  handleCompositionEnd,
  handleCompositionStart,
  handleCompositionUpdate,
} from "./compositionEvents";
import { autoScrollState, scrollbarPressState } from "./eventsState";
import { isTouchDevice, updateImageDrag } from "./eventUtils";
import { handlePaste } from "./genericEvents";
import { handleContextMenu, handleKeyDown } from "./keysEvents";
import {
  handleMouseDown,
  handleMouseMove,
  handleMouseUp,
  handlePointerCancel,
  handleWheel,
} from "./mouseEvents";
import {
  handleTouchCancel,
  handleTouchEnd,
  handleTouchMove,
  handleTouchStart,
  stopAutoScroll,
  touchState,
  triggerHapticFeedback,
} from "./touchEvents";

/** Get rendered line height (px) for the block at the given index. */
function getBlockLineHeight(
  state: EditorState,
  blockIndex: number | undefined,
): number {
  if (blockIndex == null) return 16 * 1.6;
  const block = state.document.page.blocks[blockIndex];
  if (!block) return 16 * 1.6;
  if (!isTextualBlock(block)) return 16 * 1.6;
  const styles = getEditorStyles();
  const textStyle = getTextStyle(styles, block.type);
  return textStyle.fontSize * textStyle.lineHeight;
}

export function handleEvents(
  state: EditorState,
  viewport: ViewportState,
  visibility: { start: number; end: number },
  events: Event[],
  documentHeight: number,
  containerRect: { left: number; top: number },
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  clipboardData?: { html: string; text: string; imageFile: File | null } | null
): { state: EditorState; ops: Operation[]; pastedImageBlockIndex?: number } {
  // Collect operations from commands
  let collectedOps: Operation[] = [];
  let pastedImageBlockIndex: number | undefined;
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

  // Check for cursor drag activation (200ms, before the 600ms long-press)
  if (
    touchState &&
    touchState.isTouchingCursor &&
    !touchState.isCursorDrag &&
    !touchState.isLongPress &&
    !touchState.hasMoved &&
    !touchState.isScrollbarDrag &&
    !state.ui.imageDrag &&
    !state.ui.selectionHandleDrag
  ) {
    const timeSinceStart = Date.now() - touchState.startTime;
    if (timeSinceStart >= CURSOR_DRAG_ACTIVATION_DELAY) {
      touchState.isCursorDrag = true;
      triggerHapticFeedback("light");

      // Get cursor coordinates for initial magnifier position
      const cursorCoords = state.document.cursor
        ? getCursorDocumentCoords(
            state.document.cursor.position,
            state,
            viewport,
          )
        : null;

      state = {
        ...state,
        ui: {
          ...state.ui,
          cursorDrag: {
            isActive: true,
            touchX: touchState.currentTouchX,
            touchY: touchState.currentTouchY,
            cursorX: cursorCoords ? cursorCoords.x : touchState.currentTouchX,
            cursorY: cursorCoords
              ? cursorCoords.y - viewport.scrollY
              : touchState.currentTouchY,
            touchRadiusY: touchState.touchRadiusY,
            lineHeight: getBlockLineHeight(state, state.document.cursor?.position?.blockIndex),
            lastPosition: state.document.cursor?.position ?? null,
          },
        },
      };
    }
  }

  // Check for long press trigger (independent of touchmove events)
  if (
    touchState &&
    !touchState.isLongPress &&
    !touchState.isCursorDrag && // Don't trigger long press if we're in cursor drag mode
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
        viewport
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
      viewport
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
      viewport
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
      viewport
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
  } else if (autoScrollState.isActive && touchState?.isCursorDrag) {
    // Apply auto-scroll for cursor drag (touch)
    const elapsedTime = Date.now() - autoScrollState.startTime;
    const timeBasedMultiplier = Math.min(
      Math.pow(EDGE_SCROLL_ACCELERATION_RATE, elapsedTime / 1000),
      EDGE_SCROLL_MAX_SPEED / EDGE_SCROLL_SPEED,
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
        Math.min(maxScroll, viewport.scrollY + autoScrollDelta),
      );

      if (newScrollY !== viewport.scrollY) {
        updateViewportCallback({ scrollY: newScrollY });
      }
    }

    // Update cursor position based on new scroll position
    const position = getTextPositionFromViewport(
      autoScrollState.lastMouseX,
      autoScrollState.lastMouseY,
      state,
      viewport,
    );

    if (position) {
      state = updateCursor(state, position);

      const cursorCoords = getCursorDocumentCoords(position, state, viewport);
      state = {
        ...state,
        ui: {
          ...state.ui,
          cursorDrag: {
            isActive: true,
            touchX: touchState.currentTouchX,
            touchY: touchState.currentTouchY,
            cursorX: cursorCoords
              ? cursorCoords.x
              : touchState.currentTouchX,
            cursorY: cursorCoords
              ? cursorCoords.y - viewport.scrollY
              : touchState.currentTouchY,
            touchRadiusY: touchState.touchRadiusY,
            lineHeight: getBlockLineHeight(state, position.blockIndex),
            lastPosition: position,
          },
        },
      };
    }
  } else if (autoScrollState.isActive && state.ui.imageDrag) {
    // Apply auto-scroll for image drag (constant speed, no acceleration)
    const { blockIndex, handle } = state.ui.imageDrag;
    const block = state.document.page.blocks[blockIndex];
    if (!block || block.deleted) return { state, ops: [] };
    const cursorY = autoScrollState.lastMouseY;

    // Check if we should block scrolling down (bottom handle + near bottom + at max height)
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
          (cursorY - state.ui.imageDrag.startY);
        const isAtMaxHeight = currentHeight >= maxHeightForRatio - 1;
        const isNearBottomEdge =
          cursorY > viewport.height - EDGE_SCROLL_THRESHOLD ||
          cursorY > viewport.height;
        shouldBlockBottomScroll = isAtMaxHeight && isNearBottomEdge;
      }
    }

    // Stop auto-scroll if we should block bottom scroll
    if (shouldBlockBottomScroll) {
      stopAutoScroll();
    } else {
      let autoScrollDelta = 0;

      // Use constant speed (no acceleration for image drag)
      if (cursorY < 0) {
        autoScrollDelta = -EDGE_SCROLL_SPEED;
      } else if (cursorY < EDGE_SCROLL_THRESHOLD) {
        const proximity = 1 - cursorY / EDGE_SCROLL_THRESHOLD;
        autoScrollDelta = -EDGE_SCROLL_SPEED * proximity;
      } else if (cursorY > viewport.height) {
        autoScrollDelta = EDGE_SCROLL_SPEED;
      } else if (cursorY > viewport.height - EDGE_SCROLL_THRESHOLD) {
        const proximity =
          (cursorY - (viewport.height - EDGE_SCROLL_THRESHOLD)) /
          EDGE_SCROLL_THRESHOLD;
        autoScrollDelta = EDGE_SCROLL_SPEED * proximity;
      }

      if (autoScrollDelta !== 0 && updateViewportCallback) {
        const maxScroll = documentHeight - viewport.height;
        const newScrollY = Math.max(
          0,
          Math.min(maxScroll, viewport.scrollY + autoScrollDelta)
        );

        if (newScrollY !== viewport.scrollY) {
          updateViewportCallback({ scrollY: newScrollY });

          // Continue updating image drag as we scroll
          // Adjust startY to account for the scroll so the image continues to resize
          const scrollAdjustment = newScrollY - viewport.scrollY;
          state = {
            ...state,
            ui: {
              ...state.ui,
              imageDrag: {
                ...state.ui.imageDrag!,
                startY: state.ui.imageDrag!.startY - scrollAdjustment,
              },
            },
          };
          state = updateImageDrag(
            state,
            viewport,
            autoScrollState.lastMouseX,
            autoScrollState.lastMouseY
          );
        }
      }
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
        inlineMathHover: null,
        hoveredMathBlockIndex: null,
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

    return { state, ops: collectedOps };
  }

  while (events.length > 0) {
    const event = events[0];
    switch (event.type) {
      case "contextmenu":
        state = handleContextMenu(
          state,
          viewport,
          event as unknown as MouseEvent,
          containerRect
        );
        break;
      case "mousedown":
        if (isTouchDevice()) {
          break;
        }
        const mouseDownResult = handleMouseDown(
          state,
          viewport,
          event as unknown as MouseEvent,
          containerRect,
          documentHeight,
          updateViewportCallback
        );
        state = mouseDownResult.state;
        collectedOps.push(...mouseDownResult.ops);
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
          documentHeight,
          updateViewportCallback
        );
        break;
      case "mouseup":
        if (isTouchDevice()) {
          break;
        }
        const mouseUpResult = handleMouseUp(
          state,
          viewport,
          event as unknown as MouseEvent,
          visibility
        );
        state = mouseUpResult.state;
        collectedOps.push(...mouseUpResult.ops);
        break;
      case "pointercancel":
        // Only cancel on pointercancel (not on leave)
        state = handlePointerCancel(state);
        break;
      case "keydown":
        const keyResult = handleKeyDown(
          state,
          viewport,
          event,
          updateViewportCallback
        );
        state = keyResult.state;
        collectedOps.push(...keyResult.ops);
        break;
      case "paste":
        const pasteResult = handlePaste(
          state,
          event as ClipboardEvent,
          viewport,
          updateViewportCallback,
          clipboardData
        );
        state = pasteResult.state;
        collectedOps.push(...pasteResult.ops);
        if (pasteResult.pastedImageBlockIndex !== undefined) {
          pastedImageBlockIndex = pasteResult.pastedImageBlockIndex;
        }
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
        const touchEndResult = handleTouchEnd(
          state,
          viewport,
          event as TouchEvent,
          containerRect
        );
        state = touchEndResult.state;
        collectedOps.push(...touchEndResult.ops);
        break;
      case "touchcancel":
        // Cancel touch interaction
        state = handleTouchCancel(state);
        break;
      case "compositionstart":
        const compStartResult = handleCompositionStart(
          state,
          event as CompositionEvent
        );
        state = compStartResult.state;
        collectedOps.push(...compStartResult.ops);
        break;
      case "compositionupdate":
        const compUpdateResult = handleCompositionUpdate(
          state,
          event as CompositionEvent
        );
        state = compUpdateResult.state;
        collectedOps.push(...compUpdateResult.ops);
        break;
      case "compositionend":
        const compResult = handleCompositionEnd(
          state,
          event as CompositionEvent,
          viewport,
          updateViewportCallback
        );
        state = compResult.state;
        collectedOps.push(...compResult.ops);
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

  return { state, ops: collectedOps, pastedImageBlockIndex };
}
