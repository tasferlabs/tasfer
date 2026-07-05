/**
 * A delivered `compositionend` must always terminate the IME session and clear
 * `ui.composition.isComposing`, regardless of the editor's focus/mode at the
 * moment the event is processed.
 *
 * Regression: on mobile, accepting a soft-keyboard autocomplete inside (or right
 * after) a code/math block — both preformatted, so both use the managed input
 * surface where composition is tracked — could strand `isComposing: true`. The
 * `compositionend` arrives during the transient blur that Android WebViews
 * synthesize around touch, and the old handler early-returned on `!isFocused`
 * without clearing the flag. The stale flag then hard-blocks every subsequent
 * Enter and keystroke (see the composition guards in keysEvents / the input
 * surface), producing the "can't press Enter after the block" symptom.
 */
import { startComposition } from "./composition";
import { handleCompositionEnd } from "./events/compositionEvents";
import { moveCursorToPosition } from "./selection";
import type { EditorState, ViewportState } from "./state-types";
import { createInitialState } from "./state-utils";
import { insertCharsAtPosition } from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import { describe, expect, it } from "vitest";

function proseState(text: string) {
  const binding = createCRDTbinding("comp-end", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;

  let page = engine.getState();
  if (text) {
    page = insertCharsAtPosition(page, blockId, 0, text, binding).newPage;
  }
  let state = createInitialState(page, { crdtBinding: binding });
  state = moveCursorToPosition(state, 0, text.length);
  return state;
}

const VIEWPORT = { scrollY: 0, height: 800, width: 600 } as ViewportState;

/** Minimal stand-in for the DOM CompositionEvent (the handler only reads `data`). */
function compositionEnd(data: string): CompositionEvent {
  return { data } as CompositionEvent;
}

function withComposition(state: EditorState): EditorState {
  const focused: EditorState = {
    ...state,
    view: { ...state.view, isFocused: true },
  };
  return startComposition(focused, "あ", {
    blockIndex: 0,
    textIndex: focused.document.cursor!.position.textIndex,
  });
}

describe("compositionend always clears the composition flag", () => {
  it("clears isComposing even when the editor lost focus mid-composition", () => {
    // Composition begins while focused, then the WebView blurs the input before
    // `compositionend` is processed (isFocused === false at end time).
    const composing = withComposition(proseState("hi"));
    expect(composing.ui.composition?.isComposing).toBe(true);

    const blurred: EditorState = {
      ...composing,
      view: { ...composing.view, isFocused: false },
    };

    const { state: after } = handleCompositionEnd(
      blurred,
      compositionEnd("あ"),
      VIEWPORT,
    );

    // The flag is gone, so subsequent Enter/keystrokes are no longer swallowed.
    expect(after.ui.composition).toBeNull();
  });

  it("clears isComposing when the mode flipped to readonly mid-composition", () => {
    const composing = withComposition(proseState("hi"));
    const readonly: EditorState = {
      ...composing,
      ui: { ...composing.ui, mode: "readonly" },
    };

    const { state: after } = handleCompositionEnd(
      readonly,
      compositionEnd("あ"),
      VIEWPORT,
    );

    expect(after.ui.composition).toBeNull();
  });

  it("commits the composed text and clears the flag on a normal (focused) end", () => {
    const composing = withComposition(proseState("hi"));

    const { state: after } = handleCompositionEnd(
      composing,
      compositionEnd("あ"),
      VIEWPORT,
    );

    expect(after.ui.composition).toBeNull();
    const text = after.document.page.blocks[0].charRuns
      .map((r) => r.text)
      .join("");
    expect(text).toBe("hiあ");
  });
});
