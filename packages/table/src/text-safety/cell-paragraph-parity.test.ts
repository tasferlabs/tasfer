/**
 * A table cell must store exactly what a paragraph stores for the same edits.
 *
 * Each script runs against a paragraph and against a cell, and after every step
 * the two must agree on the stored text, the marks over it, and the caret — the
 * caret is part of it because it decides where the next keystroke lands.
 *
 * This is the safety net for moving cells onto the paragraph's text code: if a
 * refactor maps an offset to the wrong character, the two surfaces drift apart
 * here before a user's text goes missing. Where the two differ today on
 * purpose, the difference is pinned in its own test below rather than hidden.
 */

import {
  allCells,
  cellSurface,
  markdownCellSurface,
  markdownParagraphSurface,
  NEIGHBOURS,
  type Offsets,
  paragraphSurface,
  plain,
  type RichText,
  type TextSurface,
} from "./harness";
import { insertText } from "@tasfer/editor/actions/actions";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_TO_LINE_END,
  DELETE_TO_LINE_START,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  REVERT_INPUT_RULE,
} from "@tasfer/editor/actions/edit-actions";
import {
  COMPOSITION_END,
  COMPOSITION_START,
  COMPOSITION_UPDATE,
} from "@tasfer/editor/actions/input-actions";
import {
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_RIGHT,
  EXTEND_SELECTION_WORD_LEFT,
  EXTEND_SELECTION_WORD_RIGHT,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
  MOVE_TO_LINE_END,
  MOVE_TO_LINE_START,
  MOVE_TO_NEXT_WORD,
  MOVE_TO_PREVIOUS_WORD,
} from "@tasfer/editor/actions/keyboard-actions";
import {
  TOGGLE_CODE,
  TOGGLE_EMPHASIS,
  TOGGLE_STRIKE,
  TOGGLE_STRONG,
} from "@tasfer/editor/rendering/marks";
import type { EditorState } from "@tasfer/editor/state-types";
import { describe, expect, it } from "vitest";

const KEYS = {
  Backspace: DELETE_BACKWARD,
  Delete: DELETE_FORWARD,
  WordBackspace: DELETE_WORD_BACKWARD,
  WordDelete: DELETE_WORD_FORWARD,
  LineBackspace: DELETE_TO_LINE_START,
  LineDelete: DELETE_TO_LINE_END,
  Bold: TOGGLE_STRONG,
  Italic: TOGGLE_EMPHASIS,
  Strike: TOGGLE_STRIKE,
  Code: TOGGLE_CODE,
  ArrowLeft: MOVE_CURSOR_LEFT,
  ArrowRight: MOVE_CURSOR_RIGHT,
  WordLeft: MOVE_TO_PREVIOUS_WORD,
  WordRight: MOVE_TO_NEXT_WORD,
  Home: MOVE_TO_LINE_START,
  End: MOVE_TO_LINE_END,
  ShiftLeft: EXTEND_SELECTION_LEFT,
  ShiftRight: EXTEND_SELECTION_RIGHT,
  ShiftWordLeft: EXTEND_SELECTION_WORD_LEFT,
  ShiftWordRight: EXTEND_SELECTION_WORD_RIGHT,
  /** The take-back Backspace and the first undo both dispatch. */
  Revert: REVERT_INPUT_RULE,
} as const;

type Step =
  | { select: [number, number] }
  | { caret: number }
  | { type: string }
  | { key: keyof typeof KEYS }
  /** An IME session: each string is one composition update, the last commits. */
  | { compose: string[] };

