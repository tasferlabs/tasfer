/**
 * Editor **touch actions** — the discrete tap / long-press / scroll actions the
 * touch handlers used to inline, lifted into named, dispatchable
 * {@link StateAction}s.
 *
 * A state action is the low-level action shape: its default behavior is a
 * pure `(state) => { state, ops }` transform (see `action-bus.ts`), which is
 * exactly the currency the event pipeline already trades in. The touch actions
 * here are pure cursor/selection/view moves and emit no ops. Handlers dispatch
 * these via `state.actionBus.dispatchState(...)`, so hosts/plugins can observe
 * or override them, and the engine's logic lives in one named place instead of
 * being scattered across the switch statements in `touchEvents.ts`.
 *
 * (The one touch action that mutates the document — creating a paragraph below
 * a trailing image — is co-located with the node it acts on: see
 * `nodes/ImageNode.ts` → CREATE_PARAGRAPH_BELOW_IMAGE.)
 *
 * Payload policy: a {@link StateAction} must stay pure over {@link EditorState},
 * but the touch handlers resolve pixel positions, hit-test viewport coordinates,
 * and read per-instance pointer `session` state. Anything that needs the
 * viewport, a resolved hit-test, or a `session`-derived value is computed in the
 * handler and threaded in via the payload, so the action body itself only reads
 * and derives from the `state` it is handed.
 */

import {
  CLOSE_CONTEXT_MENU,
  OPEN_CONTEXT_MENU,
  stateAction,
} from "../action-bus";
import {
  clearSelection,
  moveCursorToPosition,
  updateCursor,
} from "../selection";
import { type Block } from "../serlization/loadPage";
import type { Position } from "../state-types";
import { closeActiveMenu, setActiveMenu, updateMode } from "../state-utils";
import { isTextualBlock } from "../sync/block-registry";
import {
  getSelectionRange,
  selectLineAtPosition,
  selectWordAtPosition,
} from "./actions";

/** A resolved text position from {@link getTextPositionFromViewport}. */
interface PositionPayload {
  position: Position;
}

// ─── Padding taps (clear / reposition, no ops) ───────────────────────────────

/**
 * Tap in the top padding area above the first block: clear any selection, drop
 * back to edit mode, and close an open context menu. Pure, no ops.
 */
export const TAP_TOP_PADDING = stateAction("tap-top-padding", (state) => {
  let next = clearSelection(state);
  next = updateMode(next, "edit");
  // Host-owned context menu: signal it to close (no-op if none is open).
  state.actionBus.dispatch(CLOSE_CONTEXT_MENU);
  return { state: next, ops: [] };
});

/**
 * Tap in the left/right padding gutter: position the caret at the resolved
 * start/end-of-line `position`, clear any selection, drop to edit mode, and
 * close an open context menu. The handler resolves `position` from the tap
 * point. Pure, no ops.
 */
export const TAP_SIDE_PADDING = stateAction<PositionPayload>(
  "tap-side-padding",
  (state, { position }) => {
    let next = clearSelection(state);
    next = updateCursor(next, position);
    next = updateMode(next, "edit");
    // Host-owned context menu: signal it to close (no-op if none is open).
    state.actionBus.dispatch(CLOSE_CONTEXT_MENU);
    return { state: next, ops: [] };
  },
);

// ─── Visual-block selection (image / line) ───────────────────────────────────

/**
 * Select a visual (non-textual) block — an image or line — that the tap landed
 * on, mirroring the arrow-key behavior: close any active menu, move the caret to
 * the block, and create a collapsed-position selection that spans it. The
 * handler resolves `position.blockIndex` from the atomic-block hit-test. Pure,
 * no ops.
 */
export const TAP_SELECT_VISUAL_BLOCK = stateAction<PositionPayload>(
  "tap-select-visual-block",
  (state, { position }) => {
    let next = state;
    // Close any active menu when selecting a visual block.
    if (next.ui.activeMenu.type !== "none") {
      next = closeActiveMenu(next);
    }
    // Create a selection that spans the block (same as arrow key behavior).
    next = moveCursorToPosition(next, position.blockIndex, 0);
    next = {
      ...next,
      document: {
        ...next.document,
        selection: {
          anchor: position,
          focus: position,
          isForward: true,
          isCollapsed: false,
          lastUpdate: Date.now(),
        },
      },
    };
    next = updateMode(next, "edit");
    return { state: next, ops: [] };
  },
);

/**
 * Tapped outside a currently-selected visual block (image/line): clear the
 * dangling selection. The handler establishes that a non-collapsed visual-block
 * selection exists and the tap missed it, passing the spanned block's index.
 * Pure, no ops.
 */
export const TAP_CLEAR_VISUAL_BLOCK_SELECTION = stateAction(
  "tap-clear-visual-block-selection",
  (state) => ({ state: clearSelection(state), ops: [] }),
);

