/**
 * Math command-entry (the generic `ui.caretScratch` slot, `type: "math"`): while
 * a control word is being typed at the caret (`\in` heading to `\int`), the math
 * node/mark arms scratch so the renderer/caret draw it as literal source instead
 * of resolving the symbol — killing the mid-type flash where `\in` briefly shows
 * ∈. It is armed ONLY by `insertText` (the keystroke that grows the command, via
 * the `armCaretScratch` seam) and cleared by any caret move (`updateCursor`
 * resets `caretScratch`), so a finished command never re-renders literally just
 * because the caret later parks at its trailing edge. Deletion/navigation are
 * untouched — they parse the real source, so the command stays one atomic,
 * non-partially-deletable token.
 */
import { insertText } from "./actions/actions";
import { moveCursorToPosition, updateCursor } from "./selection";
import { createInitialState, isCaretScratchActive } from "./state-utils";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { insertCharsAtPosition } from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import type { EditorState } from "./state-types";
import { describe, expect, it } from "vitest";

/** A block-equation editor state holding `latex`, with the caret at `caret`. */
function mathState(latex: string, caret: number) {
  const binding = createCRDTbinding("math-cmd-entry", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;

  let page = engine.getState();
  if (latex) {
    page = insertCharsAtPosition(page, blockId, 0, latex, binding).newPage;
  }
  let state = createInitialState(page, { crdtBinding: binding });
  state = moveCursorToPosition(state, 0, caret);
  return { state, blockId };
}

const latexOf = (state: EditorState, blockIndex = 0) =>
  getVisibleTextFromRuns(state.document.page.blocks[blockIndex].charRuns);

describe("math command-entry flag", () => {
  it("arms while a command is being typed toward a longer one", () => {
    // `\i` + `n` → `\in` (en route to `\int`): the keystroke grows a command,
    // so the in-progress command is flagged for literal rendering.
    const { state, blockId } = mathState("\\i", 2);
    const after = insertText(state, "n").state;

    expect(latexOf(after)).toBe("\\in"); // inserted plainly, no separator space
    expect(after.ui.caretScratch).toEqual({ type: "math", blockId, offset: 3 });
    expect(isCaretScratchActive(after, blockId, 3)).toBe(true);
  });

  it("does NOT arm when the keystroke isn't extending a command", () => {
    const { state } = mathState("x", 1);
    const after = insertText(state, "y").state;
    expect(latexOf(after)).toBe("xy");
    expect(after.ui.caretScratch).toBeNull();
  });

  it("clears on any caret move (the command commits)", () => {
    const { state, blockId } = mathState("\\i", 2);
    const armed = insertText(state, "n").state;
    expect(armed.ui.caretScratch).not.toBeNull();

    // Stepping the caret commits it — a finished `\in` must not keep rendering
    // literally once the caret leaves the command's trailing edge.
    const moved = moveCursorToPosition(armed, 0, 0);
    expect(moved.ui.caretScratch).toBeNull();
    expect(isCaretScratchActive(moved, blockId, 0)).toBe(false);
  });

  it("re-arms at the new edge as the command keeps growing", () => {
    const { state, blockId } = mathState("\\in", 3);
    const after = insertText(state, "t").state; // `\int`
    expect(latexOf(after)).toBe("\\int");
    expect(after.ui.caretScratch).toEqual({ type: "math", blockId, offset: 4 });
  });

  it("isCaretScratchActive matches only the exact block + offset", () => {
    const base = mathState("\\in", 3).state;
    const armed: EditorState = {
      ...base,
      ui: {
        ...base.ui,
        caretScratch: { type: "math", blockId: "b", offset: 3 },
      },
    };
    expect(isCaretScratchActive(armed, "b", 3)).toBe(true);
    expect(isCaretScratchActive(armed, "b", 2)).toBe(false);
    expect(isCaretScratchActive(armed, "other", 3)).toBe(false);
    expect(isCaretScratchActive(base, "b", 3)).toBe(false);
  });

  it("updateCursor clears the scratch", () => {
    const base = mathState("\\in", 3).state;
    const armed: EditorState = {
      ...base,
      ui: {
        ...base.ui,
        caretScratch: { type: "math", blockId: "b", offset: 3 },
      },
    };
    const moved = updateCursor(armed, { blockIndex: 0, textIndex: 1 });
    expect(moved.ui.caretScratch).toBeNull();
  });
});