function run(
  state: EditorState,
  surface: TextSurface,
  step: Step,
): EditorState {
  if ("select" in step) return surface.select(state, ...step.select);
  if ("caret" in step) return surface.select(state, step.caret, step.caret);
  if ("type" in step) return insertText(state, step.type).state;
  if ("key" in step) {
    return state.actionBus.dispatchState(KEYS[step.key], state).state;
  }
  const [first, ...rest] = step.compose;
  state = state.actionBus.dispatchState(COMPOSITION_START, state, {
    data: first,
  }).state;
  for (const data of rest) {
    state = state.actionBus.dispatchState(COMPOSITION_UPDATE, state, {
      data,
    }).state;
  }
  return state.actionBus.dispatchState(COMPOSITION_END, state, {
    data: step.compose[step.compose.length - 1],
  }).state;
}

interface Trace {
  readonly step: string;
  readonly text: RichText;
  readonly selection: Offsets | null;
}

function trace(surface: TextSurface, initial: string, steps: Step[]): Trace[] {
  let state = surface.create(initial);
  const out: Trace[] = [];
  for (const step of steps) {
    state = run(state, surface, step);
    out.push({
      step: JSON.stringify(step),
      text: surface.read(state),
      selection: surface.selection(state),
    });
    if (surface === cellSurface || surface === markdownCellSurface) {
      const [headA, headB, , side] = allCells(state).map(plain);
      expect({ headA, headB, side }).toEqual(NEIGHBOURS);
    }
  }
  return out;
}

function expectParity(
  initial: string,
  steps: Step[],
  surfaces: readonly [TextSurface, TextSurface] = [
    paragraphSurface,
    cellSurface,
  ],
) {
  const paragraph = trace(surfaces[0], initial, steps);
  const cell = trace(surfaces[1], initial, steps);
  // Compared step by step so a failure names the first step that diverged.
  for (let i = 0; i < steps.length; i++) {
    expect(cell[i], `after step ${i}: ${cell[i].step}`).toEqual(paragraph[i]);
  }
  return cell[cell.length - 1];
}

