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
import { mathCommandInsertion } from "./nodes/math-commands";
import { moveCursorToPosition, updateCursor } from "./selection";
import type { EditorState } from "./state-types";
import { createInitialState, isCaretScratchActive } from "./state-utils";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "./sync/crdt-utils";
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

/**
 * A paragraph holding one inline-math chip `latex` (the whole run marked
 * `math`), with the caret at block offset `caret`.
 */
function chipState(latex: string, caret: number) {
  const binding = createCRDTbinding("inline-cmd-entry", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;

  let page = engine.getState();
  page = insertCharsAtPosition(page, blockId, 0, latex, binding).newPage;
  page = markCharsInRange(
    page,
    blockId,
    0,
    latex.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
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

  it("arms at an inline chip's trailing edge, where a command is typed", () => {
    // The reported bug: type `\` at the END of an inline chip. The caret rests at
    // the chip's right boundary — which `chipAt(…, "inside")` (a strict interior
    // test) excludes — so command entry never armed, and the lone `\` rendered
    // neutralized to *nothing* instead of a literal backslash. It must arm at the
    // trailing edge (the only place a just-typed command's caret can be).
    const { state, blockId } = chipState("x\\", 2);
    const block = state.document.page.blocks[0];
    expect(mathArmScratch(block, 2)).toEqual({
      type: "math",
      blockId,
      offset: 2,
    });
    // A caret to the LEFT of the `\` isn't entering it — no arming.
    expect(mathArmScratch(block, 1)).toBeNull();
  });

  it("arms at a chip's trailing edge for a multi-letter in-progress command", () => {
    // `\al` typed at a chip's end (en route to `\alpha`): armed so it renders as
    // literal source (`\al`), not the neutralized letters `al`.
    const { state, blockId } = chipState("\\al", 3);
    const block = state.document.page.blocks[0];
    expect(mathArmScratch(block, 3)).toEqual({
      type: "math",
      blockId,
      offset: 3,
    });
  });

  it("does NOT arm at a chip's trailing edge when the command is complete", () => {
    // Parking at the end of a finished `\alpha` chip must render α, not flash the
    // literal source — the trailing-edge fallback still gates on an in-progress run.
    const { state } = chipState("\\alpha", 6);
    const block = state.document.page.blocks[0];
    expect(mathArmScratch(block, 6)).toBeNull();
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

describe("typing \\ before a slot brace: separator, then self-heal", () => {
  const caretOf = (s: EditorState) => s.document.cursor?.position.textIndex;

  it("inserts a separator instead of eating the slot's closing brace", () => {
    // Caret in the empty numerator of `\frac{}{}` (offset 6). Typing `\` must not
    // fuse with the numerator's `}` into `\}` (which would de-structure the frac
    // and spawn a stray block). It lands as `\ ` with the caret between the two,
    // ready to keep typing the command.
    const { state } = mathState("\\frac{}{}", 6);
    const after = insertText(state, "\\").state;
    expect(latexOf(after)).toBe("\\frac{\\ }{}");
    expect(caretOf(after)).toBe(7);
  });

  it("drops the separator once a command char lands in front of it", () => {
    // `\frac{\ }{}` (caret 7) + `a`: the numerator becomes `\a`, which no longer
    // merges with the `}`, so the now-redundant separator is removed — the source
    // stays clean rather than carrying a lingering space.
    const { state } = mathState("\\frac{\\ }{}", 7);
    const after = insertText(state, "a").state;
    expect(latexOf(after)).toBe("\\frac{\\a}{}");
    expect(caretOf(after)).toBe(8);
  });

  it("types out a full command in a slot with clean final source", () => {
    // End to end: `\frac{|}{}` → type `\alpha` → `\frac{\alpha}{}`, no stray
    // block, no leftover separator space.
    let state = mathState("\\frac{}{}", 6).state;
    for (const ch of "\\alpha") {
      state = insertText(state, ch).state;
    }
    expect(latexOf(state)).toBe("\\frac{\\alpha}{}");
  });

  it("keeps a matrix column separator intact when a command is typed into a cell", () => {
    // The reported bug, end to end: caret after `a`, before the `&`. Typing `\`
    // must NOT fuse into `\&` (which merges the two cells and loses one). It lands
    // as `\ ` protecting the `&`; completing the command (`\pi`) then drops the
    // now-redundant separator, leaving a clean two-cell row.
    const at = "\\begin{matrix}a".length;
    let state = mathState("\\begin{matrix}a&b\\end{matrix}", at).state;
    state = insertText(state, "\\").state;
    expect(latexOf(state)).toBe("\\begin{matrix}a\\ &b\\end{matrix}");
    for (const ch of "pi") {
      state = insertText(state, ch).state;
    }
    // The `&` survives — still two cells — and no lingering separator space.
    expect(latexOf(state)).toBe("\\begin{matrix}a\\pi&b\\end{matrix}");
  });

  it("types out an argument-less \\text command without crashing", () => {
    // Regression: typing `\text` character by character reaches a point where the
    // source is a bare `\text` with no `{…}` yet. Materialization re-parses it, and
    // the parser used to consume the terminal EOF token as `\text`'s one-token
    // argument, running past the token array and crashing the whole edit. Typing
    // must not throw, and the following `{` escapes to a literal glyph (a typed `{`
    // never opens an argument), so `\text` + `{hi` yields `\text\{hi`.
    let state = mathState("", 0).state;
    for (const ch of "\\text") {
      state = insertText(state, ch).state; // must not throw
    }
    expect(latexOf(state)).toBe("\\text");
    state = insertText(state, "{").state; // escapes, no argument opened
    expect(latexOf(state)).toBe("\\text\\{");
    for (const ch of "hi") {
      state = insertText(state, ch).state;
    }
    expect(latexOf(state)).toBe("\\text\\{hi");
  });

  it("escapes a { typed after a command word, never opening an argument", () => {
    // A typed `{` is always a literal brace glyph — flush after `\tex` (not yet a
    // command) OR after the complete `\text`. Neither opens an argument, so both
    // escape to `\{`. (`\text{…}` runs enter via materialization/paste, not this
    // single-char typing path.)
    let state = mathState("", 0).state;
    for (const ch of "\\tex") state = insertText(state, ch).state;
    expect(latexOf(state)).toBe("\\tex");
    state = insertText(state, "{").state;
    expect(latexOf(state)).toBe("\\tex\\{");
    // A COMPLETE command's `{` escapes just the same.
    let done = mathState("", 0).state;
    for (const ch of "\\text{") done = insertText(done, ch).state;
    expect(latexOf(done)).toBe("\\text\\{");
  });

  it("keeps a \\sqrt radicand intact when a command is typed into its index", () => {
    // `\sqrt[3]{x}`, caret after `3`, before the `]`. Typing `\pi` must not fuse
    // into `\]` (which lets the index swallow `{x}`, emptying the radicand). It
    // lands as `\ ` protecting the `]`; completing `\pi` drops the separator.
    const at = "\\sqrt[3".length;
    let state = mathState("\\sqrt[3]{x}", at).state;
    state = insertText(state, "\\").state;
    expect(latexOf(state)).toBe("\\sqrt[3\\ ]{x}");
    for (const ch of "pi") {
      state = insertText(state, ch).state;
    }
    // Index is now `3\pi`, the `]` still closes it, and `{x}` stays the radicand.
    expect(latexOf(state)).toBe("\\sqrt[3\\pi]{x}");
  });
});

describe("a typed brace always escapes (no argument auto-open, no closer step-over)", () => {
  const at = (s: EditorState) => s.document.cursor?.position.textIndex;

  it("escapes every brace typed toward `\\text{hi}`", () => {
    // Typing `\text{hi}` keystroke by keystroke: `\text` is the command, then every
    // typed brace is a literal glyph — the `{` escapes (no argument opens) and the
    // closing `}` escapes (no auto-inserted closer to step over). The result is the
    // visible `\text\{hi\}`, with the caret at the source end.
    let state = mathState("", 0).state;
    for (const ch of "\\text{hi}") {
      state = insertText(state, ch).state;
    }
    expect(latexOf(state)).toBe("\\text\\{hi\\}");
    expect(at(state)).toBe("\\text\\{hi\\}".length);
  });

  it("never blocks typing an unknown command — every letter lands", () => {
    // `\asdsadad` is not a real command, but keystrokes are NEVER swallowed: the
    // whole run lands verbatim (it renders as an unknown command, not silently
    // dropped). The trailing `{x}` escapes to literal glyphs (a typed brace never
    // opens an argument).
    let state = mathState("", 0).state;
    for (const ch of "\\asdsadad{x}") {
      state = insertText(state, ch).state;
    }
    expect(latexOf(state)).toBe("\\asdsadad\\{x\\}");
  });

  it("escapes a `}` typed inside a pre-existing empty slot (`\\text{|}` + `}`)", () => {
    // Host `\text{}` (a materialized/pasted run), caret between the braces. A typed
    // `}` is a literal glyph the user wants IN the slot — it escapes to `\}`
    // (`\text{\}}`) rather than stepping over the existing closer.
    let state = mathState("\\text{}", "\\text{".length).state;
    state = insertText(state, "}").state;
    expect(latexOf(state)).toBe("\\text{\\}}");
  });

  it("escapes a } typed at top level (no group to close)", () => {
    let state = mathState("a", 1).state;
    state = insertText(state, "}").state;
    expect(latexOf(state)).toBe("a\\}"); // literal brace glyph
  });

  it("leaves set-notation braces escaping normally", () => {
    // `{1,2}` typed at top level stays the visible `\{1,2\}` set — every typed
    // brace escapes.
    let state = mathState("", 0).state;
    for (const ch of "{1,2}") {
      state = insertText(state, ch).state;
    }
    expect(latexOf(state)).toBe("\\{1,2\\}");
  });
});

describe("typing a letter after a `\\`-menu command commit does not fuse", () => {
  /** An inline chip rebuilt exactly as the `\`-command menu leaves it: the typed
   * query is range-replaced with the construct and the whole formula re-marked as
   * one chip (delete + insert + re-mark), so its char-id/tombstone layout matches
   * the live commit — the layout under which the following letter is *absorbed*
   * into the chip's mark span instead of landing beside it as prose. */
  function committedChipState(prefix: string, query: string, command: string) {
    const binding = createCRDTbinding("menu-commit", "peer-1");
    const engine = createSyncEngine(binding);
    const blockOp = engine.createBlockInsert(null, "paragraph", {});
    engine.emit([blockOp]);
    const blockId = blockOp.blockId;

    // Prose `prefix` + the in-progress query, the whole tail marked as a chip.
    const initial = prefix + query;
    let page = engine.getState();
    page = insertCharsAtPosition(page, blockId, 0, initial, binding).newPage;
    page = markCharsInRange(
      page,
      blockId,
      0,
      initial.length,
      { type: "math" },
      true,
      binding,
    ).newPage;

    // Menu commit: replace `[prefix.length, initial.length)` (the `\query`) with
    // the command, then re-mark the grown formula as one chip.
    const insertion = mathCommandInsertion(command, "");
    page = deleteCharsInRange(
      page,
      blockId,
      prefix.length,
      initial.length,
      binding,
    ).newPage;
    page = insertCharsAtPosition(
      page,
      blockId,
      prefix.length,
      insertion.text,
      binding,
    ).newPage;
    page = markCharsInRange(
      page,
      blockId,
      0,
      prefix.length + insertion.text.length,
      { type: "math" },
      true,
      binding,
    ).newPage;

    let state = createInitialState(page, { crdtBinding: binding });
    state = moveCursorToPosition(
      state,
      0,
      prefix.length + insertion.caretOffset,
    );
    return state;
  }

  const chipLatexOf = (s: EditorState) =>
    getVisibleTextFromRuns(s.document.page.blocks[0].charRuns);

  it("`\\degree` from the menu, then `C`, separates instead of fusing", () => {
    // The reported bug: `a=a=` + pick `\degree` from the `\`-menu + type `C` gave
    // the fused unknown `\degreeC` (rendered as literal `degreeC`) instead of °C.
    let state = committedChipState("a=a=", "\\degre", "\\degree");
    expect(chipLatexOf(state)).toBe("a=a=\\degree");
    state = insertText(state, "C").state;
    expect(chipLatexOf(state)).toBe("a=a=\\degree C");
  });

  it("`\\alpha` from the menu, then `s`, separates (`\\alpha s`, never `\\alphas`)", () => {
    let state = committedChipState("", "\\alph", "\\alpha");
    expect(chipLatexOf(state)).toBe("\\alpha");
    state = insertText(state, "s").state;
    expect(chipLatexOf(state)).toBe("\\alpha s");
  });

  it("a digit after a committed command needs no separator (digits terminate a control word)", () => {
    let state = committedChipState("", "\\pi", "\\pi");
    state = insertText(state, "2").state;
    expect(chipLatexOf(state)).toBe("\\pi2");
  });
});

describe("typing toward a longer catalog command past a complete prefix", () => {
  /** Type `chars` one keystroke at a time into an empty block equation. */
  function typeInto(chars: string): string {
    let { state } = mathState("", 0);
    for (const ch of chars) state = insertText(state, ch).state;
    return latexOf(state);
  }

  it("`\\pmatrix` types cleanly — no separator injected after the complete `\\pm`", () => {
    // The reported bug: `\pm` is a complete engine command (±), so typing the
    // next letter injected the command separator (`\pm atrix`), corrupting the
    // source and — because the `\`-menu query is letters-only — making the menu
    // command `\pmatrix` unreachable by typing. The run must stay intact so the
    // query keeps growing (`pm` → `pma` → … → `pmatrix`) and the menu can offer it.
    expect(typeInto("\\pmatrix")).toBe("\\pmatrix");
  });

  it("every matrix/environment name in the catalog types to its literal source", () => {
    // The whole `\begin{…}` family must be typeable, whatever shorter command each
    // one steps through: `\pm` (±, the separator path) for `\pmatrix`, and `\bm`
    // (bold, whose auto-opened `{}` argument would otherwise divert the following
    // letters into `\bm{atrix}` — the materialization path) for `\bmatrix`.
    for (const env of [
      "matrix",
      "pmatrix",
      "bmatrix",
      "vmatrix",
      "Bmatrix",
      "Vmatrix",
      "cases",
      "aligned",
    ]) {
      expect(typeInto("\\" + env)).toBe("\\" + env);
    }
  });

  it("a symbol/accent whose name is also a prefix still materializes (`\\dot` → `\\dot{}`)", () => {
    // The environment-only scope: `\dot` (a prefix of `\doteq`/`\dots`) and `\bar`
    // are common leaves the user wants materialized, so they must NOT be deferred
    // the way `\bm` is — only `\begin{…}` names defer their shorter command.
    expect(typeInto("\\dot")).toBe("\\dot{}");
    expect(typeInto("\\bar")).toBe("\\bar{}");
    expect(typeInto("\\ddot")).toBe("\\ddot{}");
  });

  it("the letters-only `\\`-menu query survives every keystroke of `\\pmatrix`", () => {
    // Mirror the host's query extraction (mobileToolbar.activeBlockMathCommand):
    // the text from the last `\` to the caret must stay letters-only, or the menu
    // closes. A stray separator space would break it at the `\pm|a` step.
    let { state } = mathState("", 0);
    for (const ch of "\\pmatrix") {
      state = insertText(state, ch).state;
      const src = latexOf(state);
      const bs = src.lastIndexOf("\\");
      expect(src.slice(bs + 1)).toMatch(/^[a-zA-Z]*$/);
    }
    expect(latexOf(state)).toBe("\\pmatrix");
  });

  it("a letter that CAN'T reach a catalog command still separates (`\\pm` + `x` → `\\pm x`)", () => {
    // The fix is scoped to runs that could still grow into a catalog id: `pmx` is
    // not a command prefix, so the ± stays complete and the `x` becomes its own atom.
    expect(typeInto("\\pmx")).toBe("\\pm x");
  });

  it("also holds at an inline chip's trailing edge (the edge-join path)", () => {
    // Typing a command at a chip's right edge goes through mathJoinAtEdgeAfterInput,
    // not mathTransformTypedInput — it has its own separator guard, which must defer
    // to the same environment-prefix rule so `\pmatrix`/`\bmatrix` type clean there.
    const chipLatexOf = (s: EditorState) =>
      getVisibleTextFromRuns(s.document.page.blocks[0].charRuns);
    const chipTypeAtEdge = (chars: string): string => {
      let { state } = chipState("x", 1); // caret at the chip's right edge
      for (const ch of chars) state = insertText(state, ch).state;
      return chipLatexOf(state);
    };
    expect(chipTypeAtEdge("\\pmatrix")).toBe("x\\pmatrix");
    expect(chipTypeAtEdge("\\bmatrix")).toBe("x\\bmatrix");
    // A non-catalog extension still separates at the edge (`\pm` + `x` → `\pm x`).
    expect(chipTypeAtEdge("\\pmx")).toBe("x\\pm x");
  });
});
