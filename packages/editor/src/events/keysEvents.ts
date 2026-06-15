import { SLASH_CONFIRM, SLASH_NAVIGATE } from "../action-bus";
import {
  applySlashAction,
  deleteText,
  getSelectionRange,
  insertText,
} from "../actions/actions";
import {
  CLEAR_SELECTION,
  createParagraphAbove,
  createParagraphBelow,
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  INSERT_TEXT,
  removeAutoCreatedParagraph,
  SELECT_ALL,
  selectVisualBlockAfterMove,
  SPLIT_BLOCK,
} from "../actions/edit-actions";
import {
  EXTEND_SELECTION_DOWN,
  EXTEND_SELECTION_END,
  EXTEND_SELECTION_HOME,
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_PAGE_DOWN,
  EXTEND_SELECTION_PAGE_UP,
  EXTEND_SELECTION_RIGHT,
  EXTEND_SELECTION_UP,
  EXTEND_SELECTION_WORD_LEFT,
  EXTEND_SELECTION_WORD_RIGHT,
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_PAGE_DOWN,
  MOVE_CURSOR_PAGE_UP,
  MOVE_CURSOR_RIGHT,
  MOVE_CURSOR_UP,
  MOVE_TO_DOCUMENT_END,
  MOVE_TO_DOCUMENT_START,
  MOVE_TO_LINE_END,
  MOVE_TO_LINE_START,
  MOVE_TO_NEXT_WORD,
  MOVE_TO_PREVIOUS_WORD,
} from "../actions/keyboard-actions";
import { getCrossedInlineMathSpan } from "../inline-math";
import { TOGGLE_BOLD } from "../rendering/marks";
import { INDENT_LIST_ITEM, OUTDENT_LIST_ITEM } from "../rendering/nodes";
import { invalidateBlockCache } from "../rendering/renderer";
import { getTextDirection } from "../rtl";
import {
  getCursorDocumentCoords,
  getTextPositionFromViewport,
  scrollToMakeCursorVisible,
} from "../selection";
import { moveCursorToPosition } from "../selection";
import { updateFocus } from "../selection";
import { updateCursor } from "../selection";
import { clearSelection } from "../selection";
import { isListBlock } from "../serlization/loadPage";
import type {
  EditorState,
  KeyboardEvent,
  MouseEvent,
  SlashAction,
  ViewportState,
} from "../state-types";
import {
  clearAutoCreatedParagraph,
  closeSlashAction,
  getBlockTextContent,
  openContextMenu,
  openSlashAction,
  setActiveMenu,
  updateSlashActionFilter,
} from "../state-utils";
import { isTextualBlock } from "../sync/block-registry";
import { redoState, undoState } from "../sync/crdt-undo";
import { deleteCharsInRange } from "../sync/crdt-utils";
import type { Operation } from "../sync/sync";
import { ensureCursorVisible, isTouchDevice } from "./eventUtils";

// Open the inline-math editor popover when an arrow key crosses an inline
// math chip (snap fired between opposite boundaries).
function maybeOpenInlineMathOnArrowCross(
  prevState: EditorState,
  newState: EditorState,
  viewport: ViewportState,
): EditorState {
  const prevCursor = prevState.document.cursor;
  const newCursor = newState.document.cursor;
  if (!prevCursor || !newCursor) return newState;
  if (prevCursor.position.blockIndex !== newCursor.position.blockIndex) {
    return newState;
  }

  const block = newState.document.page.blocks[newCursor.position.blockIndex];
  if (!block || block.deleted) return newState;

  const span = getCrossedInlineMathSpan(
    block,
    prevCursor.position.textIndex,
    newCursor.position.textIndex,
  );
  if (!span) return newState;

  const coords = getCursorDocumentCoords(
    newCursor.position,
    newState,
    viewport,
  );
  if (!coords) return newState;

  // The inline-math edit overlay is host-defined; the `math` mark owns its key.
  const key = newState.marks.get("math")?.editOverlayKey;
  if (!key) return newState;
  const blockIndex = newCursor.position.blockIndex;
  const withOverlay = setActiveMenu(newState, {
    type: "overlay",
    key,
    blockIndex,
    x: coords.x,
    y: coords.y - viewport.scrollY,
    data: {
      startIndex: span.startIndex,
      endIndex: span.endIndex,
      latex: span.latex,
    },
  });
  // Highlight the edited chip while the popover is open (engine-owned hover
  // state; the host overlay reads the range from `data`).
  return {
    ...withOverlay,
    ui: {
      ...withOverlay.ui,
      inlineMathHover: {
        blockIndex,
        startIndex: span.startIndex,
        endIndex: span.endIndex,
      },
    },
  };
}

