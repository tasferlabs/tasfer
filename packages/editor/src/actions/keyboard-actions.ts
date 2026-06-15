/**
 * Editor **keyboard actions** — the cursor-movement and selection-extension
 * actions the key handlers used to inline, lifted into named, dispatchable
 * {@link StateAction}s.
 *
 * A state action is the low-level action shape: its default behavior is a
 * pure `(state) => { state, ops }` transform (see `action-bus.ts`), which is
 * exactly the currency the event pipeline already trades in. That lets it
 * express moves a {@link MutationAction}'s `ChangeApi` can't — e.g. a
 * cursor/selection change that emits no CRDT ops. Handlers dispatch these via
 * `state.actionBus.dispatchState(...)`, so hosts/plugins can observe or
 * override them, and the engine's logic lives in one named place instead of
 * being scattered across the switch statements in `keysEvents.ts`.
 *
 * Helper policy: a move that is shared with other modules (e.g. `moveCursorLeft`
 * is part of the public `editor.ts` API, `moveToLineStart` is reused by the
 * extend-to-line actions) is imported from its home module. A helper whose only
 * call site was the key handler — the whole `extendSelection*` family — has its
 * body inlined directly into the action below, so the logic lives in one place
 * rather than behind a single-use indirection.
 */

import { stateAction } from "../action-bus";
import {
  clearSelection,
  moveCursorDown,
  moveCursorLeft,
  moveCursorPageDown,
  moveCursorPageUp,
  moveCursorRight,
  moveCursorToPosition,
  moveCursorUp,
  startSelection,
  updateSelectionFocus,
} from "../selection";
import type { ViewportState } from "../state-types";
import { getBlockTextLength } from "../state-utils";
import {
  moveToLineEnd,
  moveToLineStart,
  moveToNextWord,
  moveToPreviousWord,
} from "./actions";

/** Payload for the vertical/page moves — they need the viewport to resolve the
 * target visual line. */
interface ViewportPayload {
  viewport: ViewportState;
}

// ─── Caret moves (collapse selection, no ops) ────────────────────────────────

/**
 * Move the caret one position to the left, collapsing any active selection
 * first. Emits no ops — a pure cursor move. This is the atomic left-arrow
 * primitive; the surrounding ArrowLeft special cases (selection collapse,
 * visual-block selection) remain in the handler for now and will be migrated
 * into their own actions over time.
 */
export const MOVE_CURSOR_LEFT = stateAction("move-cursor-left", (state) => ({
  state: moveCursorLeft(clearSelection(state)),
  ops: [],
}));

/**
 * Mirror of {@link MOVE_CURSOR_LEFT}: move the caret one position to the right,
 * collapsing any active selection first. Pure cursor move, no ops.
 */
export const MOVE_CURSOR_RIGHT = stateAction("move-cursor-right", (state) => ({
  state: moveCursorRight(clearSelection(state)),
  ops: [],
}));

/**
 * Move the caret up one visual line (ArrowUp), collapsing any active selection
 * first. Pure cursor move, no ops.
 */
export const MOVE_CURSOR_UP = stateAction<ViewportPayload>(
  "move-cursor-up",
  (state, { viewport }) => ({
    state: moveCursorUp(clearSelection(state), viewport),
    ops: [],
  }),
);

/**
 * Move the caret down one visual line (ArrowDown), collapsing any active
 * selection first. Pure cursor move, no ops.
 */
export const MOVE_CURSOR_DOWN = stateAction<ViewportPayload>(
  "move-cursor-down",
  (state, { viewport }) => ({
    state: moveCursorDown(clearSelection(state), viewport),
    ops: [],
  }),
);

/**
 * Move the caret up one viewport page (PageUp), collapsing any active selection
 * first. Pure cursor move, no ops.
 */
export const MOVE_CURSOR_PAGE_UP = stateAction<ViewportPayload>(
  "move-cursor-page-up",
  (state, { viewport }) => ({
    state: moveCursorPageUp(clearSelection(state), viewport),
    ops: [],
  }),
);

/**
 * Move the caret down one viewport page (PageDown), collapsing any active
 * selection first. Pure cursor move, no ops.
 */
export const MOVE_CURSOR_PAGE_DOWN = stateAction<ViewportPayload>(
  "move-cursor-page-down",
  (state, { viewport }) => ({
    state: moveCursorPageDown(clearSelection(state), viewport),
    ops: [],
  }),
);

// ─── Word jumps (Ctrl/Cmd + Arrow) ───────────────────────────────────────────

/**
 * Jump the caret to the start of the previous word (Ctrl/Cmd+ArrowLeft),
 * collapsing any active selection first. Pure cursor move, no ops.
 */
export const MOVE_TO_PREVIOUS_WORD = stateAction(
  "move-to-previous-word",
  (state) => ({
    state: moveToPreviousWord(clearSelection(state)),
    ops: [],
  }),
);

