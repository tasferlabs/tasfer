/**
 * Regression: Shift+Home / Shift+End (⌘⇧← / ⌘⇧→ on macOS) inside a block
 * equation must reach the next boundary on every press, never stall.
 *
 * The first press extends to the edge of the caret's own row (a fraction's
 * numerator, a script slot). Before the fix, every further press re-targeted
 * that same edge and did nothing — and a caret already resting on a slot edge
 * could not move at all. A press at a slot edge now climbs to the edge of the
 * row holding the construct, so the selection grows outward to cover it.
 *
 * These drive the real EXTEND_SELECTION_HOME/_END actions over a fabricated
 * state (no canvas mount) and read the selection back as LaTeX source offsets.
 */
import { createMathTestState, loadMathPage } from "./__testutils__/math";
import { getMathStructuredDocument } from "./structured";
import {
  mathContentSelectionFromSourceOffset,
  mathSourceOffsetFromContentPoint,
} from "./tree-selection";
import {
  EXTEND_SELECTION_END,
  EXTEND_SELECTION_HOME,
} from "@tasfer/editor/actions/keyboard-actions";
import type { EditorState } from "@tasfer/editor/state-types";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { describe, expect, it } from "vitest";

// A collapsed nested caret at `sourceOffset` of the page's only equation.
function caretAt(latex: string, sourceOffset: number): EditorState {
  const state = createMathTestState(loadMathPage(`$$\n${latex}\n$$`));
  const block = state.document.page.blocks[0];
  const document = getMathStructuredDocument(block);
  if (!document) throw new Error("expected a block-authority math document");
  const selection = mathContentSelectionFromSourceOffset(
    block.id,
    document.rootId,
    document,
    sourceOffset,
  );
  if (!selection) throw new Error(`no tree caret at offset ${sourceOffset}`);
  return updateContentSelection(state, selection);
}

// The nested selection as `[anchor, focus]` source offsets.
function range(state: EditorState): [number | null, number | null] {
  const selection = state.document.contentSelection;
  const document = getMathStructuredDocument(state.document.page.blocks[0]);
  if (!selection || !document) throw new Error("expected a nested selection");
  return [
    mathSourceOffsetFromContentPoint(document, selection.anchor),
    mathSourceOffsetFromContentPoint(document, selection.focus),
  ];
}

function press(state: EditorState, edge: "start" | "end"): EditorState {
  const action =
    edge === "start" ? EXTEND_SELECTION_HOME : EXTEND_SELECTION_END;
  const result = state.actionBus.dispatchState(action, state, {
    isCtrl: false,
  });
  expect(result.claimed).toBe(true);
  return result.state;
}

describe("block math — Shift+Home/End reaches the next boundary per press", () => {
  const fraction = "a+\\frac{bc}{d}+e";
  const numeratorStart = fraction.indexOf("{bc}") + 1;
  const afterC = fraction.indexOf("c}") + 1;

  it("Shift+Home climbs from the numerator start to the equation start", () => {
    const atSlotStart = caretAt(fraction, numeratorStart);
    const once = press(atSlotStart, "start");
    // The anchor snaps past the fraction so the selection covers it whole.
    expect(range(once)).toEqual([fraction.length - 2, 0]);
    // The equation start is the last boundary; another press stays put.
    expect(range(press(once, "start"))).toEqual([fraction.length - 2, 0]);
  });

  it("Shift+End reaches the numerator end, then the equation end", () => {
    const inside = caretAt(fraction, numeratorStart);
    const once = press(inside, "end");
    expect(range(once)).toEqual([numeratorStart, afterC]);
    const twice = press(once, "end");
    expect(range(twice)).toEqual([fraction.indexOf("\\frac"), fraction.length]);
  });

  it("Shift+Home from a script base walks out to the equation start", () => {
    const scripts = "a+x^{23}+e";
    const state = caretAt(scripts, scripts.indexOf("x") + 1);
    const once = press(state, "start");
    const twice = press(once, "start");
    expect(range(twice)[1]).toBe(0);
  });

  it("a flat equation still selects to its edge in one press", () => {
    const flat = "x+y+z";
    expect(range(press(caretAt(flat, 3), "start"))).toEqual([3, 0]);
    expect(range(press(caretAt(flat, 3), "end"))).toEqual([3, flat.length]);
  });
});
