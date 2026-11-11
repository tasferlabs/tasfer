import { PASTE, runPaste } from "../actions/input-actions";
import type { EditorState } from "../state-types";
import type { Operation } from "../sync/sync";
import { getVisibleBlocks } from "../sync/sync";

export function handlePaste(
  state: EditorState,
  event: ClipboardEvent,
  clipboardData?: { html: string; text: string; imageFile: File | null } | null,
): { state: EditorState; ops: Operation[]; pastedImageBlockIndex?: number } {
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

  // Block paste in readonly or suspended mode
  if (state.ui.mode === "readonly" || state.ui.mode === "suspended") {
    return { state, ops: [] };
  }

  // Run the paste once here so we can keep the `pastedImageBlockIndex` it
  // surfaces (a StateResult can't carry it); then dispatch PASTE with the
  // already-computed `{ state, ops }` so observers/overrides still fire without
  // the paste running a second time.
  const pasted = runPaste(state, event, clipboardData);
  const result = state.actionBus.dispatchState(PASTE, state, {
    event,
    clipboardData,
    precomputed: { state: pasted.state, ops: pasted.ops },
  });

  // PASTE returns the input state untouched when the clipboard yielded nothing.
  if (result.state === state && result.ops.length === 0) {
    return { state, ops: [] };
  }

  // Update visibleBlocks since page content changed. Scrolling the caret
  // into view is the editor's job, once its block heights know the new blocks
  // (see `revealCaretAfterPaste`); doing it here measured the page differently
  // from how it is drawn, so a big paste landed the view far from the caret.
  const newState: EditorState = {
    ...result.state,
    view: {
      ...result.state.view,
      visibleBlocks: getVisibleBlocks(
        result.state.document.page,
        result.state.view.window,
      ),
    },
  };

  return {
    state: newState,
    ops: result.ops,
    pastedImageBlockIndex: pasted.pastedImageBlockIndex,
  };
}