/**
 * Jump the caret to the start of the next word (Ctrl/Cmd+ArrowRight),
 * collapsing any active selection first. Pure cursor move, no ops.
 */
export const MOVE_TO_NEXT_WORD = stateAction("move-to-next-word", (state) => ({
  state: moveToNextWord(clearSelection(state)),
  ops: [],
}));

// ─── Line / document edges (Home / End) ──────────────────────────────────────

/**
 * Move the caret to the start of the current line (Home), collapsing any active
 * selection first. Pure cursor move, no ops.
 */
export const MOVE_TO_LINE_START = stateAction(
  "move-to-line-start",
  (state) => ({
    state: moveToLineStart(clearSelection(state)),
    ops: [],
  }),
);

/**
 * Move the caret to the end of the current line (End), collapsing any active
 * selection first. Pure cursor move, no ops.
 */
export const MOVE_TO_LINE_END = stateAction("move-to-line-end", (state) => ({
  state: moveToLineEnd(clearSelection(state)),
  ops: [],
}));

/**
 * Move the caret to the very start of the document (Ctrl/Cmd+Home), collapsing
 * any active selection first. Pure cursor move, no ops.
 */
export const MOVE_TO_DOCUMENT_START = stateAction(
  "move-to-document-start",
  (state) => ({
    state: moveCursorToPosition(clearSelection(state), 0, 0),
    ops: [],
  }),
);

/**
 * Move the caret to the very end of the document (Ctrl/Cmd+End) — the end of the
 * last visible block — collapsing any active selection first. Pure cursor move,
 * no ops.
 */
export const MOVE_TO_DOCUMENT_END = stateAction(
  "move-to-document-end",
  (state) => {
    const cleared = clearSelection(state);
    const visibleBlocks = cleared.view.visibleBlocks;
    if (visibleBlocks.length === 0) return { state: cleared, ops: [] };
    const lastVisibleBlock = visibleBlocks[visibleBlocks.length - 1];
    const lastVisibleBlockIndex = cleared.document.page.blocks.findIndex(
      (b) => b.id === lastVisibleBlock.id,
    );
    if (lastVisibleBlockIndex === -1) return { state: cleared, ops: [] };
    return {
      state: moveCursorToPosition(
        cleared,
        lastVisibleBlockIndex,
        getBlockTextLength(lastVisibleBlock),
      ),
      ops: [],
    };
  },
);

// ─── Selection extension (Shift + move) ──────────────────────────────────────
//
// Each of these had a single call site (the key handler), so the former
// `extendSelection*` helper bodies are inlined here. They share one shape:
// start a selection at the caret if none exists, run the underlying caret move,
// then drag the selection focus to the new caret position.

/** Extend the selection one position to the left (Shift+ArrowLeft). */
export const EXTEND_SELECTION_LEFT = stateAction(
  "extend-selection-left",
  (state) => {
    if (!state.document.cursor) return { state, ops: [] };
    const base = state.document.selection
      ? state
      : startSelection(state, state.document.cursor.position);
    const moved = moveCursorLeft(base);
    if (moved.document.cursor) {
      return {
        state: updateSelectionFocus(moved, moved.document.cursor.position),
        ops: [],
      };
    }
    return { state: base, ops: [] };
  },
);

/** Extend the selection one position to the right (Shift+ArrowRight). */
export const EXTEND_SELECTION_RIGHT = stateAction(
  "extend-selection-right",
  (state) => {
    if (!state.document.cursor) return { state, ops: [] };
    const base = state.document.selection
      ? state
      : startSelection(state, state.document.cursor.position);
    const moved = moveCursorRight(base);
    if (moved.document.cursor) {
      return {
        state: updateSelectionFocus(moved, moved.document.cursor.position),
        ops: [],
      };
    }
    return { state: base, ops: [] };
  },
);

/** Extend the selection up one visual line (Shift+ArrowUp). */
export const EXTEND_SELECTION_UP = stateAction<ViewportPayload>(
  "extend-selection-up",
  (state, { viewport }) => {
    if (!state.document.cursor) return { state, ops: [] };
    const base = state.document.selection
      ? state
      : startSelection(state, state.document.cursor.position);
    const moved = moveCursorUp(base, viewport);
    if (moved.document.cursor) {
      return {
        state: updateSelectionFocus(moved, moved.document.cursor.position),
        ops: [],
      };
    }
    return { state: base, ops: [] };
  },
);

/** Extend the selection down one visual line (Shift+ArrowDown). */
export const EXTEND_SELECTION_DOWN = stateAction<ViewportPayload>(
  "extend-selection-down",
  (state, { viewport }) => {
    if (!state.document.cursor) return { state, ops: [] };
    const base = state.document.selection
      ? state
      : startSelection(state, state.document.cursor.position);
    const moved = moveCursorDown(base, viewport);
    if (moved.document.cursor) {
      return {
        state: updateSelectionFocus(moved, moved.document.cursor.position),
        ops: [],
      };
    }
    return { state: base, ops: [] };
  },
);

