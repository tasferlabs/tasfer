/**
 * Astral characters (emoji) are two UTF-16 units in one character, and a
 * `CharRun` addresses one ID per unit. Every layer used to disagree about
 * that: an emoji key was dropped as if it were a named key, Backspace left a
 * lone surrogate behind, a line could break between the halves, and the
 * parser/clipboard minted one ID per code point — which made an emoji's
 * second unit share the next character's ID, so a delete hit both.
 */
import { createMathTestState, loadMathPage } from "./__testutils__/math";
import {
  isTextInputKey,
  nextCodePointEnd,
  prevCodePointStart,
} from "./code-points";
import { handleKeyDown } from "./events/keysEvents";
import { wrapText } from "./fonts";
import { getBlockTextContent } from "./node-shared";
import type { Char, CharRun } from "./serlization/loadPage";
import type { EditorState, ViewportState } from "./state-types";
import { iterateVisibleChars } from "./sync/char-runs";
import { describe, expect, it } from "vitest";

const GRIN = "😀";

const viewport: ViewportState = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 2_000,
};

/** Drive a fabricated state through the real key handler. */
function press(state: EditorState, key: string) {
  return handleKeyDown(state, viewport, {
    key,
    isTrusted: true,
    preventDefault() {},
  } as unknown as Event);
}

function stateWithCaret(content: string, textIndex: number): EditorState {
  const base = createMathTestState(loadMathPage(content));
  return {
    ...base,
    view: { ...base.view, isFocused: true },
    document: {
      ...base.document,
      cursor: { position: { blockIndex: 0, textIndex }, lastUpdate: 0 },
    },
  };
}

function textOf(state: EditorState) {
  return getBlockTextContent(state.document.page.blocks[0]);
}

function caretOf(state: EditorState) {
  return state.document.cursor?.position.textIndex;
}

describe("code-point stepping", () => {
  it("steps over a whole surrogate pair in both directions", () => {
    const text = `a${GRIN}b`;
    expect(prevCodePointStart(text, 3)).toBe(1);
    expect(nextCodePointEnd(text, 1)).toBe(3);
    // Plain characters still step by one.
    expect(prevCodePointStart(text, 1)).toBe(0);
    expect(nextCodePointEnd(text, 3)).toBe(4);
  });

  it("reads a single character as text and a named key as a key", () => {
    expect(isTextInputKey(GRIN)).toBe(true);
    expect(isTextInputKey("a")).toBe(true);
    expect(isTextInputKey("ArrowLeft")).toBe(false);
    expect(isTextInputKey("Enter")).toBe(false);
    expect(isTextInputKey("")).toBe(false);
  });
});

describe("character identity around an emoji", () => {
  const idsOf = (state: EditorState) => {
    const block = state.document.page.blocks[0] as { charRuns: CharRun[] };
    return [...iterateVisibleChars(block.charRuns)].map((c) => c.id);
  };

  it("gives every UTF-16 unit its own ID", () => {
    const ids = idsOf(createMathTestState(loadMathPage(`${GRIN}hi`)));
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("deletes only the emoji, not the character after it", () => {
    // The collision showed up here: the emoji's trailing unit and the "h"
    // resolved to the same ID, so deleting the emoji took "h" with it.
    const state = press(stateWithCaret(`${GRIN}hi`, 0), "Delete").state;
    expect(textOf(state)).toBe("hi");
  });
});

describe("editing around an emoji", () => {
  it("types one", () => {
    const state = press(stateWithCaret("hi", 2), GRIN).state;
    expect(textOf(state)).toBe(`hi${GRIN}`);
  });

  it("deletes it whole on Backspace, leaving no half character", () => {
    const state = press(stateWithCaret(`hi${GRIN}`, 4), "Backspace").state;
    expect(textOf(state)).toBe("hi");
  });

  it("moves the caret past it, never into it", () => {
    expect(
      caretOf(press(stateWithCaret(`hi${GRIN}`, 4), "ArrowLeft").state),
    ).toBe(2);
    expect(
      caretOf(press(stateWithCaret(`hi${GRIN}`, 2), "ArrowRight").state),
    ).toBe(4);
  });
});

describe("wrapping around an emoji", () => {
  // The measurement stub reports a fixed width per call, so a 2.5-char budget
  // packs two chars per line — enough to prove the pair is never split.
  // One Char per UTF-16 unit, exactly as a CharRun stores them.
  const chars = (text: string): Char[] =>
    Array.from({ length: text.length }, (_, i) => ({
      id: `init:${i}`,
      char: text[i],
      deleted: false,
    })) as Char[];

  const fonts = {
    defaultFamily: "sans",
    families: { sans: "sans-serif" },
  } as never;

  it("keeps both halves of a pair on the same line", () => {
    const lines = wrapText(
      chars(`a${GRIN}bc`),
      [],
      12,
      16,
      "normal",
      "sans" as never,
      fonts,
    );
    for (const line of lines) {
      expect([...line.text].some((u) => u === "\ud83d")).toBe(false);
    }
    expect(lines.map((l) => l.text).join("")).toBe(`a${GRIN}bc`);
  });
});
