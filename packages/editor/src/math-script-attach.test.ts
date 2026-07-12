/**
 * Typing a super/subscript operator (`^`/`_`) at the end of an existing script's
 * slot must attach the new script to the SAME base, not nest it inside the slot's
 * content. After filling a subscript the live caret rests at the slot's end
 * (`x_{n|}`); a `^` there means "add the matching superscript to x" (`x_{n}^{…}`,
 * one construct with both scripts) — never `x_{n^{…}}` (a superscript on the `n`
 * inside the subscript). This exercises the whole insert pipeline (the
 * `scriptAttachOffset` redirect in `mathTransformTypedInput`), the direct
 * counterpart of the accent redirect already covered elsewhere.
 */
import {
  createMathTestState,
  createMathTestSyncEngine,
} from "./__testutils__/math";
import { insertText } from "./actions/actions";
import { moveCursorToPosition } from "./selection";
import type { EditorState } from "./state-types";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { insertCharsAtPosition } from "./sync/crdt-utils";
import { createCRDTbinding } from "./sync/sync";
import { describe, expect, it } from "vitest";

function mathState(latex: string, caret: number) {
  const binding = createCRDTbinding("math-script-attach", "peer-1");
  const engine = createMathTestSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;

  let page = engine.getState();
  if (latex) {
    page = insertCharsAtPosition(page, blockId, 0, latex, binding).newPage;
  }
  let state = createMathTestState(page, { crdtBinding: binding });
  state = moveCursorToPosition(state, 0, caret);
  return { state, blockId };
}

function latexOf(state: EditorState) {
  return getVisibleTextFromRuns(state.document.page.blocks[0].charRuns);
}

function type(state: EditorState, chars: string): EditorState {
  let s = state;
  for (const ch of chars) s = insertText(s, ch).state;
  return s;
}

describe("scripts typed after a script attach to the same base", () => {
  it("`_` then `^` builds one base with both scripts", () => {
    // `x` → `_` → `n` leaves the caret at the end of the subscript (`x_{n|}`).
    let { state } = mathState("x", 1);
    state = type(state, "_n");
    expect(latexOf(state)).toBe("x_{n}");
    // The `^` must escape the subscript and script the whole `x_{n}`.
    state = type(state, "^");
    expect(latexOf(state)).toBe("x_{n}^{}");
    state = type(state, "2");
    expect(latexOf(state)).toBe("x_{n}^{2}");
  });

  it("`^` then `_` is the mirror case", () => {
    let { state } = mathState("x", 1);
    state = type(state, "^2");
    expect(latexOf(state)).toBe("x^{2}");
    state = type(state, "_");
    expect(latexOf(state)).toBe("x^{2}_{}");
    state = type(state, "n");
    expect(latexOf(state)).toBe("x^{2}_{n}");
  });

  it("scripts a whole construct base (a fraction) from the subscript's end", () => {
    // `\frac{a}{b}_{n|}` + `^` → `\frac{a}{b}_{n}^{…}`, not nested in the sub.
    let { state } = mathState("\\frac{a}{b}_{n}", "\\frac{a}{b}_{n}".length);
    state = type(state, "^2");
    expect(latexOf(state)).toBe("\\frac{a}{b}_{n}^{2}");
  });

  it("does not escalate when the matching script already exists", () => {
    // `x_{n}^{2}` with the caret inside the subscript, at its end — typing `^`
    // can't add a second superscript, so it nests (default behavior) rather than
    // producing invalid `^{2}^{}`.
    const latex = "x_{n}^{2}";
    let { state } = mathState(latex, 4); // `x_{n|}^{2}`
    state = type(state, "^");
    expect(latexOf(state)).toBe("x_{n^{}}^{2}");
  });
});

describe("a script typed mid-content opens an empty box, never grabbing the next atom", () => {
  it("`^` between letters boxes the script instead of raising the next letter", () => {
    // `aa|aaa` + `^` must be `aa^{}aaa` (an empty box the caret sits in), never
    // `aa^aaa` (the 3rd `a` swallowed as the superscript of the 2nd).
    let { state } = mathState("aaaaa", 2);
    state = type(state, "^");
    expect(latexOf(state)).toBe("aa^{}aaa");
    expect(state.document.cursor?.position.textIndex).toBe(4); // inside the box
    state = type(state, "b");
    expect(latexOf(state)).toBe("aa^{b}aaa");
  });

  it("`_` mid-content behaves the same", () => {
    let { state } = mathState("aaaaa", 2);
    state = type(state, "_9");
    expect(latexOf(state)).toBe("aa_{9}aaa");
  });

  it("still opens the box the plain way at the end of content", () => {
    // Nothing follows, so the bare operator + materializer path is unchanged.
    let { state } = mathState("x", 1);
    state = type(state, "^2");
    expect(latexOf(state)).toBe("x^{2}");
  });
});
