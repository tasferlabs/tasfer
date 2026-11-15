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

// An apostrophe between two letters (or two digits) is inside the word, the
// Unicode word rule (UAX #29) that macOS text views, Chrome and Intl.Segmenter
// all follow on double-click: "L'été" is one word, not "L" + "été".
describe("selectWordAtPosition — apostrophes inside a word", () => {
  function selected(content: string, textIndex: number) {
    const page = loadPage(content);
    const text = getBlockTextContent(page.blocks[0]);
    const sel = selectWordAtPosition(createInitialState(page), {
      blockIndex: 0,
      textIndex,
    }).document.selection;
    return sel ? text.slice(sel.anchor.textIndex, sel.focus.textIndex) : null;
  }

  it.each([
    ["Français : L'été, où es-tu ?", "L'été"],
    ["Français : L’été, où es-tu ?", "L’été"],
    ["c'est aujourd'hui", "aujourd'hui"],
    ["c'est aujourd’hui", "aujourd’hui"],
    ["İstanbul'da kaldım", "İstanbul'da"],
    ["İstanbul’da kaldım", "İstanbul’da"],
    ["I don't know", "don't"],
    ["I don’t know", "don’t"],
    ["in the '90s, 3'4", "3'4"],
  ])("%s selects %s whole from every index inside it", (content, word) => {
    const start = content.indexOf(word);
    for (let i = start; i < start + word.length; i++) {
      expect(selected(content, i)).toBe(word);
    }
  });

  it("a decomposed accent before the apostrophe still joins", () => {
    // "é" typed as e + U+0301 (combining acute), then an apostrophe.
    const content = "lé'a b";
    expect(selected(content, 0)).toBe("lé'a");
  });

  it("quote marks at a word's edge stay outside it", () => {
    expect(selected("say 'hello' now", 6)).toBe("hello");
    expect(selected("rock 'n' roll", 6)).toBe("n");
    expect(selected("l'' x", 0)).toBe("l");
  });

  it("letter-apostrophe-digit and underscore-apostrophe stay split", () => {
    // Matches macOS and Intl.Segmenter: the rule needs the same kind on both sides.
    expect(selected("a'1", 0)).toBe("a");
    expect(selected("x_'y", 0)).toBe("x_");
  });

  it("word-wise backspace deletes L'été in one step", () => {
    const content = "Bonjour L'été";
    const page = loadPage(content);
    const base = createInitialState(page);
    const state = {
      ...base,
      document: {
        ...base.document,
        cursor: { position: { blockIndex: 0, textIndex: content.length } },
      },
    } as typeof base;
    const result = deleteWordBackward(state);
    expect(getBlockTextContent(result.state.document.page.blocks[0])).toBe(
      "Bonjour ",
    );
  });
});

// Korean puts spaces between words, so a Hangul word is one word, as on macOS
// and in Chrome. Chinese and Japanese, written without spaces, keep one
// character per word.
describe("selectWordAtPosition — Korean words stay whole", () => {
  function selected(content: string, textIndex: number) {
    const page = loadPage(content);
    const text = getBlockTextContent(page.blocks[0]);
    const sel = selectWordAtPosition(createInitialState(page), {
      blockIndex: 0,
      textIndex,
    }).document.selection;
    return sel ? text.slice(sel.anchor.textIndex, sel.focus.textIndex) : null;
  }

  it("a Hangul word selects whole from every index inside it", () => {
    const content = "안녕하세요 세계";
    for (let i = 0; i < 5; i++) expect(selected(content, i)).toBe("안녕하세요");
    expect(selected(content, 7)).toBe("세계");
  });

  it("Chinese still selects one character", () => {
    expect(selected("你好世界", 1)).toBe("好");
  });

  it("word-wise backspace deletes a Korean word in one step", () => {
    const content = "안녕하세요 세계";
    const page = loadPage(content);
    const base = createInitialState(page);
    const state = {
      ...base,
      document: {
        ...base.document,
        cursor: { position: { blockIndex: 0, textIndex: content.length } },
      },
    } as typeof base;
    const result = deleteWordBackward(state);
    expect(getBlockTextContent(result.state.document.page.blocks[0])).toBe(
      "안녕하세요 ",
    );
  });
});
