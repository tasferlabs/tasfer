import { PASTE, runPaste } from "../actions/input-commands";
import { scrollToMakeCursorVisible } from "../selection";
import type { EditorState, ViewportState } from "../state-types";
import type { Operation } from "../sync/sync";
import { getVisibleBlocks } from "../sync/sync";

export function handlePaste(
  state: EditorState,
  event: ClipboardEvent,
  viewport: ViewportState,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
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

  // Block paste in readonly or locked mode
  if (state.ui.mode === "readonly" || state.ui.mode === "locked") {
    return { state, ops: [] };
  }

  // Run the paste once here so we can keep the `pastedImageBlockIndex` it
  // surfaces (a StateResult can't carry it); then dispatch PASTE with the
  // already-computed `{ state, ops }` so observers/overrides still fire without
  // the paste running a second time.
  const pasted = runPaste(state, event, clipboardData);
  const result = state.commandBus.dispatchState(PASTE, state, {
    event,
    clipboardData,
    precomputed: { state: pasted.state, ops: pasted.ops },
  });

  // PASTE returns the input state untouched when the clipboard yielded nothing.
  if (result.state === state && result.ops.length === 0) {
    return { state, ops: [] };
  }

  // Update visibleBlocks since page content changed (needed for scroll calculation)
  let newState: EditorState = {
    ...result.state,
    view: {
      ...result.state.view,
      visibleBlocks: getVisibleBlocks(result.state.document.page),
    },
  };

  // Scroll to make the cursor (end of pasted content) visible
  if (newState.document.cursor && updateViewportCallback) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport,
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }

  return {
    state: newState,
    ops: result.ops,
    pastedImageBlockIndex: pasted.pastedImageBlockIndex,
  };
}