describe("a cell stores what a paragraph stores", () => {
  it("typing at the start, middle and end", () => {
    const last = expectParity("one two", [
      { caret: 0 },
      { type: ">" },
      { caret: 4 },
      { type: "_" },
      { caret: 9 },
      { type: "<" },
    ]);
    expect(plain(last.text)).toBe(">one_ two<");
  });

  it("replacing a selection, forwards and backwards", () => {
    expectParity("alpha beta gamma", [
      { select: [6, 10] },
      { type: "B" },
      { select: [7, 0] },
      { type: "A" },
    ]);
  });

  it("character deletes both ways", () => {
    expectParity("abcdef", [
      { caret: 3 },
      { key: "Backspace" },
      { key: "Delete" },
      { key: "Backspace" },
      { key: "Delete" },
    ]);
  });

  it("deleting a selection with either key", () => {
    expectParity("abcdefgh", [
      { select: [1, 3] },
      { key: "Backspace" },
      { select: [4, 2] },
      { key: "Delete" },
    ]);
  });

  it("word deletes both ways", () => {
    expectParity("one two three four", [
      { caret: 8 },
      { key: "WordBackspace" },
      { key: "WordDelete" },
      { caret: 4 },
      { key: "WordDelete" },
    ]);
  });

  it("word deletes over punctuation and runs of spaces", () => {
    expectParity("one,  two... three", [
      { caret: 11 },
      { key: "WordBackspace" },
      { key: "WordBackspace" },
      { caret: 0 },
      { key: "WordDelete" },
    ]);
  });

  it("bolding a range and typing inside and at its edges", () => {
    const last = expectParity("one two three", [
      { select: [4, 7] },
      { key: "Bold" },
      { caret: 5 },
      { type: "X" },
      { caret: 4 },
      { type: "S" },
      { caret: 9 },
      { type: "E" },
    ]);
    // Typing inside a mark extends it, and so does typing at its end; typing
    // at its start does not (the caret is on the side before the edge).
    expect(last.text).toEqual([
      ["one S", []],
      ["tXwoE", ["strong"]],
      [" three", []],
    ]);
  });

  it("Ctrl+B at the end of a bold run turns bold off for what comes next", () => {
    const last = expectParity("one two three", [
      { select: [4, 7] },
      { key: "Bold" },
      { caret: 7 },
      { key: "Bold" },
      { type: "D" },
    ]);
    expect(last.text).toEqual([
      ["one ", []],
      ["two", ["strong"]],
      ["D three", []],
    ]);
  });

  it("arrowing across a mark's edges switches the side typing takes", () => {
    const last = expectParity("one two three", [
      { select: [4, 7] },
      { key: "Bold" },
      // End of "two": the first ArrowRight steps out of the mark in place.
      { caret: 7 },
      { key: "ArrowRight" },
      { type: "A" },
      // One step left of "t|wo" lands on the start of the mark, arrived at
      // from inside it: typing joins the mark.
      { caret: 5 },
      { key: "ArrowLeft" },
      { type: "B" },
      // Back to the start: the first ArrowLeft lands there on the mark's side,
      // the second steps out of it in place.
      { key: "ArrowLeft" },
      { key: "ArrowLeft" },
      { type: "C" },
    ]);
    expect(last.text).toEqual([
      ["one C", []],
      ["Btwo", ["strong"]],
      ["A three", []],
    ]);
  });

  it("deleting into and across a mark's edges", () => {
    expectParity("one two three", [
      { select: [4, 7] },
      { key: "Bold" },
      { caret: 4 },
      { key: "Backspace" },
      { select: [5, 9] },
      { key: "Delete" },
    ]);
  });

  it("overlapping marks, then unmarking part of them", () => {
    expectParity("one two three", [
      { select: [0, 7] },
      { key: "Bold" },
      { select: [4, 13] },
      { key: "Italic" },
      { select: [2, 5] },
      { key: "Bold" },
    ]);
  });

  it("a mark armed at a collapsed caret", () => {
    expectParity("one", [
      { caret: 3 },
      { key: "Bold" },
      { type: "X" },
      { type: "Y" },
      { key: "Bold" },
      { type: "Z" },
    ]);
  });

  it("an IME session commits its text exactly once", () => {
    const last = expectParity("one", [
      { caret: 3 },
      { compose: ["ك", "كت", "كتب"] },
      { caret: 0 },
      { compose: ["に", "にほ", "日本"] },
    ]);
    expect(plain(last.text)).toBe("日本oneكتب");
  });

  it("an IME session over a selection", () => {
    expectParity("one two", [{ select: [0, 3] }, { compose: ["x", "xy"] }]);
  });

  it("an IME session that commits nothing", () => {
    expectParity("one two", [{ caret: 3 }, { compose: ["x", ""] }]);
  });

  it("Arabic, emoji and combining marks, typed and deleted", () => {
    expectParity("one", [
      { caret: 3 },
      { type: " مرحبا بالعالم" },
      { type: " 👨‍👩‍👧 é 🇸🇦" },
      { key: "Backspace" },
      { key: "Backspace" },
      { key: "WordBackspace" },
      { caret: 4 },
      { key: "WordDelete" },
    ]);
  });
});

describe("a cell moves and selects as a paragraph does", () => {
  it("word moves both ways, over punctuation", () => {
    expectParity("one, two... three", [
      { caret: 9 },
      { key: "WordLeft" },
      { type: "|" },
      { key: "WordRight" },
      { type: "|" },
      { key: "WordRight" },
      { type: "|" },
    ]);
  });

  it("Home and End inside the text", () => {
    expectParity("one two", [
      { caret: 3 },
      { key: "Home" },
      { type: "[" },
      { key: "End" },
      { type: "]" },
    ]);
  });

  it("Shift+arrow and Shift+word build a selection typing replaces", () => {
    expectParity("one two three", [
      { caret: 4 },
      { key: "ShiftRight" },
      { key: "ShiftRight" },
      { key: "ShiftLeft" },
      { type: "X" },
      // Every step stays inside the text: walking past its end is where a
      // cell (a grid of them) and a paragraph part ways on purpose.
      { caret: 9 },
      { key: "ShiftWordLeft" },
      { key: "ShiftWordLeft" },
      { key: "ShiftWordRight" },
      { type: "Y" },
    ]);
  });

  it("arrowing into a mark from the outside keeps typing out of it", () => {
    expectParity("one two three", [
      { select: [4, 7] },
      { key: "Bold" },
      { caret: 9 },
      { key: "ArrowLeft" },
      { key: "ArrowLeft" },
      { key: "ArrowLeft" },
      { type: "A" },
      { caret: 2 },
      { key: "ArrowRight" },
      { key: "ArrowRight" },
      { key: "ArrowRight" },
      { type: "B" },
    ]);
  });
});

