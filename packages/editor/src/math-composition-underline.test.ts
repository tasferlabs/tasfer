/**
 * IME composition in math shows a live typeset preview AND underlines the string
 * being composed — the same marker the operating system draws under composition
 * text. Two surfaces:
 *   - a block equation (`MathNode`), whose preview folds a `\text{…}` run into the
 *     equation and underlines that sub-range via the tex selection rects;
 *   - an inline-math chip (`MathMark`), whose preview folds into the chip and
 *     underlines it through the chip's own selection rects.
 *
 * The stub canvas records `fillText` (did the preview paint?) and horizontal
 * `moveTo→lineTo→stroke` segments (was an underline drawn?). A no-composition
 * control asserts the underline is present ONLY while composing.
 */
import { startComposition } from "./composition";
import { renderBlock } from "./rendering/renderer";
import { moveCursorToPosition } from "./selection";
import type { EditorState } from "./state-types";
import { createInitialState } from "./state-utils";
import { getEditorStyles } from "./styles";
import { insertCharsAtPosition, markCharsInRange } from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  // Length-proportional measurement on the lazily-built shared canvas.
  const g = globalThis as unknown as {
    document: { createElement: () => unknown };
  };
  const ctx = {
    measureText: (t: string) => ({
      width: (t?.length ?? 0) * 9,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 4,
    }),
    setTransform() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    fillText() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    roundRect() {},
    fill() {},
    fillRect() {},
  };
  g.document.createElement = () => ({
    getContext: () => ctx,
    style: {},
    setAttribute() {},
    appendChild() {},
    width: 1,
    height: 1,
  });
});

interface Recorded {
  text: string[];
  /** Horizontal segments (a moveTo followed by a same-y lineTo). */
  underlines: { x0: number; x1: number; y: number }[];
}

function recordingCtx(): { ctx: CanvasRenderingContext2D; rec: Recorded } {
  const rec: Recorded = { text: [], underlines: [] };
  let penX = 0;
  let penY = 0;
  const ctx = {
    measureText: (t: string) => ({ width: (t?.length ?? 0) * 9 }),
    save() {},
    restore() {},
    translate() {},
    scale() {},
    fillText(s: string) {
      rec.text.push(s);
    },
    strokeText() {},
    beginPath() {},
    moveTo(x: number, y: number) {
      penX = x;
      penY = y;
    },
    lineTo(x: number, y: number) {
      if (Math.abs(y - penY) < 0.01) {
        rec.underlines.push({ x0: penX, x1: x, y });
      }
    },
    stroke() {},
    roundRect() {},
    fill() {},
    fillRect() {},
    set font(_v: string) {},
    set fillStyle(_v: string) {},
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set textBaseline(_v: string) {},
    set textAlign(_v: string) {},
    set direction(_v: string) {},
    set globalAlpha(_v: number) {},
    get globalAlpha() {
      return 1;
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, rec };
}

function paintFirstBlock(state: EditorState): Recorded {
  const { ctx, rec } = recordingCtx();
  const styles = getEditorStyles(state);
  renderBlock(
    ctx,
    state,
    state.document.page.blocks[0],
    0,
    true,
    0,
    0,
    600,
    styles,
  );
  return rec;
}

function blockEquation(latex: string) {
  const binding = createCRDTbinding("comp-underline", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([blockOp]);
  const page = insertCharsAtPosition(
    engine.getState(),
    blockOp.blockId,
    0,
    latex,
    binding,
  ).newPage;
  return createInitialState(page, { crdtBinding: binding });
}

function inlineChip(latex: string) {
  const binding = createCRDTbinding("comp-underline", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;
  let page = insertCharsAtPosition(
    engine.getState(),
    blockId,
    0,
    latex,
    binding,
  ).newPage;
  page = markCharsInRange(
    page,
    blockId,
    0,
    latex.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
  return createInitialState(page, { crdtBinding: binding });
}

function focus(state: EditorState): EditorState {
  return { ...state, view: { ...state.view, isFocused: true } };
}

describe("block equation — IME composition preview + underline", () => {
  it("paints the composed preview and underlines exactly that sub-range", () => {
    let state = focus(blockEquation("x+y"));
    state = moveCursorToPosition(state, 0, 2); // x+|y
    state = startComposition(state, "あ", { blockIndex: 0, textIndex: 2 });

    const rec = paintFirstBlock(state);
    // The preview now typesets (it previously did not paint at all).
    expect(rec.text.join("")).toContain("あ");
    // …and the composing sub-range is underlined.
    expect(rec.underlines.length).toBeGreaterThan(0);
  });

  it("draws no composition underline at rest (control)", () => {
    const state = focus(blockEquation("x+y"));
    const rec = paintFirstBlock(state);
    expect(rec.underlines.length).toBe(0);
  });
});

describe("inline math chip — IME composition underline", () => {
  it("underlines the composed sub-range inside the chip", () => {
    let state = focus(inlineChip("ab"));
    state = moveCursorToPosition(state, 0, 1); // strictly inside the chip
    state = startComposition(state, "あ", { blockIndex: 0, textIndex: 1 });

    const rec = paintFirstBlock(state);
    expect(rec.text.join("")).toContain("あ");
    expect(rec.underlines.length).toBeGreaterThan(0);
  });

  it("draws no composition underline at rest (control)", () => {
    const state = focus(inlineChip("ab"));
    const rec = paintFirstBlock(state);
    expect(rec.underlines.length).toBe(0);
  });
});
