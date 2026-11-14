/**
 * Arabic text inside a display formula: `\text{المساحة} = \pi r^2`.
 *
 * The word is drawn from the host font as one shaped, right-to-left box. The
 * selection bridges used to measure the formula WITHOUT that host font, where
 * the Arabic letters are zero-width and have no caret stops — so select-all
 * started after the word (highlighting only "= πr²") and a double-click on the
 * word collapsed to nothing. Arrow keys also followed the letters' logical
 * order, so ← moved the caret rightward through the word.
 */
import { vi } from "vitest";

// Node has no text shaping; give each fallback letter a fixed width so the
// word's letter boundaries are distinct, as they are in a browser.
vi.mock("@tasfer/editor/fonts", async (original) => ({
  ...(await original<object>()),
  measureTexFallbackEm: (text: string) => ({
    width: [...text].length * 0.5,
    ascent: 0.8,
    depth: 0.2,
  }),
}));

import { createMathTestState, loadMathPage } from "./__testutils__/math";
import {
  getMathStructuredDocument,
  structuredToMathDocument,
} from "./structured";
import { layoutMathDocumentHost } from "./tex-host";
import {
  mathContentSelectionFromSourceOffset,
  mathSourceOffsetFromContentPoint,
} from "./tree-selection";
import { SELECT_ALL } from "@tasfer/editor/actions/edit-actions";
import {
  EXTEND_SELECTION_LEFT,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
} from "@tasfer/editor/actions/keyboard-actions";
import { SELECT_WORD_AT_POINT } from "@tasfer/editor/actions/mouse-actions";
import type { EditorState } from "@tasfer/editor/state-types";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { printMathDocument, selectionRects, spanAtPoint } from "@tasfer/tex";
import { describe, expect, it } from "vitest";

const LATEX = "\\text{المساحة} = \\pi r^2";
// Canonical source: `\text{المساحة}=\pi{r}^{2}`. The seven letters sit at
// offsets 6..12; 13 is the end of the word, 14 is after `}`.
const WORD = { start: 6, end: 13 };

function setup(): { state: EditorState; source: string } {
  const state = createMathTestState(loadMathPage(`before\n\n$$\n${LATEX}\n$$`));
  const document = getMathStructuredDocument(mathBlock(state));
  if (!document) throw new Error("expected a structured equation");
  const source = printMathDocument(structuredToMathDocument(document)!);
  return { state, source };
}

function mathBlock(state: EditorState) {
  const block = state.document.page.blocks.find(
    (b) => (b.type as string) === "math",
  );
  if (!block) throw new Error("expected a math block");
  return block;
}

function caretAt(state: EditorState, offset: number): EditorState {
  const block = mathBlock(state);
  const document = getMathStructuredDocument(block)!;
  const selection = mathContentSelectionFromSourceOffset(
    block.id,
    document.rootId,
    document,
    offset,
  );
  if (!selection) throw new Error(`no caret at ${offset}`);
  return updateContentSelection(state, selection);
}

/** The nested selection as `[anchor, focus]` source offsets, or null. */
function range(state: EditorState): [number, number] | null {
  const selection = state.document.contentSelection;
  if (!selection) return null;
  const document = getMathStructuredDocument(mathBlock(state))!;
  const anchor = mathSourceOffsetFromContentPoint(document, selection.anchor);
  const focus = mathSourceOffsetFromContentPoint(document, selection.focus);
  if (anchor === null || focus === null) return null;
  return [anchor, focus];
}

/** Caret x (px) for each source offset, as the block lays it out. */
function caretX(state: EditorState): Map<number, number> {
  const document = getMathStructuredDocument(mathBlock(state))!;
  const layout = layoutMathDocumentHost(structuredToMathDocument(document)!);
  const xs = new Map<number, number>();
  for (const stop of layout.caretStops) {
    if (!xs.has(stop.sourceOffset)) xs.set(stop.sourceOffset, stop.x);
  }
  return xs;
}

function press(state: EditorState, action: typeof MOVE_CURSOR_LEFT) {
  return state.actionBus.dispatchState(action, state).state;
}

