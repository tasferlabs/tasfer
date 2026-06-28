import {
  createParagraphAboveOnClick,
  createParagraphBelowOnClick,
} from "../actions/edit-actions";
import {
  CLEAR_SELECTION_IN_PADDING,
  CLEAR_VISUAL_BLOCK_SELECTION,
  OPEN_BLOCK_OVERLAY,
  PLACE_CURSOR_AT_POINT,
  PLACE_CURSOR_IN_SIDE_PADDING,
  SELECT_LINE_AT_POINT,
  SELECT_VISUAL_BLOCK,
  SELECT_WORD_AT_POINT,
} from "../actions/mouse-actions";
import { POINTER_MOVE, TEXT_CLICK } from "../actions/pointer-actions";
import { DOUBLE_CLICK_TIME, EDGE_SCROLL_THRESHOLD } from "../constants";
import {
  getScrollbarStyles,
  isPointInThumb,
  updateScrollbarHover,
  updateScrollFromWheel,
} from "../rendering/scrollbar";
import {
  getBlockIndexAtPoint,
  getCursorDocumentCoords,
  getTextPositionFromViewport,
} from "../selection";
import { updateCursor } from "../selection";
import { updateSelectionFocus } from "../selection";
import type {
  EditorState,
  MouseEvent,
  Position,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import { closeActiveMenu, setLinkHover, updateMode } from "../state-utils";
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
  visibility: VisibleBlockRange,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  scrollPositionIntoView?: (position: Position) => void,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  stopAutoScroll(session);

  // Ignore right-click - it will be handled by contextmenu event
  // This prevents clearing selection when right-clicking
  if (event.button === 2) {
    return { state, ops };
  }

  // Track if any menu was open (we'll use this to prevent reopening on same click)
  const wasMenuOpen = state.ui.activeMenu.type !== "none";
  const previousMenu = state.ui.activeMenu;

  // Close any active menu on mouse click (will be reopened below if needed)
  if (wasMenuOpen) {
    state = closeActiveMenu(state);
  }

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
    visibility,
    session,
    updateViewport: updateViewportCallback,
    scrollPositionIntoView,
  };
  const point = { x: canvasX, y: canvasY };
  const claim = hitTestAllRegions(point, "mouse", regionCtx);
  if (claim) {
    const begin = beginRegionInteraction(claim, point, "mouse", regionCtx);
    if (begin && begin !== "pending") {
      return { state: begin.state, ops: begin.ops ?? [] };
    }
  }

  // Check if clicking on an atomic block (image/line/math/custom void). One
  // type-agnostic pass: `getAtomicBlockAtPoint` hit-tests any AtomicNode, and
  // the node decides what a click means via its `activate` hook. A block type
  // gets click-to-open + click-to-select with no code here.
  const atomicBlock = getAtomicBlockAtPoint(
    canvasX,
    canvasY,
    state,
    viewport,
    undefined,
    visibility,
  );
  if (atomicBlock) {
    const block = state.document.page.blocks[atomicBlock.blockIndex];
    if (!block || block.deleted) return { state, ops };

    // Non-readonly: ask the node whether activation opens a host overlay (a
    // placeholder image opens its upload popover; a math block opens its
    // editor). The engine relays the host-provided key/data and never names
    // the overlay itself. Nodes with no overlay (e.g. a divider) return
    // nothing and fall through to selection.
    // (Image resize-handle drags are claimed by the image-resize region above.)
    if (state.ui.mode !== "readonly") {
      const activation = state.nodes.get(block.type)?.activate?.({
        state,
        block,
        blockIndex: atomicBlock.blockIndex,
      });
      if (activation) {
        // Don't reopen if we just closed the overlay for this same block
        if (
          wasMenuOpen &&
          previousMenu.type === "overlay" &&
          previousMenu.blockId === block.id
        ) {
          return { state, ops };
        }

        // Open the host overlay at the click position
        return {
          state: state.actionBus.dispatchState(OPEN_BLOCK_OVERLAY, state, {
            overlay: {
              type: "overlay",
              key: activation.key,
              blockId: block.id,
              x: canvasX,
              y: canvasY,
              data: activation.data,
            },
          }).state,
          ops,
        };
      }
    }

    // No activation (or readonly): select the visual block (same as arrow-key
    // behavior). Position at the start of the block (textIndex 0).
    const position = { blockIndex: atomicBlock.blockIndex, textIndex: 0 };
    return {
      state: state.actionBus.dispatchState(SELECT_VISUAL_BLOCK, state, {
        position,
        extend: !!(event.shiftKey && state.document.selection),
      }).state,
      ops,
    };
  }

  // Check if we have a visual block selected but clicked outside its container
  if (
    !atomicBlock &&
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

  // If clicking in top padding, start a fresh paragraph above a leading
  // self-contained block (code/math/quote); otherwise clear selection.
  if (isClickInTopPadding) {
    if (state.ui.mode !== "readonly") {
      const edge = createParagraphAboveOnClick(state, canvasY, viewport);
      if (edge.kind === "break") {
        return { state: edge.state, ops: [...ops, ...edge.ops] };
      }
    }
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
      undefined,
      visibility,
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
    undefined,
    visibility,
  );

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

  // A single click in the empty area below a trailing self-contained block
  // (code/math/quote) starts a fresh paragraph there, so the caret lands in
  // editable text rather than inside the block.
  if (!isMultiClick && state.ui.mode !== "readonly") {
    const edge = createParagraphBelowOnClick(state, canvasY, viewport);
    if (edge.kind === "break") {
      return { state: edge.state, ops: [...ops, ...edge.ops] };
    }
  }

  // A resolved single click. Dispatch the generic TEXT_CLICK: nodes/marks may
  // claim it (a link Ctrl+click opens the URL, an inline-math chip opens its
  // editor, a trailing image appends a paragraph). This replaces the old per-node
  // onTextClick loop.
  const clicked = state.actionBus.dispatchState(TEXT_CLICK, state, {
    canvasX,
    canvasY,
    position,
    previousMenu,
    viewport,
    modifiers: {
      ctrlOrMeta: event.ctrlKey || event.metaKey,
      shift: event.shiftKey,
    },
  });
  if (clicked.claimed) {
    return { state: clicked.state, ops: [...ops, ...clicked.ops] };
  }

  // Nothing claimed the click: place the caret. If Shift is held, extend the
  // selection; otherwise start a new selection and enter select mode.
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
  visibility: VisibleBlockRange,
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
    visibility,
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

  // Block reorder handle hover — drives the gutter grip. Same hit-test the drag
  // uses, so the painted grip and the grabbable band can never disagree.
  const hoveredDragHandleBlockId =
    hoverClaim?.region.id === "block-drag-handle"
      ? (hoverClaim.hit as { blockId: string }).blockId
      : null;
  if (hoveredDragHandleBlockId !== state.ui.hoveredDragHandleBlockId) {
    state = {
      ...state,
      ui: { ...state.ui, hoveredDragHandleBlockId },
    };
  }

  // Desktop hover (not in select mode, not during an image drag): let each node
  // update its own hover highlights. The engine resolves the atomic block +
  // caret position under the pointer once; nodes read those and set/clear their
  // own hover state (ImageNode → resize-handle hover, MathNode → block +
  // inline-math chip hover).
  if (state.ui.mode !== "select") {
    if (!isTouchDevice()) {
      // Generic desktop pointer-move: node + mark handlers update their own hover
      // UI off the resolved atomic block / caret position (ImageNode →
      // resize-handle hover, MathNode → block + inline-math chip hover, LinkMark
      // → link tooltip). The engine names no block/mark type.
      const atomicBlock = getAtomicBlockAtPoint(
        canvasX,
        canvasY,
        state,
        viewport,
        undefined,
        visibility,
      );
      const textPosition = getTextPositionFromViewport(
        canvasX,
        canvasY,
        state,
        viewport,
        undefined,
        visibility,
      );
      const blockUnderPoint = getBlockIndexAtPoint(
        canvasY,
        state,
        viewport,
        undefined,
        visibility,
      );
      state = state.actionBus.dispatchState(POINTER_MOVE, state, {
        canvasX,
        canvasY,
        atomicBlock,
        textPosition,
        blockUnderPoint,
        pointerX: event.x,
        pointerY: event.y,
        viewport,
        resolveCoords: (pos) => getCursorDocumentCoords(pos, state, viewport),
        modifiers: { ctrlOrMeta: event.ctrlKey || event.metaKey },
      }).state;
    } else if (state.ui.linkHover || state.ui.isHoveringLinkWithModifier) {
      // Clear any stale link hover on touch devices (link hover is desktop-only).
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
    undefined,
    visibility,
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
  // In suspended mode, block scrolling (but allow in readonly mode)
  if (state.ui.mode === "suspended") {
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
