/**
 * A cell's text and marks through markdown export and back.
 *
 * Markdown is the export and import format (the export dialog, space export),
 * not how pages are saved, so a loss here costs a user their exported copy
 * rather than the page itself. Cells and paragraphs share the inline codec;
 * these tests keep it that way and pin the cases that survive today.
 *
 * Known losses are pinned with `it.fails`: each one is a real bug that exists
 * in paragraphs too. When one gets fixed the test starts passing, vitest
 * reports it, and it should be moved into the surviving group.
 */

import {
  cellSurface,
  editorOf,
  markdownOf,
  paragraphSurface,
  plain,
  type RichText,
  type TextSurface,
} from "./harness";
import type { StateAction } from "@tasfer/editor/action-bus";
import { insertText } from "@tasfer/editor/actions/actions";
import { TOGGLE_EMPHASIS, TOGGLE_STRONG } from "@tasfer/editor/rendering/marks";
import type { EditorState } from "@tasfer/editor/state-types";
import { describe, expect, it } from "vitest";

interface Case {
  readonly text: string;
  readonly typed?: string;
  readonly marks?: readonly [number, number, StateAction][];
}

function build(surface: TextSurface, { text, typed, marks = [] }: Case) {
  let state: EditorState = surface.create(text);
  if (typed !== undefined) {
    state = insertText(
      surface.select(state, text.length, text.length),
      typed,
    ).state;
  }
  for (const [from, to, toggle] of marks) {
    state = surface.select(state, from, to);
    state = state.actionBus.dispatchState(toggle, state).state;
  }
  return state;
}

/** What the surface holds before export, and after export and re-import. */
function roundTrip(surface: TextSurface, test: Case) {
  const state = build(surface, test);
  const reloaded = editorOf(markdownOf(state));
  return { stored: surface.read(state), reloaded: surface.read(reloaded) };
}

function expectSurvives(test: Case) {
  const { stored, reloaded } = roundTrip(cellSurface, test);
  expect(reloaded).toEqual(stored);
}

/** The cell's markdown, unwrapped from its row. */
function cellMarkdown(state: EditorState): string {
  const row = markdownOf(state).split("\n")[2];
  return row.slice(2, row.lastIndexOf(" | side |"));
}

const SURVIVING: Record<string, Case> = {
  "plain text": { text: "one two three" },
  "bold inside a word run": {
    text: "one two three",
    marks: [[4, 7, TOGGLE_STRONG]],
  },
  "bold with a space at its start": {
    text: "one two three",
    marks: [[3, 7, TOGGLE_STRONG]],
  },
  "bold with a space at its end": {
    text: "one two three",
    marks: [[4, 8, TOGGLE_STRONG]],
  },
  "bold in the middle of a word": {
    text: "onetwothree",
    marks: [[3, 6, TOGGLE_STRONG]],
  },
  "bold and italic side by side": {
    text: "one two",
    marks: [
      [0, 3, TOGGLE_STRONG],
      [4, 7, TOGGLE_EMPHASIS],
    ],
  },
  "Arabic with bold": {
    text: "مرحبا بالعالم",
    marks: [[0, 5, TOGGLE_STRONG]],
  },
  "emoji and combining marks": { text: "one", typed: " 👨‍👩‍👧 é 🇸🇦" },
  "a literal pipe": { text: "one", typed: " a|b" },
  "a literal backslash": { text: "one", typed: " a\\b" },
  "html-looking text": { text: "one", typed: " <b>x</b> &amp;" },
  "a tab": { text: "one", typed: "\tb" },
};

describe("cell text that survives export and re-import", () => {
  for (const [name, test] of Object.entries(SURVIVING)) {
    it(name, () => expectSurvives(test));
  }
});

describe("a cell exports what a paragraph exports", () => {
  for (const [name, test] of Object.entries(SURVIVING)) {
    it(name, () => {
      const paragraph = markdownOf(build(paragraphSurface, test));
      const cell = cellMarkdown(build(cellSurface, test)).replaceAll(
        "\\|",
        "|",
      );
      expect(cell).toBe(paragraph);
    });
  }
});

describe("known export losses (shared with paragraphs)", () => {
  function expectParagraphLosesToo(test: Case) {
    const { stored, reloaded } = roundTrip(paragraphSurface, test);
    expect(reloaded).not.toEqual(stored);
  }

  const LOSSES: Record<string, Case & { note: string }> = {
    "overlapping bold and italic": {
      text: "one two three",
      marks: [
        [0, 7, TOGGLE_STRONG],
        [4, 13, TOGGLE_EMPHASIS],
      ],
      note: 'bold spreads over " three" on re-import',
    },
    "literal markdown syntax": {
      text: "one",
      typed: " **x** `c` [l](u)",
      note: "exported unescaped, so it re-imports as formatting",
    },
    "an escaped asterisk": {
      text: "one",
      typed: " \\*",
      note: "the asterisk is dropped on re-import",
    },
    "trailing spaces": {
      text: "one",
      typed: "  ",
      note: "trimmed by the table row (paragraphs keep them)",
    },
    "a pasted line break": {
      text: "one",
      typed: "\ntwo",
      note: "cells export it as a space",
    },
  };

  for (const [name, { note, ...test }] of Object.entries(LOSSES)) {
    it.fails(`${name}: ${note}`, () => expectSurvives(test));
  }

  it("the paragraph losses are the same bugs, not cell-only ones", () => {
    expectParagraphLosesToo(LOSSES["overlapping bold and italic"]);
    expectParagraphLosesToo(LOSSES["literal markdown syntax"]);
    expectParagraphLosesToo(LOSSES["an escaped asterisk"]);
  });

  it("the stored text is still intact before export", () => {
    // The loss is in export only: the editor itself holds what was typed.
    const state = build(cellSurface, { text: "one", typed: "\ntwo" });
    expect(plain(cellSurface.read(state) as RichText)).toBe("one\ntwo");
  });
});
