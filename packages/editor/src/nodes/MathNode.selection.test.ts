import { SELECT_ALL } from "../actions/edit-actions";
import { EXTEND_SELECTION_RIGHT } from "../actions/keyboard-actions";
import { SELECT_WORD_AT_POINT } from "../actions/mouse-actions";
import { TAP_SELECT_WORD } from "../actions/touch-actions";
import { startSelection, updateSelectionFocus } from "../selection";
import type { CursorState, Page } from "../state-types";
import { createInitialState } from "../state-utils";
import type { MathBlock } from "./MathNode";
import { describe, expect, it } from "vitest";

function mathBlock(latex: string): MathBlock {
  return {
    id: "math-1",
    orderKey: "a0",
    deleted: false,
    type: "math",
    charRuns: [{ peerId: "peer", startCounter: 0, text: latex }],
    formats: [],
    displayMode: true,
  };
}

function selectAt(latex: string, textIndex: number) {
  const page: Page = {
    id: "page-1",
    title: "Math",
    blocks: [mathBlock(latex)],
  };
  const state = createInitialState(page);
  return state.actionBus.dispatchState(SELECT_WORD_AT_POINT, state, {
    position: { blockIndex: 0, textIndex },
  }).state.document.selection;
}

function tapSelectAt(latex: string, textIndex: number) {
  const page: Page = {
    id: "page-1",
    title: "Math",
    blocks: [mathBlock(latex)],
  };
  const state = createInitialState(page);
  return state.actionBus.dispatchState(TAP_SELECT_WORD, state, {
    position: { blockIndex: 0, textIndex },
  }).state.document.selection;
}

function stateWithMathCaret(latex: string, textIndex: number) {
  const page: Page = {
    id: "page-1",
    title: "Math",
    blocks: [
      mathBlock(latex),
      {
        id: "paragraph-1",
        orderKey: "a1",
        deleted: false,
        type: "paragraph",
        charRuns: [{ peerId: "peer", startCounter: 20, text: "after" }],
        formats: [],
      },
    ],
  };
  const state = createInitialState(page);
  const cursor: CursorState = {
    position: { blockIndex: 0, textIndex },
    lastUpdate: 0,
  };
  return { ...state, document: { ...state.document, cursor } };
}

describe("MathNode double-click selection", () => {
  it("selects a complete fraction when the hit lands in its numerator", () => {
    const latex = "\\frac{a}{b}";
    const selection = selectAt(latex, 7);

    expect(selection?.anchor.textIndex).toBe(0);
    expect(selection?.focus.textIndex).toBe(latex.length);
    expect(selection?.initialBoundary).toEqual({
      start: { blockIndex: 0, textIndex: 0 },
      end: { blockIndex: 0, textIndex: latex.length },
    });
  });

  it("selects a whole command instead of its source letters", () => {
    const selection = selectAt("\\alpha+1", 0);

    expect(selection?.anchor.textIndex).toBe(0);
    expect(selection?.focus.textIndex).toBe(6);
  });

  it("selects the whole fraction from a glyph mid-numerator", () => {
    // "\frac{ab}{c}" — the hit lands between the two numerator glyphs. The unit
    // must escalate to the whole fraction, not chip the lone source char `a`.
    const latex = "\\frac{ab}{c}";
    const selection = selectAt(latex, 7);

    expect(selection?.anchor.textIndex).toBe(0);
    expect(selection?.focus.textIndex).toBe(latex.length);
  });

  it("selects the innermost construct when constructs nest", () => {
    // "\frac{x^2}{d}" — clicking the script base selects the whole `x^2`.
    const selection = selectAt("\\frac{x^2}{d}", 7);

    expect(selection?.anchor.textIndex).toBe(6);
    expect(selection?.focus.textIndex).toBe(9);
  });

  it("double-tap (touch) selects the construct just like double-click", () => {
    const latex = "\\frac{a}{b}";
    const selection = tapSelectAt(latex, 7);

    expect(selection?.anchor.textIndex).toBe(0);
    expect(selection?.focus.textIndex).toBe(latex.length);
  });

  it("keeps ordinary text blocks on the normal word-selection path", () => {
    const page: Page = {
      id: "page-1",
      title: "Text",
      blocks: [
        {
          id: "paragraph-1",
          orderKey: "a0",
          deleted: false,
          type: "paragraph",
          charRuns: [{ peerId: "peer", startCounter: 0, text: "hello world" }],
          formats: [],
        },
      ],
    };
    const state = createInitialState(page);
    const selection = state.actionBus.dispatchState(
      SELECT_WORD_AT_POINT,
      state,
      { position: { blockIndex: 0, textIndex: 1 } },
    ).state.document.selection;

    expect(selection?.anchor.textIndex).toBe(0);
    expect(selection?.focus.textIndex).toBe(5);
  });
});

