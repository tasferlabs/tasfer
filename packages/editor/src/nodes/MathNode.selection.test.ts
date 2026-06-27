import { SELECT_ALL } from "../actions/edit-actions";
import { SELECT_WORD_AT_POINT } from "../actions/mouse-actions";
import { TAP_SELECT_WORD } from "../actions/touch-actions";
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
