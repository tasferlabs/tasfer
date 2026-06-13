/**
 * Chrome regions — the editor's built-in interactive areas that are not part
 * of block content: scrollbar thumb/track, touch selection handles, and
 * out-of-view peer indicators. Block-content regions (checkboxes, image
 * resize handles, …) are contributed by nodes instead.
 *
 * Behavior is ported 1:1 from the former inline branches in mouseEvents.ts /
 * touchEvents.ts; each region is now the single implementation for both
 * pointer types, with per-pointer hit slop in its own hitTest.
 */

import {
  EDGE_SCROLL_THRESHOLD,
  SCROLLBAR_HOLD_DURATION,
  SCROLLBAR_TOUCH_BUFFER,
} from "../constants";
import { getOutOfViewIndicatorAtPoint } from "../rendering/renderer";
import {
  endScrollbarDrag,
  getScrollbarStyles,
  isPointInScrollbar,
  isPointInThumb,
  startScrollbarDrag,
  updateScrollFromThumbDrag,
  updateScrollFromTrackClick,
} from "../rendering/scrollbar";
import {
  getTextPositionFromViewport,
  scrollToMakeCursorVisible,
} from "../selection";
import type { EditorState } from "../state-types";
import { getSelectionHandleAtPoint } from "./eventUtils";
import { startAutoScroll, stopAutoScroll } from "./interaction-session";
import { type Region, RegionRegistry } from "./regions";

