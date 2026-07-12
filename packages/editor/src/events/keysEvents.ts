import { OPEN_CONTEXT_MENU, TEXT_INPUT } from "../action-bus";
import { getSelectionRange } from "../actions/actions";
import {
  CLEAR_SELECTION,
  createParagraphAbove,
  createParagraphBelow,
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  escapeAboveSelfContainedBlock,
  escapeBelowSelfContainedBlock,
  INSERT_TEXT,
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
  MOVE_CONTENT_TAB,
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
import { CURSOR_MOVED } from "../actions/pointer-actions";
import { TOGGLE_STRONG } from "../rendering/marks";
import {
  INDENT_LIST_ITEM,
  INSERT_TAB,
  OUTDENT_LIST_ITEM,
} from "../rendering/nodes";
import { getBlockDirection } from "../rtl";
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
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import { isPreformattedType, isTextualBlock } from "../sync/block-registry";
import { redoState, undoState } from "../sync/crdt-undo";
import type { Operation } from "../sync/sync";
import { ensureCursorVisible } from "./eventUtils";
import type { InteractionSession } from "./interaction-session";

// After an arrow-key caret move, dispatch CURSOR_MOVED so marks can react to the
// caret crossing an inline boundary — MathMark opens the inline-math editor when
// the caret steps across a chip. Gated on staying within the same block (a move
// to another block isn't a "cross"); the engine names no mark type.
function dispatchCursorCrossed(
  prevState: EditorState,
  newState: EditorState,
  viewport: ViewportState,
  direction: "left" | "right",
): EditorState {
  const prevCursor = prevState.document.cursor;
  const newCursor = newState.document.cursor;
  if (!prevCursor || !newCursor) return newState;
  if (prevCursor.position.blockIndex !== newCursor.position.blockIndex) {
    return newState;
  }
  const block = newState.document.page.blocks[newCursor.position.blockIndex];
  if (!block || block.deleted) return newState;

  return newState.actionBus.dispatchState(CURSOR_MOVED, newState, {
    block,
    blockIndex: newCursor.position.blockIndex,
    oldIndex: prevCursor.position.textIndex,
    newIndex: newCursor.position.textIndex,
    direction,
    viewport,
    resolveCoords: (pos) => getCursorDocumentCoords(pos, newState, viewport),
  }).state;
}

export function handleKeyDown(
  state: EditorState,
  viewport: ViewportState,
  event: Event,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  visibility?: VisibleBlockRange,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  const keyEvent = event as unknown as KeyboardEvent;
  const key = keyEvent.key;
  const code = keyEvent.code;
  const isCtrl = keyEvent.ctrlKey || keyEvent.metaKey;

  // In suspended mode, block all operations
  if (state.ui.mode === "suspended") {
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
    ensureCursorVisible(
      result.state,
      state,
      viewport,
      updateViewportCallback,
      visibility,
    );
    return { state: result.state, ops: result.ops };
  }
  if (isCtrl && (code === "KeyY" || (keyEvent.shiftKey && code === "KeyZ"))) {
    const result = redoState(state);
    ensureCursorVisible(
      result.state,
      state,
      viewport,
      updateViewportCallback,
      visibility,
    );
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
    const result = state.actionBus.dispatchState(TOGGLE_STRONG, state);
    ops.push(...result.ops);
    return { state: result.state, ops };
  }

  // Tab - indent/outdent list items
  if (key === "Tab") {
    if (state.document.contentSelection) {
      event.preventDefault();
      const result = state.actionBus.dispatchState(MOVE_CONTENT_TAB, state, {
        backward: keyEvent.shiftKey,
      });
      ensureCursorVisible(
        result.state,
        state,
        viewport,
        updateViewportCallback,
        visibility,
      );
      return { state: result.state, ops: result.ops };
    }
    // Give any structured node a chance to promote a bridge cursor and own Tab
    // before list/code handling or browser focus traversal.
    const contentMove = state.actionBus.dispatchState(MOVE_CONTENT_TAB, state, {
      backward: keyEvent.shiftKey,
    });
    if (contentMove.claimed) {
      event.preventDefault();
      ensureCursorVisible(
        contentMove.state,
        state,
        viewport,
        updateViewportCallback,
        visibility,
      );
      return { state: contentMove.state, ops: contentMove.ops };
    }
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
            visibility,
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
            visibility,
          );
          return { state: newState, ops };
        }
      } else if (isPreformattedType(block.type)) {
        // Tab in a preformatted (code) block inserts indentation instead of
        // moving focus. The insertion behavior lives on the node (INSERT_TAB in
        // CodeNode); the gate is a capability query, so a new code-like block
        // opts in via its descriptor rather than being named here.
        event.preventDefault();
        const result = state.actionBus.dispatchState(INSERT_TAB, state);
        const newState = result.state;
        ops.push(...result.ops);
        ensureCursorVisible(
          newState,
          state,
          viewport,
          updateViewportCallback,
          visibility,
        );
        return { state: newState, ops };
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

          // Create a new paragraph above a leading visual block (image/line).
          const edge = createParagraphAbove(state, isFirstBlock, currentBlock);
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
            getBlockDirection(selStartBlock, state.marks) === "rtl";

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
        newState = selectVisualBlockAfterMove(newState);

        newState = dispatchCursorCrossed(state, newState, viewport, "left");
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

          // Create a new paragraph below a trailing visual block (image/line).
          const edge = createParagraphBelow(state, isLastBlock, currentBlock);
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
            getBlockDirection(selEndBlock, state.marks) === "rtl";

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
        newState = selectVisualBlockAfterMove(newState);

        newState = dispatchCursorCrossed(state, newState, viewport, "right");
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

          // Create a new paragraph above a leading visual block (image/line), or
          // escape a leading self-contained text block (code/math/quote) when the
          // caret is on its first line, instead of clamping inside it.
          const edge = createParagraphAbove(state, isFirstBlock, currentBlock);
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
          const textEdge = escapeAboveSelfContainedBlock(
            state,
            isFirstBlock,
            currentBlock,
            viewport,
          );
          if (textEdge.kind === "break") {
            newState = textEdge.state;
            ops.push(...textEdge.ops);
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
        // just cursor.
        newState = selectVisualBlockAfterMove(newState);
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

          // Create a new paragraph below a trailing visual block (image/line),
          // or escape a trailing self-contained text block (code/math/quote)
          // when the caret is on its last line, instead of clamping inside it.
          const edge = createParagraphBelow(state, isLastBlock, currentBlock);
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
          const textEdge = escapeBelowSelfContainedBlock(
            state,
            isLastBlock,
            currentBlock,
            viewport,
          );
          if (textEdge.kind === "break") {
            newState = textEdge.state;
            ops.push(...textEdge.ops);
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
        // just cursor.
        newState = selectVisualBlockAfterMove(newState);
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

          // Create a new paragraph above a leading visual block (image/line), or
          // escape a leading self-contained text block (code/math/quote) when the
          // caret is on its first line, instead of clamping inside it.
          const edge = createParagraphAbove(state, isFirstBlock, currentBlock);
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
          const textEdge = escapeAboveSelfContainedBlock(
            state,
            isFirstBlock,
            currentBlock,
            viewport,
          );
          if (textEdge.kind === "break") {
            newState = textEdge.state;
            ops.push(...textEdge.ops);
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
        // just cursor.
        newState = selectVisualBlockAfterMove(newState);
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

          // Create a new paragraph below a trailing visual block (image/line),
          // or escape a trailing self-contained text block (code/math/quote)
          // when the caret is on its last line, instead of clamping inside it.
          const edge = createParagraphBelow(state, isLastBlock, currentBlock);
          if (edge.kind === "break") {
            newState = edge.state;
            ops.push(...edge.ops);
            break;
          }
          const textEdge = escapeBelowSelfContainedBlock(
            state,
            isLastBlock,
            currentBlock,
            viewport,
          );
          if (textEdge.kind === "break") {
            newState = textEdge.state;
            ops.push(...textEdge.ops);
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
        newState = selectVisualBlockAfterMove(newState);
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
      break;
    }
    default:
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
        // Host-facing input signal: report the inserted character + where it
        // landed, so plugins (slash menus, typeaheads) can edge-trigger on it.
        // The engine itself does nothing with this — it's observe-only.
        const inserted = newState.document.cursor;
        if (inserted) {
          state.actionBus.dispatch(TEXT_INPUT, {
            text: key,
            blockIndex: inserted.position.blockIndex,
            textIndex: inserted.position.textIndex - key.length,
          });
        } else {
          const contentPoint = newState.document.contentSelection?.focus;
          if (contentPoint) {
            const blockIndex = newState.document.page.blocks.findIndex(
              (block) => block.id === contentPoint.blockId && !block.deleted,
            );
            if (blockIndex >= 0) {
              state.actionBus.dispatch(TEXT_INPUT, {
                text: key,
                blockIndex,
                // Structured positions carry identity, not one generic source
                // offset. Host adapters derive their own projection if needed.
                textIndex: 0,
                contentPoint,
              });
            }
          }
        }
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
      undefined,
      visibility,
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
  session: InteractionSession,
): EditorState {
  event.preventDefault();

  // Don't open context menu while a region drag owns the pointer (e.g. an
  // in-progress image resize).
  if (session.captured) {
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

    // Headless: the engine doesn't own the menu — it signals the host, which
    // renders its own context menu. `x`/`y` are canvas coords; the host adds its
    // container rect.
    state.actionBus.dispatch(OPEN_CONTEXT_MENU, {
      x: canvasX,
      y: canvasY,
      hasSelection: !!getSelectionRange(state),
    });
  }

  return state;
}
