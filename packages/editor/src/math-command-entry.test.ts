/**
 * Math command-entry (the generic `ui.caretScratch` slot, `type: "math"`): while
 * a control word is being typed at the caret (`\in` heading to `\int`), the math
 * node/mark arms scratch so the renderer/caret draw it as literal source instead
 * of resolving the symbol — killing the mid-type flash where `\in` briefly shows
 * ∈. It is armed by the edits that grow OR shrink the command — `insertText`
 * (TEXT_INPUTTED) and the DELETE_* actions (CONTENT_DELETED): backspacing `\fr`
 * to `\f` is still editing that command, and its residue must keep rendering as
 * literal source (a residue left as a bare `\` would otherwise merge with a
 * following structural char — `\frac{J\|}{K}` ⌫ → `\}` steals the frac's closing
 * brace and de-structures the formula). It is cleared by any caret move
 * (`updateCursor` resets `caretScratch`), so a finished command never re-renders
 * literally just because the caret later parks at its trailing edge. Caret
 * NAVIGATION and the delete-unit computation itself stay untouched — they parse
 * the real source, so a committed command stays one atomic token.
 */
import { insertText } from "./actions/actions";
import { DELETE_BACKWARD } from "./actions/edit-actions";
import { mathArmScratch } from "./nodes/math";
import { moveCursorToPosition, updateCursor } from "./selection";
import type { EditorState } from "./state-types";
import { createInitialState, isCaretScratchActive } from "./state-utils";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { insertCharsAtPosition } from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
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

function latexOf(state: EditorState, blockIndex = 0) {
  return getVisibleTextFromRuns(
    state.document.page.blocks[blockIndex].charRuns,
  );
}

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

  it("does NOT arm when the caret rests INSIDE a complete command", () => {
    // Regression: place the caret before a `\frac{dy}{dx}` chip and type a char,
    // and the caret can land between the `\` and the end of `\frac`. Arming there
    // would render the resolved fraction as the literal source `\fracdydx` (the
    // command de-structures, orphaning its `{dy}{dx}` args). A complete command is
    // never "being typed", so no interior offset arms scratch.
    const { state } = mathState("\\frac{dy}{dx}", 0);
    const block = state.document.page.blocks[0];
    for (let offset = 0; offset <= "\\frac{dy}{dx}".length; offset++) {
      expect(mathArmScratch(block, offset)).toBeNull();
    }
  });

  it("still arms for a genuinely in-progress command (`\\fra` → `\\frac`)", () => {
    // The counterpart: an INCOMPLETE run must stay flagged so it renders literally
    // while typed — the fix narrows only complete commands, not in-progress ones.
    const { state, blockId } = mathState("\\fra", 4);
    const block = state.document.page.blocks[0];
    expect(mathArmScratch(block, 4)).toEqual({
      type: "math",
      blockId,
      offset: 4,
    });
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

  it("re-arms when a backspace shrinks a command still being typed", () => {
    // `\fra` ⌫ → `\fr`: an in-progress (unknown) run deletes char by char, and
    // deleting inside it is still editing it. The caret move cleared the
    // scratch; CONTENT_DELETED must re-arm it so the residue keeps rendering as
    // literal source. (A COMMITTED command like `\int` instead deletes as one
    // atomic token — there is no residue to arm for.)
    const { state, blockId } = mathState("\\fra", 4);
    const after = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;
    expect(latexOf(after)).toBe("\\fr");
    expect(after.ui.caretScratch).toEqual({ type: "math", blockId, offset: 3 });
  });

  it("re-arms when a backspace leaves a bare `\\` before a structural brace", () => {
    // The reported bug: `\frac{J\f|}{K}`, ⌫ the `f`. The residue `\` sits right
    // before the numerator's closing `}` — unarmed, it lexes as the command `\}`,
    // stealing the frac's closer and de-structuring the whole formula (everything
    // collapses into the numerator). Armed, the lexer keeps the command-entry `\`
    // standalone and the fraction stays intact.
    const { state, blockId } = mathState("\\frac{J\\f}{K}", 9);
    const after = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;
    expect(latexOf(after)).toBe("\\frac{J\\}{K}");
    expect(after.ui.caretScratch).toEqual({ type: "math", blockId, offset: 8 });
    expect(isCaretScratchActive(after, blockId, 8)).toBe(true);
  });

  it("does NOT arm when a delete lands the caret at a finished command's edge", () => {
    // `\sum1` ⌫ the `1`: the caret parks at the edge of `\sum` — complete and
    // not a prefix of anything longer. It must keep rendering as ∑, not flash
    // back to literal source.
    const { state } = mathState("\\sum1", 5);
    const after = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;
    expect(latexOf(after)).toBe("\\sum");
    expect(after.ui.caretScratch).toBeNull();
  });

  it("does NOT arm when the delete has nothing to do with a command", () => {
    const { state } = mathState("xy", 2);
    const after = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;
    expect(latexOf(after)).toBe("x");
    expect(after.ui.caretScratch).toBeNull();
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
