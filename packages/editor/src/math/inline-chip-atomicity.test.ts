/**
 * An inline chip is ATOMIC to the flat model.
 *
 * A chip is exactly one anchor char whose only source is its attached
 * MathDocument — there is no flat LaTeX projection to diverge from (the old
 * "divergent projection" cannot exist). These tests pin the atomic contract
 * that made divergence safe to remove: flat gestures address the chip as one
 * unit (word-select, selection stops, highlight geometry, taps), and edits
 * that cross a chip edge flow through the tree, not through flat offsets.
 */
import { selectWordAtPosition } from "../actions/actions";
import { DELETE_BACKWARD } from "../actions/edit-actions";
import { EXTEND_SELECTION_RIGHT } from "../actions/keyboard-actions";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { mathExtension } from "../math-extension";
import { TextNode, type TextualBlock } from "../nodes/TextNode";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { resolveTheme } from "../styles";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { createCRDTbinding } from "../sync/sync";
import { resolveStructuredInlineMathRuns } from "./inline-structured";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

/** `aa $x+y$ bb` — one attached chip flanked by prose. */
function chipState(peer: string): {
  state: EditorState;
  chipStart: number;
  chipEnd: number;
} {
  const binding = createCRDTbinding("page", peer);
  const state = createInitialState(loadPage("aa $x+y$ bb", schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: binding,
  });
  const run = resolveStructuredInlineMathRuns(
    state.document.page.blocks[0] as TextualBlock,
  )[0];
  if (!run) throw new Error("expected an inline math run");
  return { state, chipStart: run.startIndex, chipEnd: run.endIndex };
}

function chipRun(state: EditorState) {
  return resolveStructuredInlineMathRuns(
    state.document.page.blocks[0] as TextualBlock,
  )[0];
}

function blockText(state: EditorState): string {
  const block = state.document.page.blocks[0];
  return "charRuns" in block ? getVisibleTextFromRuns(block.charRuns) : "";
}

describe("inline chip atomicity in the flat model", () => {
  it("the chip is one anchor char with the formula as its attachment", () => {
    const { state, chipStart, chipEnd } = chipState("atomic-shape");
    expect(chipEnd).toBe(chipStart + 1);
    expect(blockText(state)).toBe(`aa ${STRUCTURED_MARK_ANCHOR_CHAR} bb`);
    expect(chipRun(state)?.latex).toBe("x+y");
  });

  it("word-select on the chip takes the whole run", () => {
    const { state, chipStart, chipEnd } = chipState("atomic-word");
    const sel = selectWordAtPosition(state, {
      blockIndex: 0,
      textIndex: chipStart,
    }).document.selection;
    expect(sel?.anchor.textIndex).toBe(chipStart);
    expect(sel?.focus.textIndex).toBe(chipEnd);
  });

  it("one flat selection step from the chip's edge covers it whole", () => {
    // The flat caret has no interior stops: a single Shift+Right sweeps the
    // entire formula into the selection.
    const { state, chipStart, chipEnd } = chipState("atomic-step");
    const withCaret = moveCursorToPosition(state, 0, chipStart);
    const extended = withCaret.actionBus.dispatchState(
      EXTEND_SELECTION_RIGHT,
      withCaret,
    );
    expect(extended.state.document.selection?.anchor.textIndex).toBe(chipStart);
    expect(extended.state.document.selection?.focus.textIndex).toBe(chipEnd);
  });

  it("Backspace from trailing prose deletes through the formula, the chip, then prose", () => {
    const { state, chipEnd } = chipState("atomic-backspace");
    // Facing the chip's trailing edge, Backspace promotes into the tree and
    // deletes one unit per press.
    let current = moveCursorToPosition(state, 0, chipEnd);
    const sources: (string | undefined)[] = [];
    for (let press = 0; press < 3; press++) {
      const result = current.actionBus.dispatchState(DELETE_BACKWARD, current);
      expect(result.claimed).toBe(true);
      current = result.state;
      sources.push(chipRun(current)?.latex);
    }
    expect(sources).toEqual(["x+", "x", ""]);
    // The drained chip survives one press as an empty editable slot; the next
    // press removes the chip whole (anchor char + attachment)…
    current = current.actionBus.dispatchState(DELETE_BACKWARD, current).state;
    expect(chipRun(current)).toBeUndefined();
    expect(blockText(current)).toBe("aa  bb");
    // …and further presses continue into the leading prose without sticking.
    for (let press = 0; press < 3; press++) {
      current = current.actionBus.dispatchState(DELETE_BACKWARD, current).state;
    }
    expect(blockText(current)).toBe(" bb");
  });
});

describe("inline chip atomicity in flat geometry", () => {
  const styles = resolveTheme({});
  const node = new TextNode();

  const geometry = (peer: string) => {
    const { state, chipStart, chipEnd } = chipState(peer);
    const block = state.document.page.blocks[0] as TextualBlock;
    const layout = node.computeLayout(
      block,
      1000,
      styles,
      undefined,
      state.marks,
    );
    return {
      block,
      layout,
      chipStart,
      chipEnd,
      chipLeft: node.caretRect(layout, chipStart, 0, 0).x,
      chipRight: node.caretRect(layout, chipEnd, 0, 0).x,
    };
  };

  it("a whole-chip flat selection highlights the full formula width", () => {
    const { layout, chipStart, chipEnd, chipLeft, chipRight } =
      geometry("atomic-paint");
    const rects = node.selectionRects(
      layout,
      {
        anchor: { blockIndex: 0, textIndex: chipStart },
        focus: { blockIndex: 0, textIndex: chipEnd },
        isForward: true,
      },
      0,
      0,
      0,
    );
    expect(rects.length).toBeGreaterThan(0);
    // One flat char, but the highlight spans the painted formula's advance.
    const left = Math.min(...rects.map((r) => r.x));
    const right = Math.max(...rects.map((r) => r.x + r.width));
    expect(chipRight - chipLeft).toBeGreaterThan(10);
    expect(left).toBeCloseTo(chipLeft, 0);
    expect(right).toBeCloseTo(chipRight, 0);
  });

  it("a tap anywhere on the chip resolves to a chip edge at the flat level", () => {
    const { block, layout, chipStart, chipEnd, chipLeft, chipRight } =
      geometry("atomic-tap");
    const line = layout.lines[0];
    const midY = line.y + line.height / 2;
    for (let frac = 0.1; frac < 1; frac += 0.2) {
      const x = chipLeft + (chipRight - chipLeft) * frac;
      const index = node.positionFromPoint(block, layout, x, midY, 0, 0);
      // Interior flat indices don't exist; the near edge wins.
      expect(index).toBe(frac < 0.5 ? chipStart : chipEnd);
    }
  });
});
