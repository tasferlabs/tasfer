/**
 * Editor **mouse actions** — the discrete, mostly-pure pointer interactions the
 * mouse handlers used to inline, lifted into named, dispatchable
 * {@link StateAction}s. Sibling to `keyboard-actions.ts` (cursor/selection key
 * moves) and `edit-actions.ts` (content edits); this file holds the click,
 * hover, and scroll transforms dispatched from `mouseEvents.ts`.
 *
 * A state action is the low-level action shape: its default behavior is a pure
 * `(state) => { state, ops }` transform (see `action-bus.ts`), exactly the
 * currency the event pipeline already trades in. That lets hosts/plugins observe
 * or override each interaction, and keeps the engine's logic in one named place
 * instead of being scattered across the long switch-like sequence in
 * `handleMouseDown`/`handleMouseMove`. Handlers dispatch these via
 * `state.actionBus.dispatchState(...)`.
 *
 * Geometry policy: a `StateAction` must stay pure over `EditorState`, so it
 * never hit-tests. The handler in `mouseEvents.ts` resolves the click against the
 * viewport (text position, atomic-block hit, inline-math span, drag-handle) and
 * passes the resolved data in via the payload. Most of these emit no ops — they
 * are cursor/selection/UI-only changes; only the placeholder/overlay openings and
 * visual-block selections touch document position, and none emit CRDT ops.
 */

import { stateAction } from "../action-bus";
import { selectLineAtPosition, selectWordAtPosition } from "../actions/actions";
import {
  clearSelection,
  startSelection,
  updateCursor,
  updateSelectionFocus,
} from "../selection";
import type { ActiveMenu, Position } from "../state-types";
import { setActiveMenu, updateMode } from "../state-utils";

// ─── Cursor placement (single click) ─────────────────────────────────────────

/**
 * Place the caret at a resolved text position (single click). With `extend`
 * (Shift held and a selection already exists) the active selection's focus is
 * dragged to the position; otherwise a fresh selection is started at the caret
 * and the editor enters `select` mode (drag-to-select). Pure, no ops.
 */
export const PLACE_CURSOR_AT_POINT = stateAction<{
  position: Position;
  extend: boolean;
}>("place-cursor-at-point", (state, { position, extend }) => {
  let newState = updateCursor(state, position);
  if (extend) {
    newState = updateSelectionFocus(newState, position);
  } else {
    newState = startSelection(newState, position);
    newState = updateMode(newState, "select");
  }
  return { state: newState, ops: [] };
});

/**
 * Place the caret at a resolved position after a click in the left/right padding
 * gutter, clearing any active selection first and switching to `edit` mode. Pure,
 * no ops.
 */
export const PLACE_CURSOR_IN_SIDE_PADDING = stateAction<{
  position: Position;
}>("place-cursor-in-side-padding", (state, { position }) => {
  let newState = clearSelection(state);
  newState = updateCursor(newState, position);
  return { state: updateMode(newState, "edit"), ops: [] };
});

// ─── Word / line selection (double / triple click) ───────────────────────────

/** Select the whole word at a resolved position (double-click). Pure, no ops. */
export const SELECT_WORD_AT_POINT = stateAction<{
  position: Position;
  /**
   * A pre-resolved word/token range (block-text indices), when the node under the
   * pointer selects by POINT rather than by the `position` offset — a math block
   * resolves the atom the cursor is on, and an inline-math chip resolves the
   * construct under the finger (an atomic command like `\det` is reachable ONLY by
   * point). See `getWordRangeFromViewport`. The math node's own handler consumes it
   * for a math block; for a text block carrying a chip the default handler below
   * threads it into the word-select.
   */
  range?: { start: number; end: number };
}>("select-word-at-point", (state, { position, range }) => ({
  state: selectWordAtPosition(state, position, range),
  ops: [],
}));

/** Select the whole line at a resolved position (triple-click). Pure, no ops. */
export const SELECT_LINE_AT_POINT = stateAction<{ position: Position }>(
  "select-line-at-point",
  (state, { position }) => ({
    state: selectLineAtPosition(state, position),
    ops: [],
  }),
);

// ─── Visual-block selection (image / line / math click) ──────────────────────

/**
 * Select a visual (non-textual) block — image, line, or math — that was clicked.
 * Mirrors the arrow-key visual-block selection: move the caret to the block's
 * start (`textIndex 0`) and, unless `extend` drags an existing selection's focus
 * there, anchor a collapsed-false selection on the block itself. Always lands in
 * `edit` mode. The handler resolves the block hit and passes its start position.
 * Pure, no ops.
 */
export const SELECT_VISUAL_BLOCK = stateAction<{
  position: Position;
  extend: boolean;
}>("select-visual-block", (state, { position, extend }) => {
  let newState = updateCursor(state, position);
  if (extend) {
    newState = updateSelectionFocus(newState, position);
  } else {
    newState = {
      ...newState,
      document: {
        ...newState.document,
        selection: {
          anchor: position,
          focus: position,
          isForward: true,
          isCollapsed: false,
          lastUpdate: Date.now(),
        },
      },
    };
  }
  return { state: updateMode(newState, "edit"), ops: [] };
});

/**
 * Clear a lingering visual-block selection when the click landed outside the
 * selected image/line/math container (the handler has already confirmed the
 * collapsed-false selection points at a single non-textual block). Pure, no ops.
 */
export const CLEAR_VISUAL_BLOCK_SELECTION = stateAction(
  "clear-visual-block-selection",
  (state) => ({ state: clearSelection(state), ops: [] }),
);

// ─── Padding / outside clicks ────────────────────────────────────────────────

/**
 * Clear the selection on a click in the top padding area, switching to `edit`
 * mode. Pure, no ops.
 */
export const CLEAR_SELECTION_IN_PADDING = stateAction(
  "clear-selection-in-padding",
  (state) => ({ state: updateMode(clearSelection(state), "edit"), ops: [] }),
);

// ─── Host overlay openings (image placeholder / math editor) ─────────────────

/**
 * Open a host overlay anchored at a block — the image-upload placeholder popover
 * or the block-math editor. The handler asks the node whether activation opens an
 * overlay and resolves the full `overlay` menu (key/data/anchor); this action
 * just installs it. Pure, no ops.
 */
export const OPEN_BLOCK_OVERLAY = stateAction<{
  overlay: Extract<ActiveMenu, { type: "overlay" }>;
}>("open-block-overlay", (state, { overlay }) => ({
  state: setActiveMenu(state, overlay),
  ops: [],
}));

// The node-specific hover/overlay actions are co-located with the node they act
// on: image hover (SET_IMAGE_HOVER) lives in `nodes/ImageNode.ts`; the math
// hover actions (SET_MATH_BLOCK_HOVER, SET_INLINE_MATH_HOVER) live in
// `nodes/MathNode.ts`.