export function handleKeyDown(
  state: EditorState,
  viewport: ViewportState,
  event: Event,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  const keyEvent = event as unknown as KeyboardEvent;
  const key = keyEvent.key;
  const code = keyEvent.code;
  const isCtrl = keyEvent.ctrlKey || keyEvent.metaKey;

  // In locked mode, block all operations
  if (state.ui.mode === "locked") {
    return { state, ops };
  }

  // In readonly mode, only allow navigation, selection, and copy operations
  if (state.ui.mode === "readonly") {
    const isNavigationKey = [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "PageUp",
      "PageDown",
      "Home",
      "End",
    ].includes(key);
    const isCopy = isCtrl && code === "KeyC";
    const isSelectAll = isCtrl && code === "KeyA";
    const isEscape = key === "Escape";
    const isFind = isCtrl && code === "KeyF";

    // Allow navigation, copy, select all, find, and escape in readonly mode
    if (!isNavigationKey && !isCopy && !isSelectAll && !isEscape && !isFind) {
      return { state, ops };
    }
  }

  // If editor is not focused, ignore keyboard input
  if (!state.view.isFocused) {
    return { state, ops };
  }

  // Block most operations during composition - let IME handle input
  if (state.ui.composition?.isComposing) {
    // Block undo/redo
    if (isCtrl && (code === "KeyZ" || code === "KeyY")) {
      return { state, ops };
    }
    // Block cut operation
    if (isCtrl && code === "KeyX") {
      return { state, ops };
    }
    // Block text input keys - let IME handle all text input
    if (
      key === "Backspace" ||
      key === "Delete" ||
      key === "Enter" ||
      key === " " ||
      key === "Space"
    ) {
      return { state, ops };
    }
    // Block regular character input during composition
    if (
      key.length === 1 &&
      !keyEvent.ctrlKey &&
      !keyEvent.altKey &&
      !keyEvent.metaKey
    ) {
      return { state, ops };
    }
  }

  // Undo/Redo - handle these first, even if slash action is open
  // Use code instead of key for keyboard layout independence
  if (isCtrl && code === "KeyZ" && !keyEvent.shiftKey) {
    const result = undoState(state);
    ensureCursorVisible(result.state, state, viewport, updateViewportCallback);
    return { state: result.state, ops: result.ops };
  }
  if (isCtrl && (code === "KeyY" || (keyEvent.shiftKey && code === "KeyZ"))) {
    const result = redoState(state);
    ensureCursorVisible(result.state, state, viewport, updateViewportCallback);
    return { state: result.state, ops: result.ops };
  }

  // Select All
  if (isCtrl && code === "KeyA") {
    const result = state.actionBus.dispatchState(SELECT_ALL, state);
    ops.push(...result.ops);
    return { state: result.state, ops };
  }

  // Bold
  if (isCtrl && code === "KeyB") {
    event.preventDefault();
    const result = state.actionBus.dispatchState(TOGGLE_BOLD, state);
    ops.push(...result.ops);
    return { state: result.state, ops };
  }

  // Tab - indent/outdent list items
  if (key === "Tab") {
    if (state.document.cursor) {
      const { blockIndex: blockIndex } = state.document.cursor.position;
      const block = state.document.page.blocks[blockIndex];
      if (!block || block.deleted) return { state, ops };

      if (isListBlock(block)) {
        if (keyEvent.shiftKey) {
          // Shift+Tab: outdent
          const result = state.actionBus.dispatchState(
            OUTDENT_LIST_ITEM,
            state,
          );
          const newState = result.state;
          ops.push(...result.ops);
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback,
          );
          return { state: newState, ops };
        } else {
          // Tab: indent
          const result = state.actionBus.dispatchState(INDENT_LIST_ITEM, state);
          const newState = result.state;
          ops.push(...result.ops);
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback,
          );
          return { state: newState, ops };
        }
      }
    }
    // For non-list blocks, return state without preventing default
    return { state, ops };
  }

  // Copy/cut (Ctrl/Cmd+C / +X) are handled by the native `copy`/`cut`
  // ClipboardEvents on the input surface (see copyHandler/cutHandler in
  // editor.ts), which write the clipboard synchronously via clipboardData. They
  // are intentionally NOT intercepted here, so the keydown falls through and
  // the browser fires those events.

  // Handle slash action menu navigation
  if (state.ui.activeMenu.type === "slashAction") {
    // The host owns the action list, filtering, and the current selection.
    // The engine only relays navigation keys to it (via the action bus) and
    // applies the chosen action — it never sees the list itself.
    const slashMenu = state.ui.activeMenu;

    switch (key) {
      case "ArrowLeft":
      case "ArrowRight":
        // Close slash menu on left/right arrow and continue to normal arrow key handling
        state = closeSlashAction(state);
        break;
      case "ArrowDown":
        // Relay to the host so it moves its own highlight; consume the key so
        // the caret doesn't move.
        state.actionBus.dispatch(SLASH_NAVIGATE, { direction: "down" });
        return { state, ops };
      case "ArrowUp":
        state.actionBus.dispatch(SLASH_NAVIGATE, { direction: "up" });
        return { state, ops };
      case "Enter": {
        // Ask the host for its selected action. It calls `confirm`
        // synchronously; we apply it here, through the normal return path, so
        // the engine stays the sole writer of `state` (no mid-frame clobber
        // from the host callback). No host claim (e.g. empty list) → close.
        const picked: { action: SlashAction | null } = { action: null };
        state.actionBus.dispatch(SLASH_CONFIRM, {
          confirm: (action) => {
            picked.action = action;
          },
        });
        if (picked.action && state.document.cursor) {
          const result = applySlashAction(state, picked.action);
          const newState = result.state;
          ops.push(...result.ops);
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback,
          );
          return { state: newState, ops };
        }
        return { state: closeSlashAction(state), ops };
      }
      case "Escape":
        // Close slash action and remove the "/" character
        if (state.document.cursor) {
          const { blockIndex, textIndex } = slashMenu;
          const block = state.document.page.blocks[blockIndex];
          if (!block || block.deleted) return { state, ops };

          // Visual blocks (image/line/math) don't have text content, so guard anyway
          if (!isTextualBlock(block)) {
            return { state: closeSlashAction(state), ops };
          }

          // Remove the "/" and filter text using CRDT operations
          const { newPage } = deleteCharsInRange(
            state.document.page,
            block.id,
            textIndex - 1, // Remove the "/"
            state.document.cursor.position.textIndex, // Remove up to cursor (the filter text),
            state.CRDTbinding,
          );

          const newBlock = newPage.blocks[blockIndex];
          invalidateBlockCache(newBlock);

          let newState: EditorState = {
            ...state,
            document: { ...state.document, page: newPage },
          };
          newState = closeSlashAction(newState);
          newState = moveCursorToPosition(newState, blockIndex, textIndex - 1);

          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback,
          );
          return { state: newState, ops };
        }
        return { state: closeSlashAction(state), ops };
      case "Backspace":
        // If at the start of filter, close menu
        if (
          state.document.cursor &&
          state.ui.activeMenu.type === "slashAction" &&
          state.document.cursor.position.textIndex <=
            state.ui.activeMenu.textIndex
        ) {
          // Close menu and delete the slash character - no  needed since deleteText already records
          const deleteResult = deleteText(state);
          const newState = closeSlashAction(deleteResult.state);
          ops.push(...deleteResult.ops);
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback,
          );
          return { state: newState, ops };
        }
        // Otherwise update filter - deleteText handles  internally
        if (
          state.document.cursor &&
          state.ui.activeMenu.type === "slashAction"
        ) {
          const slashMenu = state.ui.activeMenu;
          const result = deleteText(state);
          const newState = result.state;
          ops.push(...result.ops);
          if (newState.document.cursor) {
            const block = newState.document.page.blocks[slashMenu.blockIndex];
            if (!block || block.deleted) return { state, ops };
            const text = getBlockTextContent(block);
            const filter = text.slice(
              slashMenu.textIndex,
              newState.document.cursor.position.textIndex,
            );
            const finalState = updateSlashActionFilter(newState, filter);
            ensureCursorVisible(
              finalState,
              state,
              viewport,
              updateViewportCallback,
            );
            return { state: finalState, ops };
          }
        }
        return { state, ops };
      default:
        // Handle typing to filter actions (including spaces)
        if (
          key.length === 1 &&
          !keyEvent.ctrlKey &&
          !keyEvent.altKey &&
          !keyEvent.metaKey &&
          state.ui.activeMenu.type === "slashAction"
        ) {
          const slashMenu = state.ui.activeMenu;
          // insertText handles  internally
          const result = insertText(state, key);
          ops.push(...result.ops);
          if (result.state.document.cursor) {
            const block =
              result.state.document.page.blocks[slashMenu.blockIndex];
            if (!block || block.deleted) return { state, ops };
            const text = getBlockTextContent(block);
            const filter = text.slice(
              slashMenu.textIndex,
              result.state.document.cursor.position.textIndex,
            );
            const finalState = updateSlashActionFilter(result.state, filter);
            ensureCursorVisible(
              finalState,
              state,
              viewport,
              updateViewportCallback,
            );
            return { state: finalState, ops };
          }
          return { state: result.state, ops };
        }
        return { state, ops };
    }
  }

  let newState = state;

  // Prevent navigation keys during composition (IME input)
  // These keys are used by the IME to navigate candidate characters
  const navigationKeys = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
  ];
  if (state.ui.composition?.isComposing && navigationKeys.includes(key)) {
    return { state, ops };
  }

  // Navigation & selection
  switch (key) {
    case "ArrowLeft":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (isCtrl && keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_WORD_LEFT,
          newState,
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else if (keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_LEFT,
          newState,
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else {
        // Check if we're on an image at the start of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          if (!currentBlock || currentBlock.deleted) return { state, ops };
          const visibleBlocks = state.view.visibleBlocks;
          const firstVisibleBlock =
            visibleBlocks.length > 0 ? visibleBlocks[0] : null;
          const isFirstBlock = !!(
            firstVisibleBlock && currentBlock.id === firstVisibleBlock.id
          );

          // Create a new paragraph above the visual block (no tracking on
          // ArrowLeft).
          const edge = createParagraphAbove(
            state,
            isFirstBlock,
            currentBlock,
            false,
          );
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
        }

        // Check if we should remove an auto-created paragraph (RTL: left = forward)
        {
          const edge = removeAutoCreatedParagraph(state, "rtl");
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
        }

        // If there's a selection, check if it's a visual block selection (image/line)
        const range = getSelectionRange(newState);
        const startBlock = range
          ? state.document.page.blocks[range.start.blockIndex]
          : null;
        const isVisualBlockSelection =
          range &&
          startBlock &&
          !isTextualBlock(startBlock) &&
          range.start.blockIndex === range.end.blockIndex;

        if (range && !isVisualBlockSelection) {
          // Regular text selection - determine direction for correct collapse behavior
          const selStartBlock =
            state.document.page.blocks[range.start.blockIndex];
          const selectionIsRTL =
            selStartBlock &&
            isTextualBlock(selStartBlock) &&
            getTextDirection(getBlockTextContent(selStartBlock)) === "rtl";

          if (selectionIsRTL) {
            // RTL: ArrowLeft = visual left = move to end (forward in logical order)
            newState = moveCursorToPosition(
              clearSelection(newState),
              range.end.blockIndex,
              range.end.textIndex,
            );
          } else {
            // LTR: ArrowLeft = move to start
            newState = moveCursorToPosition(
              clearSelection(newState),
              range.start.blockIndex,
              range.start.textIndex,
            );
          }
        } else if (isCtrl) {
          const moved = newState.actionBus.dispatchState(
            MOVE_TO_PREVIOUS_WORD,
            newState,
          );
          newState = moved.state;
          ops.push(...moved.ops);
        } else {
          // Dispatch the named state action so hosts/plugins can observe or
          // override it; the bus threads {state, ops} forward (no ops here —
          // a pure caret move).
          const moved = newState.actionBus.dispatchState(
            MOVE_CURSOR_LEFT,
            newState,
          );
          newState = moved.state;
          ops.push(...moved.ops);
        }

        // If we moved to a visual block (image/line), select it; otherwise leave
        // just cursor. Also clears auto-created paragraph tracking if we moved
        // off the tracked block.
        newState = selectVisualBlockAfterMove(state, newState);

        newState = maybeOpenInlineMathOnArrowCross(state, newState, viewport);
      }
      break;
    case "ArrowRight":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (isCtrl && keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_WORD_RIGHT,
          newState,
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else if (keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_RIGHT,
          newState,
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else {
        // Check if we're on a visual block (image/line) at the end of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const visibleBlocks = state.view.visibleBlocks;
          const lastVisibleBlockIndex =
            visibleBlocks.length > 0
              ? state.document.page.blocks.findIndex(
                  (b) => b.id === visibleBlocks[visibleBlocks.length - 1].id,
                )
              : -1;
          const isLastBlock =
            state.document.cursor.position.blockIndex === lastVisibleBlockIndex;

          // Create a new paragraph below the visual block.
          const edge = createParagraphBelow(state, isLastBlock, currentBlock);
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
        }

        // Check if we should remove an auto-created paragraph (LTR: right = forward)
        {
          const edge = removeAutoCreatedParagraph(state, "ltr");
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
        }

        // If there's a selection, check if it's a visual block selection (image/line)
        const range = getSelectionRange(newState);
        const endBlock = range
          ? state.document.page.blocks[range.end.blockIndex]
          : null;
        const isVisualBlockSelection =
          range &&
          endBlock &&
          !isTextualBlock(endBlock) &&
          range.start.blockIndex === range.end.blockIndex;

        if (range && !isVisualBlockSelection) {
          // Regular text selection - determine direction for correct collapse behavior
          const selEndBlock = state.document.page.blocks[range.end.blockIndex];
          const selectionIsRTL =
            selEndBlock &&
            isTextualBlock(selEndBlock) &&
            getTextDirection(getBlockTextContent(selEndBlock)) === "rtl";

          if (selectionIsRTL) {
            // RTL: ArrowRight = visual right = move to start (backward in logical order)
            newState = moveCursorToPosition(
              clearSelection(newState),
              range.start.blockIndex,
              range.start.textIndex,
            );
          } else {
            // LTR: ArrowRight = move to end
            newState = moveCursorToPosition(
              clearSelection(newState),
              range.end.blockIndex,
              range.end.textIndex,
            );
          }
        } else if (isCtrl) {
          const moved = newState.actionBus.dispatchState(
            MOVE_TO_NEXT_WORD,
            newState,
          );
          newState = moved.state;
          ops.push(...moved.ops);
        } else {
          const moved = newState.actionBus.dispatchState(
            MOVE_CURSOR_RIGHT,
            newState,
          );
          newState = moved.state;
          ops.push(...moved.ops);
        }

        // If we moved to a visual block (image/line), select it; otherwise leave
        // just cursor. Also clears auto-created paragraph tracking if we moved
        // off the tracked block.
        newState = selectVisualBlockAfterMove(state, newState);

        newState = maybeOpenInlineMathOnArrowCross(state, newState, viewport);
      }
      break;
    case "ArrowUp":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_UP,
          newState,
          { viewport },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else {
        // Check if we're on a visual block (image/line) at the start of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const isFirstBlock = state.document.cursor.position.blockIndex === 0;

          // Create a new paragraph above the visual block (track it on ArrowUp).
          const edge = createParagraphAbove(
            state,
            isFirstBlock,
            currentBlock,
            true,
          );
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
        }

        // Clear selection and move cursor
        {
          const moved = newState.actionBus.dispatchState(
            MOVE_CURSOR_UP,
            newState,
            { viewport },
          );
          newState = moved.state;
          ops.push(...moved.ops);
        }

        // If we moved to a visual block (image/line), select it; otherwise leave
        // just cursor. Also clears auto-created paragraph tracking if we moved
        // off the tracked block.
        newState = selectVisualBlockAfterMove(state, newState);
      }
      break;
    case "ArrowDown":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_DOWN,
          newState,
          { viewport },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else {
        // Check if we should remove an auto-created paragraph
        {
          const edge = removeAutoCreatedParagraph(state, null);
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
        }

        // Check if we're on a visual block (image/line) at the end of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const visibleBlocks = state.view.visibleBlocks;
          const lastVisibleBlockIndex =
            visibleBlocks.length > 0
              ? state.document.page.blocks.findIndex(
                  (b) => b.id === visibleBlocks[visibleBlocks.length - 1].id,
                )
              : -1;
          const isLastBlock =
            state.document.cursor.position.blockIndex === lastVisibleBlockIndex;

          // Create a new paragraph below the visual block.
          const edge = createParagraphBelow(state, isLastBlock, currentBlock);
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
        }

        // Clear selection and move cursor
        {
          const moved = newState.actionBus.dispatchState(
            MOVE_CURSOR_DOWN,
            newState,
            { viewport },
          );
          newState = moved.state;
          ops.push(...moved.ops);
        }

        // If we moved to a visual block (image/line), select it; otherwise leave
        // just cursor. Also clears auto-created paragraph tracking if we moved
        // off the tracked block.
        newState = selectVisualBlockAfterMove(state, newState);
      }
      break;
    case "PageUp":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_PAGE_UP,
          newState,
          { viewport },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else {
        // Check if we're on a visual block (image/line) at the start of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const isFirstBlock = state.document.cursor.position.blockIndex === 0;

          // Create a new paragraph above the visual block (track it on PageUp).
          const edge = createParagraphAbove(
            state,
            isFirstBlock,
            currentBlock,
            true,
          );
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
        }

        {
          const moved = newState.actionBus.dispatchState(
            MOVE_CURSOR_PAGE_UP,
            newState,
            { viewport },
          );
          newState = moved.state;
          ops.push(...moved.ops);
        }

        // If we moved to a visual block (image/line), select it; otherwise leave
        // just cursor. Also clears auto-created paragraph tracking if we moved
        // off the tracked block.
        newState = selectVisualBlockAfterMove(state, newState);
      }
      break;
    case "PageDown":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_PAGE_DOWN,
          newState,
          { viewport },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else {
        // Check if we should remove an auto-created paragraph
        {
          const edge = removeAutoCreatedParagraph(state, null);
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
        }

        // Check if we're on a visual block (image/line) at the end of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const visibleBlocks = state.view.visibleBlocks;
          const lastVisibleBlockIndex =
            visibleBlocks.length > 0
              ? state.document.page.blocks.findIndex(
                  (b) => b.id === visibleBlocks[visibleBlocks.length - 1].id,
                )
              : -1;
          const isLastBlock =
            state.document.cursor.position.blockIndex === lastVisibleBlockIndex;

          // Create a new paragraph below the visual block.
          const edge = createParagraphBelow(state, isLastBlock, currentBlock);
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
        }

        {
          const moved = newState.actionBus.dispatchState(
            MOVE_CURSOR_PAGE_DOWN,
            newState,
            { viewport },
          );
          newState = moved.state;
          ops.push(...moved.ops);
        }

        // If we moved to a visual block (image/line), select it; otherwise leave
        // just cursor. Also clears auto-created paragraph tracking if we moved
        // off the tracked block.
        newState = selectVisualBlockAfterMove(state, newState);
      }
      break;
    case "Home":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_HOME,
          newState,
          { isCtrl },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else {
        const moved = newState.actionBus.dispatchState(
          isCtrl ? MOVE_TO_DOCUMENT_START : MOVE_TO_LINE_START,
          newState,
        );
        newState = moved.state;
        ops.push(...moved.ops);
      }
      break;
    case "End":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_END,
          newState,
          { isCtrl },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else {
        const moved = newState.actionBus.dispatchState(
          isCtrl ? MOVE_TO_DOCUMENT_END : MOVE_TO_LINE_END,
          newState,
        );
        newState = moved.state;
        ops.push(...moved.ops);
      }
      break;
    case "Escape": {
      const result = state.actionBus.dispatchState(CLEAR_SELECTION, state);
      ops.push(...result.ops);
      return { state: result.state, ops };
    }
    case "Backspace": {
      const result = state.actionBus.dispatchState(
        isCtrl ? DELETE_WORD_BACKWARD : DELETE_BACKWARD,
        state,
      );
      newState = result.state;
      ops.push(...result.ops);
      break;
    }
    case "Delete": {
      const result = state.actionBus.dispatchState(
        isCtrl ? DELETE_WORD_FORWARD : DELETE_FORWARD,
        state,
      );
      newState = result.state;
      ops.push(...result.ops);
      break;
    }
    case "Enter": {
      const result = state.actionBus.dispatchState(SPLIT_BLOCK, state);
      newState = result.state;
      ops.push(...result.ops);
      break;
    }
    case " ":
    case "Space": {
      const result = state.actionBus.dispatchState(INSERT_TEXT, state, {
        text: " ",
      });
      newState = result.state;
      ops.push(...result.ops);
      // Clear auto-created paragraph tracking on space (already cleared in
      // insertText on its main paths, but for safety on its early-return guards)
      newState = clearAutoCreatedParagraph(newState);
      break;
    }
    default:
      // Check if typing "/" at the start of a block (only on desktop)
      if (
        key === "/" &&
        !isTouchDevice() &&
        state.document.cursor &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey
      ) {
        const { blockIndex: blockIndex } = state.document.cursor.position;

        // Allow slash action anywhere in paragraphs and headings
        const slashResult = insertText(state, "/");
        const newState = slashResult.state;
        ops.push(...slashResult.ops);
        if (newState.document.cursor) {
          const finalState = openSlashAction(
            newState,
            blockIndex,
            newState.document.cursor.position.textIndex,
          );
          ensureCursorVisible(
            finalState,
            state,
            viewport,
            updateViewportCallback,
          );
          return { state: finalState, ops };
        }
        return { state: newState, ops };
      }

      if (
        key.length === 1 &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey
      ) {
        const result = state.actionBus.dispatchState(INSERT_TEXT, state, {
          text: key,
        });
        newState = result.state;
        ops.push(...result.ops);
        break;
      }
      return { state, ops };
  }

  if (
    newState !== state &&
    newState.document.cursor &&
    updateViewportCallback
  ) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport,
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }

  return { state: newState, ops };
}
export function handleContextMenu(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  containerRect: { left: number; top: number },
): EditorState {
  event.preventDefault();

  // Don't open context menu if we're dragging an image
  if (state.ui.imageDrag) {
    return state;
  }

  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  const position = getTextPositionFromViewport(
    canvasX,
    canvasY,
    state,
    viewport,
  );

  // Always open context menu at click position if we have a valid position
  // Preserve existing selection for copy/cut operations
  if (position) {
    // Only update cursor/clear selection if there's no selection active
    // This preserves "Select All" and other selections when right-clicking
    if (!state.document.selection) {
      state = updateCursor(state, position);
    }

    // Clear link hover tooltip and slash menu when opening context menu
    state = {
      ...state,
      ui: {
        ...state.ui,
        isHoveringLinkWithModifier: false,
      },
    };

    state = openContextMenu(state, canvasX, canvasY);
  }

  return state;
}
