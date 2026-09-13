/**
 * Random edit sessions in a cell, checked after every step against a plain
 * string model.
 *
 * The scripted tests cover the cases someone thought of; this covers the rest.
 * Each seed replays exactly, so a failure prints a seed and a step that can be
 * turned into a scripted test. After every step:
 *
 *   - typing and replacing produce exactly the model's string;
 *   - a delete removes one contiguous piece next to the caret and nothing else;
 *   - the stored text is well-formed UTF-16 (no half of an emoji left behind);
 *   - the neighbouring cells are untouched;
 *   - the ops sent so far rebuild the author's table exactly.
 *
 * A second block runs two peers at once and requires both arrival orders to
 * converge.
 */

import { CELL_TEXT_FIELD } from "../structured";
import {
  allCells,
  NEIGHBOURS,
  plain,
  random,
  replicated,
  selectInCell,
  tableDocument,
  tableOn,
  tableSource,
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
import { getVisibleOffsetAfterChar } from "@tasfer/editor/sync/char-runs";
import type { Operation } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

const CELL = 2;
const SEEDS = 40;
const STEPS = 60;

/** Pieces to type: Latin, Arabic, CJK, emoji sequences, combining marks. */
const PIECES = [
  "a",
  "xyz",
  " ",
  "word ",
  "مرحبا",
  "ب",
  " عالم ",
  "日本",
  "👍",
  "👨‍👩‍👧",
  "🇸🇦",
  "é",
  "1,2.",
];

/** Half of a surrogate pair with no partner: an emoji cut in two. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const BACKWARD = [DELETE_BACKWARD, DELETE_WORD_BACKWARD, DELETE_TO_LINE_START];
const FORWARD = [DELETE_FORWARD, DELETE_WORD_FORWARD, DELETE_TO_LINE_END];

/** Offsets that do not split a surrogate pair — the only ones a caret takes. */
function boundaries(text: string): number[] {
  const out = [0];
  let at = 0;
  for (const point of text) {
    at += point.length;
    out.push(at);
  }
  return out;
}

function cellString(state: EditorState): string {
  return plain(allCells(state)[CELL]);
}

function caretOffsets(state: EditorState): [number, number] {
  const selection = state.document.contentSelection!;
  const { document } = tableDocument(state);
  const runs = [
    ...document.nodes[(selection.focus as { nodeId: string }).nodeId]
      .textFields[CELL_TEXT_FIELD],
  ];
  const at = (point: typeof selection.anchor) =>
    getVisibleOffsetAfterChar(
      runs,
      (point as { afterCharId: string | null }).afterCharId,
    )!;
  return [at(selection.anchor), at(selection.focus)];
}

type Result = { state: EditorState; ops: Operation[] };

interface Step {
  readonly label: string;
  run(state: EditorState): Result;
  check(before: string, after: string, state: EditorState): void;
}

/** One random step against the cell's current text. */
function randomStep(next: () => number, text: string): Step {
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(next() * items.length)];
  const cuts = boundaries(text);
  const a = pick(cuts);
  const b = next() < 0.6 ? a : pick(cuts);
  const [from, to] = a <= b ? [a, b] : [b, a];
  const at = (state: EditorState) => selectInCell(state, CELL, a, b);
  const roll = next();

  if (roll < 0.35) {
    const piece = pick(PIECES);
    return {
      label: `select ${a}..${b}, type ${JSON.stringify(piece)}`,
      run: (state) => insertText(at(state), piece),
      check(before, after, state) {
        expect(after).toBe(before.slice(0, from) + piece + before.slice(to));
        expect(caretOffsets(state)).toEqual([
          from + piece.length,
          from + piece.length,
        ]);
      },
    };
  }

  if (roll < 0.45) {
    const updates = [pick(PIECES), pick(PIECES)];
    const commit = next() < 0.2 ? "" : updates[1];
    return {
      label: `select ${a}..${b}, compose ${JSON.stringify(updates)} → ${JSON.stringify(commit)}`,
      run(state) {
        let s = at(state);
        const ops: Operation[] = [];
        const start = s.actionBus.dispatchState(COMPOSITION_START, s, {
          data: updates[0],
        });
        ops.push(...start.ops);
        s = s.actionBus.dispatchState(COMPOSITION_UPDATE, start.state, {
          data: updates[1],
        }).state;
        const end = s.actionBus.dispatchState(COMPOSITION_END, s, {
          data: commit,
        });
        return { state: end.state, ops: [...ops, ...end.ops] };
      },
      check(before, after) {
        // A cancelled session keeps the selection's text; a committed one
        // replaces it, exactly once.
        expect(after).toBe(
          commit === ""
            ? before
            : before.slice(0, from) + commit + before.slice(to),
        );
      },
    };
  }

  if (roll < 0.85) {
    const backward = next() < 0.5;
    const action = pick(backward ? BACKWARD : FORWARD);
    return {
      label: `select ${a}..${b}, ${backward ? "backward" : "forward"} delete #${(backward ? BACKWARD : FORWARD).indexOf(action)}`,
      run: (state) => at(state).actionBus.dispatchState(action, at(state)),
      check(before, after, state) {
        if (from !== to) {
          expect(after).toBe(before.slice(0, from) + before.slice(to));
          return;
        }
        // One contiguous piece next to the caret, on the side the key names.
        const removed = before.length - after.length;
        expect(removed).toBeGreaterThanOrEqual(0);
        const [caret] = caretOffsets(state);
        if (backward) {
          expect(after).toBe(
            before.slice(0, from - removed) + before.slice(from),
          );
          expect(caret).toBe(from - removed);
        } else {
          expect(after).toBe(
            before.slice(0, from) + before.slice(from + removed),
          );
          expect(caret).toBe(from);
        }
      },
    };
  }

  const action = next() < 0.5 ? TOGGLE_STRONG : TOGGLE_EMPHASIS;
  return {
    label: `select ${a}..${b}, toggle ${action === TOGGLE_STRONG ? "bold" : "italic"}`,
    run: (state) => at(state).actionBus.dispatchState(action, at(state)),
    check(before, after) {
      expect(after).toBe(before);
    },
  };
}

