import type { Operation } from "@/sync";
import { pasteFromClipboardEvent } from "../clipboard";
import { scrollToMakeCursorVisible } from "../selection";
import type { EditorState, ViewportState } from "../types";

export function handlePaste(
  state: EditorState,
  event: ClipboardEvent,
  viewport: ViewportState,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  clipboardData?: { html: string; text: string; } | null): { state: EditorState; ops: Operation[]; } {
  // Prevent default paste behavior
  event.preventDefault();

  // If editor is not focused, ignore paste
  if (!state.view.isFocused) {
    return { state, ops: [] };
  }

  // Block paste during composition - let IME handle input
  if (state.ui.composition?.isComposing) {
    return { state, ops: [] };
  }

  // Use the tracked pasteAsPlainText flag (set during keydown)
  // Paste as plain text
  const result = pasteFromClipboardEvent(
    state,
    event,
    state.crdt,
    clipboardData
  );
  if (!result) {
    return { state, ops: [] };
  }

  const newState = result.state;

  // Scroll to make the cursor (end of pasted content) visible
  if (newState.document.cursor && updateViewportCallback) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }

  return { state: newState, ops: result.ops };
}
