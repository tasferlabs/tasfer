import {
  COMPOSITION_END,
  COMPOSITION_START,
  COMPOSITION_UPDATE,
} from "../actions/input-actions";
import { endComposition } from "../composition";
import { getBlockTextContent } from "../node-shared";
import { scrollToMakeCursorVisible } from "../selection";
import type { EditorState, Position, ViewportState } from "../state-types";
import { contentPointsEqual } from "../structured-selection";
import { crdtToPosition, positionToCRDT } from "../sync/crdt-utils";
import type { Operation } from "../sync/sync";

/**
 * How many characters before the caret the composition replaces, when the host
 * measured it from its input surface (see `CompositionState.replaces`). The
 * editor entry attaches it to the native event before queueing; absent means
 * unknown (start: 0, update: keep the current value).
 */
export type MeasuredCompositionEvent = CompositionEvent & {
  readonly replaces?: number;
};

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
    replaces: (event as MeasuredCompositionEvent).replaces,
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
    replaces: (event as MeasuredCompositionEvent).replaces,
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

  const composedText = event.data || "";
  const result = commitComposition(
    state,
    composedText,
    (event as MeasuredCompositionEvent).replaces,
  );
  if (!result) return { state: endComposition(state), ops: [] };

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

/**
 * Commit the composition through COMPOSITION_END. Returns null when it was not
 * committed — the editor cannot take text (unfocused, readonly, suspended), or
 * the commit threw — and the caller must end the composition without
 * inserting: losing the word is cheaper than a stranded `isComposing`, which
 * blocks every later keystroke (see handleCompositionEnd).
 */
function commitComposition(
  state: EditorState,
  data: string,
  replaces?: number,
): { state: EditorState; ops: Operation[] } | null {
  const canInsert =
    state.view.isFocused &&
    state.ui.mode !== "readonly" &&
    state.ui.mode !== "suspended";
  if (!canInsert) return null;
  try {
    return state.actionBus.dispatchState(COMPOSITION_END, state, {
      data,
      replaces,
    });
  } catch (error) {
    // A schema insert rule, a node's typed-input transform, or a
    // host-registered override threw; the clear inside COMPOSITION_END never ran.
    console.error("Failed to commit IME composition:", error);
    return null;
  }
}

/**
 * Commit an open composition when a non-IME event moved the caret away from it
 * (a tap or click on another line, a drag-select, a long-press). Returns null
 * when nothing needs to change.
 *
 * The composition is drawn at the caret and committed at the caret, so leaving
 * it open would carry the word to wherever the caret went. A native text field
 * instead commits the composing text where it was typed when the caret leaves
 * it; this does the same — the text lands at the composition's own spot, and
 * the caret/selection stays where the gesture put it (re-anchored to the same
 * characters, so text inserted before it does not shift it).
 *
 * `before` is the state right before the event, `after` the state it produced.
 * The host still has to tell the keyboard its composition is over (see the
 * editor entry's `staleComposition`).
 */