describe("a cell formats as a paragraph does", () => {
  it("strike and code toggles over a range and at a caret", () => {
    expectParity("one two three", [
      { select: [0, 3] },
      { key: "Strike" },
      { select: [8, 13] },
      { key: "Code" },
      { caret: 3 },
      { type: "S" },
      { caret: 14 },
      { type: "C" },
      { caret: 7 },
      { key: "Code" },
      { type: "K" },
    ]);
  });

  it("typing over a marked selection takes its first character's marks", () => {
    expectParity("one two three", [
      { select: [4, 7] },
      { key: "Bold" },
      { select: [5, 11] },
      { type: "X" },
      { select: [7, 2] },
      { type: "Y" },
    ]);
  });

  it("toggling a mark across a range that is partly marked", () => {
    expectParity("one two three", [
      { select: [4, 7] },
      { key: "Italic" },
      { select: [2, 9] },
      { key: "Italic" },
      { select: [2, 9] },
      { key: "Italic" },
    ]);
  });
});

describe("a cell with markdown shortcuts formats as a paragraph does", () => {
  const MARKDOWN = [markdownParagraphSurface, markdownCellSurface] as const;

  it("closing delimiters wrap the text before them", () => {
    expectParity(
      "one",
      [
        { caret: 3 },
        { type: " " },
        { type: "*" },
        { type: "*" },
        { type: "b" },
        { type: "*" },
        { type: "*" },
        { type: " " },
        { type: "_" },
        { type: "i" },
        { type: "_" },
        { type: " " },
        { type: "~" },
        { type: "~" },
        { type: "s" },
        { type: "~" },
        { type: "~" },
        { type: " " },
        { type: "`" },
        { type: "c" },
        { type: "`" },
      ],
      MARKDOWN,
    );
  });

  it("the take-back puts the literal syntax back", () => {
    expectParity(
      "go",
      [
        { caret: 2 },
        { type: " " },
        { type: "*" },
        { type: "a" },
        { type: "*" },
        { key: "Revert" },
        { type: " " },
        { type: "`" },
        { type: "x" },
        { type: "`" },
        { key: "Revert" },
        { key: "Revert" },
      ],
      MARKDOWN,
    );
  });

  it("a delimiter typed inside a word stays literal", () => {
    expectParity(
      "snake",
      [{ caret: 5 }, { type: "_" }, { type: "c" }, { type: "_" }],
      MARKDOWN,
    );
  });

  it("a block prefix stays literal text in a cell", () => {
    // A paragraph would become a heading here; a cell has no block to turn
    // into one, so both keep the typed characters as text and the cell must
    // not lose any of them.
    const cell = markdownCellSurface;
    let state = cell.select(cell.create("x"), 0, 0);
    for (const ch of "# hi") {
      state = run(state, cell, { type: ch });
    }
    expect(plain(cell.read(state))).toBe("# hix");
  });
});

describe("a cell links as a paragraph does", () => {
  it("a URL followed by a space becomes a link", () => {
    expectParity("see", [
      { caret: 3 },
      { type: " https://example.com" },
      { type: " " },
      { type: "x" },
    ]);
  });
});
