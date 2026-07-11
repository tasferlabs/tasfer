/**
 * Integration test — drives the REAL desktop keyboard pipeline, not the bare
 * `insertText` action the other math tests call.
 *
 * The app routes a keystroke as: hidden-contenteditable `input` event →
 * `queueSyntheticKey` → a synthetic `keydown` on the event queue → the render
 * loop's `handleEvents` → `handleKeyDown` → `INSERT_TEXT` action → `insertText`
 * (+ the `TEXT_INPUTTED`/`TEXT_INPUT` observers). The corpus/fuzzer tests enter
 * at `insertText`, skipping `handleKeyDown`'s key routing and the observe-only
 * `TEXT_INPUT` dispatch. This test enters at `handleKeyDown` so a divergence in
 * that upper layer (special-cased keys, observer ordering) would show up here.
 *
 * Canvas painting and the DOM input-diff mirror are still out of scope (they
 * need a real canvas/jsdom); this covers everything from the synthetic keydown
 * down to the committed CRDT source.
 */
import { handleKeyDown } from "./events/keysEvents";
import { getInlineMathSpans } from "./inline-math-spans";
import { mathMatrixContext } from "./nodes/math";
import { moveCursorToPosition } from "./selection";
import type { EditorState, ViewportState } from "./state-types";
import { createInitialState } from "./state-utils";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { insertCharsAtPosition, markCharsInRange } from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import { describe, expect, it } from "vitest";

const VIEWPORT: ViewportState = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 2000,
};