/** Bump the scrollbar's lastInteraction so it stays visible (fade timer). */
export function withScrollbarInteraction(state: EditorState): EditorState {
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

export function withStoppedMomentum(state: EditorState): EditorState {
  return {
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

function endScrollbarDragState(state: EditorState): EditorState {
  return {
    ...state,
    view: {
      ...state.view,
      scrollbar: endScrollbarDrag(state.view.scrollbar),
    },
  };
}

/**
 * Scrollbar thumb — immediate drag with mouse; iOS-style hold-to-activate
 * with touch (while the hold is pending the touch scrolls normally).
 */
const scrollbarThumbRegion: Region = {
  id: "scrollbar-thumb",
  priority: 100,
  modes: ["edit", "select", "readonly"],
  hitTest(p, pointerType, ctx) {
    const buffer = pointerType === "touch" ? SCROLLBAR_TOUCH_BUFFER : 0;
    return isPointInThumb(
      p.x,
      p.y,
      ctx.viewport,
      ctx.documentHeight,
      ctx.state.view.scrollbar,
      getScrollbarStyles(ctx.state),
      buffer,
    )
      ? true
      : null;
  },
  drag: {
    touchHoldMs: SCROLLBAR_HOLD_DURATION,
    activationIntensity: "heavy",
    onStart(_hit, p, ctx) {
      return {
        state: {
          ...ctx.state,
          view: {
            ...ctx.state.view,
            scrollbar: startScrollbarDrag(
              ctx.state.view.scrollbar,
              p.y,
              ctx.viewport,
              ctx.documentHeight,
              getScrollbarStyles(ctx.state),
            ),
          },
        },
      };
    },
    onMove(p, ctx) {
      const newScrollY = updateScrollFromThumbDrag(
        p.y,
        ctx.viewport,
        ctx.documentHeight,
        ctx.state.view.scrollbar,
        getScrollbarStyles(ctx.state),
      );
      ctx.updateViewport?.({ scrollY: newScrollY });
      // Clear hover overlays while scrolling via the scrollbar
      return {
        state: {
          ...ctx.state,
          ui: {
            ...ctx.state.ui,
            activeMenu: { type: "none" },
            isHoveringLinkWithModifier: false,
            imageHover: null,
          },
        },
      };
    },
    onEnd(_p, ctx) {
      return { state: endScrollbarDragState(ctx.state) };
    },
    onCancel(ctx) {
      return endScrollbarDragState(ctx.state);
    },
  },
};

/** Scrollbar track (outside the thumb) — mouse page-jump click. */
const scrollbarTrackRegion: Region = {
  id: "scrollbar-track",
  priority: 90,
  modes: ["edit", "select", "readonly"],
  hitTest(p, pointerType, ctx) {
    if (pointerType !== "mouse") return null;
    return isPointInScrollbar(
      p.x,
      p.y,
      ctx.viewport,
      ctx.documentHeight,
      getScrollbarStyles(ctx.state),
    )
      ? true
      : null;
  },
  onTap(_hit, p, _tapCount, ctx) {
    const newScrollY = updateScrollFromTrackClick(
      p.y,
      ctx.viewport,
      ctx.documentHeight,
      ctx.state.view.scrollbar,
      getScrollbarStyles(ctx.state),
    );
    ctx.updateViewport?.({ scrollY: newScrollY });
    return { state: withScrollbarInteraction(ctx.state) };
  },
};

/** Touch selection handles (anchor/focus) — drag to adjust the selection. */
const selectionHandleRegion: Region = {
  id: "selection-handle",
  priority: 80,
  modes: ["edit", "select"],
  hitTest(p, pointerType, ctx) {
    if (pointerType !== "touch") return null;
    return getSelectionHandleAtPoint(p.x, p.y, ctx.state, ctx.viewport);
  },
  drag: {
    onStart(hit, p, ctx) {
      const handleType = hit as "anchor" | "focus";
      return {
        state: withScrollbarInteraction(
          withStoppedMomentum({
            ...ctx.state,
            ui: {
              ...ctx.state.ui,
              selectionHandleDrag: {
                handleType,
                startX: p.x,
                startY: p.y,
              },
            },
          }),
        ),
      };
    },
    onMove(p, ctx) {
      const { state, viewport, session } = ctx;

      // Edge auto-scroll: record the pointer so the frame loop in
      // handleEvents keeps scrolling (and re-applying this drag) while the
      // finger holds still at the edge.
      const isNearEdge =
        p.y < EDGE_SCROLL_THRESHOLD ||
        p.y > viewport.height - EDGE_SCROLL_THRESHOLD ||
        p.y < 0 ||
        p.y > viewport.height;
      if (isNearEdge) {
        startAutoScroll(session);
        session.autoScroll.lastPointerX = p.x;
        session.autoScroll.lastPointerY = p.y;
      } else if (session.autoScroll.isActive) {
        stopAutoScroll(session);
      }

      const newPosition = getTextPositionFromViewport(
        p.x,
        p.y,
        state,
        viewport,
      );

      let next = state;
      if (
        newPosition &&
        state.document.selection &&
        state.ui.selectionHandleDrag
      ) {
        const { handleType } = state.ui.selectionHandleDrag;
        const { anchor, focus } = state.document.selection;

        const newAnchor = handleType === "anchor" ? newPosition : anchor;
        const newFocus = handleType === "anchor" ? focus : newPosition;

        const isForward =
          newAnchor.blockIndex < newFocus.blockIndex ||
          (newAnchor.blockIndex === newFocus.blockIndex &&
            newAnchor.textIndex <= newFocus.textIndex);

        const isCollapsed =
          newAnchor.blockIndex === newFocus.blockIndex &&
          newAnchor.textIndex === newFocus.textIndex;

        next = {
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

      return { state: withScrollbarInteraction(next) };
    },
    onEnd(_p, ctx) {
      stopAutoScroll(ctx.session);
      return {
        state: withScrollbarInteraction({
          ...ctx.state,
          ui: { ...ctx.state.ui, selectionHandleDrag: null },
        }),
      };
    },
    onCancel(ctx) {
      stopAutoScroll(ctx.session);
      return {
        ...ctx.state,
        ui: { ...ctx.state.ui, selectionHandleDrag: null },
      };
    },
  },
};

/** Out-of-view peer indicator — click to scroll that peer into view. */
const peerIndicatorRegion: Region = {
  id: "peer-indicator",
  priority: 70,
  modes: ["edit", "select", "readonly"],
  hitTest(p, pointerType, ctx) {
    if (pointerType !== "mouse") return null;
    return getOutOfViewIndicatorAtPoint(ctx.session, p.x, p.y);
  },
  onTap(hit, _p, _tapCount, ctx) {
    const target = hit as { blockIndex: number; textIndex: number };
    const newScrollY = scrollToMakeCursorVisible(
      target,
      ctx.state,
      ctx.viewport,
    );
    if (newScrollY !== null) {
      ctx.updateViewport?.({ scrollY: newScrollY });
    }
    return { state: withScrollbarInteraction(ctx.state) };
  },
};

/** The built-in chrome region set every editor instance starts with. */
export function createChromeRegionRegistry(): RegionRegistry {
  return new RegionRegistry()
    .register(scrollbarThumbRegion)
    .register(scrollbarTrackRegion)
    .register(selectionHandleRegion)
    .register(peerIndicatorRegion);
}
