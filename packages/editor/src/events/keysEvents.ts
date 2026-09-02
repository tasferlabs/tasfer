import { OPEN_CONTEXT_MENU, TEXT_INPUT } from "../action-bus";
import { getSelectionRange } from "../actions/actions";
import {
  CLEAR_SELECTION,
  createParagraphAbove,
  createParagraphBelow,
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_TO_LINE_END,
  DELETE_TO_LINE_START,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  escapeAboveSelfContainedBlock,
  escapeBelowSelfContainedBlock,
  INSERT_TAB,
  INSERT_TEXT,
  REVERT_INPUT_RULE,
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
import { isTextInputKey } from "../code-points";
import { isApplePlatform } from "../platform";
import { docSelectionFocus, toDocPoint } from "../positions";
import {
  TOGGLE_CODE,
  TOGGLE_EMPHASIS,
  TOGGLE_STRIKE,
  TOGGLE_STRONG,
} from "../rendering/marks";
import { INDENT_LIST_ITEM, OUTDENT_LIST_ITEM } from "../rendering/nodes";
import { getBlockDirection } from "../rtl";
import {
  getBlockDocumentRect,
  getContentPointDocumentCoords,
  getContentSelectionFromViewport,
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
import {
  isContentSelectionCollapsed,
  updateContentSelection,
} from "../structured-selection";
import { isPreformattedType, isTextualBlock } from "../sync/block-registry";
import { redoState, undoState } from "../sync/crdt-undo";
import type { Operation } from "../sync/sync";
import { ensureCursorVisible } from "./eventUtils";
import type { InteractionSession } from "./interaction-session";
import { routeCapturedCancel } from "./regions";

// After an arrow-key caret move, dispatch CURSOR_MOVED so marks can react to the
// caret crossing an inline boundary — @tasfer/math's MathMark opens its editor when
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

/** The Cocoa emacs chords (⌃A/⌃E/⌃K/…) the keymap answers on macOS. */
const MAC_EMACS_CODES = [
  "KeyA",
  "KeyE",
  "KeyB",
  "KeyF",
  "KeyP",
  "KeyN",
  "KeyH",
  "KeyD",
  "KeyK",
];

/**
 * Whether the built-in keymap answers this Ctrl/Cmd chord. The input surface
 * asks before it swallows a keydown: a claimed chord is consumed and queued,
 * anything else is left alone so it bubbles to the host — a save, a sidebar
 * toggle, a command palette. Kept beside the keymap so the two cannot drift,
 * and it consults the schema, so an editor whose schema lacks or disallows a
 * mark also frees that mark's chord. Copy, cut and paste are not claimed: they
 * must reach the browser's native clipboard events. A chord with Alt down is
 * never claimed — on Windows that is AltGr, which types a character.
 */
export function builtInKeymapClaims(
  state: EditorState,
  e: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  >,
): boolean {
  const isApple = isApplePlatform();
  if (isApple && e.ctrlKey && !e.metaKey && !e.altKey) {
    return MAC_EMACS_CODES.includes(e.code);
  }
  const isCmd = isApple ? e.metaKey : e.ctrlKey;
  if (!isCmd || e.altKey) return false;
  const toggles = (name: string) =>
    !e.shiftKey &&
    state.marks.get(name) !== undefined &&
    state.schema.isMarkAllowed(name);
  switch (e.code) {
    case "KeyZ":
    case "KeyY":
    case "KeyA":
      return true;
    case "KeyB":
      return toggles("strong");
    case "KeyI":
      return toggles("emphasis");
    case "KeyE":
      return toggles("code");
    case "KeyX":
      // ⌘⇧X is strike-through; a plain ⌘X is the native cut and stays free.
      return (
        e.shiftKey &&
        state.marks.get("strike") !== undefined &&
        state.schema.isMarkAllowed("strike")
      );
    default:
      return false;
  }
}

export function handleKeyDown(
  state: EditorState,
  viewport: ViewportState,
  event: Event,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  visibility?: VisibleBlockRange,
  session?: InteractionSession,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  const keyEvent = event as unknown as KeyboardEvent;
  const key = keyEvent.key;
  const code = keyEvent.code;
  const isApple = isApplePlatform();

  // macOS splits into three modifiers what Windows/Linux put on one. Deriving
  // them by role — rather than testing `ctrlKey || metaKey` — is what keeps each
  // platform's own conventions intact:
  //
  //   role      macOS   Windows/Linux
  //   command     ⌘        Ctrl        undo, select all, bold
  //   word        ⌥        Ctrl        move/delete by word
  //   line        ⌘         —          move/delete to line or document edge
  //
  // Windows and Linux have no line-edge chord at all: Home/End own that there,
  // so `isLineMod` is Apple-only by design, not by omission.
  const isCmd = isApple ? keyEvent.metaKey : keyEvent.ctrlKey;
  const isWordMod = isApple ? keyEvent.altKey : keyEvent.ctrlKey;
  const isLineMod = isApple && keyEvent.metaKey;
  // The Cocoa emacs bindings (⌃A/⌃E/⌃K/…) every macOS text view answers to.
  // Only bare Ctrl — with ⌘ or ⌥ also down the chord belongs to something else.
  const isMacEmacs =
    isApple && keyEvent.ctrlKey && !keyEvent.metaKey && !keyEvent.altKey;
  // Open the contextual menu on the caret: ⌘↩ on Apple (Ctrl+↩ elsewhere), plus
  // the ⇧F10 / Menu-key chord every desktop toolkit answers to.
  const isContextMenuChord =
    (isCmd && key === "Enter") ||
    key === "ContextMenu" ||
    (keyEvent.shiftKey && key === "F10");
  const inputSource =
    keyEvent.inputSource ??
    (keyEvent.isTrusted === true ? "hardware-keyboard" : "input-surface");

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
    const isCopy = isCmd && code === "KeyC";
    const isSelectAll = isCmd && code === "KeyA";
    const isEscape = key === "Escape";
    const isFind = isCmd && code === "KeyF";
    // The read-only reader on a Mac navigates with ⌃A/⌃E/⌃B/⌃F/⌃P/⌃N too; the
    // destructive half of the emacs set (⌃D/⌃H/⌃K) stays blocked.
    const isEmacsNavigation =
      isMacEmacs &&
      ["KeyA", "KeyB", "KeyE", "KeyF", "KeyN", "KeyP"].includes(code);

    // Allow navigation, copy, select all, find, and escape in readonly mode
    if (
      !isNavigationKey &&
      !isCopy &&
      !isSelectAll &&
      !isEscape &&
      !isFind &&
      !isEmacsNavigation &&
      // A readonly mount still offers the contextual menu (Copy, Select All).
      !isContextMenuChord
    ) {
      return { state, ops };
    }
  }

  // If editor is not focused, ignore keyboard input
  if (!state.view.isFocused) {
    return { state, ops };
  }

  // A host contextual menu is up. It tracks the keyboard the way a native menu
  // does — arrows move the highlight, ↩ runs the item, ⎋ dismisses — so swallow
  // every key here rather than editing the document behind the open menu. The
  // host dispatches CLOSE_CONTEXT_MENU when it dismisses, which clears this.
  if (session?.hostMenuCapturing) {
    return { state, ops };
  }

  // A region drag holding the pointer (a column being carried, an image being
  // resized) is what Escape cancels, ahead of everything else the key means:
  // the drag puts its picture back and the pointer falls free. The selection
  // underneath is kept — the key was aimed at the gesture, not at it — and no
  // caret is needed for it, so this sits before the caret-dependent paths.
  if (key === "Escape" && session?.captured?.region.drag) {
    const cancelled = routeCapturedCancel({
      state,
      viewport,
      documentHeight: viewport.documentHeight,
      session,
    });
    return { state: cancelled ?? state, ops };
  }

  if (inputSource === "hardware-keyboard" && !state.ui.hasHardwareKeyboard) {
    state = {
      ...state,
      ui: { ...state.ui, hasHardwareKeyboard: true },
    };
  }

  // Block most operations during composition - let IME handle input
  if (state.ui.composition?.isComposing) {
    // Block undo/redo
    if (isCmd && (code === "KeyZ" || code === "KeyY")) {
      return { state, ops };
    }
    // Block cut operation
    if (isCmd && code === "KeyX") {
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
      isTextInputKey(key) &&
      !keyEvent.ctrlKey &&
      !keyEvent.altKey &&
      !keyEvent.metaKey
    ) {
      return { state, ops };
    }
  }

  // Undo/Redo - handle these first, even if slash action is open
  // Use code instead of key for keyboard layout independence
  if (isCmd && code === "KeyZ" && !keyEvent.shiftKey) {
    // A markdown auto-format that just fired takes the first undo: it peels off
    // the promotion and leaves the literal syntax, which is the only way to type
    // "# foo" as text. The undo stack itself is untouched — see
    // `revertInputRule`. Empty ops means it couldn't run; fall through.
    if (state.ui.revertibleInputRule) {
      const reverted = state.actionBus.dispatchState(REVERT_INPUT_RULE, state);
      if (reverted.ops.length > 0) {
        ensureCursorVisible(
          reverted.state,
          state,
          viewport,
          updateViewportCallback,
          visibility,
        );
        return { state: reverted.state, ops: reverted.ops };
      }
    }
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
  if (isCmd && (code === "KeyY" || (keyEvent.shiftKey && code === "KeyZ"))) {
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

  // macOS emacs-style text bindings. Every Cocoa text view answers to these and
  // the browser supplies them for free in a normal text field — but the canvas
  // surface swallows the keydown, so the editor has to provide them itself.
  // Matched on `code`, so they survive a non-Latin keyboard layout.
  if (isMacEmacs) {
    const emacs = ((): { state: EditorState; ops: Operation[] } | null => {
      switch (code) {
        case "KeyA":
          return state.actionBus.dispatchState(MOVE_TO_LINE_START, state);
        case "KeyE":
          return state.actionBus.dispatchState(MOVE_TO_LINE_END, state);
        case "KeyB":
          return state.actionBus.dispatchState(MOVE_CURSOR_LEFT, state);
        case "KeyF":
          return state.actionBus.dispatchState(MOVE_CURSOR_RIGHT, state);
        case "KeyP":
          return state.actionBus.dispatchState(MOVE_CURSOR_UP, state, {
            viewport,
          });
        case "KeyN":
          return state.actionBus.dispatchState(MOVE_CURSOR_DOWN, state, {
            viewport,
          });
        case "KeyH":
          return state.actionBus.dispatchState(DELETE_BACKWARD, state);
        case "KeyD":
          return state.actionBus.dispatchState(DELETE_FORWARD, state);
        case "KeyK":
          return state.actionBus.dispatchState(DELETE_TO_LINE_END, state);
        default:
          return null;
      }
    })();
    if (emacs) {
      event.preventDefault();
      ensureCursorVisible(
        emacs.state,
        state,
        viewport,
        updateViewportCallback,
        visibility,
      );
      return { state: emacs.state, ops: emacs.ops };
    }
  }

  // Must come before the `Enter` case in the switch below, which would otherwise
  // split the block instead.
  if (isContextMenuChord) {
    event.preventDefault();
    return { state: openContextMenuAtCaret(state, viewport, visibility), ops };
  }

  // Select All
  if (isCmd && code === "KeyA") {
    const result = state.actionBus.dispatchState(SELECT_ALL, state);
    ops.push(...result.ops);
    return { state: result.state, ops };
  }

  // Inline formatting. The engine stays mark-agnostic about *what* these do —
  // each toggle resolves through the mark registry and no-ops when the schema
  // doesn't include that mark.
  if (isCmd) {
    const toggle =
      code === "KeyB" && !keyEvent.shiftKey
        ? TOGGLE_STRONG
        : code === "KeyI" && !keyEvent.shiftKey
          ? TOGGLE_EMPHASIS
          : code === "KeyE" && !keyEvent.shiftKey
            ? TOGGLE_CODE
            : code === "KeyX" && keyEvent.shiftKey
              ? TOGGLE_STRIKE
              : null;
    if (toggle) {
      event.preventDefault();
      const result = state.actionBus.dispatchState(toggle, state);
      ops.push(...result.ops);
      return { state: result.state, ops };
    }
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

      if (keyEvent.shiftKey && isLineMod) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_HOME,
          newState,
          { isCtrl: false },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else if (keyEvent.shiftKey && isWordMod) {
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
        } else if (isLineMod) {
          // ⌘← is the *logical* line start in both writing directions — an RTL
          // block behaves like an LTR one rather than following visual order.
          const moved = newState.actionBus.dispatchState(
            MOVE_TO_LINE_START,
            newState,
          );
          newState = moved.state;
          ops.push(...moved.ops);
        } else if (isWordMod) {
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

      if (keyEvent.shiftKey && isLineMod) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_END,
          newState,
          { isCtrl: false },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else if (keyEvent.shiftKey && isWordMod) {
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
        } else if (isLineMod) {
          // Logical line end — see the ⌘← note above.
          const moved = newState.actionBus.dispatchState(
            MOVE_TO_LINE_END,
            newState,
          );
          newState = moved.state;
          ops.push(...moved.ops);
        } else if (isWordMod) {
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

      if (keyEvent.shiftKey && isLineMod) {
        // ⇧⌘↑ extends to the document start — reuses the Home extension, whose
        // `isCtrl` flag already means "document edge, not line edge".
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_HOME,
          newState,
          { isCtrl: true },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else if (keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_UP,
          newState,
          { viewport },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else if (isLineMod) {
        // ⌘↑ jumps to the document start, skipping the leading-block escape
        // handling below — there is nothing to escape into when we leave.
        const moved = newState.actionBus.dispatchState(
          MOVE_TO_DOCUMENT_START,
          newState,
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

      if (keyEvent.shiftKey && isLineMod) {
        // ⇧⌘↓ extends to the document end — see the ⇧⌘↑ note above.
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_END,
          newState,
          { isCtrl: true },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else if (keyEvent.shiftKey) {
        const moved = newState.actionBus.dispatchState(
          EXTEND_SELECTION_DOWN,
          newState,
          { viewport },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else if (isLineMod) {
        // ⌘↓ jumps to the document end — see the ⌘↑ note above.
        const moved = newState.actionBus.dispatchState(
          MOVE_TO_DOCUMENT_END,
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
          { isCtrl: isCmd },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else {
        const moved = newState.actionBus.dispatchState(
          isCmd ? MOVE_TO_DOCUMENT_START : MOVE_TO_LINE_START,
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
          { isCtrl: isCmd },
        );
        newState = moved.state;
        ops.push(...moved.ops);
      } else {
        const moved = newState.actionBus.dispatchState(
          isCmd ? MOVE_TO_DOCUMENT_END : MOVE_TO_LINE_END,
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
      // A plain Backspace right after a markdown auto-format takes it back
      // instead of deleting — the transform visibly ate those characters, so
      // this is the other key users reach for. Modified deletes skip it.
      if (state.ui.revertibleInputRule && !isLineMod && !isWordMod) {
        const reverted = state.actionBus.dispatchState(
          REVERT_INPUT_RULE,
          state,
        );
        if (reverted.ops.length > 0) {
          return { state: reverted.state, ops: [...ops, ...reverted.ops] };
        }
      }
      // ⌘⌫ clears to the line start, ⌥⌫ (Ctrl+⌫ off Apple) one word. Line beats
      // word: on macOS both flags can be up at once only if the user holds ⌘⌥,
      // where ⌘ wins by convention.
      const result = state.actionBus.dispatchState(
        isLineMod
          ? DELETE_TO_LINE_START
          : isWordMod
            ? DELETE_WORD_BACKWARD
            : DELETE_BACKWARD,
        state,
      );
      newState = result.state;
      ops.push(...result.ops);
      break;
    }
    case "Delete": {
      const result = state.actionBus.dispatchState(
        isLineMod
          ? DELETE_TO_LINE_END
          : isWordMod
            ? DELETE_WORD_FORWARD
            : DELETE_FORWARD,
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
        isTextInputKey(key) &&
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
            inputSource,
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
                inputSource,
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
    // Only move the caret when no selection is active — flat or nested (a held
    // construct inside structured math) — so "Select All" and other selections
    // survive a right-click. A bare caret resolves structured-first: inside a
    // tree-authoritative equation the flat projection is an empty compatibility
    // stub, so a flat `updateCursor` there would both land nowhere meaningful
    // and destroy the live nested caret the menu's actions need.
    const heldContentRange =
      !!state.document.contentSelection &&
      !isContentSelectionCollapsed(state.document.contentSelection);
    if (!state.document.selection && !heldContentRange) {
      const contentSelection = getContentSelectionFromViewport(
        canvasX,
        canvasY,
        state,
        viewport,
        "mouse",
      );
      state = contentSelection
        ? updateContentSelection(state, contentSelection)
        : updateCursor(state, position);
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
    // container rect. A ranged selection counts whichever model holds it: the
    // flat block range or a nested structured range. `point` is what sits under
    // the pointer — not the caret, which a held selection keeps where it was.
    state.actionBus.dispatch(OPEN_CONTEXT_MENU, {
      x: canvasX,
      y: canvasY,
      hasSelection: hasRangedSelection(state),
      point: toDocPoint(state, position) ?? undefined,
    });
  }

  return state;
}

/**
 * Whether either selection model holds a range — the flat block range or a
 * nested structured one. What the menu means by "there is something to act on".
 */
function hasRangedSelection(state: EditorState): boolean {
  return (
    !!getSelectionRange(state) ||
    (!!state.document.contentSelection &&
      !isContentSelectionCollapsed(state.document.contentSelection))
  );
}

/**
 * Open the contextual menu from the keyboard, anchored on the caret rather than a
 * pointer. Unlike the pointer path this never moves the caret: the menu acts on
 * whatever was already selected. Structured-first, for the same reason
 * `handleContextMenu` resolves that way — inside a tree-authoritative construct
 * the flat projection is an empty compatibility stub.
 */
export function openContextMenuAtCaret(
  state: EditorState,
  viewport: ViewportState,
  visibility?: VisibleBlockRange,
): EditorState {
  const contentSelection = state.document.contentSelection;
  const caretPosition = state.document.cursor?.position;
  const caretCoords = contentSelection
    ? getContentPointDocumentCoords(
        contentSelection.focus,
        state,
        viewport,
        undefined,
        visibility,
      )
    : caretPosition
      ? getCursorDocumentCoords(
          caretPosition,
          state,
          viewport,
          undefined,
          visibility,
        )
      : null;
  // A visual block (a selected image) has no caret to measure — anchor the menu
  // on the block itself so ⌘↩ there still reaches Copy image / Download image.
  const coords =
    caretCoords ??
    (caretPosition
      ? getBlockDocumentRect(
          state,
          caretPosition.blockIndex,
          viewport,
          undefined,
          visibility,
        )
      : null);
  if (!coords) return state;

  state = {
    ...state,
    ui: {
      ...state.ui,
      isHoveringLinkWithModifier: false,
    },
  };

  // Canvas coords, like the pointer path: document y minus the scroll offset.
  // `point` is where the menu is anchored: the caret, or a held range's focus.
  state.actionBus.dispatch(OPEN_CONTEXT_MENU, {
    x: coords.x,
    y: coords.y - viewport.scrollY,
    hasSelection: hasRangedSelection(state),
    point: docSelectionFocus(state) ?? undefined,
  });

  return state;
}
