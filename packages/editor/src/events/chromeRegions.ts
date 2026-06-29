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

import { CURSOR_DRAG_END } from "../action-bus";
import { MOVE_BLOCK } from "../actions/edit-actions";
import {
  BLOCK_DRAG_HANDLE_HIT_WIDTH,
  EDGE_SCROLL_THRESHOLD,
  MOVEMENT_THRESHOLD,
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
  type InteractionSession,
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

/**
 * Tear down the selection-handle magnifier loupe at the end of a handle drag:
 * emit the matching CURSOR_DRAG_END (only if it was ever shown) and drop the
 * transient session state. Shared by the drag's onEnd and onCancel.
 */
function endHandleLoupe(state: EditorState, session: InteractionSession): void {
  if (session.handleDragLoupe?.shown) {
    state.actionBus.dispatch(CURSOR_DRAG_END);
  }
  session.handleDragLoupe = null;
}

/** Touch selection handles (anchor/focus) — drag to adjust the selection. */
const selectionHandleRegion: Region = {
  id: "selection-handle",
  priority: 80,
  modes: ["edit", "select"],
  hitTest(p, pointerType, ctx) {
    if (pointerType !== "touch") return null;
    return getSelectionHandleAtPoint(
      p.x,
      p.y,
      ctx.state,
      ctx.viewport,
      ctx.visibility,
    );
  },
  drag: {
    onStart(hit, p, ctx) {
      // The handle under the finger becomes the focus — the moving end — and the
      // opposite handle becomes the anchor, the fixed base. Grabbing the "anchor"
      // handle therefore swaps the stored endpoints so the drag always moves the
      // focus; the swap is visually identical (same span and highlight
      // direction) but keeps `selection.focus` and the caret tracking the held
      // handle, so a later keyboard shift-extension continues from there.
      const grabbedAnchorHandle = (hit as "anchor" | "focus") === "anchor";
      // Start the loupe timer at grab. The per-frame tick in handleEvents shows
      // the magnifier once this hold outlives CURSOR_DRAG_ACTIVATION_DELAY and
      // tracks the handle from the coords kept current in onMove.
      ctx.session.handleDragLoupe = {
        startTime: Date.now(),
        shown: false,
        x: p.x,
        y: p.y,
      };

      let state = ctx.state;
      const sel = state.document.selection;
      if (grabbedAnchorHandle && sel) {
        state = {
          ...state,
          document: {
            ...state.document,
            selection: {
              anchor: sel.focus,
              focus: sel.anchor,
              isForward: !sel.isForward,
              isCollapsed: sel.isCollapsed,
              lastUpdate: Date.now(),
            },
            cursor: { position: sel.anchor, lastUpdate: Date.now() },
          },
        };
      }

      return {
        state: withScrollbarInteraction(
          withStoppedMomentum({
            ...state,
            ui: {
              ...state.ui,
              selectionHandleDrag: {
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
        undefined,
        ctx.visibility,
      );

      let next = state;
      if (
        newPosition &&
        state.document.selection &&
        state.ui.selectionHandleDrag
      ) {
        // The dragged handle is always the focus (set up in onStart); the anchor
        // is the opposite, fixed endpoint.
        const { anchor } = state.document.selection;
        const newFocus = newPosition;

        const isForward =
          anchor.blockIndex < newFocus.blockIndex ||
          (anchor.blockIndex === newFocus.blockIndex &&
            anchor.textIndex <= newFocus.textIndex);

        const isCollapsed =
          anchor.blockIndex === newFocus.blockIndex &&
          anchor.textIndex === newFocus.textIndex;

        next = {
          ...state,
          document: {
            ...state.document,
            selection: {
              anchor,
              focus: newFocus,
              isForward,
              isCollapsed,
              lastUpdate: Date.now(),
            },
            cursor: {
              position: newFocus,
              lastUpdate: Date.now(),
            },
          },
        };
      }

      // The loupe is a dwell affordance (iOS-style): if the finger starts
      // dragging straight away — past the movement threshold before the loupe has
      // shown — cancel it for this drag, so only a deliberate hold-before-drag
      // brings it up. Once shown, movement simply repositions it.
      const loupe = session.handleDragLoupe;
      if (loupe) {
        const grab = state.ui.selectionHandleDrag;
        if (
          !loupe.shown &&
          grab &&
          Math.hypot(p.x - grab.startX, p.y - grab.startY) > MOVEMENT_THRESHOLD
        ) {
          session.handleDragLoupe = null;
        } else {
          loupe.x = p.x;
          loupe.y = p.y;
        }
      }

      return { state: withScrollbarInteraction(next) };
    },
    onEnd(_p, ctx) {
      stopAutoScroll(ctx.session);
      endHandleLoupe(ctx.state, ctx.session);
      return {
        state: withScrollbarInteraction({
          ...ctx.state,
          ui: { ...ctx.state.ui, selectionHandleDrag: null },
        }),
      };
    },
    onCancel(ctx) {
      stopAutoScroll(ctx.session);
      endHandleLoupe(ctx.state, ctx.session);
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
    if (ctx.scrollPositionIntoView) {
      // Corrected scroll: re-measures over the next few frames so it lands on
      // the peer's exact caret even when the target is far off-screen (where a
      // one-shot jump from estimated heights would land short).
      ctx.scrollPositionIntoView(target);
    } else {
      // Fallback for a host that builds its own region context without the
      // correction hook: a single estimate-based make-visible jump.
      const newScrollY = scrollToMakeCursorVisible(
        target,
        ctx.state,
        ctx.viewport,
      );
      if (newScrollY !== null) {
        ctx.updateViewport?.({ scrollY: newScrollY });
      }
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