/** Extend the selection up one viewport page (Shift+PageUp). */
export const EXTEND_SELECTION_PAGE_UP = stateAction<ViewportPayload>(
  "extend-selection-page-up",
  (state, { viewport }) => {
    if (!state.document.cursor) return { state, ops: [] };
    const base = state.document.selection
      ? state
      : startSelection(state, state.document.cursor.position);
    const moved = moveCursorPageUp(base, viewport);
    if (moved.document.cursor) {
      return {
        state: updateSelectionFocus(moved, moved.document.cursor.position),
        ops: [],
      };
    }
    return { state: base, ops: [] };
  },
);

/** Extend the selection down one viewport page (Shift+PageDown). */
export const EXTEND_SELECTION_PAGE_DOWN = stateAction<ViewportPayload>(
  "extend-selection-page-down",
  (state, { viewport }) => {
    if (!state.document.cursor) return { state, ops: [] };
    const base = state.document.selection
      ? state
      : startSelection(state, state.document.cursor.position);
    const moved = moveCursorPageDown(base, viewport);
    if (moved.document.cursor) {
      return {
        state: updateSelectionFocus(moved, moved.document.cursor.position),
        ops: [],
      };
    }
    return { state: base, ops: [] };
  },
);

/** Extend the selection to the previous word boundary (Ctrl/Cmd+Shift+ArrowLeft). */
export const EXTEND_SELECTION_WORD_LEFT = stateAction(
  "extend-selection-word-left",
  (state) => {
    if (!state.document.cursor) return { state, ops: [] };
    const base = state.document.selection
      ? state
      : startSelection(state, state.document.cursor.position);
    const moved = moveToPreviousWord(base);
    if (moved.document.cursor) {
      return {
        state: updateSelectionFocus(moved, moved.document.cursor.position),
        ops: [],
      };
    }
    return { state: base, ops: [] };
  },
);

/** Extend the selection to the next word boundary (Ctrl/Cmd+Shift+ArrowRight). */
export const EXTEND_SELECTION_WORD_RIGHT = stateAction(
  "extend-selection-word-right",
  (state) => {
    if (!state.document.cursor) return { state, ops: [] };
    const base = state.document.selection
      ? state
      : startSelection(state, state.document.cursor.position);
    const moved = moveToNextWord(base);
    if (moved.document.cursor) {
      return {
        state: updateSelectionFocus(moved, moved.document.cursor.position),
        ops: [],
      };
    }
    return { state: base, ops: [] };
  },
);

/**
 * Extend the selection to the line start, or to the document start when
 * `isCtrl` (Shift+Home / Ctrl+Shift+Home).
 */
export const EXTEND_SELECTION_HOME = stateAction<{ isCtrl: boolean }>(
  "extend-selection-home",
  (state, { isCtrl }) => {
    if (!state.document.cursor) return { state, ops: [] };
    const base = state.document.selection
      ? state
      : startSelection(state, state.document.cursor.position);
    const moved = isCtrl
      ? moveCursorToPosition(base, 0, 0)
      : moveToLineStart(base);
    if (moved.document.cursor) {
      return {
        state: updateSelectionFocus(moved, moved.document.cursor.position),
        ops: [],
      };
    }
    return { state: base, ops: [] };
  },
);

/**
 * Extend the selection to the line end, or to the document end when `isCtrl`
 * (Shift+End / Ctrl+Shift+End).
 */
export const EXTEND_SELECTION_END = stateAction<{ isCtrl: boolean }>(
  "extend-selection-end",
  (state, { isCtrl }) => {
    if (!state.document.cursor) return { state, ops: [] };
    const base = state.document.selection
      ? state
      : startSelection(state, state.document.cursor.position);

    let moved = base;
    if (isCtrl) {
      // Document end: jump to the end of the last visible block.
      const visibleBlocks = base.view.visibleBlocks;
      if (visibleBlocks.length > 0) {
        const lastVisibleBlock = visibleBlocks[visibleBlocks.length - 1];
        const lastVisibleBlockIndex = base.document.page.blocks.findIndex(
          (b) => b.id === lastVisibleBlock.id,
        );
        if (lastVisibleBlockIndex !== -1) {
          moved = moveCursorToPosition(
            base,
            lastVisibleBlockIndex,
            getBlockTextLength(lastVisibleBlock),
          );
        }
      }
    } else {
      moved = moveToLineEnd(base);
    }

    if (moved.document.cursor) {
      return {
        state: updateSelectionFocus(moved, moved.document.cursor.position),
        ops: [],
      };
    }
    return { state: base, ops: [] };
  },
);
