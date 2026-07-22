import { createMathTestState } from "../__testutils__/math";
import { SELECT_ALL } from "../actions/edit-actions";
import { SELECT_WORD_AT_POINT } from "../actions/mouse-actions";
import { TAP_SELECT_WORD } from "../actions/touch-actions";
import type { Block, Page } from "../serlization/loadPage";
import type { CursorState } from "../state-types";
import { getEditorStyles } from "../styles";
import { type MathBlock, MathNode } from "./MathNode";
import { describe, expect, it } from "vitest";

// A display equation still carrying its interchange LaTeX source in charRuns
// (the import-time compatibility shape, before a structured attachment exists).
// "math" sits outside the closed core Block union, hence the crossing cast.
function mathBlock(latex: string): Block {
  const block: MathBlock = {
    id: "math-1",
    orderKey: "a0",
    deleted: false,
    type: "math",
    charRuns: [{ peerId: "peer", startCounter: 0, text: latex }],
    formats: [],
    displayMode: true,
  };
  return block as never;
}

function selectAt(latex: string, textIndex: number) {
  const page: Page = {
    id: "page-1",
    title: "Math",
    blocks: [mathBlock(latex)],
  };
  const state = createMathTestState(page);
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
  const state = createMathTestState(page);
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
  const state = createMathTestState(page);
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
    const state = createMathTestState(page);
    const selection = state.actionBus.dispatchState(
      SELECT_WORD_AT_POINT,
      state,
      { position: { blockIndex: 0, textIndex: 1 } },
    ).state.document.selection;

    expect(selection?.anchor.textIndex).toBe(0);
    expect(selection?.focus.textIndex).toBe(5);
  });
});

describe("MathNode selection rects hug the rendered formula", () => {
  // Regression: the hit-test that decides "did this tap land inside the
  // selection" (`isPointWithinSelectionRects`) reads the node's `selectionRects`.
  // MathNode must return the tex-rendered highlight geometry (what `paint`
  // draws), NOT the base TextNode band derived from laying the raw LaTeX source
  // out as prose — otherwise the whole equation reads as "inside the selection",
  // so a tap anywhere on it spuriously opens the context menu instead of
  // collapsing the selection and moving the caret.
  const PADDING_LEFT = 24;

  function layoutFor(latex: string) {
    const page: Page = { id: "p", title: "M", blocks: [mathBlock(latex)] };
    const state = createMathTestState(page);
    const node = new MathNode();
    const layout = node.computeLayout(
      state.document.page.blocks[0] as never as MathBlock,
      600,
      getEditorStyles(state),
      undefined,
      state.marks,
    );
    return { node, layout };
  }

  function rectsForRange(latex: string, from: number, to: number) {
    const { node, layout } = layoutFor(latex);
    const selection = {
      anchor: { blockIndex: 0, textIndex: from },
      focus: { blockIndex: 0, textIndex: to },
      isForward: true,
      isCollapsed: from === to,
    };
    return {
      layout,
      rects: node.selectionRects(layout, selection, 0, PADDING_LEFT, 0),
    };
  }

  it("highlights only the selected atom, not the whole equation band", () => {
    // Select just the leading `x` of `x+y`: the highlight hugs that glyph, so a
    // tap at the formula's right edge is OUTSIDE the selection.
    const { layout, rects } = rectsForRange("x+y", 0, 1);
    const fullWidth = layout.mathLayout!.width;

    expect(rects.length).toBeGreaterThan(0);
    const selectedWidth = Math.max(...rects.map((r) => r.width));
    // A single glyph is a small fraction of the whole formula's width — proving
    // the rect is tex geometry, not a source-text band spanning the block.
    expect(selectedWidth).toBeLessThan(fullWidth * 0.6);

    // No rect covers the formula's far right edge (well past the selected `x`).
    const rightEdge = PADDING_LEFT + layout.mathOffsetX + fullWidth - 1;
    const covered = rects.some(
      (r) => rightEdge >= r.x && rightEdge <= r.x + r.width,
    );
    expect(covered).toBe(false);
  });

  it("returns no rects for a collapsed caret", () => {
    expect(rectsForRange("x+y", 1, 1).rects).toEqual([]);
  });

  it("returns no rects for an empty equation", () => {
    expect(rectsForRange("", 0, 0).rects).toEqual([]);
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
