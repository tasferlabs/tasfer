import { getBlockTextContent } from "../node-shared";
import { loadPage } from "../serlization/loadPage";
import { createInitialState } from "../state-utils";
import {
  emojiSpanAt,
  findWordBoundary,
  findWordDeleteBoundaryLeft,
  findWordDeleteBoundaryRight,
} from "../word-chars";
import {
  deleteWordBackward,
  moveToNextWord,
  moveToPreviousWord,
  selectWordAtPosition,
} from "./actions";
import { describe, expect, it } from "vitest";

function selected(content: string, textIndex: number): string | null {
  const page = loadPage(content);
  const text = getBlockTextContent(page.blocks[0]);
  const sel = selectWordAtPosition(createInitialState(page), {
    blockIndex: 0,
    textIndex,
  }).document.selection;
  return sel ? text.slice(sel.anchor.textIndex, sel.focus.textIndex) : null;
}

function withCaret(content: string, textIndex: number) {
  const base = createInitialState(loadPage(content));
  return {
    ...base,
    document: {
      ...base.document,
      cursor: { position: { blockIndex: 0, textIndex } },
    },
  } as typeof base;
}

// Each row: text, the character double-clicked, what macOS selects there
// (`NSAttributedString.doubleClick(at:)`, the rule TextEdit, Notes and Mail
// use). `Intl.Segmenter` words agree on every row.
describe("double-click on an emoji selects the emoji, as on macOS", () => {
  it.each([
    ["a 👋 b", 2, "👋"],
    ["a 👋 b", 3, "👋"],
    ["👋🌍", 0, "👋"],
    ["👋🌍", 2, "🌍"],
    ["hello👋", 0, "hello"],
    ["hello👋", 5, "👋"],
    ["hello👋 x", 6, "👋"],
    ["مرحبا👋", 0, "مرحبا"],
    ["مرحبا👋", 5, "👋"],
    ["hi👋there", 0, "hi"],
    ["👋hi", 0, "👋"],
    ["👋hi", 2, "hi"],
    ["a 👨‍👩‍👧‍👦 b", 2, "👨‍👩‍👧‍👦"],
    ["a 👨‍👩‍👧‍👦 b", 5, "👨‍👩‍👧‍👦"],
    ["a 👨‍👩‍👧‍👦 b", 9, "👨‍👩‍👧‍👦"],
    ["a 👩🏽‍💻 b", 2, "👩🏽‍💻"],
    ["a 👩🏽‍💻 b", 6, "👩🏽‍💻"],
    ["a 🇸🇦 b", 2, "🇸🇦"],
    ["a 🇸🇦 b", 4, "🇸🇦"],
    ["🇸🇦🇫🇷", 0, "🇸🇦"],
    ["🇸🇦🇫🇷", 4, "🇫🇷"],
    ["a 1️⃣ b", 2, "1️⃣"],
    ["a 1️⃣ b", 3, "1️⃣"],
    ["a 1️⃣2️⃣ b", 2, "1️⃣2️⃣"],
    ["a #️⃣ b", 3, "#️⃣"],
    ["a ❤️ b", 2, "❤️"],
    ["a ❤️ b", 3, "❤️"],
    ["a ❤ b", 2, "❤"],
    ["a 🫠 b", 2, "🫠"],
    ["a 🫠🫠 b", 2, "🫠"],
    ["x👍🏽y", 3, "👍🏽"],
  ])("%s at %i selects %s", (content, index, expected) => {
    expect(selected(content, index)).toBe(expected);
  });

  it("a click just past an emoji takes the emoji", () => {
    // The caret lands after the emoji: on the space after it, or at the end.
    expect(selected("a 👋 b", 4)).toBe("👋");
    expect(selected("hello 👨‍👩‍👧‍👦", "hello 👨‍👩‍👧‍👦".length)).toBe("👨‍👩‍👧‍👦");
    expect(selected("你 b", 1)).toBe("你");
  });
});

describe("double-click on a number keeps its dot or comma, as on macOS", () => {
  it.each([
    ["x 3.14 y", 2, "3.14"],
    ["x 3.14 y", 5, "3.14"],
    ["x 1,000 y", 2, "1,000"],
    ["x ١٢٫٥ y", 2, "١٢٫٥"],
    ["x ١٢٫٥ y", 5, "١٢٫٥"],
    ["x ١٬٠٠٠ y", 3, "١٬٠٠٠"],
    ["x 3.14. y", 2, "3.14"],
    ["x 3. y", 2, "3"],
    ["x 1,a y", 2, "1"],
  ])("%s at %i selects %s", (content, index, expected) => {
    expect(selected(content, index)).toBe(expected);
  });
});

describe("emoji clusters stay whole for word moves and deletes", () => {
  const family = "👨‍👩‍👧‍👦";

  it("finds the whole cluster from any index inside it", () => {
    const text = `a ${family} b`;
    for (let i = 2; i < 2 + family.length; i++) {
      expect(emojiSpanAt(text, i)).toEqual({
        start: 2,
        end: 2 + family.length,
      });
    }
    expect(emojiSpanAt(text, 0)).toBeNull();
    expect(emojiSpanAt("a 1️⃣ b", 2)).toBeNull(); // belongs to its number
  });

  it("⌥⌫ deletes a whole ZWJ family, ❤️ with its selector, a flag", () => {
    for (const emoji of [family, "❤️", "🇸🇦", "👩🏽‍💻", "🫠"]) {
      const content = `hi ${emoji}`;
      const result = deleteWordBackward(withCaret(content, content.length));
      expect(getBlockTextContent(result.state.document.page.blocks[0])).toBe(
        "hi ",
      );
    }
  });

  it("⌥⌫ after a word glued to an emoji takes the emoji first", () => {
    const content = "hello👋";
    const once = deleteWordBackward(withCaret(content, content.length));
    expect(getBlockTextContent(once.state.document.page.blocks[0])).toBe(
      "hello",
    );
  });

  it("word delete boundaries never land inside an emoji", () => {
    const text = `${family}${family}`;
    expect(findWordDeleteBoundaryLeft(text, text.length)).toBe(family.length);
    expect(findWordDeleteBoundaryRight(text, 0)).toBe(family.length);
  });

  it("⌥←/⌥→ step over an emoji in one press", () => {
    const text = `hello${family} x`;
    expect(findWordBoundary(text, 5, "right")).toBe(5 + family.length);
    expect(findWordBoundary(text, 5 + family.length, "left")).toBe(5);
    expect(findWordBoundary(text, 5, "left")).toBe(0);

    const content = `ab ${family}`;
    const end = content.length;
    const back = moveToPreviousWord(withCaret(content, end));
    expect(back.document.cursor?.position.textIndex).toBe(3);
    const forward = moveToNextWord(withCaret(content, 3));
    expect(forward.document.cursor?.position.textIndex).toBe(end);
  });

  it("⌥⌫ deletes a number with its dot in one press", () => {
    const content = "pi 3.14";
    const result = deleteWordBackward(withCaret(content, content.length));
    expect(getBlockTextContent(result.state.document.page.blocks[0])).toBe(
      "pi ",
    );
  });
});
