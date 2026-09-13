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
} from "@tasfer/editor/actions/edit-actions";
import {
  COMPOSITION_END,
  COMPOSITION_START,
  COMPOSITION_UPDATE,
} from "@tasfer/editor/actions/input-actions";
import { TOGGLE_EMPHASIS, TOGGLE_STRONG } from "@tasfer/editor/rendering/marks";
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
    if (surface === cellSurface) {
      const [headA, headB, , side] = allCells(state).map(plain);
      expect({ headA, headB, side }).toEqual(NEIGHBOURS);
    }
  }
  return out;
}

function expectParity(initial: string, steps: Step[]) {
  const paragraph = trace(paragraphSurface, initial, steps);
  const cell = trace(cellSurface, initial, steps);
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
    // Typing inside a mark extends it; typing at either edge does not.
    expect(last.text).toEqual([
      ["one S", []],
      ["tXwo", ["strong"]],
      ["E three", []],
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