describe("random edit sessions in one cell", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, () => {
      const next = random(seed);
      const page = replicated(tableSource("one two"));
      let state = page.open("author");
      const sent: Operation[] = [];

      for (let index = 0; index < STEPS; index++) {
        const before = cellString(state);
        const step = randomStep(next, before);
        const where = `seed ${seed}, step ${index}: ${step.label} on ${JSON.stringify(before)}`;

        try {
          const result = step.run(state);
          state = result.state;
          sent.push(...result.ops);
          const after = cellString(state);

          step.check(before, after, state);
          expect(after).not.toMatch(LONE_SURROGATE);
          const [headA, headB, , side] = allCells(state).map(plain);
          expect({ headA, headB, side }).toEqual(NEIGHBOURS);
          expect(tableOn(page.replay(sent))).toEqual(
            tableOn(state.document.page),
          );
        } catch (error) {
          (error as Error).message = `${where}\n${(error as Error).message}`;
          throw error;
        }
      }
    });
  }
});

describe("random concurrent sessions converge", () => {
  for (let seed = 1; seed <= SEEDS / 2; seed++) {
    it(`seed ${seed}`, () => {
      const next = random(1000 + seed);
      const page = replicated(tableSource("one two three"));
      const peers = [page.open("peer-a"), page.open("peer-b")];
      const sent: Operation[][] = [[], []];

      for (let index = 0; index < STEPS / 2; index++) {
        const who = next() < 0.5 ? 0 : 1;
        const step = randomStep(next, cellString(peers[who]));
        const result = step.run(peers[who]);
        peers[who] = result.state;
        sent[who].push(...result.ops);
      }

      const oneWay = page.replay(sent[0], sent[1]);
      const otherWay = page.replay(sent[1], sent[0]);
      expect(tableOn(oneWay)).toEqual(tableOn(otherWay));

      // Interleaved delivery (the realistic case) lands in the same place too.
      const interleaved = page.replay(
        ...sent[0].flatMap((op, i) => [[op], sent[1][i] ? [sent[1][i]] : []]),
        sent[1].slice(sent[0].length),
      );
      expect(tableOn(interleaved)).toEqual(tableOn(oneWay));
    });
  }
});
