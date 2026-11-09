/**
 * Committing a recomposition — a keyboard (HeliBoard) that reopened the word
 * before the caret — replaces only the characters that changed. The ones the
 * old and new word share keep their formatting and their CRDT ids, so marks,
 * comments and remote carets on them survive, and an unchanged commit edits
 * nothing.
 */
import "../entries/editor";
import { sharedEnds } from "../composition";
import { commitCompositionOnCaretMove } from "../events/compositionEvents";
import { resolveMarkRunsFromChars } from "../mark-runs";
import { getBlockTextContent } from "../node-shared";
import { getContentWithComposition } from "../nodes/TextNode";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { isTextualBlock } from "../sync/block-registry";
import { iterateVisibleChars } from "../sync/char-runs";
import {
  COMPOSITION_END,
  COMPOSITION_START,
  COMPOSITION_UPDATE,
} from "./input-actions";
import { describe, expect, it } from "vitest";

function reopened(
  markdown: string,
  at: number,
  replaces: number,
  text: string,
): EditorState {
  let state = createInitialState(loadPage(markdown));
  state = moveCursorToPosition(state, 0, at);
  state = { ...state, view: { ...state.view, isFocused: true } };
  state = state.actionBus.dispatchState(COMPOSITION_START, state, {
    data: "",
    replaces,
  }).state;
  return state.actionBus.dispatchState(COMPOSITION_UPDATE, state, {
    data: text,
  }).state;
}

function commit(state: EditorState, data: string) {
  return state.actionBus.dispatchState(COMPOSITION_END, state, { data });
}

function charIds(state: EditorState, block = 0) {
  const b = state.document.page.blocks[block];
  return isTextualBlock(b)
    ? [...iterateVisibleChars(b.charRuns)].map((c) => c.id)
    : [];
}

function boldText(state: EditorState, block = 0) {
  const b = state.document.page.blocks[block];
  if (!isTextualBlock(b)) return [];
  return resolveMarkRunsFromChars(
    [...iterateVisibleChars(b.charRuns)].map((c) => ({ ...c })),
    b.formats,
  )
    .filter((run) => run.name === "strong")
    .map((run) => run.text);
}

describe("recomposition commit", () => {
  it("emits nothing when the reopened word is committed unchanged", () => {
    const state = reopened("he**llo**", 5, 5, "hello");
    const ids = charIds(state);

    const result = commit(state, "hello");

    expect(result.ops).toEqual([]);
    expect(getBlockTextContent(result.state.document.page.blocks[0])).toBe(
      "hello",
    );
    expect(charIds(result.state)).toEqual(ids);
    expect(boldText(result.state)).toEqual(["llo"]);
    expect(result.state.ui.composition).toBeNull();
  });

  it("keeps the shared start and end of a corrected word, and their marks", () => {
    // "helo" → "hello": only an "l" is added; "o" keeps its bold and its id.
    const state = reopened("hel**o** world", 4, 4, "hello");
    const [h, e, l, o] = charIds(state);

    const result = commit(state, "hello");

    expect(getBlockTextContent(result.state.document.page.blocks[0])).toBe(
      "hello world",
    );
    const after = charIds(result.state);
    expect(after.slice(0, 3)).toEqual([h, e, l]);
    expect(after[4]).toBe(o);
    expect(boldText(result.state)).toEqual(["o"]);
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 5,
    });
  });

  it("puts the caret after the whole word when the end was kept", () => {
    // "teh" → "the": the "t" is kept, "eh" becomes "he".
    const state = reopened("teh cat", 3, 3, "the");

    const result = commit(state, "the");

    expect(getBlockTextContent(result.state.document.page.blocks[0])).toBe(
      "the cat",
    );
    expect(result.state.document.cursor?.position.textIndex).toBe(3);
  });

  it("an empty commit still deletes the reopened word", () => {
    const state = reopened("one two", 7, 3, "");

    const result = commit(state, "");

    expect(getBlockTextContent(result.state.document.page.blocks[0])).toBe(
      "one ",
    );
    expect(result.state.document.selection?.isCollapsed ?? true).toBe(true);
  });

  it("a tap inside the word stays there when its character was replaced", () => {
    // "helo more" → "help": the tap after "hel" is anchored to "l" (kept);
    // a tap after "helo"'s "o" is anchored to the replaced "o".
    const before = reopened("helo more", 4, 4, "help");
    const tapped = moveCursorToPosition(before, 0, 3);
    const kept = commitCompositionOnCaretMove(before, tapped)!;
    expect(getBlockTextContent(kept.state.document.page.blocks[0])).toBe(
      "help more",
    );
    expect(kept.state.document.cursor?.position.textIndex).toBe(3);

    const shrinking = reopened("hello more", 5, 5, "hi");
    const inside = moveCursorToPosition(shrinking, 0, 4); // after "hell"
    const moved = commitCompositionOnCaretMove(shrinking, inside)!;
    expect(getBlockTextContent(moved.state.document.page.blocks[0])).toBe(
      "hi more",
    );
    // Clamped to the end of the new word, not the end of the paragraph.
    expect(moved.state.document.cursor?.position.textIndex).toBe(2);
  });
});

describe("recomposition preview", () => {
  it("draws a reopened bold word bold while it is being changed", () => {
    // The bold span starts at the reopened word's first character; "hello" →
    // "jello" swaps that very character.
    const state = reopened("**hello** there", 5, 5, "jello");
    const block = state.document.page.blocks[0];

    const { chars, formats, compositionRange } = getContentWithComposition(
      block,
      state,
      0,
    );
    const bold = resolveMarkRunsFromChars(chars, formats).filter(
      (run) => run.name === "strong",
    );

    // Split around the preview, so two runs; together they cover the word.
    const covered = bold
      .sort((a, b) => a.startIndex - b.startIndex)
      .map((run) => run.text)
      .join("");
    expect(covered).toBe("jello");
    expect(compositionRange).toEqual({ start: 0, end: 5 });
  });

  it("keeps a partly formatted word's formatting where it is unchanged", () => {
    const state = reopened("he**llo**", 5, 5, "hello");
    const block = state.document.page.blocks[0];

    const { chars, formats } = getContentWithComposition(block, state, 0);
    const bold = resolveMarkRunsFromChars(chars, formats).filter(
      (run) => run.name === "strong",
    );

    expect(bold.map((run) => run.text)).toEqual(["llo"]);
  });
});

describe("sharedEnds", () => {
  it("splits around the changed middle", () => {
    expect(sharedEnds("helo", "hello")).toEqual({ prefix: 3, suffix: 1 });
    expect(sharedEnds("hello", "hello")).toEqual({ prefix: 5, suffix: 0 });
    expect(sharedEnds("teh", "the")).toEqual({ prefix: 1, suffix: 0 });
  });

  it("never splits a surrogate pair", () => {
    // 😀 (D83D DE00) and 😃 (D83D DE03) share their high surrogate only.
    expect(sharedEnds("a😀", "a😃")).toEqual({ prefix: 1, suffix: 0 });
    // 😀 and 🙀 (D83D DE40) share no whole character; only "b" is shared.
    expect(sharedEnds("😀b", "🙀b")).toEqual({ prefix: 0, suffix: 1 });
  });
});
