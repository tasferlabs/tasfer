/**
 * A DIVERGED chip — an attached inline MathMark whose tree edits have outrun
 * its flat compatibility characters — must be ATOMIC to the flat model. Flat
 * offsets index the stale chars while every layout paints the canonical
 * source, so interior caret stops, partial selection, and construct
 * sub-selection would land on phantom positions. These tests build a real
 * divergence (attach a chip, edit it through the tree) and assert the flat
 * paths snap to whole-chip units.
 */
import { selectWordAtPosition } from "../actions/actions";
import { resolveMarkRuns } from "../inline-math-spans";
import { mathExtension } from "../math-extension";
import { mathCaretStep, mathSelectionRange } from "../nodes/math";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { updateContentSelection } from "../structured-selection";
import { createCRDTbinding } from "../sync/sync";
import { resolveStructuredInlineMathRuns } from "./inline-structured";
import {
  enterInlineMathTreeAtPosition,
  insertActiveInlineMathTreeCommand,
} from "./inline-tree-state";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

/**
 * `aa $x+y$ bb` with the chip attached and tree-edited so its canonical source
 * no longer matches its flat chars, and the nested selection cleared so the
 * flat model is back in charge.
 */
function divergedChip(peer: string): {
  state: EditorState;
  chipStart: number;
  chipEnd: number;
} {
  const binding = createCRDTbinding("page", peer);
  const initial = createInitialState(loadPage("aa $x+y$ bb", schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: binding,
  });
  const run = resolveMarkRuns(initial.document.page.blocks[0]).find(
    (candidate) => candidate.name === "math",
  );
  if (!run) throw new Error("expected an inline math run");

  const entered = enterInlineMathTreeAtPosition(
    initial,
    0,
    run.startIndex + 1,
    {
      allowBoundary: true,
    },
  );
  if (!entered) throw new Error("inline math did not enter tree mode");
  const edited = insertActiveInlineMathTreeCommand(entered.state, "z");
  if (!edited) throw new Error("tree edit did not apply");

  const block = edited.state.document.page.blocks[0];
  const resolved = resolveStructuredInlineMathRuns(
    block as Parameters<typeof resolveStructuredInlineMathRuns>[0],
  )[0];
  if (!resolved?.document || resolved.latex === resolved.compatibilityLatex) {
    throw new Error("expected the chip's canonical source to have diverged");
  }

  return {
    state: updateContentSelection(edited.state, null),
    chipStart: resolved.startIndex,
    chipEnd: resolved.endIndex,
  };
}

describe("diverged inline chip is atomic to the flat model", () => {
  it("word-select inside the chip takes the whole run, not a stale construct", () => {
    const { state, chipStart, chipEnd } = divergedChip("diverge-word");
    const sel = selectWordAtPosition(state, {
      blockIndex: 0,
      textIndex: chipStart + 1,
    }).document.selection;
    expect(sel?.anchor.textIndex).toBe(chipStart);
    expect(sel?.focus.textIndex).toBe(chipEnd);
  });

  it("a selection entering the chip snaps to its far edge — no interior stops", () => {
    const { state, chipStart, chipEnd } = divergedChip("diverge-enter");
    const block = state.document.page.blocks[0];
    const snapped = mathSelectionRange(block, 0, chipStart + 1, "end");
    expect(snapped).toEqual({ anchor: 0, focus: chipEnd });
  });

  it("a range wholly inside the chip widens to the whole chip", () => {
    const { state, chipStart, chipEnd } = divergedChip("diverge-inside");
    const block = state.document.page.blocks[0];
    const snapped = mathSelectionRange(
      block,
      chipStart + 1,
      chipStart + 2,
      "end",
    );
    expect(snapped).toEqual({ anchor: chipStart, focus: chipEnd });
  });

  it("a flat caret step crosses the chip whole in both directions", () => {
    const { state, chipStart, chipEnd } = divergedChip("diverge-step");
    const block = state.document.page.blocks[0];
    expect(mathCaretStep(block, chipStart, "right")).toBe(chipEnd);
    expect(mathCaretStep(block, chipEnd, "left")).toBe(chipStart);
  });

  it("an attached but UNEDITED chip keeps its interior stops (control)", () => {
    const binding = createCRDTbinding("page", "diverge-control");
    const initial = createInitialState(loadPage("aa $x+y$ bb", schema.data), {
      schema: schema.data,
      nodes: createNodeRegistry(schema.nodes),
      marks: createMarkRegistry(schema.marks),
      crdtBinding: binding,
    });
    const run = resolveMarkRuns(initial.document.page.blocks[0]).find(
      (candidate) => candidate.name === "math",
    );
    if (!run) throw new Error("expected an inline math run");
    const entered = enterInlineMathTreeAtPosition(
      initial,
      0,
      run.startIndex + 1,
      { allowBoundary: true },
    );
    if (!entered) throw new Error("inline math did not enter tree mode");
    const state = updateContentSelection(entered.state, null);
    const block = state.document.page.blocks[0];
    // Attached, compat chars still equal the source: partial entry still rests
    // at an interior stop, per the established partial-selection semantics.
    const snapped = mathSelectionRange(block, 0, run.startIndex + 1, "end");
    expect(snapped).toEqual({ anchor: 0, focus: run.startIndex + 1 });
  });
});
