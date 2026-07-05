import { SELECT_ALL } from "../actions/edit-actions";
import { EXTEND_SELECTION_RIGHT } from "../actions/keyboard-actions";
import { SELECT_WORD_AT_POINT } from "../actions/mouse-actions";
import { TAP_SELECT_WORD } from "../actions/touch-actions";
import {
  snapSelectionToConstructs,
  startSelection,
  updateSelectionFocus,
} from "../selection";
import type { CursorState, Page } from "../state-types";
import { createInitialState } from "../state-utils";
import { getEditorStyles } from "../styles";
import { type MathBlock, MathNode } from "./MathNode";
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

describe("mobile selection-handle drag snaps level-by-level", () => {
  // The touch selection-handle drag (chromeRegions `selectionHandleRegion`
  // onMove) writes the focus from a raw, row-accurate hit-test, so the finger
  // can reach a fraction's stacked rows. It then routes that focus through the
  // SAME `snapSelectionToConstructs` every desktop extension uses, so dragging a
  // handle out through a construct escalates to the whole construct level by
  // level — while a partial span that never straddles a construct's slots is
  // left exactly as dragged (a "half construct" the user is mid-selecting).
  const snap = (latex: string, anchor: number, rawFocus: number) => {
    const page: Page = { id: "p", title: "M", blocks: [mathBlock(latex)] };
    const state = createInitialState(page);
    return snapSelectionToConstructs(
      state,
      { blockIndex: 0, textIndex: anchor },
      { blockIndex: 0, textIndex: rawFocus },
      undefined,
    );
  };

  it("escalates a focus dragged into a fraction to the whole construct", () => {
    // Anchor after the fraction; the finger drags the focus into the denominator
    // (raw stop 9). The half-covered fraction snaps out to its far edge — whole.
    const latex = "\\frac{a}{b}"; // [0, 11)
    const { anchor, focus } = snap(latex, latex.length, 9);

    expect(anchor.textIndex).toBe(latex.length);
    expect(focus.textIndex).toBe(0);
  });

  it("takes each nested construct whole as the drag descends level by level", () => {
    // "\frac{x^2}{d}": the finger drags the focus into the numerator's script
    // base. The nearest construct straddled — the inner `x^2` — is taken whole,
    // not the outer fraction and not the bare `x`.
    const latex = "\\frac{x^2}{d}"; // inner script x^2 spans [6, 9)
    const { anchor, focus } = snap(latex, 6, 8);

    expect(anchor.textIndex).toBe(6);
    expect(focus.textIndex).toBe(9);
  });

  it("leaves a half-construct partial span exactly as dragged", () => {
    // Both endpoints sit inside one slot (`ab` in the numerator): the user is
    // mid-selecting a fragment, so nothing balloons — the partial stays partial.
    const latex = "\\frac{ab}{c}"; // numerator `ab` spans [6, 8)
    const { anchor, focus } = snap(latex, 6, 7);

    expect(anchor.textIndex).toBe(6);
    expect(focus.textIndex).toBe(7);
  });

  // The onMove loop must return the SAME selection every frame while the finger
  // dwells inside a construct — otherwise the whole construct flickers in and out
  // between expand and shrink. This simulates that loop for a sequence of raw
  // hit-test focuses, updating the travel-direction reference by one of three
  // rules so the stable one can be told apart from the two that flicker:
  //   • "settled" — the fix: advance the reference only when the finger lands at
  //     a stop the snapper did NOT widen, so an interior dwell stays latched.
  //   • "raw"     — advance every frame to the raw focus: a finger dithering
  //     between two INTERIOR stops flips the travel sign each frame.
  //   • "snapped" — advance to the snapped focus (the original bug): the focus
  //     jumps to the construct's edges, flipping the sign even when held still.
  const driveDrag = (
    latex: string,
    anchor: number,
    rawSequence: number[],
    reference: "settled" | "raw" | "snapped",
  ): number[] => {
    const page: Page = { id: "p", title: "M", blocks: [mathBlock(latex)] };
    const state = createInitialState(page);
    const anchorPos = { blockIndex: 0, textIndex: anchor };
    let prev: { blockIndex: number; textIndex: number } | undefined = undefined;
    const focuses: number[] = [];
    for (const rawIndex of rawSequence) {
      const raw = { blockIndex: 0, textIndex: rawIndex };
      const snapped = snapSelectionToConstructs(state, anchorPos, raw, prev);
      const settled = snapped.focus.textIndex === raw.textIndex;
      if (reference === "snapped") prev = snapped.focus;
      else if (reference === "raw") prev = raw;
      else if (settled) prev = raw;
      focuses.push(snapped.focus.textIndex);
    }
    return focuses;
  };

  it("holds a steady selection when the finger rests near a construct edge", () => {
    // "\frac{a}{b}+c": anchor after everything, finger held in the denominator.
    // Every frame resolves to the same snapped focus — no expand/shrink flicker.
    const latex = "\\frac{a}{b}+c"; // fraction [0, 11)
    const focuses = driveDrag(latex, latex.length, [9, 9, 9, 9], "settled");

    expect(new Set(focuses).size).toBe(1);
  });

  it("holds steady even when the raw hit-test dithers between interior stops", () => {
    // The real shrink flicker: a finger hovering the fraction it is trying to
    // exclude resolves alternately to two interior stops. The latched reference
    // keeps the decision fixed, so the selection never oscillates.
    const latex = "\\frac{a}{b}+c";
    const focuses = driveDrag(latex, latex.length, [8, 9, 8, 9, 8], "settled");

    expect(new Set(focuses).size).toBe(1);
  });

  it("guards the regression: a per-frame raw reference flickers on dither", () => {
    // Advancing the reference every frame (not only at settled stops) lets the
    // interior dither flip the travel sign each frame — the residual flicker.
    const latex = "\\frac{a}{b}+c";
    const focuses = driveDrag(latex, latex.length, [8, 9, 8, 9, 8], "raw");

    expect(new Set(focuses).size).toBeGreaterThan(1);
  });

  it("guards the regression: feeding back the snapped focus oscillates at rest", () => {
    // The original bug — the snapped focus jumps to the construct's edges, so
    // even a perfectly still finger flickers the selection.
    const latex = "\\frac{a}{b}+c";
    const focuses = driveDrag(latex, latex.length, [9, 9, 9, 9], "snapped");

    expect(new Set(focuses).size).toBeGreaterThan(1);
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
    const state = createInitialState(page);
    const node = new MathNode();
    const layout = node.computeLayout(
      state.document.page.blocks[0] as MathBlock,
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
