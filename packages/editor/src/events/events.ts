import {
  CONTEXT_MENU_DURATION,
  CURSOR_DRAG_ACTIVATION_DELAY,
  EDGE_SCROLL_THRESHOLD,
} from "../constants";
import { imageCache } from "../rendering/renderer";
import {
  applyMomentum,
  updateScrollbarFadeOpacity,
} from "../rendering/scrollbar";
import {
  getCursorDocumentCoords,
  getTextPositionFromViewport,
} from "../selection";
import { updateCursor } from "../selection";
import { startSelection, updateSelectionFocus } from "../selection";
import type { EditorState, MouseEvent, ViewportState } from "../state-types";
import type { Operation } from "../state-types";
import { closeActiveMenu, openContextMenu, updateMode } from "../state-utils";
import { getEditorStyles, getTextStyle } from "../styles";
import { isTextualBlock } from "../sync/block-registry";
import { applyEdgeScroll } from "./autoScroll";
import {
  handleCompositionEnd,
  handleCompositionStart,
  handleCompositionUpdate,
} from "./compositionEvents";
import { isTouchDevice, updateImageDrag } from "./eventUtils";
import { handlePaste } from "./genericEvents";
import { triggerHapticFeedback } from "./haptics";
import { handleContextMenu, handleKeyDown } from "./keysEvents";
import {
  handleMouseDown,
  handleMouseMove,
  handleMouseUp,
  handlePointerCancel,
  handleWheel,
} from "./mouseEvents";
import { tickPendingCapture } from "./regions";
import { type InteractionSession, stopAutoScroll } from "./session";
import {
  handleTouchCancel,
  handleTouchEnd,
  handleTouchMove,
  handleTouchStart,
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
  const styles = getEditorStyles(state);
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
  session: InteractionSession,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  clipboardData?: { html: string; text: string; imageFile: File | null } | null,
): { state: EditorState; ops: Operation[]; pastedImageBlockIndex?: number } {
  // Collect operations from commands
  let collectedOps: Operation[] = [];
  let pastedImageBlockIndex: number | undefined;
  // Promote a pending hold-to-drag capture once its hold time has elapsed
  // (e.g. iOS-style scrollbar hold). Runs every frame, independent of events.
  const promoted = tickPendingCapture({
    state,
    viewport,
    documentHeight,
    session,
    updateViewport: updateViewportCallback,
  });
  if (promoted) {
    state = promoted;
  }

  // Check for cursor drag activation (200ms, before the 600ms long-press)
  if (
    session.touch &&
    session.touch.isTouchingCursor &&
    !session.touch.isCursorDrag &&
    !session.touch.isLongPress &&
    !session.touch.hasMoved &&
    !session.captured &&
    !session.pendingCapture &&
    !state.ui.imageDrag &&
    !state.ui.selectionHandleDrag
  ) {
    const timeSinceStart = Date.now() - session.touch.startTime;
    if (timeSinceStart >= CURSOR_DRAG_ACTIVATION_DELAY) {
      session.touch.isCursorDrag = true;
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
            touchX: session.touch.currentTouchX,
            touchY: session.touch.currentTouchY,
            cursorX: cursorCoords
              ? cursorCoords.x
              : session.touch.currentTouchX,
            cursorY: cursorCoords
              ? cursorCoords.y - viewport.scrollY
              : session.touch.currentTouchY,
            touchRadiusY: session.touch.touchRadiusY,
            lineHeight: getBlockLineHeight(
              state,
              state.document.cursor?.position?.blockIndex,
            ),
            lastPosition: state.document.cursor?.position ?? null,
          },
        },
      };
    }
  }

  // Check for long press trigger (independent of touchmove events)
  if (
    session.touch &&
    !session.touch.isLongPress &&
    !session.touch.isCursorDrag && // Don't trigger long press if we're in cursor drag mode
    !session.touch.hasMoved &&
    !session.captured && // Not while a region drag owns the pointer
    !session.pendingCapture && // ... or is waiting on its hold timer
    !state.ui.imageDrag && // Don't open context menu if we're dragging an image
    !state.ui.selectionHandleDrag // Don't open context menu if we're dragging a selection handle
  ) {
    const timeSinceStart = Date.now() - session.touch.startTime;
    if (timeSinceStart >= CONTEXT_MENU_DURATION) {
      session.touch.isLongPress = true;

      const position = getTextPositionFromViewport(
        session.touch.currentTouchX,
        session.touch.currentTouchY,
        state,
        viewport,
      );

      // Long press behavior depends on whether touching selected text
      if (session.touch.isTouchingSelection) {
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
          session.touch.currentTouchX,
          session.touch.currentTouchY,
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
  if (session.autoScroll.isActive && session.touch?.isLongPress) {
    // Current touch coordinates are already adjusted relative to container in handleTouchMove
    const touch = {
      clientY: session.touch.currentTouchY,
      clientX: session.touch.currentTouchX,
    };

    applyEdgeScroll(
      touch.clientY,
      session,
      viewport,
      documentHeight,
      true,
      updateViewportCallback,
    );

    const position = getTextPositionFromViewport(
      touch.clientX,
      touch.clientY,
      state,
      viewport,
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
  } else if (session.autoScroll.isActive && state.ui.mode === "select") {
    // Apply auto-scroll for mouse selection
    applyEdgeScroll(
      session.autoScroll.lastPointerY,
      session,
      viewport,
      documentHeight,
      true,
      updateViewportCallback,
    );

    // Update selection based on new scroll position
    const position = getTextPositionFromViewport(
      session.autoScroll.lastPointerX,
      session.autoScroll.lastPointerY,
      state,
      viewport,
    );

    if (position) {
      state = updateSelectionFocus(state, position);
      state = updateCursor(state, position);
    }
  } else if (session.autoScroll.isActive && state.ui.selectionHandleDrag) {
    // Apply auto-scroll for selection handle drag (touch)
    applyEdgeScroll(
      session.autoScroll.lastPointerY,
      session,
      viewport,
      documentHeight,
      true,
      updateViewportCallback,
    );

    // Update selection based on new scroll position
    const position = getTextPositionFromViewport(
      session.autoScroll.lastPointerX,
      session.autoScroll.lastPointerY,
      state,
      viewport,
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
  } else if (session.autoScroll.isActive && session.touch?.isCursorDrag) {
    // Apply auto-scroll for cursor drag (touch)
    applyEdgeScroll(
      session.autoScroll.lastPointerY,
      session,
      viewport,
      documentHeight,
      true,
      updateViewportCallback,
    );

    // Update cursor position based on new scroll position
    const position = getTextPositionFromViewport(
      session.autoScroll.lastPointerX,
      session.autoScroll.lastPointerY,
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
            touchX: session.touch.currentTouchX,
            touchY: session.touch.currentTouchY,
            cursorX: cursorCoords
              ? cursorCoords.x
              : session.touch.currentTouchX,
            cursorY: cursorCoords
              ? cursorCoords.y - viewport.scrollY
              : session.touch.currentTouchY,
            touchRadiusY: session.touch.touchRadiusY,
            lineHeight: getBlockLineHeight(state, position.blockIndex),
            lastPosition: position,
          },
        },
      };
    }
  } else if (session.autoScroll.isActive && state.ui.imageDrag) {
    // Apply auto-scroll for image drag (constant speed, no acceleration)
    const { blockIndex, handle } = state.ui.imageDrag;
    const block = state.document.page.blocks[blockIndex];
    if (!block || block.deleted) return { state, ops: [] };
    const cursorY = session.autoScroll.lastPointerY;

    // Check if we should block scrolling down (bottom handle + near bottom + at max height)
    let shouldBlockBottomScroll = false;
    const objectFit =
      block.type === "image" ? (block.objectFit ?? "cover") : "cover";
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
      stopAutoScroll(session);
    } else {
      // Constant speed (no acceleration for image drag)
      const newScrollY = applyEdgeScroll(
        cursorY,
        session,
        viewport,
        documentHeight,
        false,
        updateViewportCallback,
      );

      if (newScrollY !== null) {
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
          session.autoScroll.lastPointerX,
          session.autoScroll.lastPointerY,
        );
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
      viewport.height,
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
          containerRect,
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
          session,
          updateViewportCallback,
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
          session,
          updateViewportCallback,
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
          visibility,
          documentHeight,
          session,
        );
        state = mouseUpResult.state;
        collectedOps.push(...mouseUpResult.ops);
        break;
      case "pointercancel":
        // Only cancel on pointercancel (not on leave)
        state = handlePointerCancel(state, viewport, documentHeight, session);
        break;
      case "keydown":
        const keyResult = handleKeyDown(
          state,
          viewport,
          event,
          updateViewportCallback,
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
          clipboardData,
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
          updateViewportCallback,
        );
        break;
      case "touchstart":
        state = handleTouchStart(
          state,
          viewport,
          event as TouchEvent,
          containerRect,
          documentHeight,
          session,
        );
        break;
      case "touchmove":
        state = handleTouchMove(
          state,
          viewport,
          event as TouchEvent,
          containerRect,
          documentHeight,
          session,
          updateViewportCallback,
        );
        break;
      case "touchend":
        const touchEndResult = handleTouchEnd(
          state,
          viewport,
          event as TouchEvent,
          containerRect,
          documentHeight,
          session,
        );
        state = touchEndResult.state;
        collectedOps.push(...touchEndResult.ops);
        break;
      case "touchcancel":
        // Cancel touch interaction
        state = handleTouchCancel(state, viewport, documentHeight, session);
        break;
      case "compositionstart":
        const compStartResult = handleCompositionStart(
          state,
          event as CompositionEvent,
        );
        state = compStartResult.state;
        collectedOps.push(...compStartResult.ops);
        break;
      case "compositionupdate":
        const compUpdateResult = handleCompositionUpdate(
          state,
          event as CompositionEvent,
        );
        state = compUpdateResult.state;
        collectedOps.push(...compUpdateResult.ops);
        break;
      case "compositionend":
        const compResult = handleCompositionEnd(
          state,
          event as CompositionEvent,
          viewport,
          updateViewportCallback,
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
