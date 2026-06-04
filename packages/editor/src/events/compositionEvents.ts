import {
  deleteSelectedText,
  getSelectionRange,
  insertText,
} from "../actions/commands";
import { scrollToMakeCursorVisible } from "../selection";
import type { Operation } from "../sync/sync";
import type { EditorState, ViewportState } from "../state-types";

// Composition (IME) Event Handlers
export function handleCompositionStart(
  state: EditorState,
  event: CompositionEvent,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];

  // If editor is not focused, ignore composition
  if (!state.view.isFocused) {
    return { state, ops };
  }

  // Block composition in readonly or locked mode
  if (state.ui.mode === "readonly" || state.ui.mode === "locked") {
    return { state, ops };
  }

  // When composition starts, save the current cursor position
  if (!state.document.cursor) return { state, ops };

  // Delete any selected text first (like normal typing would)
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const range = getSelectionRange(state);
    if (range) {
      const result = deleteSelectedText(state);
      state = result.state;
      ops.push(...result.ops);
    }
  }

  // Store the starting position for composition
  if (!state.document.cursor) return { state, ops };
  const startPosition = state.document.cursor.position;

  return {
    state: {
      ...state,
      ui: {
        ...state.ui,
        composition: {
          isComposing: true,
          text: event.data || "",
          startPosition,
          cursorOffset: (event.data || "").length,
        },
      },
    },
    ops,
  };
}
export function handleCompositionUpdate(
  state: EditorState,
  event: CompositionEvent,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];

  // If editor is not focused, ignore composition
  if (!state.view.isFocused) {
    return { state, ops };
  }

  // Block composition in readonly or locked mode
  if (state.ui.mode === "readonly" || state.ui.mode === "locked") {
    return { state, ops };
  }

  if (!state.ui.composition) {
    // If composition wasn't started properly, start it now
    return handleCompositionStart(state, event);
  }

  // Don't insert text during composition - just track it
  // The actual text will be inserted on compositionend
  const newText = event.data || "";
  const oldText = state.ui.composition.text;
  const oldOffset = state.ui.composition.cursorOffset;
  // If cursor was at the end of the old text, keep it at the end of the new text
  // Otherwise preserve the user's explicit cursor position (from arrow keys), clamped to new length
  const cursorOffset =
    oldOffset >= oldText.length
      ? newText.length
      : Math.min(oldOffset, newText.length);
  return {
    state: {
      ...state,
      document: {
        ...state.document,
        // Keep cursor active (not blinking) during composition updates
        cursor: state.document.cursor
          ? {
              ...state.document.cursor,
              lastUpdate: Date.now(),
            }
          : null,
      },
      ui: {
        ...state.ui,
        composition: {
          ...state.ui.composition,
          text: newText,
          cursorOffset,
        },
      },
    },
    ops,
  };
}
export function handleCompositionEnd(
  state: EditorState,
  event: CompositionEvent,
  viewport: ViewportState,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];

  // If editor is not focused, ignore composition
  if (!state.view.isFocused) {
    return { state, ops };
  }

  // Block composition in readonly or locked mode
  if (state.ui.mode === "readonly" || state.ui.mode === "locked") {
    return { state, ops };
  }

  // Insert the final composed text
  const composedText = event.data || "";

  if (composedText && state.document.cursor) {
    // Insert the composed text at the cursor position
    const result = insertText(state, composedText);
    state = result.state;
    ops.push(...result.ops);

    // Scroll to make cursor visible
    if (state.document.cursor && updateViewportCallback) {
      const newScrollY = scrollToMakeCursorVisible(
        state.document.cursor.position,
        state,
        viewport,
      );
      if (newScrollY !== null) {
        updateViewportCallback({ scrollY: newScrollY });
      }
    }
  }

  // Clear composition state
  return {
    state: {
      ...state,
      ui: {
        ...state.ui,
        composition: null,
      },
    },
    ops,
  };
}