export function commitCompositionOnCaretMove(
  before: EditorState,
  after: EditorState,
): { state: EditorState; ops: Operation[] } | null {
  const composition = after.ui.composition;
  if (!before.ui.composition?.isComposing || !composition?.isComposing) {
    return null;
  }
  if (!caretMoved(before, after)) return null;

  if (!composition.text) {
    // Nothing to insert. An empty recomposition — a reopened word the keyboard
    // emptied — is the one case that would edit; keeping the word is the safe
    // side.
    return { state: endComposition(after), ops: [] };
  }

  // A reopened word the keyboard has not changed: nothing to commit. Common on
  // HeliBoard, which reopens the word the caret rests after, so a tap elsewhere
  // usually ends an untouched recomposition.
  const caret = before.document.cursor?.position;
  const replaces = composition.replaces ?? 0;
  if (caret && replaces > 0 && !before.document.contentSelection) {
    const block = after.document.page.blocks[caret.blockIndex];
    const word = block
      ? getBlockTextContent(block).slice(
          Math.max(0, caret.textIndex - replaces),
          caret.textIndex,
        )
      : "";
    if (word === composition.text) {
      return { state: endComposition(after), ops: [] };
    }
  }

  // Re-anchor the gesture's flat caret/selection to characters, so it survives
  // the commit's insert. A content selection (a table cell) already is.
  const page = after.document.page;
  const anchorOf = (p: Position) => positionToCRDT(page, p);
  const afterCursor = after.document.cursor;
  const afterSelection = after.document.selection;
  const cursorAnchor = afterCursor ? anchorOf(afterCursor.position) : null;
  const selectionAnchors = afterSelection
    ? {
        anchor: anchorOf(afterSelection.anchor),
        focus: anchorOf(afterSelection.focus),
      }
    : null;

  // Commit from where the composition was typed: the pre-event caret.
  const base: EditorState = {
    ...after,
    document: {
      ...after.document,
      cursor: before.document.cursor,
      selection: before.document.selection,
      contentSelection: before.document.contentSelection,
    },
  };
  const committed = commitComposition(base, composition.text);
  if (!committed) return { state: endComposition(after), ops: [] };

  const nextPage = committed.state.document.page;
  // A recomposition replaces only the characters that changed (see
  // COMPOSITION_END), so a tap inside the word usually stays on a kept
  // character. When the commit replaced the very character the caret was
  // anchored to, keep the same offset into the word instead: the CRDT fallback
  // for a deleted character lands elsewhere in the block.
  const wordStart = caret ? caret.textIndex - replaces : 0;
  const insideWord = (p: Position) =>
    !!caret &&
    replaces > 0 &&
    p.blockIndex === caret.blockIndex &&
    p.textIndex > wordStart &&
    p.textIndex < caret.textIndex;
  const restore = (p: Position, anchor: ReturnType<typeof anchorOf>) => {
    const moved = anchor && crdtToPosition(nextPage, anchor);
    if (!moved) return p;
    const kept =
      !anchor.afterCharId ||
      positionToCRDT(nextPage, moved)?.afterCharId === anchor.afterCharId;
    if (kept || !insideWord(p)) return moved;
    return {
      blockIndex: p.blockIndex,
      textIndex:
        wordStart + Math.min(p.textIndex - wordStart, composition.text.length),
    };
  };
  return {
    state: {
      ...committed.state,
      document: {
        ...committed.state.document,
        cursor: afterCursor
          ? {
              ...afterCursor,
              position: restore(afterCursor.position, cursorAnchor),
            }
          : null,
        selection:
          afterSelection && selectionAnchors
            ? {
                ...afterSelection,
                anchor: restore(afterSelection.anchor, selectionAnchors.anchor),
                focus: restore(afterSelection.focus, selectionAnchors.focus),
              }
            : afterSelection,
        contentSelection: after.document.contentSelection,
      },
    },
    ops: committed.ops,
  };
}

// Whether the event moved the caret or changed the selection.
function caretMoved(before: EditorState, after: EditorState): boolean {
  const a = before.document;
  const b = after.document;
  const samePosition = (p?: Position | null, q?: Position | null) =>
    p === q ||
    (!!p &&
      !!q &&
      p.blockIndex === q.blockIndex &&
      p.textIndex === q.textIndex);
  if (!samePosition(a.cursor?.position, b.cursor?.position)) return true;
  // A collapsed selection is only a caret, already compared above.
  const rangeA = a.selection?.isCollapsed ? null : a.selection;
  const rangeB = b.selection?.isCollapsed ? null : b.selection;
  if (!!rangeA !== !!rangeB) return true;
  if (
    rangeA &&
    rangeB &&
    (!samePosition(rangeA.anchor, rangeB.anchor) ||
      !samePosition(rangeA.focus, rangeB.focus))
  ) {
    return true;
  }
  if (a.contentSelection === b.contentSelection) return false;
  if (!a.contentSelection || !b.contentSelection) return true;
  return (
    !contentPointsEqual(a.contentSelection.anchor, b.contentSelection.anchor) ||
    !contentPointsEqual(a.contentSelection.focus, b.contentSelection.focus)
  );
}
