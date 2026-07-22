import {
  COMPOSITION_END,
  COMPOSITION_START,
  COMPOSITION_UPDATE,
} from "../actions/input-actions";
import { endComposition } from "../composition";
import { scrollToMakeCursorVisible } from "../selection";
import type { EditorState, ViewportState } from "../state-types";
import type { Operation } from "../sync/sync";

// Composition (IME) Event Handlers
//
// Math source (a block equation, an inline-math chip) composes like any other
// text: the composed string is committed on end through the SAME node/mark-aware
// typed path as normal typing (`insertText` → `mathTransformTypedInput`, which
// wraps non-renderable text in `\text{…}`, fills an empty slot the caret sits just
// past, and keeps an IME commit's braces). The in-progress preview is folded in
// through that same transform (see `getContentWithComposition`), so the formula
// stays typeset while composing — a live, correctly-scoped preview that matches
// exactly what the commit produces — instead of flashing to raw source.
export function handleCompositionStart(
  state: EditorState,
  event: CompositionEvent,
): { state: EditorState; ops: Operation[] } {
  // If editor is not focused, ignore composition
  if (!state.view.isFocused) {
    return { state, ops: [] };
  }

  // Block composition in readonly or suspended mode
  if (state.ui.mode === "readonly" || state.ui.mode === "suspended") {
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

  // Block composition in readonly or suspended mode
  if (state.ui.mode === "readonly" || state.ui.mode === "suspended") {
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
  // A delivered `compositionend` always terminates the IME session, so the
  // composition flag MUST be cleared here no matter the editor's focus/mode. If
  // we bailed out while leaving `ui.composition.isComposing` set — an end that
  // arrives during a transient blur (Android WebViews synthesize a blur/refocus
  // around touch), or after the mode flipped to readonly/suspended — the stale
  // flag would hard-block every subsequent Enter and keystroke (see the guards
  // in keysEvents and hiddenInputKeyDownHandler). This is the "can't press Enter
  // after a code/math block" symptom: those preformatted blocks always use the
  // managed surface where composition is tracked. Only the text INSERTION is
  // gated on being focused and editable; the flag clear is unconditional.
  if (!state.ui.composition) {
    return { state, ops: [] };
  }
  const canInsert =
    state.view.isFocused &&
    state.ui.mode !== "readonly" &&
    state.ui.mode !== "suspended";
  if (!canInsert) {
    return { state: endComposition(state), ops: [] };
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
