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

import { MOVE_BLOCK } from "../actions/edit-actions";
import {
  BLOCK_DRAG_HANDLE_HIT_WIDTH,
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
  dropIndexAtPoint,
  getBlockIndexAtPoint,
  getTextPositionFromViewport,
  scrollToMakeCursorVisible,
} from "../selection";
import type { EditorState } from "../state-types";
import { getEditorStyles } from "../styles";
import { getAtomicBlockAtPoint, getSelectionHandleAtPoint } from "./eventUtils";
import {
  startAutoScroll,
  stopAutoScroll,
  withScrollbarInteraction,
  withStoppedMomentum,
} from "./interaction-session";
import type { RegionCtx, RegionPoint } from "./regions";
import { type Region, RegionRegistry } from "./regions";

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
    activationIntensity: "medium",
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

/** Out-of-view peer indicator — click/tap to scroll that peer into view. */
const peerIndicatorRegion: Region = {
  id: "peer-indicator",
  priority: 70,
  modes: ["edit", "select", "readonly"],
  hitTest(p, _pointerType, ctx) {
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

/**
 * The block whose left-gutter handle band contains `p`, or `null`. The band is
 * the slice of the left padding nearest the content column (`[paddingLeft -
 * HIT_WIDTH, paddingLeft)`); the canvas gutter is never mirrored for RTL (text
 * direction is intra-block), so it is always on the left.
 *
 * A full-bleed atomic block (an edge-to-edge image) draws its own content
 * across this band, so the block it covers owns the pixel — the handle yields
 * rather than steal the interaction from the image underneath. Asked
 * node-agnostically via `getAtomicBlockAtPoint`: any block whose interactive
 * box reaches into the gutter suppresses the handle there; a normal centered
 * block's box starts at `paddingLeft` and never does.
 */
function blockAtGutterPoint(
  p: RegionPoint,
  ctx: RegionCtx,
): { blockId: string; originalIndex: number } | null {
  const styles = getEditorStyles(ctx.state);
  const gutterInner = styles.canvas.paddingLeft;
  if (p.x < gutterInner - BLOCK_DRAG_HANDLE_HIT_WIDTH || p.x >= gutterInner) {
    return null;
  }
  if (
    getAtomicBlockAtPoint(
      p.x,
      p.y,
      ctx.state,
      ctx.viewport,
      undefined,
      ctx.visibility,
    )
  ) {
    return null;
  }
  const originalIndex = getBlockIndexAtPoint(
    p.y,
    ctx.state,
    ctx.viewport,
    styles,
    ctx.visibility,
  );
  if (originalIndex === null) return null;
  const block = ctx.state.view.visibleBlocks.find(
    (b) => b.originalIndex === originalIndex,
  );
  return block ? { blockId: block.id, originalIndex } : null;
}

function setBlockDrag(
  state: EditorState,
  blockDrag: EditorState["ui"]["blockDrag"],
): EditorState {
  return { ...state, ui: { ...state.ui, blockDrag } };
}

/**
 * Block reorder handle — the left-gutter grab band. Hovering a block's gutter
 * shows a grip (painted by the renderer off `ui.hoveredDragHandleBlockId`);
 * dragging it repositions the block via the {@link MOVE_BLOCK} action on
 * release. Mouse only — touch reordering is a separate gesture (not built yet).
 */
const blockDragHandleRegion: Region = {
  id: "block-drag-handle",
  priority: 60,
  modes: ["edit"],
  hitTest(p, pointerType, ctx) {
    if (pointerType !== "mouse") return null;
    return blockAtGutterPoint(p, ctx);
  },
  drag: {
    onStart(hit, p, ctx) {
      const { blockId } = hit as { blockId: string };
      return {
        state: setBlockDrag(ctx.state, {
          blockId,
          pointerY: p.y,
          dropIndex: dropIndexAtPoint(
            p.y,
            ctx.state,
            ctx.viewport,
            undefined,
            ctx.visibility,
          ),
        }),
      };
    },
    onMove(p, ctx) {
      const drag = ctx.state.ui.blockDrag;
      if (!drag) return { state: ctx.state };
      return {
        state: setBlockDrag(ctx.state, {
          ...drag,
          pointerY: p.y,
          dropIndex: dropIndexAtPoint(
            p.y,
            ctx.state,
            ctx.viewport,
            undefined,
            ctx.visibility,
          ),
        }),
      };
    },
    onEnd(_p, ctx) {
      const drag = ctx.state.ui.blockDrag;
      const cleared = setBlockDrag(ctx.state, null);
      if (!drag) return { state: cleared };
      // Resolve the STORED dropIndex (a window-level mouseup has no position).
      // visibleBlocks are in visual order, so the block at dropIndex-1 is the
      // new predecessor; index 0 means the head of the document.
      const { visibleBlocks } = cleared.view;
      const afterBlockId =
        drag.dropIndex <= 0
          ? null
          : (visibleBlocks[drag.dropIndex - 1]?.id ?? null);
      const result = cleared.actionBus.dispatchState(MOVE_BLOCK, cleared, {
        blockId: drag.blockId,
        afterBlockId,
      });
      return { state: result.state, ops: result.ops };
    },
    onCancel(ctx) {
      return setBlockDrag(ctx.state, null);
    },
  },
};

/** The built-in chrome region set every editor instance starts with. */
export function createChromeRegionRegistry(): RegionRegistry {
  return new RegionRegistry()
    .register(scrollbarThumbRegion)
    .register(scrollbarTrackRegion)
    .register(selectionHandleRegion)
    .register(peerIndicatorRegion)
    .register(blockDragHandleRegion);
}
