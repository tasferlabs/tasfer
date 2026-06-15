/**
 * Editor **touch commands** — the discrete tap / long-press / scroll actions the
 * touch handlers used to inline, lifted into named, dispatchable
 * {@link StateCommand}s.
 *
 * A state command is the low-level command shape: its default behavior is a
 * pure `(state) => { state, ops }` transform (see `command-bus.ts`), which is
 * exactly the currency the event pipeline already trades in. Most touch actions
 * are pure cursor/selection/view moves and emit no ops; the one that creates a
 * paragraph below a trailing image emits a single `block_insert`. Handlers
 * dispatch these via `state.commandBus.dispatchState(...)`, so hosts/plugins can
 * observe or override them, and the engine's logic lives in one named place
 * instead of being scattered across the switch statements in `touchEvents.ts`.
 *
 * Payload policy: a {@link StateCommand} must stay pure over {@link EditorState},
 * but the touch handlers resolve pixel positions, hit-test viewport coordinates,
 * and read per-instance pointer `session` state. Anything that needs the
 * viewport, a resolved hit-test, or a `session`-derived value is computed in the
 * handler and threaded in via the payload, so the command body itself only reads
 * and derives from the `state` it is handed.
 */

import { stateCommand } from "../command-bus";
import {
  clearSelection,
  moveCursorToPosition,
  updateCursor,
} from "../selection";
import { type Block } from "../serlization/loadPage";
import type { CRDTbinding, Operation, Position } from "../state-types";
import {
  closeActiveMenu,
  openContextMenu,
  setActiveMenu,
  updateMode,
} from "../state-utils";
import { isTextualBlock } from "../sync/block-registry";
import { selectLineAtPosition, selectWordAtPosition } from "./commands";

/** A resolved text position from {@link getTextPositionFromViewport}. */
interface PositionPayload {
  position: Position;
}

/** A resolved hit position plus the pixel point the tap landed at. */
interface PointPayload {
  position: Position;
  point: { x: number; y: number };
}

// ─── Padding taps (clear / reposition, no ops) ───────────────────────────────

/**
 * Tap in the top padding area above the first block: clear any selection, drop
 * back to edit mode, and close an open context menu. Pure, no ops.
 */
export const TAP_TOP_PADDING = stateCommand("tap-top-padding", (state) => {
  let next = clearSelection(state);
  next = updateMode(next, "edit");
  if (next.ui.activeMenu.type === "contextMenu") {
    next = closeActiveMenu(next);
  }
  return { state: next, ops: [] };
});

/**
 * Tap in the left/right padding gutter: position the caret at the resolved
 * start/end-of-line `position`, clear any selection, drop to edit mode, and
 * close an open context menu. The handler resolves `position` from the tap
 * point. Pure, no ops.
 */
