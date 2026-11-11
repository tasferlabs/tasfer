/**
 * The Math button with nothing selected.
 *
 * It used to arm an invisible pending mark: nothing showed until a key was
 * typed. Now it puts an EMPTY formula at the caret, with the caret inside it,
 * painted as the faint slot box an empty `\sqrt{}` or `\frac{}{}` shows.
 */
import { getStructuredMathMarkSource } from "./inline-structured";
import { mathExtension } from "./math-extension";
import { insertText } from "@tasfer/editor/actions/actions";
import { DELETE_BACKWARD } from "@tasfer/editor/actions/edit-actions";
import { resolveMarkRuns } from "@tasfer/editor/mark-runs";
import { createMarkRegistry, TOGGLE_MARK } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import {
  moveCursorToPosition,
  startSelection,
  updateSelectionFocus,
} from "@tasfer/editor/selection";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { isTextualBlock } from "@tasfer/editor/sync/block-registry";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import { applyOp } from "@tasfer/editor/sync/reducer";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

function caretIn(markdown: string, textIndex: number): EditorState {
  const state = createInitialState(loadPage(markdown, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
  });
  return moveCursorToPosition(state, 0, textIndex);
}

function toggleMath(state: EditorState) {
  return state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "math" });
}

/** The first block as text, with `[latex]` for each formula. */
function view(state: EditorState): string {
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual block");
  const text = getVisibleTextFromRuns(block.charRuns);
  const runs = resolveMarkRuns(block).filter((run) => run.name === "math");
  let out = "";
  for (let at = 0; at < text.length; at++) {
    const run = runs.find((candidate) => candidate.startIndex === at);
    if (run) {
      out += `[${getStructuredMathMarkSource(
        { type: "math", attrs: run.attrs },
        block.structuredContent,
      )}]`;
      at = run.endIndex - 1;
    } else {
      out += text[at];
    }
  }
  return out;
}

describe("the Math button at a bare caret", () => {
  it("puts an empty formula box at the caret, with the caret inside", () => {
    const boxed = toggleMath(caretIn("a b", 2));
    expect(view(boxed.state)).toBe("a []b");
    expect(boxed.state.document.contentSelection).toBeTruthy();

    const typed = insertText(boxed.state, "x");
    expect(view(typed.state)).toBe("a [x]b");
  });

  it("removes the empty box again on Backspace", () => {
    const boxed = toggleMath(caretIn("a b", 2));
    const removed = boxed.state.actionBus.dispatchState(
      DELETE_BACKWARD,
      boxed.state,
    );
    expect(view(removed.state)).toBe("a b");
    expect(
      Object.keys(removed.state.document.page.blocks[0].structuredContent ?? {}),
    ).toEqual([]);
  });

  it("rebuilds the empty box from the operations alone", () => {
    const start = caretIn("a b", 2);
    const boxed = toggleMath(start);
    let page = start.document.page;
    for (const op of boxed.ops) page = applyOp(page, op, schema.data);
    expect(view({ ...boxed.state, document: { ...boxed.state.document, page } })).toBe(
      "a []b",
    );
  });

  it("still turns a selection into a formula", () => {
    const state = caretIn("a+b c", 0);
    const selected = updateSelectionFocus(
      startSelection(state, { blockIndex: 0, textIndex: 0 }),
      { blockIndex: 0, textIndex: 3 },
    );
    expect(view(toggleMath(selected).state)).toBe("[a+b] c");
  });

  it("leaves a caret on a formula's edge to the formula", () => {
    // Typing there already continues the formula, so no second box is made.
    const state = caretIn("a $x$ b", 3);
    const result = toggleMath(state);
    expect(view(result.state)).toBe("a [x] b");
  });
});