// ─── Image-node overlay toggle ───────────────────────────────────────────────

/**
 * Open a host overlay for an image node's activation (e.g. a placeholder image's
 * upload popover). The handler asks the node whether activation opens an overlay
 * and passes the resolved `key`/`data`, the block id, and the tap point.
 * Pure, no ops.
 */
export const OPEN_NODE_OVERLAY = stateAction<{
  key: string;
  blockId: string;
  point: { x: number; y: number };
  data: unknown;
}>("open-node-overlay", (state, { key, blockId, point, data }) => ({
  state: setActiveMenu(state, {
    type: "overlay",
    key,
    blockId,
    x: point.x,
    y: point.y,
    data,
  }),
  ops: [],
}));

/**
 * Re-tapping an image whose overlay is already open closes the overlay (and
 * keeps it closed for this tap). Pure, no ops.
 */
export const CLOSE_NODE_OVERLAY = stateAction(
  "close-node-overlay",
  (state) => ({ state: closeActiveMenu(state), ops: [] }),
);

// ─── Multi-tap word/line selection ───────────────────────────────────────────

/**
 * Triple-tap: select the whole line at the tap position (fires even inside an
 * existing selection). The handler resolves `position`. Pure, no ops.
 *
 * Named `TAP_*` (vs the mouse `SELECT_LINE_AT_POINT`) for the touch convention.
 */
export const TAP_SELECT_LINE = stateAction<PositionPayload>(
  "tap-select-line",
  (state, { position }) => ({
    state: selectLineAtPosition(state, position),
    ops: [],
  }),
);

/**
 * Double-tap: select the word at the tap position, closing an open context menu
 * (a new selection supersedes it). The handler resolves `position`. Pure, no
 * ops.
 *
 * Named `TAP_*` (vs the mouse `SELECT_WORD_AT_POINT`) for the touch convention.
 */
export const TAP_SELECT_WORD = stateAction<PositionPayload>(
  "tap-select-word",
  (state, { position }) => {
    const next = selectWordAtPosition(state, position);
    // Host-owned context menu: signal it to close (no-op if none is open).
    state.actionBus.dispatch(CLOSE_CONTEXT_MENU);
    return { state: next, ops: [] };
  },
);

// ─── Tap-place-cursor ────────────────────────────────────────────────────────

/**
 * Single tap: clear any selection, place the caret at the tap position, drop to
 * edit mode, and close an open context menu. A tap landing inside an existing
 * selection routes here too — matching native editors, where a tap dismisses
 * the selection and repositions the caret rather than opening a menu (the menu
 * is reached via long-press). The handler resolves `position`. Pure, no ops.
 */
export const TAP_PLACE_CURSOR = stateAction<PositionPayload>(
  "tap-place-cursor",
  (state, { position }) => {
    let next = clearSelection(state);
    next = updateCursor(next, position);
    next = updateMode(next, "edit");
    // Host-owned context menu: signal it to close (no-op if none is open).
    state.actionBus.dispatch(CLOSE_CONTEXT_MENU);
    return { state: next, ops: [] };
  },
);

/**
 * Tap that resolves to no text position (outside the editor's content area):
 * clear the selection, drop to edit mode, and close an open context menu. Pure,
 * no ops.
 */
export const TAP_OUTSIDE_CONTENT = stateAction(
  "tap-outside-content",
  (state) => {
    let next = clearSelection(state);
    next = updateMode(next, "edit");
    // Host-owned context menu: signal it to close (no-op if none is open).
    state.actionBus.dispatch(CLOSE_CONTEXT_MENU);
    return { state: next, ops: [] };
  },
);

// ─── Long-press / cursor-drag context menu ───────────────────────────────────

/**
 * Open the context menu at a resolved tap/long-press point. Shared by the
 * long-press-without-drag release and the cursor-drag-held-without-move release
 * (mobile's long-press-on-cursor = paste menu). The handler supplies the
 * pixel `point`. Headless: the engine doesn't own the menu — it dispatches the
 * host-facing {@link OPEN_CONTEXT_MENU} and leaves the state unchanged (the host
 * renders the menu; the engine flips its own capture flag). Pure, no ops. Kept
 * as a thin state-action shim so the touch call sites stay uniform.
 */
export const OPEN_CONTEXT_MENU_AT = stateAction<{
  point: { x: number; y: number };
}>("open-context-menu-at", (state, { point }) => {
  state.actionBus.dispatch(OPEN_CONTEXT_MENU, {
    x: point.x,
    y: point.y,
    hasSelection: !!getSelectionRange(state),
  });
  return { state, ops: [] };
});

/** Whether the spanned block of the current selection is a non-textual visual
 * block — used by the handler to gate {@link CLEAR_VISUAL_BLOCK_SELECTION}. */
export function isVisualBlockSelection(
  block: Block | undefined,
): block is Block {
  return !!block && !block.deleted && !isTextualBlock(block);
}
