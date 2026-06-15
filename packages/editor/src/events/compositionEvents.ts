import {
  COMPOSITION_END,
  COMPOSITION_START,
  COMPOSITION_UPDATE,
} from "../actions/input-actions";
import { scrollToMakeCursorVisible } from "../selection";
import type { EditorState, ViewportState } from "../state-types";
import type { Operation } from "../sync/sync";

// Composition (IME) Event Handlers
export function handleCompositionStart(
  state: EditorState,
  event: CompositionEvent,
): { state: EditorState; ops: Operation[] } {
  // If editor is not focused, ignore composition
  if (!state.view.isFocused) {
    return { state, ops: [] };
  }

  // Block composition in readonly or locked mode
  if (state.ui.mode === "readonly" || state.ui.mode === "locked") {
    return { state, ops: [] };
  }

  return state.actionBus.dispatchState(COMPOSITION_START, state, {
    data: event.data || "",
  });
}
export function handleCompositionUpdate(
  state: EditorState,
  event: CompositionEvent,
): { state: EditorState; ops: Operation[] } {
  // If editor is not focused, ignore composition
  if (!state.view.isFocused) {
    return { state, ops: [] };
  }

  // Block composition in readonly or locked mode
  if (state.ui.mode === "readonly" || state.ui.mode === "locked") {
    return { state, ops: [] };
  }

  if (!state.ui.composition) {
    // If composition wasn't started properly, start it now
    return handleCompositionStart(state, event);
  }

  // Don't insert text during composition - just track it.
  // The actual text will be inserted on compositionend.
  return state.actionBus.dispatchState(COMPOSITION_UPDATE, state, {
    data: event.data || "",
  });
}
export function handleCompositionEnd(
  state: EditorState,
  event: CompositionEvent,
  viewport: ViewportState,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
): { state: EditorState; ops: Operation[] } {
  // If editor is not focused, ignore composition
  if (!state.view.isFocused) {
    return { state, ops: [] };
  }

  // Block composition in readonly or locked mode
  if (state.ui.mode === "readonly" || state.ui.mode === "locked") {
    return { state, ops: [] };
  }

  const composedText = event.data || "";
  const result = state.actionBus.dispatchState(COMPOSITION_END, state, {
    data: composedText,
  });

  // Scroll to make cursor visible after inserting the composed text. Only when
  // text was actually composed and inserted, mirroring the original handler.
  if (composedText && result.state.document.cursor && updateViewportCallback) {
    const newScrollY = scrollToMakeCursorVisible(
      result.state.document.cursor.position,
      result.state,
      viewport,
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }

  return result;
}
