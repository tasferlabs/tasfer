/**
 * Random edit sessions run against a paragraph and a table cell side by side.
 *
 * `cell-paragraph-parity` holds the cases someone thought of; this holds the
 * rest. Each seed builds one random script and runs it on both surfaces, and
 * after every step the cell must store exactly what the paragraph stores — the
 * text, the marks over it, and the caret — while its neighbouring cells stay
 * untouched. A failure names the seed and the first step that diverged, plus
 * the script so far, which is enough to replay it as a scripted test.
 *
 * Steps are chosen from the paragraph's current state and never walk past the
 * text's edges: that is the one place a cell (one of a grid) and a paragraph
 * part ways on purpose, and those rules are pinned in their own tests.
 */

import {
  allCells,
  cellSurface,
  markdownCellSurface,
  markdownParagraphSurface,
  NEIGHBOURS,
  paragraphSurface,
  plain,
  random,
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

const SEEDS = 60;
const STEPS = 50;

/**
 * The markdown delimiters. Typed only where both surfaces run the shortcuts:
 * with them off a cell keeps `*` literal by design, and a paragraph cannot
 * turn them off.
 */
const DELIMITERS = ["*", "**", "~", "`"];

/** Pieces to type: Latin, Arabic, CJK, emoji sequences, a URL, `_`. */
const PLAIN = [
  "a",
  "xyz",
  " ",
  "word ",
  "مرحبا",
  " عالم ",
  "日本",
  "👍",
  "👨‍👩‍👧",
  "é",
  "1,2.",
  "https://example.com",
  "_",
];

/** Keys that act in place or delete; none of them can leave the text. */
const IN_PLACE = {
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
  Home: MOVE_TO_LINE_START,
  End: MOVE_TO_LINE_END,
  Revert: REVERT_INPUT_RULE,
} as const;

/** Caret moves, each paired with the edge it must not start from. */
const MOVES = {
  ArrowLeft: [MOVE_CURSOR_LEFT, "start"],
  ArrowRight: [MOVE_CURSOR_RIGHT, "end"],
  WordLeft: [MOVE_TO_PREVIOUS_WORD, "start"],
  WordRight: [MOVE_TO_NEXT_WORD, "end"],
  ShiftLeft: [EXTEND_SELECTION_LEFT, "start"],
  ShiftRight: [EXTEND_SELECTION_RIGHT, "end"],
  ShiftWordLeft: [EXTEND_SELECTION_WORD_LEFT, "start"],
  ShiftWordRight: [EXTEND_SELECTION_WORD_RIGHT, "end"],
} as const;

type Step =
  | { select: [number, number] }
  | { type: string }
  | { key: keyof typeof IN_PLACE | keyof typeof MOVES }
  | { compose: string[] };

/** Offsets that do not split a surrogate pair — the only ones a caret takes. */
function boundaries(text: string): number[] {
  const out = [0];
  let at = 0;
  for (const ch of text) {
    at += ch.length;
    out.push(at);
  }
  return out;
}

function nextStep(
  next: () => number,
  text: string,
  pieces: readonly string[],
): Step {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(next() * items.length)];
  const roll = next();
  if (roll < 0.3) return { type: pick(pieces) };
  if (roll < 0.45) {
    const at = boundaries(text);
    const anchor = pick(at);
    return { select: [anchor, next() < 0.5 ? anchor : pick(at)] };
  }
  if (roll < 0.5) {
    const composed = pick(pieces);
    return { compose: [composed.slice(0, 1), composed] };
  }
  if (roll < 0.75) {
    return { key: pick(Object.keys(IN_PLACE) as (keyof typeof IN_PLACE)[]) };
  }
  return { key: pick(Object.keys(MOVES) as (keyof typeof MOVES)[]) };
}

/**
 * Whether a caret move ran into the text's edge: the paragraph's caret did not
 * move and sits at the start or the end. Visual keys go the other way in
 * right-to-left text, so the edge is read off the outcome, not the key.
 */
function hitEdge(
  before: { anchor: number; focus: number } | null,
  after: { anchor: number; focus: number } | null,
  length: number,
): boolean {
  if (!after) return true;
  const still = before?.focus === after.focus;
  return still && (after.focus === 0 || after.focus === length);
}

function run(
  state: EditorState,
  surface: TextSurface,
  step: Step,
): EditorState {
  if ("select" in step) return surface.select(state, ...step.select);
  if ("type" in step) return insertText(state, step.type).state;
  if ("key" in step) {
    const action =
      step.key in IN_PLACE
        ? IN_PLACE[step.key as keyof typeof IN_PLACE]
        : MOVES[step.key as keyof typeof MOVES][0];
    return state.actionBus.dispatchState(action, state).state;
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

function session(
  seed: number,
  [paragraph, cell]: readonly [TextSurface, TextSurface],
  pieces: readonly string[],
) {
  const next = random(seed);
  let left = paragraph.select(paragraph.create("one two"), 3, 3);
  let right = cell.select(cell.create("one two"), 3, 3);
  const steps: Step[] = [];
  for (let i = 0; i < STEPS; i++) {
    const step = nextStep(next, plain(paragraph.read(left)), pieces);
    const at = paragraph.selection(left);
    if (
      "select" in step &&
      step.select[0] === step.select[1] &&
      at?.anchor === at?.focus &&
      at?.focus === step.select[1]
    ) {
      // A click on the caret's own spot: placing a flat caret always drops a
      // pending Ctrl+B, placing a nested one only when it moves. That is caret
      // placement in core, not text editing — out of this suite's reach.
      continue;
    }
    const movedLeft = run(left, paragraph, step);
    if (
      "key" in step &&
      step.key in MOVES &&
      hitEdge(
        paragraph.selection(left),
        paragraph.selection(movedLeft),
        plain(paragraph.read(left)).length,
      )
    ) {
      // At the edge a cell steps into its neighbour; not this suite's concern.
      continue;
    }
    steps.push(step);
    left = movedLeft;
    right = run(right, cell, step);
    const where = `seed ${seed}, step ${i}: ${JSON.stringify(step)}\nscript: ${JSON.stringify(steps)}`;
    expect(
      { text: cell.read(right), selection: cell.selection(right) },
      where,
    ).toEqual({
      text: paragraph.read(left),
      selection: paragraph.selection(left),
    });
    const [headA, headB, , side] = allCells(right).map(plain);
    expect({ headA, headB, side }, where).toEqual(NEIGHBOURS);
  }
}

describe("random sessions: a cell stores what a paragraph stores", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, () =>
      session(seed, [paragraphSurface, cellSurface], PLAIN));
  }
});

describe("random sessions with markdown shortcuts on", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, () =>
      session(
        seed,
        [markdownParagraphSurface, markdownCellSurface],
        [...PLAIN, ...DELIMITERS],
      ));
  }
});