export const TAP_SIDE_PADDING = stateCommand<PositionPayload>(
  "tap-side-padding",
  (state, { position }) => {
    let next = clearSelection(state);
    next = updateCursor(next, position);
    next = updateMode(next, "edit");
    if (next.ui.activeMenu.type === "contextMenu") {
      next = closeActiveMenu(next);
    }
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
export const TAP_SELECT_VISUAL_BLOCK = stateCommand<PositionPayload>(
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
export const TAP_CLEAR_VISUAL_BLOCK_SELECTION = stateCommand(
  "tap-clear-visual-block-selection",
  (state) => ({ state: clearSelection(state), ops: [] }),
);

// ─── Image-node overlay toggle ───────────────────────────────────────────────

/**
 * Open a host overlay for an image node's activation (e.g. a placeholder image's
 * upload popover). The handler asks the node whether activation opens an overlay
 * and passes the resolved `key`/`data`, the block index, and the tap point.
 * Pure, no ops.
 */
export const OPEN_NODE_OVERLAY = stateCommand<{
  key: string;
  blockIndex: number;
  point: { x: number; y: number };
  data: unknown;
}>("open-node-overlay", (state, { key, blockIndex, point, data }) => ({
  state: setActiveMenu(state, {
    type: "overlay",
    key,
    blockIndex,
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
export const CLOSE_NODE_OVERLAY = stateCommand(
  "close-node-overlay",
  (state) => ({ state: closeActiveMenu(state), ops: [] }),
);

// ─── Trailing-image paragraph creation (emits a block_insert) ────────────────

/**
 * Tap below a trailing image block: append a new empty paragraph after it and
 * place the caret in it. This is the one touch action that mutates the document,
 * so it emits a single `block_insert`. The handler supplies the `afterBlock`
 * (the trailing image), its index, and the per-instance {@link CRDTbinding} used
 * to mint the new block + op ids.
 */
export const CREATE_PARAGRAPH_BELOW_IMAGE = stateCommand<{
  afterBlock: Block;
  afterBlockIndex: number;
  binding: CRDTbinding;
}>(
  "create-paragraph-below-image",
  (state, { afterBlock, afterBlockIndex, binding }) => {
    const newParagraphId = binding.nextId();
    const newParagraph: Block = {
      id: newParagraphId,
      afterId: afterBlock.id,
      type: "paragraph",
      charRuns: [],
      formats: [],
    };

    const blockInsertOp: Operation = {
      op: "block_insert",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      afterBlockId: afterBlock.id,
      blockId: newParagraphId,
      blockType: "paragraph",
    };

    const newBlocks = [...state.document.page.blocks, newParagraph];
    const newPage = { ...state.document.page, blocks: newBlocks };

    let next = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    next = clearSelection(next);
    next = moveCursorToPosition(next, afterBlockIndex + 1, 0);
    next = updateMode(next, "edit");

    return { state: next, ops: [blockInsertOp] };
  },
);

// ─── Multi-tap word/line selection ───────────────────────────────────────────

/**
 * Triple-tap: select the whole line at the tap position (fires even inside an
 * existing selection). The handler resolves `position`. Pure, no ops.
 */
export const SELECT_LINE = stateCommand<PositionPayload>(
  "select-line",
  (state, { position }) => ({
    state: selectLineAtPosition(state, position),
    ops: [],
  }),
);

/**
 * Double-tap: select the word at the tap position, closing an open context menu
 * (a new selection supersedes it). The handler resolves `position`. Pure, no
 * ops.
 */
export const SELECT_WORD = stateCommand<PositionPayload>(
  "select-word",
  (state, { position }) => {
    let next = selectWordAtPosition(state, position);
    if (next.ui.activeMenu.type === "contextMenu") {
      next = closeActiveMenu(next);
    }
    return { state: next, ops: [] };
  },
);

// ─── Tap-on-selection / tap-place-cursor ─────────────────────────────────────

/**
 * Tap landing inside an existing selection: keep the selection but move the
 * caret to the tap position, and open the context menu (mobile paste UX) if one
 * isn't already open. The handler resolves `position` and supplies the tap
 * `point` the menu anchors to. Pure, no ops.
 */
export const TAP_ON_SELECTION = stateCommand<PointPayload>(
  "tap-on-selection",
  (state, { position, point }) => {
    let next = updateCursor(state, position);
    if (next.ui.activeMenu.type !== "contextMenu") {
      next = openContextMenu(next, point.x, point.y);
    }
    return { state: next, ops: [] };
  },
);

/**
 * Single tap outside any selection: clear the selection, place the caret at the
 * tap position, drop to edit mode, and close an open context menu. The handler
 * resolves `position`. Pure, no ops.
 */
export const TAP_PLACE_CURSOR = stateCommand<PositionPayload>(
  "tap-place-cursor",
  (state, { position }) => {
    let next = clearSelection(state);
    next = updateCursor(next, position);
    next = updateMode(next, "edit");
    if (next.ui.activeMenu.type === "contextMenu") {
      next = closeActiveMenu(next);
    }
    return { state: next, ops: [] };
  },
);

/**
 * Tap that resolves to no text position (outside the editor's content area):
 * clear the selection, drop to edit mode, and close an open context menu. Pure,
 * no ops.
 */
export const TAP_OUTSIDE_CONTENT = stateCommand(
  "tap-outside-content",
  (state) => {
    let next = clearSelection(state);
    next = updateMode(next, "edit");
    if (next.ui.activeMenu.type === "contextMenu") {
      next = closeActiveMenu(next);
    }
    return { state: next, ops: [] };
  },
);

// ─── Long-press / cursor-drag context menu ───────────────────────────────────

/**
 * Open the context menu at a resolved tap/long-press point. Shared by the
 * long-press-without-drag release and the cursor-drag-held-without-move release
 * (mobile's long-press-on-cursor = paste menu). The handler supplies the
 * pixel `point`. Pure, no ops.
 */
export const OPEN_CONTEXT_MENU_AT = stateCommand<{
  point: { x: number; y: number };
}>("open-context-menu-at", (state, { point }) => ({
  state: openContextMenu(state, point.x, point.y),
  ops: [],
}));

/**
 * Finish a long-press drag-selection: clear the selection's `initialBoundary`
 * marker and drop from select mode back to edit. Pure, no ops.
 */
export const FINISH_SELECT_MODE = stateCommand(
  "finish-select-mode",
  (state) => {
    let next = state;
    if (next.document.selection?.initialBoundary) {
      next = {
        ...next,
        document: {
          ...next.document,
          selection: next.document.selection
            ? { ...next.document.selection, initialBoundary: undefined }
            : null,
        },
      };
    }
    next = updateMode(next, "edit");
    return { state: next, ops: [] };
  },
);

/** Whether the spanned block of the current selection is a non-textual visual
 * block — used by the handler to gate {@link CLEAR_VISUAL_BLOCK_SELECTION}. */
export function isVisualBlockSelection(
  block: Block | undefined,
): block is Block {
  return !!block && !block.deleted && !isTextualBlock(block);
}
