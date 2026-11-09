import type { EditorState, Position } from "./state-types";
import type { ContentPoint } from "./structured-selection";

// Composition (IME) State Management

export function startComposition(
  state: EditorState,
  text: string,
  startPosition: Position | ContentPoint,
): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        isComposing: true,
        text,
        startPosition,
        cursorOffset: text.length,
      },
    },
  };
}

export function updateComposition(
  state: EditorState,
  text: string,
): EditorState {
  if (!state.ui.composition) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        ...state.ui.composition,
        text,
        cursorOffset: Math.min(state.ui.composition.cursorOffset, text.length),
      },
    },
  };
}

export function endComposition(state: EditorState): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: null,
    },
  };
}

/**
 * How many UTF-16 units `a` and `b` share at the start and, after that, at the
 * end — never splitting a surrogate pair, never overlapping. A recomposition
 * (a keyboard that reopened the word before the caret) only replaces what lies
 * between: the commit edits it and the preview draws it, so both agree on which
 * characters keep their own formatting.
 */
export function sharedEnds(a: string, b: string) {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  if (prefix > 0 && (isLowSurrogate(a, prefix) || isLowSurrogate(b, prefix))) {
    prefix--;
  }
  let suffix = 0;
  while (
    suffix < max - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (
    suffix > 0 &&
    (isLowSurrogate(a, a.length - suffix) ||
      isLowSurrogate(b, b.length - suffix))
  ) {
    suffix--;
  }
  return { prefix, suffix };
}

function isLowSurrogate(text: string, index: number) {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}
