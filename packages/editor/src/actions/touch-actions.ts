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
import { docSelectionFocus } from "../positions";
import {
  clearSelection,
  moveCursorToPosition,
  updateCursor,
} from "../selection";
import { type Block } from "../serlization/loadPage";
import type { Position } from "../state-types";
import { closeActiveMenu, setActiveMenu, updateMode } from "../state-utils";
import {
  type ContentSelection,
  isContentSelectionCollapsed,
  updateContentSelection,
} from "../structured-selection";
import { isTextualBlock } from "../sync/block-registry";
import {
  getSelectionRange,
  selectLineAtPosition,
  selectWordAtPosition,
} from "./actions";

/** A resolved text position from {@link getTextPositionFromViewport}. */
interface PositionPayload {
  position: Position;
  /** Node-resolved nested caret for content taps. Ignored by gutter actions. */
  contentSelection?: ContentSelection | null;
}

// ─── Padding taps (clear / reposition, no ops) ───────────────────────────────

/**
 * Tap in the top padding above the first block: clears any selection, switches
 * back to edit mode, and closes an open context menu. Does not change the
 * document.
 */
export const TAP_TOP_PADDING = stateAction("tap-top-padding", (state) => {
  let next = clearSelection(state);
  next = updateMode(next, "edit");
  // Host-owned context menu: signal it to close (no-op if none is open).
  state.actionBus.dispatch(CLOSE_CONTEXT_MENU);
  return { state: next, ops: [] };
});

/**
 * Tap in the left or right padding: clears any selection, puts the caret at the
 * start or end of that line, switches to edit mode, and closes an open context
 * menu. The handler resolves `position` from the tap point. Does not change the
 * document.
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
 * Selects the image or line block the tap landed on, the same way the arrow
 * keys do. It closes any open menu, moves the caret to the block, selects the
 * whole block, and switches to edit mode. The handler finds the block and
 * passes it as `position.blockIndex`. Does not change the document.
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
 * Clears the selection. Touch handling dispatches it when you tap outside a
 * selected image or line block. Takes no payload and does not change the
 * document.
 */
export const TAP_CLEAR_VISUAL_BLOCK_SELECTION = stateAction(
  "tap-clear-visual-block-selection",
  (state) => ({ state: clearSelection(state), ops: [] }),
);

// ─── Image-node overlay toggle ───────────────────────────────────────────────

/**
 * Opens a host overlay for an image, such as the upload popover on a
 * placeholder image. The handler asks the node which overlay to open and passes
 * its `key` and `data`, the block id, and the tap `point`. Does not change the
 * document.
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
 * Closes the open overlay (or any open editor menu). Touch handling dispatches
 * it when you tap an image whose overlay is already open. Does not change the
 * document.
 */
export const CLOSE_NODE_OVERLAY = stateAction(
  "close-node-overlay",
  (state) => ({ state: closeActiveMenu(state), ops: [] }),
);

// ─── Multi-tap word/line selection ───────────────────────────────────────────

/**
 * Triple-tap: selects the whole line at the tap, even inside an existing
 * selection. The handler resolves `position`. Does not change the document.
 */
// Named TAP_* (vs the mouse SELECT_LINE_AT_POINT) for the touch convention.
export const TAP_SELECT_LINE = stateAction<PositionPayload>(
  "tap-select-line",
  (state, { position }) => ({
    state: selectLineAtPosition(state, position),
    ops: [],
  }),
);

/**
 * Double-tap: selects the word at the tap and closes an open context menu. The
 * handler resolves `position`. It can also pass a ready-made `range` when the
 * node under the finger picks the word itself, such as a formula. Does not
 * change the document.
 */
// Named TAP_* (vs the mouse SELECT_WORD_AT_POINT) for the touch convention.
export const TAP_SELECT_WORD = stateAction<
  PositionPayload & {
    /**
     * A pre-resolved word/token range (block-text indices), when the node under
     * the tap selects by POINT rather than by the `position` offset — a math block
     * resolves the atom the finger is on, and an inline-math chip resolves the
     * construct under the finger (an atomic command like `\det` is reachable ONLY
     * by point). See `getWordRangeFromViewport`. The math node's handler consumes
     * it for a math block; for a text block carrying a chip it is threaded into the
     * word-select here.
     */
    range?: { start: number; end: number };
  }
>("tap-select-word", (state, { position, range }) => {
  const next = selectWordAtPosition(state, position, range);
  // Host-owned context menu: signal it to close (no-op if none is open).
  state.actionBus.dispatch(CLOSE_CONTEXT_MENU);
  return { state: next, ops: [] };
});

// ─── Tap-place-cursor ────────────────────────────────────────────────────────

/**
 * Single tap: clears any selection, places the caret at the tap, switches to
 * edit mode, and closes an open context menu. A tap inside an existing
 * selection lands here too, as in native editors: it drops the selection and
 * moves the caret. Long-press opens the menu instead.
 *
 * The handler resolves `position`. When it also passes a `contentSelection` (a
 * caret inside a node such as a formula), that caret is used instead. Does not
 * change the document.
 */
export const TAP_PLACE_CURSOR = stateAction<PositionPayload>(
  "tap-place-cursor",
  (state, { position, contentSelection }) => {
    if (contentSelection) {
      let next = updateContentSelection(state, contentSelection);
      if (next.document.contentSelection) {
        next = updateMode(next, "edit");
        state.actionBus.dispatch(CLOSE_CONTEXT_MENU);
        return { state: next, ops: [] };
      }
    }
    let next = clearSelection(state);
    next = updateCursor(next, position);
    next = updateMode(next, "edit");
    // Host-owned context menu: signal it to close (no-op if none is open).
    state.actionBus.dispatch(CLOSE_CONTEXT_MENU);
    return { state: next, ops: [] };
  },
);

/**
 * Tap outside the content, where there is no text: clears the selection,
 * switches to edit mode, and closes an open context menu. Does not change the
 * document.
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
 * Asks the host to open the context menu at the pixel `point`. Touch handling
 * dispatches it when a long-press ends without a drag, or when you hold the
 * caret without moving it (the paste menu on phones). The editor does not draw
 * the menu. It dispatches {@link OPEN_CONTEXT_MENU} with the point and whether
 * something is selected, and leaves the editor state as it is.
 */
// Kept as a thin state-action shim so the touch call sites stay uniform; the
// engine flips its own capture flag when the host menu opens.
export const OPEN_CONTEXT_MENU_AT = stateAction<{
  point: { x: number; y: number };
}>("open-context-menu-at", (state, { point }) => {
  state.actionBus.dispatch(OPEN_CONTEXT_MENU, {
    x: point.x,
    y: point.y,
    // A ranged selection counts whichever model holds it: the flat block range
    // or a nested structured range (a held construct inside structured math).
    hasSelection:
      !!getSelectionRange(state) ||
      (!!state.document.contentSelection &&
        !isContentSelectionCollapsed(state.document.contentSelection)),
    // The caret the long-press landed, or a held range's focus.
    point: docSelectionFocus(state) ?? undefined,
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