describe("MathNode range selection snaps to whole constructs", () => {
  // A drag or Shift+Arrow that lands a selection endpoint inside a fraction must
  // widen out to the whole construct — you cannot select PART of a fraction. Both
  // gestures funnel through `updateSelectionFocus`, so driving it directly with a
  // seed anchor + a moved focus exercises the shared snap.
  const dragSelect = (
    latex: string,
    anchorIndex: number,
    focusIndex: number,
  ) => {
    const page: Page = {
      id: "page-1",
      title: "Math",
      blocks: [mathBlock(latex)],
    };
    let state = createInitialState(page);
    state = startSelection(state, {
      blockIndex: 0,
      textIndex: anchorIndex,
    });
    state = updateSelectionFocus(state, {
      blockIndex: 0,
      textIndex: focusIndex,
    });
    return state.document.selection;
  };

  it("widens a focus that lands inside the fraction to its far edge", () => {
    // Anchor just after the whole fraction; drag the focus back into the
    // denominator — the selection must snap to cover the entire `\frac`.
    const latex = "\\frac{a}{b}"; // length 11
    const selection = dragSelect(latex, latex.length, 9);

    expect(selection?.anchor.textIndex).toBe(latex.length);
    expect(selection?.focus.textIndex).toBe(0);
  });

  it("stays WITHIN a slot when both endpoints share it (level-aware)", () => {
    // "\frac{ab}{c}": both endpoints in the numerator — selecting just `a` must
    // NOT balloon to the whole fraction. This is the level-awareness the caret
    // navigation already has, mirrored for range selection.
    const latex = "\\frac{ab}{c}"; // numerator `ab` spans [6, 8)
    const selection = dragSelect(latex, 6, 7);

    expect(selection?.anchor.textIndex).toBe(6);
    expect(selection?.focus.textIndex).toBe(7);
  });

  it("escalates to the whole fraction only when endpoints straddle its slots", () => {
    // Numerator → denominator: the shared level is the top level, so the whole
    // `\frac` is taken (you can't select the numerator plus half the denominator).
    const latex = "\\frac{a}{b}"; // numerator `a` at 6, denominator `b` at 9
    const selection = dragSelect(latex, 6, 9);

    expect(selection?.anchor.textIndex).toBe(0);
    expect(selection?.focus.textIndex).toBe(latex.length);
  });

  it("widens an anchor that started inside the fraction", () => {
    // A drag that BEGAN inside the numerator, then moved past the fraction: the
    // anchor is an illegal in-construct boundary and must widen out too.
    const latex = "\\frac{a}{b}+1"; // fraction is [0, 11)
    const selection = dragSelect(latex, 6, latex.length);

    expect(selection?.anchor.textIndex).toBe(0);
    expect(selection?.focus.textIndex).toBe(latex.length);
  });

  it("leaves a selection between top-level tokens untouched", () => {
    // "\frac{a}{b}+1" — selecting the trailing `+1` never touches the fraction.
    const latex = "\\frac{a}{b}+1";
    const selection = dragSelect(latex, latex.length, 11);

    expect(selection?.anchor.textIndex).toBe(latex.length);
    expect(selection?.focus.textIndex).toBe(11);
  });

  it("does not snap a collapsed caret resting inside a fraction", () => {
    // A bare caret may legally sit inside a construct to edit it; only a real
    // range snaps. Focus back onto the anchor → collapsed, unchanged.
    const latex = "\\frac{a}{b}";
    const selection = dragSelect(latex, 6, 6);

    expect(selection?.isCollapsed).toBe(true);
    expect(selection?.anchor.textIndex).toBe(6);
    expect(selection?.focus.textIndex).toBe(6);
  });

  it("dragging the focus back OUT of the fraction shrinks the selection", () => {
    // Anchor after the fraction; the whole `\frac` is selected (focus at 0). Now
    // drag the focus rightward, back into the fraction: travelling right must snap
    // the focus to the construct's FAR edge (drop it) rather than re-expand — the
    // "select less" case. Emulate the two drag events with two focus updates.
    const latex = "\\frac{a}{b}"; // [0, 11)
    const page: Page = { id: "p", title: "M", blocks: [mathBlock(latex)] };
    let state = createInitialState(page);
    state = startSelection(state, { blockIndex: 0, textIndex: latex.length });
    // First drag left into the denominator → whole fraction selected.
    state = updateSelectionFocus(state, { blockIndex: 0, textIndex: 9 });
    expect(state.document.selection?.focus.textIndex).toBe(0);
    // Now drag back right into the numerator → shrink out to the fraction's end.
    state = updateSelectionFocus(state, { blockIndex: 0, textIndex: 6 });
    expect(state.document.selection?.focus.textIndex).toBe(latex.length);
    expect(state.document.selection?.isCollapsed).toBe(true);
  });
});