describe("Arabic \\text inside a display formula", () => {
  it("select-all covers the whole formula, Arabic word included", () => {
    const { state, source } = setup();
    const selected = state.actionBus.dispatchState(
      SELECT_ALL,
      caretAt(state, 15),
    ).state;
    expect(range(selected)).toEqual([0, source.length]);

    // …and the highlight starts at the formula's left edge (the word's end).
    const document = getMathStructuredDocument(mathBlock(state))!;
    const layout = layoutMathDocumentHost(structuredToMathDocument(document)!);
    const rects = selectionRects(layout, 0, source.length);
    expect(Math.min(...rects.map((r) => r.x))).toBe(0);
  });

  it("double-click on the word selects the word", () => {
    const { state } = setup();
    const document = getMathStructuredDocument(mathBlock(state))!;
    const layout = layoutMathDocumentHost(structuredToMathDocument(document)!);
    const x = caretX(state);
    // A point in the middle of the word resolves to its letters.
    const middle = (x.get(WORD.start)! + x.get(WORD.end)!) / 2;
    const hit = spanAtPoint(layout, middle, -5);
    expect(hit).toEqual(WORD);

    const selected = state.actionBus.dispatchState(
      SELECT_WORD_AT_POINT,
      state,
      {
        position: {
          blockIndex: state.document.page.blocks.indexOf(mathBlock(state)),
          textIndex: 0,
        },
        range: hit!,
      },
    ).state;
    expect(range(selected)).toEqual([WORD.start, WORD.end]);
  });

  it("a range that covers no letter does not light the word", () => {
    const { state } = setup();
    const document = getMathStructuredDocument(mathBlock(state))!;
    const layout = layoutMathDocumentHost(structuredToMathDocument(document)!);
    // Just `\text{`: nothing visible.
    expect(selectionRects(layout, 0, WORD.start)).toEqual([]);
  });

  it("the gap before the word shows at the formula's left edge", () => {
    const { state } = setup();
    const x = caretX(state);
    expect(x.get(0)).toBe(0);
    // The word reads right to left: its first letter boundary is at the right.
    expect(x.get(WORD.start)!).toBeGreaterThan(x.get(WORD.end)!);
  });

  it("← walks left through the word one letter at a time, then leaves", () => {
    const { state } = setup();
    const x = caretX(state);
    let current = caretAt(state, 15); // just right of "="
    const xs: number[] = [];
    for (let i = 0; i < 8; i++) {
      current = press(current, MOVE_CURSOR_LEFT);
      const at = range(current);
      expect(at).not.toBeNull();
      xs.push(x.get(at![1])!);
    }
    // Every press moves the caret visibly LEFT, reaching the word's left end.
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1]);
    expect(range(current)![1]).toBe(WORD.end);
    // One more press leaves the formula for the block before it.
    const out = press(current, MOVE_CURSOR_LEFT);
    const blocks = out.document.page.blocks;
    expect(out.document.contentSelection).toBeNull();
    expect(blocks[out.document.cursor!.position.blockIndex].type).toBe(
      "paragraph",
    );
  });

  it("→ walks right through the word one letter at a time, then past it", () => {
    const { state } = setup();
    const x = caretX(state);
    let current = caretAt(state, 0); // formula start, left of the word
    const xs: number[] = [x.get(0)!];
    for (let i = 0; i < 8; i++) {
      current = press(current, MOVE_CURSOR_RIGHT);
      xs.push(x.get(range(current)![1])!);
    }
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    }
    // The 7 letter boundaries inside the word, then on past the word.
    expect(range(current)![1]).toBeGreaterThan(14);
  });

  it("Shift+← selects letters on the left of the caret", () => {
    const { state } = setup();
    let current = caretAt(state, WORD.start); // right edge of the word
    current = press(current, EXTEND_SELECTION_LEFT);
    current = press(current, EXTEND_SELECTION_LEFT);
    // Two letters: the word's first two (rightmost on screen).
    expect(range(current)).toEqual([WORD.start, WORD.start + 2]);
  });
});
