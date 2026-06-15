import { OPEN_LINK } from "../action-bus";
import {
  CLEAR_SELECTION_IN_PADDING,
  CLEAR_VISUAL_BLOCK_SELECTION,
  OPEN_BLOCK_OVERLAY,
  OPEN_INLINE_MATH_OVERLAY,
  PLACE_CURSOR_AT_POINT,
  PLACE_CURSOR_IN_SIDE_PADDING,
  SELECT_LINE_AT_POINT,
  SELECT_VISUAL_BLOCK,
  SELECT_WORD_AT_POINT,
  SET_IMAGE_HOVER,
  SET_INLINE_MATH_HOVER,
  SET_MATH_BLOCK_HOVER,
} from "../actions/mouse-actions";
import { DOUBLE_CLICK_TIME, EDGE_SCROLL_THRESHOLD } from "../constants";
import { getInlineMathAtPosition } from "../inline-math";
import { getDragHandleAtPoint } from "../rendering/nodes";
import {
  getScrollbarStyles,
  isPointInThumb,
  updateScrollbarHover,
  updateScrollFromWheel,
} from "../rendering/scrollbar";
import {
  getCursorDocumentCoords,
  getLinkAtPosition,
  getTextPositionFromViewport,
} from "../selection";
import { updateFocus } from "../selection";
import { updateCursor } from "../selection";
import { updateSelectionFocus } from "../selection";
import type { EditorState, MouseEvent, ViewportState } from "../state-types";
import {
  clearAutoCreatedParagraph,
  closeActiveMenu,
  closeSlashAction,
  setLinkHover,
  updateMode,
} from "../state-utils";
import { getEditorStyles } from "../styles";
import { isTextualBlock } from "../sync/block-registry";
import type { Operation } from "../sync/sync";
import { hitTestAllRegions } from "./blockRegions";
import {
  getAtomicBlockAtPoint,
  isTouchDevice,
  isWithinClickDistance,
} from "./eventUtils";
import {
  type InteractionSession,
  startAutoScroll,
  stopAutoScroll,
} from "./interaction-session";
import {
  beginRegionInteraction,
  type RegionCtx,
  routeCapturedCancel,
  routeCapturedEnd,
  routeCapturedMove,
} from "./regions";

