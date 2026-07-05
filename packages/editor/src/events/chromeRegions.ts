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

import { CURSOR_DRAG_BOUNDARY, CURSOR_DRAG_END } from "../action-bus";
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
  snapSelectionToConstructs,
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
  session.handleDragPrevRawFocus = null;
  session.handleDragPrevHit = null;
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
      // Fresh drag: no travel history, so the first move snaps by the
      // selection's own orientation rather than a stale direction, and the row
      // hysteresis anchors only once the first move has resolved.
      ctx.session.handleDragPrevRawFocus = null;
      ctx.session.handleDragPrevHit = null;

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

      // Finger-drag resolution, exactly like the single-caret magnifier drag:
      // over a formula the focus follows the finger to its nearest caret stop
      // through stacked constructs, instead of the tap path's leap out to a
      // construct's boundary in the gap between rows. On a coarse (touch)
      // pointer that band leap flickers as the finger hovers a row gap, and the
      // construct snapper below turns that flicker into a selection that jitters
      // between whole-construct and partial — `drag: true` is what keeps it
      // steady (see the same fix on the caret drag in touchEvents).
      //
      // `prev` is the LAST frame's raw hit — the row-hysteresis anchor. Nearest-
      // stop alone still dithers between two tightly-stacked rows when the
      // finger sits on their midline (a fraction's bar); with the caret's rows
      // ~1em apart every sub-pixel wobble flips the row, the snapper amplifies
      // each flip into whole-construct-vs-partial, and the loupe bounces. The
      // anchor must be the raw hit, not the snapped focus: a focus widened to a
      // construct's edge sits on the OUTER baseline row, which would disarm the
      // hysteresis exactly where it's needed.
      const newPosition = getTextPositionFromViewport(
        p.x,
        p.y,
        state,
        viewport,
        undefined,
        ctx.visibility,
        { drag: true, prev: session.handleDragPrevHit },
      );
      if (newPosition) session.handleDragPrevHit = newPosition;

      let next = state;
      if (
        newPosition &&
        state.document.selection &&
        state.ui.selectionHandleDrag
      ) {
        // The dragged handle is always the focus (set up in onStart); the anchor
        // is the opposite, fixed endpoint.
        const { anchor: rawAnchor, focus: prevFocus } =
          state.document.selection;

        // Snap the raw hit-test focus so the drag never leaves a math construct
        // half-covered: descending out through a construct escalates level by
        // level to the whole construct, exactly like a desktop mouse/keyboard
        // extension (both route focus through this same snapper). A partial
        // (non-construct) span stays as dragged. The fixed anchor widens outward
        // too, matching desktop.
        //
        // The snapper reads the finger's travel DIRECTION to decide "take the
        // construct in vs drop it", and that reference must stay stable while the
        // finger sits inside a construct — otherwise its two failure modes flicker
        // the whole construct in and out every frame:
        //   • feeding back the snapped focus (which jumps to the construct's
        //     edges) flips the sign each frame;
        //   • even the raw focus dithers between two interior stops when a finger
        //     hovers the construct it's trying to include/exclude (worst on
        //     shrink), flipping the sign just the same.
        // So the reference is the last raw focus that landed at a SETTLED stop —
        // one the snapper did NOT have to widen. While the finger is interior the
        // reference is pinned to where it entered, so the take-in/drop decision is
        // latched until the finger actually crosses out one side.
        const prevRawFocus = session.handleDragPrevRawFocus ?? undefined;
        const { anchor, focus: newFocus } = snapSelectionToConstructs(
          state,
          rawAnchor,
          newPosition,
          prevRawFocus,
        );
        const focusSettled =
          newFocus.blockIndex === newPosition.blockIndex &&
          newFocus.textIndex === newPosition.textIndex;
        if (focusSettled) {
          session.handleDragPrevRawFocus = newPosition;
        }

        // Tick a haptic each time the held handle crosses a character or line
        // boundary, mirroring the caret cursor-drag path in touchEvents — the
        // host maps CURSOR_DRAG_BOUNDARY to a light tap. Compared against the
        // snapped focus so it fires with the visible selection, not on interior
        // stops the snapper collapses over.
        if (
          prevFocus.blockIndex !== newFocus.blockIndex ||
          prevFocus.textIndex !== newFocus.textIndex
        ) {
          state.actionBus.dispatch(CURSOR_DRAG_BOUNDARY);
        }

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

      // Edge auto-scroll: when the pointer nears a viewport edge, record it so
      // the frame loop in handleEvents keeps scrolling (via onAutoScrollTick)
      // while the pointer holds still — letting a drag reach off-screen blocks.
      const { session } = ctx;
      const isNearTopEdge = p.y < EDGE_SCROLL_THRESHOLD || p.y < 0;
      const isNearBottomEdge =
        p.y > ctx.viewport.height - EDGE_SCROLL_THRESHOLD ||
        p.y > ctx.viewport.height;
      if (isNearTopEdge || isNearBottomEdge) {
        startAutoScroll(session);
        session.autoScroll.lastPointerX = p.x;
        session.autoScroll.lastPointerY = p.y;
      } else if (session.autoScroll.isActive) {
        stopAutoScroll(session);
      }

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
    // While edge auto-scroll is active, the frame loop drives scrolling through
    // these. A block reorder never needs to halt scrolling early (unlike an
    // image resize chasing its own height), so it always permits the scroll;
    // applyEdgeScroll clamps at the document ends.
    onAutoScrollTick() {
      return { blockScroll: false };
    },
    onAutoScrollScrolled(p, _scrollDelta, ctx) {
      // The viewport scrolled under a stationary pointer, so the same pointerY
      // now sits over a different block — re-resolve the drop gap.
      const drag = ctx.state.ui.blockDrag;
      if (!drag) return ctx.state;
      return setBlockDrag(ctx.state, {
        ...drag,
        pointerY: p.y,
        dropIndex: dropIndexAtPoint(
          p.y,
          ctx.state,
          ctx.viewport,
          undefined,
          ctx.visibility,
        ),
      });
    },
    onEnd(_p, ctx) {
      stopAutoScroll(ctx.session);
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
      stopAutoScroll(ctx.session);
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