/** A minimal keydown event — handleKeyDown reads only these fields and casts. */
function keydown(key: string): Event {
  return {
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as Event;
}

/** Type `seq` one keydown at a time through the real handleKeyDown pipeline. */
function typeKeys(state: EditorState, seq: string): EditorState {
  for (const ch of seq) {
    // A space arrives as key " " (handleKeyDown special-cases "Space" by code,
    // but the default char path also handles a literal " " key); our formulas
    // here contain no spaces, so the plain key is faithful.
    state = handleKeyDown(state, VIEWPORT, keydown(ch)).state;
  }
  return state;
}

/** handleKeyDown ignores input on an unfocused editor (keysEvents.ts:146), which
 * a mounted editor gets on click. Mark focus so the keyboard path runs. */
function focus(state: EditorState): EditorState {
  return { ...state, view: { ...state.view, isFocused: true } };
}

function blockState(latex: string, caret: number): EditorState {
  const binding = createCRDTbinding("integration-block", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([blockOp]);
  let page = engine.getState();
  page = insertCharsAtPosition(
    page,
    blockOp.blockId,
    0,
    latex,
    binding,
  ).newPage;
  let state = createInitialState(page, { crdtBinding: binding });
  state = moveCursorToPosition(state, 0, caret);
  return focus(state);
}

function inlineState(latex: string, caret: number): EditorState {
  const binding = createCRDTbinding("integration-inline", "peer-1");
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
  return focus(state);
}

function blockLatex(state: EditorState): string {
  return getVisibleTextFromRuns(state.document.page.blocks[0].charRuns);
}

function caretOffset(state: EditorState): number {
  return state.document.cursor?.position.textIndex ?? -1;
}

const CELL1_END = "\\begin{matrix}a".length; // caret just after `a`, before `&`
const TEMPLATE_2X2 = "\\begin{pmatrix}{}&{}\\\\{}&{}\\end{pmatrix}";

describe("keyboard integration: \\text in a matrix cell (block equation)", () => {
  it("typing partial \\text{ in an empty template cell keeps 2x2", () => {
    const at = TEMPLATE_2X2.indexOf("{}") + 1;
    let s = blockState(TEMPLATE_2X2, at);
    s = typeKeys(s, "\\text{");
    const src = blockLatex(s);
    const live = mathMatrixContext(src, caretOffset(s));
    const ctx = mathMatrixContext(src, at);
    expect(ctx?.cols).toBe(2);
    expect(ctx?.rows).toBe(2);
    expect(live?.cols).toBe(2);
    expect(live?.rows).toBe(2);
  });

  it("typing partial \\text{ in the first cell keeps 2 columns", () => {
    let s = blockState("\\begin{matrix}a&b\\end{matrix}", CELL1_END);
    s = typeKeys(s, "\\text{");
    const src = blockLatex(s);
    // The `{` escapes to `\{` (a typed brace never opens an argument), and the
    // `&` column separator survives — the 2-column grid is intact.
    expect(src).toBe("\\begin{matrix}a\\text\\{&b\\end{matrix}");
    expect(mathMatrixContext(src, CELL1_END)?.cols).toBe(2);
    expect(mathMatrixContext(src, caretOffset(s))?.cols).toBe(2);
  });

  it("typing partial \\text{ before a column separator keeps the separator", () => {
    const at = "\\begin{matrix}a".length;
    let s = blockState("\\begin{matrix}a&b\\end{matrix}", at);
    s = typeKeys(s, "\\text{");
    const src = blockLatex(s);
    expect(src).toBe("\\begin{matrix}a\\text\\{&b\\end{matrix}");
    expect(mathMatrixContext(src, at)?.cols).toBe(2);
    expect(mathMatrixContext(src, caretOffset(s))?.cols).toBe(2);
  });

  it("typing partial \\text{ at the start of the second cell keeps the live caret in that cell", () => {
    const at = "\\begin{matrix}a&".length;
    let s = blockState("\\begin{matrix}a&b\\end{matrix}", at);
    s = typeKeys(s, "\\text{");
    const src = blockLatex(s);
    expect(src).toBe("\\begin{matrix}a&\\text\\{b\\end{matrix}");
    const live = mathMatrixContext(src, caretOffset(s));
    expect(live?.cols).toBe(2);
    expect(live?.col).toBe(1);
  });

  it("typing \\ inside a PRE-EXISTING matrix text cell enters a literal backslash, keeps the grid", () => {
    // Editing INSIDE an existing `\text{}` run (from materialization/paste — a
    // typed `\text{` no longer creates one): the content is prose, not math, so a
    // typed `\` is the literal backslash glyph (`\textbackslash{}`), NOT a command
    // intro that would seed a fake command run and eat following letters. The `&`
    // still separates the cells, so the 2-column grid is intact.
    const host = "\\begin{matrix}a\\text{}&b\\end{matrix}";
    const inside = "\\begin{matrix}a\\text{".length; // caret between the `\text{}` braces
    let s = blockState(host, inside);
    s = typeKeys(s, "\\");
    const src = blockLatex(s);
    expect(src).toBe(
      "\\begin{matrix}a\\text{\\textbackslash{}}&b\\end{matrix}",
    );
    const live = mathMatrixContext(src, caretOffset(s));
    expect(live?.cols).toBe(2);
    expect(live?.col).toBe(0);
    // Following letters land as plain text (no command building, no data loss).
    s = typeKeys(s, "hi");
    expect(blockLatex(s)).toBe(
      "\\begin{matrix}a\\text{\\textbackslash{}hi}&b\\end{matrix}",
    );
  });

  it("typing partial \\text{ before a row separator keeps the row break", () => {
    const at = "\\begin{matrix}a".length;
    let s = blockState("\\begin{matrix}a\\\\b\\end{matrix}", at);
    s = typeKeys(s, "\\text{");
    const src = blockLatex(s);
    expect(src).toBe("\\begin{matrix}a\\text\\{\\\\b\\end{matrix}");
    const ctx = mathMatrixContext(src, at);
    const live = mathMatrixContext(src, caretOffset(s));
    expect(ctx?.cols).toBe(1);
    expect(ctx?.rows).toBe(2);
    expect(live?.cols).toBe(1);
    expect(live?.rows).toBe(2);
  });

  it("typing \\text{x} in the first cell keeps 2 columns", () => {
    let s = blockState("\\begin{matrix}a&b\\end{matrix}", CELL1_END);
    s = typeKeys(s, "\\text{x}");
    const src = blockLatex(s);
    expect(src).toBe("\\begin{matrix}a\\text\\{x\\}&b\\end{matrix}");
    expect(mathMatrixContext(src, CELL1_END)?.cols).toBe(2);
  });

  it("typing \\text{x} in the second cell keeps 2 columns", () => {
    const at = "\\begin{matrix}a&b".length;
    let s = blockState("\\begin{matrix}a&b\\end{matrix}", at);
    s = typeKeys(s, "\\text{x}");
    const src = blockLatex(s);
    expect(src).toBe("\\begin{matrix}a&b\\text\\{x\\}\\end{matrix}");
    expect(mathMatrixContext(src, at)?.cols).toBe(2);
  });

  it("typing \\text{x} in a 2×2 grid keeps 2×2", () => {
    const at = "\\begin{matrix}a&b\\\\c".length;
    let s = blockState("\\begin{matrix}a&b\\\\c&d\\end{matrix}", at);
    s = typeKeys(s, "\\text{x}");
    const src = blockLatex(s);
    const ctx = mathMatrixContext(src, at);
    expect(ctx?.cols).toBe(2);
    expect(ctx?.rows).toBe(2);
  });
});

describe("keyboard integration: \\text in a matrix cell (inline math)", () => {
  it("typing \\text{x} in an inline-math matrix cell keeps one chip, 2 columns", () => {
    let s = inlineState("\\begin{matrix}a&b\\end{matrix}", CELL1_END);
    s = typeKeys(s, "\\text{x}");
    const spans = getInlineMathSpans(s.document.page.blocks[0]);
    expect(spans).toHaveLength(1);
    expect(spans[0].latex).toBe("\\begin{matrix}a\\text\\{x\\}&b\\end{matrix}");
    expect(mathMatrixContext(spans[0].latex, CELL1_END)?.cols).toBe(2);
  });
});