export function handleMouseDown(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  containerRect: { left: number; top: number },
  documentHeight: number,
  session: InteractionSession,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  stopAutoScroll(session);

  // Ignore right-click - it will be handled by contextmenu event
  // This prevents clearing selection when right-clicking
  if (event.button === 2) {
    return { state, ops };
  }

  // Close slash action menu on mouse click
  if (state.ui.activeMenu.type === "slashAction") {
    state = closeSlashAction(state);
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

  // Interactive regions (scrollbar, peer indicators, checkbox, image resize
  // handles) — highest-priority hit wins. Drags capture the pointer; taps
  // act immediately on mouse-down.
  const regionCtx: RegionCtx = {
    state,
    viewport,
    documentHeight,
    session,
    updateViewport: updateViewportCallback,
  };
  const point = { x: canvasX, y: canvasY };
  const claim = hitTestAllRegions(point, "mouse", regionCtx);
  if (claim) {
    const begin = beginRegionInteraction(claim, point, "mouse", regionCtx);
    if (begin && begin !== "pending") {
      return { state: begin.state, ops: begin.ops ?? [] };
    }
  }

  // Check for Ctrl/Action+Click on link to open it
  const isCtrlOrCmd = event.ctrlKey || event.metaKey;
  if (isCtrlOrCmd) {
    const position = getTextPositionFromViewport(
      canvasX,
      canvasY,
      state,
      viewport,
    );

    if (position) {
      const linkData = getLinkAtPosition(position, state);
      if (linkData) {
        // Activate the link as a action: the editor's default opens it in a
        // new tab; a native shell can override OPEN_LINK to route it natively.
        state.actionBus.dispatch(OPEN_LINK, { url: linkData.url });
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

  // Check if clicking on an image cover block (including placeholders)
  const imageBlock = getAtomicBlockAtPoint(
    canvasX,
    canvasY,
    state,
    viewport,
    "image",
  );
  if (imageBlock) {
    const block = state.document.page.blocks[imageBlock.blockIndex];
    if (!block || block.deleted) return { state: state, ops };
    if (block.type === "image") {
      // In readonly mode, don't allow placeholder clicks
      // (resize handle drags are claimed by the image-resize region above)
      if (state.ui.mode !== "readonly") {
        // Ask the node whether activation opens a host overlay (a placeholder
        // image opens its upload popover); the engine relays the host-provided
        // key/data and never names the overlay itself.
        const activation = state.nodes.get(block.type)?.activate?.({
          state,
          block,
          blockIndex: imageBlock.blockIndex,
        });
        if (activation) {
          // Don't reopen if we just closed the overlay for this same block
          if (
            wasMenuOpen &&
            previousMenu.type === "overlay" &&
            previousMenu.blockIndex === imageBlock.blockIndex
          ) {
            // Just keep it closed
            return { state, ops };
          }

          // Open the host overlay at the click position
          return {
            state: state.actionBus.dispatchState(OPEN_BLOCK_OVERLAY, state, {
              overlay: {
                type: "overlay",
                key: activation.key,
                blockIndex: imageBlock.blockIndex,
                x: canvasX,
                y: canvasY,
                data: activation.data,
              },
            }).state,
            ops,
          };
        }
      }
      // If it has an image, select the image block (same as arrow key behavior)
      // Position at the start of the image block (textIndex 0)
      const imagePosition = { blockIndex: imageBlock.blockIndex, textIndex: 0 };
      return {
        state: state.actionBus.dispatchState(SELECT_VISUAL_BLOCK, state, {
          position: imagePosition,
          extend: !!(event.shiftKey && state.document.selection),
        }).state,
        ops,
      };
    }
  }

  // Check if clicking on a line block
  const lineBlock = getAtomicBlockAtPoint(
    canvasX,
    canvasY,
    state,
    viewport,
    "line",
  );
  if (lineBlock) {
    const block = state.document.page.blocks[lineBlock.blockIndex];
    if (!block || block.deleted || block.type !== "line") {
      return { state, ops };
    }
    if (block.type === "line") {
      // Select the line block (same as image block behavior)
      const linePosition = { blockIndex: lineBlock.blockIndex, textIndex: 0 };
      return {
        state: state.actionBus.dispatchState(SELECT_VISUAL_BLOCK, state, {
          position: linePosition,
          extend: !!(event.shiftKey && state.document.selection),
        }).state,
        ops,
      };
    }
  }

  // Check if clicking on a math block
  const mathBlock = getAtomicBlockAtPoint(
    canvasX,
    canvasY,
    state,
    viewport,
    "math",
  );
  if (mathBlock) {
    const block = state.document.page.blocks[mathBlock.blockIndex];
    if (!block || block.deleted || block.type !== "math") {
      return { state, ops };
    }

    if (state.ui.mode !== "readonly") {
      // Ask the node whether activation opens a host overlay (the math editor);
      // the engine relays the host-provided key/data and never names the overlay.
      const activation = state.nodes.get(block.type)?.activate?.({
        state,
        block,
        blockIndex: mathBlock.blockIndex,
      });
      if (activation) {
        // Don't reopen if we just closed the overlay for this same block
        if (
          wasMenuOpen &&
          previousMenu.type === "overlay" &&
          previousMenu.blockIndex === mathBlock.blockIndex
        ) {
          return { state, ops };
        }

        // Open the host overlay at the click position
        return {
          state: state.actionBus.dispatchState(OPEN_BLOCK_OVERLAY, state, {
            overlay: {
              type: "overlay",
              key: activation.key,
              blockIndex: mathBlock.blockIndex,
              x: canvasX,
              y: canvasY,
              data: activation.data,
            },
          }).state,
          ops,
        };
      }
    }

    // In readonly mode (or no activation), just select the block
    const mathPosition = { blockIndex: mathBlock.blockIndex, textIndex: 0 };
    return {
      state: state.actionBus.dispatchState(SELECT_VISUAL_BLOCK, state, {
        position: mathPosition,
        extend: false,
      }).state,
      ops,
    };
  }

  // Check if we have a visual block (image/line/math) selected but clicked outside its container
  if (
    !imageBlock &&
    !lineBlock &&
    !mathBlock &&
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
      if (!selectedBlock || selectedBlock.deleted) return { state, ops };
      if (selectedBlock && !isTextualBlock(selectedBlock)) {
        // We have a visual block selected, but clicked outside it - clear the selection
        state = state.actionBus.dispatchState(
          CLEAR_VISUAL_BLOCK_SELECTION,
          state,
        ).state;
      }
    }
  }

  // Check if clicking in top padding area
  const styles = getEditorStyles(state);
  const isClickInTopPadding =
    canvasY < styles.canvas.paddingTop - viewport.scrollY;

  // If clicking in top padding, clear selection
  if (isClickInTopPadding) {
    return {
      state: state.actionBus.dispatchState(CLEAR_SELECTION_IN_PADDING, state)
        .state,
      ops,
    };
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
    );

    if (paddingPosition) {
      return {
        state: state.actionBus.dispatchState(
          PLACE_CURSOR_IN_SIDE_PADDING,
          state,
          { position: paddingPosition },
        ).state,
        ops,
      };
    }
  }

  const position = getTextPositionFromViewport(
    canvasX,
    canvasY,
    state,
    viewport,
  );

  // Click landed on an inline math chip → open the inline math editor popover
  // instead of placing the cursor inside the LaTeX source.
  if (position && state.ui.mode !== "readonly") {
    const inlineMath = getInlineMathAtPosition(
      position.blockIndex,
      position.textIndex,
      state,
      "inside",
      { x: canvasX, viewport },
    );
    // The inline-math edit overlay is host-defined; the `math` mark owns its key.
    const key = inlineMath
      ? state.marks.get("math")?.editOverlayKey
      : undefined;
    if (inlineMath && key) {
      // Don't reopen if we just closed the popover for this same block
      if (
        wasMenuOpen &&
        previousMenu.type === "overlay" &&
        previousMenu.key === key &&
        previousMenu.blockIndex === position.blockIndex
      ) {
        return { state, ops };
      }

      // Highlight the edited chip while the popover is open (engine-owned hover
      // state; the host overlay reads the range from `data`).
      return {
        state: state.actionBus.dispatchState(OPEN_INLINE_MATH_OVERLAY, state, {
          overlay: {
            type: "overlay",
            key,
            blockIndex: position.blockIndex,
            x: canvasX,
            y: canvasY,
            data: {
              startIndex: inlineMath.startIndex,
              endIndex: inlineMath.endIndex,
              latex: inlineMath.latex,
            },
          },
          hover: {
            blockIndex: position.blockIndex,
            startIndex: inlineMath.startIndex,
            endIndex: inlineMath.endIndex,
          },
        }).state,
        ops,
      };
    }
  }

  // If clicking in padding/outside editor area, preserve active selections
  if (!position) {
    // Only clear selection if it's collapsed or doesn't exist
    if (!state.document.selection || state.document.selection.isCollapsed) {
      return {
        state: state.actionBus.dispatchState(CLEAR_SELECTION_IN_PADDING, state)
          .state,
        ops,
      };
    }
    // Keep active selection and just switch to edit mode
    return { state: updateMode(state, "edit"), ops };
  }

  // If clicking below all blocks, check if last block is an image and select it
  const visibleBlocks = state.view.visibleBlocks;
  const lastVisibleBlockIndex =
    visibleBlocks.length > 0
      ? state.document.page.blocks.findIndex(
          (b) => b.id === visibleBlocks[visibleBlocks.length - 1].id,
        )
      : -1;
  if (
    lastVisibleBlockIndex >= 0 &&
    position.blockIndex === lastVisibleBlockIndex
  ) {
    const lastBlock = state.document.page.blocks[lastVisibleBlockIndex];

    // Calculate if click is below the last block's content
    // Use pre-computed documentHeight instead of iterating through all blocks
    const totalContentHeight = documentHeight + styles.canvas.paddingTop;
    const isClickBelowContent = canvasY > totalContentHeight - viewport.scrollY;

    // If clicking below content and last block is an image, select it
    if (isClickBelowContent && !isTextualBlock(lastBlock)) {
      const imagePosition = { blockIndex: lastVisibleBlockIndex, textIndex: 0 };
      return {
        state: state.actionBus.dispatchState(SELECT_VISUAL_BLOCK, state, {
          position: imagePosition,
          extend: false,
        }).state,
        ops,
      };
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
      state.view.clickTracker.lastClickPosition,
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
    return {
      state: state.actionBus.dispatchState(SELECT_LINE_AT_POINT, state, {
        position,
      }).state,
      ops,
    };
  }

  // Handle double-click: select word
  if (isMultiClick && clickCount === 2) {
    return {
      state: state.actionBus.dispatchState(SELECT_WORD_AT_POINT, state, {
        position,
      }).state,
      ops,
    };
  }

  // Set cursor position. If shift is held, extend selection; otherwise start a
  // new selection and enter select mode (drag-to-select).
  return {
    state: state.actionBus.dispatchState(PLACE_CURSOR_AT_POINT, state, {
      position,
      extend: !!(event.shiftKey && state.document.selection),
    }).state,
    ops,
  };
}
export function handleMouseMove(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  containerRect: { left: number; top: number },
  documentHeight: number,
  session: InteractionSession,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
): EditorState {
  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  // A captured region drag (scrollbar thumb) owns the pointer.
  if (session.captured) {
    const result = routeCapturedMove(
      { x: canvasX, y: canvasY },
      {
        state,
        viewport,
        documentHeight,
        session,
        updateViewport: updateViewportCallback,
      },
    );
    return result ? result.state : state;
  }

  // iOS-style: Only show hover when over the thumb itself
  const isOverScrollbarThumb = isPointInThumb(
    canvasX,
    canvasY,
    viewport,
    documentHeight,
    state.view.scrollbar,
    getScrollbarStyles(state),
  );
  state = {
    ...state,
    view: {
      ...state.view,
      scrollbar: updateScrollbarHover(
        state.view.scrollbar,
        isOverScrollbarThumb,
      ),
    },
  };

  // Region hover — pointer cursor for checkbox / peer indicator
  const hoverClaim = hitTestAllRegions({ x: canvasX, y: canvasY }, "mouse", {
    state,
    viewport,
    documentHeight,
    session,
    updateViewport: updateViewportCallback,
  });
  const isOverCheckbox = hoverClaim?.region.id === "todo-checkbox";
  if (isOverCheckbox !== state.ui.isHoveringCheckbox) {
    state = {
      ...state,
      ui: {
        ...state.ui,
        isHoveringCheckbox: isOverCheckbox,
      },
    };
  }

  const isOverPeerIndicator = hoverClaim?.region.id === "peer-indicator";
  if (isOverPeerIndicator !== state.ui.isHoveringPeerIndicator) {
    state = {
      ...state,
      ui: {
        ...state.ui,
        isHoveringPeerIndicator: isOverPeerIndicator,
      },
    };
  }

  // Check for image hover (desktop only, not in select mode, and not during image drag)
  if (!isTouchDevice() && state.ui.mode !== "select") {
    const imageBlock = getAtomicBlockAtPoint(
      canvasX,
      canvasY,
      state,
      viewport,
      "image",
    );

    if (imageBlock) {
      // Get the block to check its object-fit mode
      const block = state.document.page.blocks[imageBlock.blockIndex];
      if (!block || block.deleted || block.type !== "image") {
        return state;
      }
      const objectFit = block.objectFit ?? "cover";

      // Check if hovering over a drag handle
      const hoveredHandle = getDragHandleAtPoint(
        canvasX,
        canvasY,
        imageBlock.x,
        imageBlock.y,
        imageBlock.width,
        imageBlock.height,
        objectFit,
      );

      // Mouse is over an image block - set imageHover state (not a blocking menu)
      state = state.actionBus.dispatchState(SET_IMAGE_HOVER, state, {
        imageHover: {
          blockIndex: imageBlock.blockIndex,
          x: imageBlock.x,
          y: imageBlock.y,
          width: imageBlock.width,
          height: imageBlock.height,
          hoveredHandle,
        },
      }).state;
    } else {
      // Clear image hover state
      state = state.actionBus.dispatchState(SET_IMAGE_HOVER, state, {
        imageHover: null,
      }).state;
    }

    // Math block hover (full block backdrop)
    const mathBlock = getAtomicBlockAtPoint(
      canvasX,
      canvasY,
      state,
      viewport,
      "math",
    );
    const newMathBlockHover = mathBlock ? mathBlock.blockIndex : null;
    state = state.actionBus.dispatchState(SET_MATH_BLOCK_HOVER, state, {
      blockIndex: newMathBlockHover,
    }).state;

    // Inline math chip hover (per-chip background highlight)
    let newInlineMathHover: typeof state.ui.inlineMathHover = null;
    if (!mathBlock) {
      const hoverPos = getTextPositionFromViewport(
        canvasX,
        canvasY,
        state,
        viewport,
      );
      if (hoverPos) {
        const inlineMath = getInlineMathAtPosition(
          hoverPos.blockIndex,
          hoverPos.textIndex,
          state,
          "inside",
          { x: canvasX, viewport },
        );
        if (inlineMath) {
          newInlineMathHover = {
            blockIndex: hoverPos.blockIndex,
            startIndex: inlineMath.startIndex,
            endIndex: inlineMath.endIndex,
          };
        }
      }
    }
    state = state.actionBus.dispatchState(SET_INLINE_MATH_HOVER, state, {
      hover: newInlineMathHover,
    }).state;
  }

  if (state.ui.mode !== "select") {
    // Check for link hover when not selecting (desktop only)
    // Don't show tooltip if Ctrl/Action key is held (user wants to click to open)
    const isCtrlOrCmd = event.ctrlKey || event.metaKey;

    // If Ctrl/Action is held and we have a link hover showing, clear it
    if (isCtrlOrCmd && state.ui.linkHover) {
      state = setLinkHover(state, null);
      return state;
    }

    // Don't show the link tooltip while a menu is open; clear any stale hover.
    if (state.ui.activeMenu.type !== "none") {
      if (state.ui.linkHover) state = setLinkHover(state, null);
      return state;
    }

    if (!isTouchDevice()) {
      const position = getTextPositionFromViewport(
        canvasX,
        canvasY,
        state,
        viewport,
      );

      let isOverLink = false;

      if (position) {
        const linkData = getLinkAtPosition(position, state);
        if (linkData) {
          isOverLink = true;
          // If Ctrl/Action is held, show pointer cursor but no tooltip
          if (isCtrlOrCmd) {
            state = setLinkHover(state, null);
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
            const linkCoords = getCursorDocumentCoords(
              linkStartPos,
              state,
              viewport,
            );

            if (linkCoords) {
              // Anchor in canvas/container space (the overlay shifts it into
              // viewport space by adding containerRect — do NOT bake it in here,
              // or it gets added twice). `linkCoords` is document space, so
              // subtract scrollY to land in container space (matching canvasX/Y).
              state = setLinkHover(state, {
                position,
                url: linkData.url,
                text: linkData.text,
                x: linkCoords.x,
                y: linkCoords.y - viewport.scrollY + linkCoords.height,
                startIndex: linkData.startIndex,
                endIndex: linkData.endIndex,
              });

              state = {
                ...state,
                ui: {
                  ...state.ui,
                  isHoveringLinkWithModifier: false,
                },
              };
            }
          }
        }
      }

      // Handle clearing linkHover when not over a link
      if (!isOverLink) {
        if (state.ui.linkHover) {
          // Check if mouse is over the tooltip area before clearing
          const tooltipHeight = 120;
          const tooltipWidth = 300;
          const hover = state.ui.linkHover;

          const isOverTooltip =
            event.x >= hover.x &&
            event.x <= hover.x + tooltipWidth &&
            event.y >= hover.y &&
            event.y <= hover.y + tooltipHeight;

          if (!isOverTooltip) {
            // Clear link hover
            state = setLinkHover(state, null);
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
    } else if (state.ui.linkHover || state.ui.isHoveringLinkWithModifier) {
      // Clear link hover on touch devices
      state = setLinkHover(state, null);
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
    if (!session.autoScroll.isActive) {
      startAutoScroll(session);
    }

    // Update stored mouse position for auto-scroll loop
    session.autoScroll.lastPointerX = canvasX;
    session.autoScroll.lastPointerY = canvasY;

    // We let handleEvents loop handle the actual scrolling to support
    // scrolling while the mouse is stationary at the edge.
  } else {
    if (session.autoScroll.isActive) {
      stopAutoScroll(session);
    }
  }

  return newState;
}
export function handleMouseUp(
  state: EditorState,
  viewport: ViewportState,
  _event: MouseEvent,
  _visibility: { start: number; end: number },
  documentHeight: number,
  session: InteractionSession,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  stopAutoScroll(session);
  session.pendingCapture = null;

  // Release a captured region drag (scrollbar thumb)
  if (session.captured) {
    const endResult = routeCapturedEnd(null, {
      state,
      viewport,
      documentHeight,
      session,
    });
    return {
      state: endResult ? endResult.state : state,
      ops: endResult?.ops ?? [],
    };
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
export function handlePointerCancel(
  state: EditorState,
  viewport: ViewportState,
  documentHeight: number,
  session: InteractionSession,
): EditorState {
  stopAutoScroll(session);
  session.pendingCapture = null;

  // Cancel a captured region drag (scrollbar thumb)
  const cancelled = routeCapturedCancel({
    state,
    viewport,
    documentHeight,
    session,
  });
  if (cancelled) {
    state = cancelled;
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
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
): EditorState {
  // In locked mode, block scrolling (but allow in readonly mode)
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
    state.view.scrollbar,
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
      inlineMathHover: null,
      hoveredMathBlockIndex: null,
    },
  };
}