describe("MathNode Shift+Arrow crosses a construct in one extra press", () => {
  // The caret must park on the snapped focus, not the interior stop the move
  // landed on — otherwise crossing a construct costs one press per interior stop.
  it("selects the whole fraction, then leaves it, one press each", () => {
    const latex = "\\frac{a}{b}"; // one top-level construct, [0, 11)
    let state = stateWithMathCaret(latex, 0); // caret before the fraction

    // Press 1: Shift+Right takes in the entire fraction and parks the caret on
    // its far edge (11), not an interior numerator/denominator stop.
    state = state.actionBus.dispatchState(EXTEND_SELECTION_RIGHT, state).state;
    expect(state.document.selection?.anchor.textIndex).toBe(0);
    expect(state.document.selection?.focus).toEqual({
      blockIndex: 0,
      textIndex: latex.length,
    });
    expect(state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: latex.length,
    });

    // Press 2: from the parked edge, one more Shift+Right leaves the equation for
    // the following paragraph — no "stuck" repeats.
    state = state.actionBus.dispatchState(EXTEND_SELECTION_RIGHT, state).state;
    expect(state.document.selection?.focus.blockIndex).toBe(1);
  });
});

describe("MathNode select-all scope", () => {
  it("selects only the active math block on the first Ctrl/Cmd+A", () => {
    const latex = "\\frac{a}{b}+1";
    const state = stateWithMathCaret(latex, 7);
    const result = state.actionBus.dispatchState(SELECT_ALL, state);

    expect(result.claimed).toBe(true);
    expect(result.state.document.selection?.anchor).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
    expect(result.state.document.selection?.focus).toEqual({
      blockIndex: 0,
      textIndex: latex.length,
    });
  });

  it("selects the whole document on the second Ctrl/Cmd+A", () => {
    const latex = "\\alpha+1";
    const state = stateWithMathCaret(latex, 3);
    const first = state.actionBus.dispatchState(SELECT_ALL, state);
    const second = first.state.actionBus.dispatchState(SELECT_ALL, first.state);

    expect(second.claimed).toBe(false);
    expect(second.state.document.selection?.anchor).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
    expect(second.state.document.selection?.focus).toEqual({
      blockIndex: 1,
      textIndex: 5,
    });
  });
});
