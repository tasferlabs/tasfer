import { getBlockTextContent } from "../node-shared";
import { loadPage } from "../serlization/loadPage";
import { createInitialState } from "../state-utils";
import { deleteWordBackward, selectWordAtPosition } from "./actions";
import { describe, expect, it } from "vitest";

// Double-click / double-tap word selection for scripts whose words legitimately
// contain non-letter code points: Arabic harakāt (combining marks, \p{M}) and
// Persian/Arabic zero-width joiners (ZWNJ/ZWJ). Before `isWordChar` included
// marks and joiners, the boundary walk stopped at the first such code point and
// the selection was a mid-word fragment.
describe("selectWordAtPosition — RTL words stay whole", () => {
  function fullWord(content: string, interiorIndex: number) {
    const page = loadPage(content);
    const text = getBlockTextContent(page.blocks[0]);
    const state = createInitialState(page);
    const sel = selectWordAtPosition(state, {
      blockIndex: 0,
      textIndex: interiorIndex,
    }).document.selection;
    return { text, sel };
  }

  it("bare Arabic word selects wholly from any interior index", () => {
    const word = "مرحبا";
    const len = word.length;
    for (let i = 0; i < len; i++) {
      const { sel } = fullWord(word, i);
      expect(sel?.anchor.textIndex).toBe(0);
      expect(sel?.focus.textIndex).toBe(len);
    }
  });

  it("vocalized Arabic word (with harakāt) selects wholly, marks included", () => {
    // م+fatha, ر, ح+fatha, ب, ا+tanwīn — letters interleaved with \p{M} marks.
    const word = "مَرحَبًا";
    const { text, sel } = fullWord(word, 3);
    expect(sel?.anchor.textIndex).toBe(0);
    expect(sel?.focus.textIndex).toBe(text.length);
    // Clicking directly on a diacritic still selects the whole word.
    const onMark = fullWord(word, 1);
    expect(onMark.sel?.anchor.textIndex).toBe(0);
    expect(onMark.sel?.focus.textIndex).toBe(text.length);
  });

  it("Persian word joined by a ZWNJ selects across the joiner", () => {
    const word = "می‌روم"; // mī-ravam, ZWNJ (U+200C) between the two parts
    const { text, sel } = fullWord(word, word.length - 1);
    expect(sel?.anchor.textIndex).toBe(0);
    expect(sel?.focus.textIndex).toBe(text.length);
  });

  it("Arabic word adjacent to inline math selects only the word", () => {
    // Matches the reported case: an Arabic word immediately before inline math.
    const page = loadPage("مرحبا $\\int a == a$");
    const state = createInitialState(page);
    const sel = selectWordAtPosition(state, { blockIndex: 0, textIndex: 2 })
      .document.selection;
    expect(sel?.anchor.textIndex).toBe(0);
    expect(sel?.focus.textIndex).toBe(5); // stops at the space before the math
  });

  it("word-wise backspace deletes a vocalized Arabic word in one step", () => {
    const word = "مَرحَبًا";
    const page = loadPage(word);
    const base = createInitialState(page);
    const state = {
      ...base,
      document: {
        ...base.document,
        cursor: { position: { blockIndex: 0, textIndex: word.length } },
      },
    } as typeof base;
    const result = deleteWordBackward(state);
    expect(getBlockTextContent(result.state.document.page.blocks[0])).toBe("");
  });
});
