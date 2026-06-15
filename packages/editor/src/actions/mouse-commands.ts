/**
 * Editor **mouse commands** — the discrete, mostly-pure pointer interactions the
 * mouse handlers used to inline, lifted into named, dispatchable
 * {@link StateCommand}s. Sibling to `keyboard-commands.ts` (cursor/selection key
 * moves) and `edit-commands.ts` (content edits); this file holds the click,
 * hover, and scroll transforms dispatched from `mouseEvents.ts`.
 *
 * A state command is the low-level command shape: its default behavior is a pure
 * `(state) => { state, ops }` transform (see `command-bus.ts`), exactly the
 * currency the event pipeline already trades in. That lets hosts/plugins observe
 * or override each interaction, and keeps the engine's logic in one named place
 * instead of being scattered across the long switch-like sequence in
 * `handleMouseDown`/`handleMouseMove`. Handlers dispatch these via
 * `state.commandBus.dispatchState(...)`.
 *
 * Geometry policy: a `StateCommand` must stay pure over `EditorState`, so it
 * never hit-tests. The handler in `mouseEvents.ts` resolves the click against the
 * viewport (text position, atomic-block hit, inline-math span, drag-handle) and
 * passes the resolved data in via the payload. Most of these emit no ops — they
 * are cursor/selection/UI-only changes; only the placeholder/overlay openings and
 * visual-block selections touch document position, and none emit CRDT ops.
 */

import {
  selectLineAtPosition,
  selectWordAtPosition,
} from "../actions/commands";
import { stateCommand } from "../command-bus";
import {
  clearSelection,
  startSelection,
  updateCursor,
  updateSelectionFocus,
} from "../selection";
import type { ActiveMenu, ImageHoverState, Position } from "../state-types";
import { setActiveMenu, updateMode } from "../state-utils";

/** An inline-math chip's highlight range (engine-owned hover state). */
interface InlineMathHover {
  blockIndex: number;
  startIndex: number;
  endIndex: number;
}

// ─── Cursor placement (single click) ─────────────────────────────────────────

/**
 * Place the caret at a resolved text position (single click). With `extend`
 * (Shift held and a selection already exists) the active selection's focus is
 * dragged to the position; otherwise a fresh selection is started at the caret
 * and the editor enters `select` mode (drag-to-select). Pure, no ops.
 */
export const PLACE_CURSOR_AT_POINT = stateCommand<{
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
export const PLACE_CURSOR_IN_SIDE_PADDING = stateCommand<{
  position: Position;
}>("place-cursor-in-side-padding", (state, { position }) => {
  let newState = clearSelection(state);
  newState = updateCursor(newState, position);
  return { state: updateMode(newState, "edit"), ops: [] };
});

// ─── Word / line selection (double / triple click) ───────────────────────────

/** Select the whole word at a resolved position (double-click). Pure, no ops. */
export const SELECT_WORD_AT_POINT = stateCommand<{ position: Position }>(
  "select-word-at-point",
  (state, { position }) => ({
    state: selectWordAtPosition(state, position),
    ops: [],
  }),
);

/** Select the whole line at a resolved position (triple-click). Pure, no ops. */
export const SELECT_LINE_AT_POINT = stateCommand<{ position: Position }>(
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
export const SELECT_VISUAL_BLOCK = stateCommand<{
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
export const CLEAR_VISUAL_BLOCK_SELECTION = stateCommand(
  "clear-visual-block-selection",
  (state) => ({ state: clearSelection(state), ops: [] }),
);

// ─── Padding / outside clicks ────────────────────────────────────────────────

/**
 * Clear the selection on a click in the top padding area, switching to `edit`
 * mode. Pure, no ops.
 */
export const CLEAR_SELECTION_IN_PADDING = stateCommand(
  "clear-selection-in-padding",
  (state) => ({ state: updateMode(clearSelection(state), "edit"), ops: [] }),
);

// ─── Host overlay openings (image placeholder / math editor / inline math) ───

/**
 * Open a host overlay anchored at a block — the image-upload placeholder popover
 * or the block-math editor. The handler asks the node whether activation opens an
 * overlay and resolves the full `overlay` menu (key/data/anchor); this command
 * just installs it. Pure, no ops.
 */
export const OPEN_BLOCK_OVERLAY = stateCommand<{
  overlay: Extract<ActiveMenu, { type: "overlay" }>;
}>("open-block-overlay", (state, { overlay }) => ({
  state: setActiveMenu(state, overlay),
  ops: [],
}));

/**
 * Open the inline-math edit popover for a clicked chip and highlight that chip
 * while the popover is open. The handler resolves the overlay menu (host `math`
 * mark's key + the chip's range as `data`) and the matching hover range. Pure,
 * no ops.
 */
export const OPEN_INLINE_MATH_OVERLAY = stateCommand<{
  overlay: Extract<ActiveMenu, { type: "overlay" }>;
  hover: InlineMathHover;
}>("open-inline-math-overlay", (state, { overlay, hover }) => {
  const withOverlay = setActiveMenu(state, overlay);
  return {
    state: {
      ...withOverlay,
      ui: { ...withOverlay.ui, inlineMathHover: hover },
    },
    ops: [],
  };
});

// ─── Hover state (handleMouseMove) ───────────────────────────────────────────
//
// Pure view/UI updates fired as the pointer moves. The handler resolves the hit
// (image block + drag handle, math block, inline-math chip, link) and passes the
// resolved hover payload; these commands install it idempotently.

/**
 * Set or clear the image hover overlay (the resize-handle chrome). The handler
 * passes the resolved `ImageHoverState` (or `null` to clear). Pure, no ops.
 */
export const SET_IMAGE_HOVER = stateCommand<{
  imageHover: ImageHoverState | null;
}>("set-image-hover", (state, { imageHover }) => {
  if (imageHover === null) {
    if (state.ui.imageHover === null) return { state, ops: [] };
    return {
      state: { ...state, ui: { ...state.ui, imageHover: null } },
      ops: [],
    };
  }
  return { state: { ...state, ui: { ...state.ui, imageHover } }, ops: [] };
});

/** Set or clear the hovered block-math index (full-block backdrop). Pure, no ops. */
export const SET_MATH_BLOCK_HOVER = stateCommand<{ blockIndex: number | null }>(
  "set-math-block-hover",
  (state, { blockIndex }) => {
    if (blockIndex === state.ui.hoveredMathBlockIndex)
      return { state, ops: [] };
    return {
      state: {
        ...state,
        ui: { ...state.ui, hoveredMathBlockIndex: blockIndex },
      },
      ops: [],
    };
  },
);

/**
 * Set or clear the inline-math chip hover highlight. The handler resolves the
 * chip range under the pointer (or `null`); this installs it only when the range
 * actually changed. Pure, no ops.
 */
export const SET_INLINE_MATH_HOVER = stateCommand<{
  hover: InlineMathHover | null;
}>("set-inline-math-hover", (state, { hover }) => {
  const prev = state.ui.inlineMathHover;
  const changed =
    (prev === null) !== (hover === null) ||
    (prev &&
      hover &&
      (prev.blockIndex !== hover.blockIndex ||
        prev.startIndex !== hover.startIndex ||
        prev.endIndex !== hover.endIndex));
  if (!changed) return { state, ops: [] };
  return {
    state: { ...state, ui: { ...state.ui, inlineMathHover: hover } },
    ops: [],
  };
});
