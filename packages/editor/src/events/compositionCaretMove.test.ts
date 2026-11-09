/**
 * Moving the caret away from an open IME composition (a tap on another line, a
 * drag-select) commits the composed text where it was typed. The composition is
 * drawn and committed at the caret, so before this it followed the caret to its
 * new spot — on Android (HeliBoard) the word being typed jumped lines on a tap.
 */
import "../entries/editor";
import {
  COMPOSITION_START,
  COMPOSITION_UPDATE,
} from "../actions/input-actions";
import { getBlockTextContent } from "../node-shared";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { commitCompositionOnCaretMove } from "./compositionEvents";
import { describe, expect, it } from "vitest";

function composing(
  markdown: string,
  at: { block: number; index: number },
  text: string,
  replaces = 0,
): EditorState {
  let state = createInitialState(loadPage(markdown));
  state = moveCursorToPosition(state, at.block, at.index);
  state = { ...state, view: { ...state.view, isFocused: true } };
  state = state.actionBus.dispatchState(COMPOSITION_START, state, {
    data: "",
    replaces,
  }).state;
  return state.actionBus.dispatchState(COMPOSITION_UPDATE, state, {
    data: text,
  }).state;
}

function texts(state: EditorState) {
  return (
    state.document.page.blocks
      .filter((b) => !b.deleted)
      .map((b) => getBlockTextContent(b))
      // Markdown's blank line between paragraphs loads as an empty block.
      .filter((t) => t !== "")
  );
}

describe("commitCompositionOnCaretMove", () => {
  it("commits the word where it was typed when the caret moves to another line", () => {
    const before = composing("first \n\nsecond", { block: 0, index: 6 }, "hey");
    const after = moveCursorToPosition(before, 2, 3);

    const result = commitCompositionOnCaretMove(before, after)!;

    expect(texts(result.state)).toEqual(["first hey", "second"]);
    expect(result.state.ui.composition).toBeNull();
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 2,
      textIndex: 3,
    });
    expect(result.ops.length).toBeGreaterThan(0);
  });

  it("commits a CJK composition as shown, where it was typed", () => {
    // A Japanese IME mid-conversion: the preview is what gets committed, the
    // same as a native field does when the caret leaves the composition.
    const before = composing("日本\n\n東京", { block: 0, index: 2 }, "語です");
    const after = moveCursorToPosition(before, 2, 1);

    const result = commitCompositionOnCaretMove(before, after)!;

    expect(texts(result.state)).toEqual(["日本語です", "東京"]);
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 2,
      textIndex: 1,
    });
  });

  it("keeps a caret later in the same line on the same characters", () => {
    const before = composing("Hi there", { block: 0, index: 2 }, "ya");
    const after = moveCursorToPosition(before, 0, 8); // after "there"

    const result = commitCompositionOnCaretMove(before, after)!;

    expect(texts(result.state)).toEqual(["Hiya there"]);
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 10,
    });
  });

  it("ends an untouched reopened word without editing", () => {
    // The keyboard reopened "hello" (the word before the caret) and changed
    // nothing: a tap elsewhere has nothing to commit.
    const before = composing(
      "hello\n\nworld",
      { block: 0, index: 5 },
      "hello",
      5,
    );
    const after = moveCursorToPosition(before, 2, 0);

    const result = commitCompositionOnCaretMove(before, after)!;

    expect(result.ops).toEqual([]);
    expect(result.state.ui.composition).toBeNull();
    expect(texts(result.state)).toEqual(["hello", "world"]);
  });

  it("replaces a reopened word the keyboard changed", () => {
    const before = composing(
      "helo\n\nworld",
      { block: 0, index: 4 },
      "hello",
      4,
    );
    const after = moveCursorToPosition(before, 2, 0);

    const result = commitCompositionOnCaretMove(before, after)!;

    expect(texts(result.state)).toEqual(["hello", "world"]);
  });

  it("leaves the composition alone when the caret did not move", () => {
    const before = composing("Hi ", { block: 0, index: 3 }, "there");
    const after = { ...before, view: { ...before.view } };

    expect(commitCompositionOnCaretMove(before, after)).toBeNull();
  });
});
