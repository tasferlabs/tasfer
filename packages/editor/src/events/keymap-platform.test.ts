/**
 * Which physical modifier means what, per OS.
 *
 * The key handler used to collapse ⌘ and Ctrl into one `ctrlKey || metaKey`
 * flag and never read ⌥ at all, so macOS was served Windows semantics: ⌘←
 * jumped a word instead of going to the line start, ⌥← moved a single
 * character, and ⌘⌫ deleted a word instead of clearing to the line start.
 *
 * These assertions pin the modifier→granularity mapping on both platforms.
 * Every case must stub `navigator` — Node reports a Mac `navigator.platform`,
 * so an unpinned case silently tests whichever machine runs it.
 */

import { baseSchema } from "../schema";
import type { Block, Page } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { handleKeyDown } from "./keysEvents";
import { afterEach, describe, expect, it, vi } from "vitest";

const viewport: ViewportState = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 2000,
};

type Mods = Partial<
  Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>
>;

function usePlatform(platform: "MacIntel" | "Win32"): void {
  vi.stubGlobal("navigator", { platform, userAgent: platform });
}

function page(...texts: string[]): Page {
  return {
    id: "page-1",
    title: "t",
    blocks: texts.map(
      (text, i) =>
        ({
          id: `p-${i + 1}`,
          orderKey: `a${i}`,
          deleted: false,
          type: "paragraph",
          // Each block starts its own counter range so two blocks of the same
          // peer never mint the same character id.
          charRuns: [{ peerId: "peer", startCounter: i * 1000, text }],
          formats: [],
        }) as unknown as Block,
    ),
  };
}

function focusedAt(
  source: Page,
  blockIndex: number,
  textIndex: number,
): EditorState {
  const base = createInitialState(source, { schema: baseSchema.data });
  return {
    ...base,
    view: { ...base.view, isFocused: true },
    document: {
      ...base.document,
      cursor: { position: { blockIndex, textIndex }, lastUpdate: 0 },
    },
  };
}

/** "hello world here" with the caret parked between "world" and " here". */
function stateAt(textIndex: number, text = "hello world here"): EditorState {
  return focusedAt(page(text), 0, textIndex);
}

/** Two paragraphs — "one" then "two" — with the caret parked in one of them. */
function statePair(blockIndex: number, textIndex: number): EditorState {
  return focusedAt(page("one", "two"), blockIndex, textIndex);
}

/** A paragraph, then a bullet item indented one rung under it. */
function pageWithIndentedItem(): Page {
  const source = page("one", "item");
  source.blocks[1] = {
    ...source.blocks[1],
    type: "bullet_list",
    indent: 1,
  } as unknown as Block;
  return source;
}

function press(state: EditorState, key: string, mods: Mods = {}) {
  return handleKeyDown(state, viewport, {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isTrusted: true,
    preventDefault() {},
    stopPropagation() {},
    ...mods,
  } as unknown as Event);
}

function caretOf(state: EditorState): number | undefined {
  return state.document.cursor?.position.textIndex;
}

function textOf(state: EditorState): string {
  return getVisibleTextFromRuns(
    (state.document.page.blocks[0] as { charRuns?: [] }).charRuns,
  );
}

function blockTextsOf(state: EditorState): string[] {
  return state.document.page.blocks
    .filter((b) => !b.deleted)
    .map((b) => getVisibleTextFromRuns((b as { charRuns?: [] }).charRuns));
}

describe("modifier conventions per platform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("macOS", () => {
    it("Cmd+Left/Right go to the line edges", () => {
      usePlatform("MacIntel");
      expect(
        caretOf(press(stateAt(11), "ArrowLeft", { metaKey: true }).state),
      ).toBe(0);
      expect(
        caretOf(press(stateAt(11), "ArrowRight", { metaKey: true }).state),
      ).toBe(16);
    });

    it("Option+Left/Right move by word", () => {
      usePlatform("MacIntel");
      // From "hello world| here": left to the start of "world", right across
      // the space to the start of "here".
      expect(
        caretOf(press(stateAt(11), "ArrowLeft", { altKey: true }).state),
      ).toBe(6);
      expect(
        caretOf(press(stateAt(11), "ArrowRight", { altKey: true }).state),
      ).toBe(12);
    });

    it("Cmd+Up/Down go to the document edges", () => {
      usePlatform("MacIntel");
      expect(
        caretOf(press(stateAt(11), "ArrowUp", { metaKey: true }).state),
      ).toBe(0);
      expect(
        caretOf(press(stateAt(11), "ArrowDown", { metaKey: true }).state),
      ).toBe(16);
    });

    it("Option+Backspace deletes a word, Cmd+Backspace clears to the line start", () => {
      usePlatform("MacIntel");
      expect(
        textOf(press(stateAt(11), "Backspace", { altKey: true }).state),
      ).toBe("hello  here");
      expect(
        textOf(press(stateAt(11), "Backspace", { metaKey: true }).state),
      ).toBe(" here");
    });

    it("Cmd+Delete clears to the line end", () => {
      usePlatform("MacIntel");
      expect(
        textOf(press(stateAt(11), "Delete", { metaKey: true }).state),
      ).toBe("hello world");
    });

    // On the edge there is no run to clear, and a delete key that deletes
    // nothing reads as broken. Both fall back to the plain delete, so they join
    // the neighbouring paragraph exactly as ⌫ / ⌦ would.
    it("Cmd+Backspace at the line start joins the paragraph above", () => {
      usePlatform("MacIntel");
      const after = press(statePair(1, 0), "Backspace", {
        metaKey: true,
      }).state;
      expect(blockTextsOf(after)).toEqual(["onetwo"]);
      expect(caretOf(after)).toBe(3);
    });

    it("Cmd+Delete at the line end pulls the paragraph below up", () => {
      usePlatform("MacIntel");
      const after = press(statePair(0, 3), "Delete", { metaKey: true }).state;
      expect(blockTextsOf(after)).toEqual(["onetwo"]);
      expect(caretOf(after)).toBe(3);
    });

    // The word deletes reach the same edge, and used to join there through a
    // merge of their own that a list item, a quote or a code neighbour all
    // refused — the key simply died. They now hand the edge to the plain delete
    // too, so ⌥⌫ outdents an item exactly as ⌫ does.
    it("Option+Backspace at a list item's start outdents it, like Backspace", () => {
      usePlatform("MacIntel");
      const after = press(
        focusedAt(pageWithIndentedItem(), 1, 0),
        "Backspace",
        {
          altKey: true,
        },
      ).state;
      expect(
        (after.document.page.blocks[1] as { indent?: number }).indent,
      ).toBe(0);
      expect(blockTextsOf(after)).toEqual(["one", "item"]);
    });

    it("Ctrl+K at the line end kills the break, as Cocoa does", () => {
      usePlatform("MacIntel");
      const after = press(statePair(0, 3), "k", { ctrlKey: true }).state;
      expect(blockTextsOf(after)).toEqual(["onetwo"]);
    });

    it("answers the Cocoa emacs bindings", () => {
      usePlatform("MacIntel");
      expect(caretOf(press(stateAt(11), "a", { ctrlKey: true }).state)).toBe(0);
      expect(caretOf(press(stateAt(11), "e", { ctrlKey: true }).state)).toBe(
        16,
      );
      expect(caretOf(press(stateAt(11), "b", { ctrlKey: true }).state)).toBe(
        10,
      );
      expect(caretOf(press(stateAt(11), "f", { ctrlKey: true }).state)).toBe(
        12,
      );
      // ⌃K kills to the line end; ⌃A is the line start, NOT select-all.
      expect(textOf(press(stateAt(11), "k", { ctrlKey: true }).state)).toBe(
        "hello world",
      );
      expect(
        press(stateAt(11), "a", { ctrlKey: true }).state.document.selection,
      ).toBeFalsy();
    });

    it("leaves Ctrl+Arrow to the OS rather than moving by word", () => {
      usePlatform("MacIntel");
      // ⌃← is Mission Control, not a word jump — the caret steps one character.
      expect(
        caretOf(press(stateAt(11), "ArrowLeft", { ctrlKey: true }).state),
      ).toBe(10);
    });
  });

  describe("Windows / Linux", () => {
    it("Ctrl+Left/Right move by word", () => {
      usePlatform("Win32");
      expect(
        caretOf(press(stateAt(11), "ArrowLeft", { ctrlKey: true }).state),
      ).toBe(6);
      expect(
        caretOf(press(stateAt(11), "ArrowRight", { ctrlKey: true }).state),
      ).toBe(12);
    });

    it("Ctrl+Backspace deletes a word", () => {
      usePlatform("Win32");
      expect(
        textOf(press(stateAt(11), "Backspace", { ctrlKey: true }).state),
      ).toBe("hello  here");
    });

    it("has no line-edge chord — Alt+Arrow is not a word move", () => {
      usePlatform("Win32");
      expect(
        caretOf(press(stateAt(11), "ArrowLeft", { altKey: true }).state),
      ).toBe(10);
      expect(
        caretOf(press(stateAt(11), "ArrowLeft", { metaKey: true }).state),
      ).toBe(10);
    });

    it("does not answer the macOS emacs bindings", () => {
      usePlatform("Win32");
      // Ctrl+A stays Select All off Apple platforms.
      expect(
        press(stateAt(11), "a", { ctrlKey: true }).state.document.selection,
      ).toBeTruthy();
    });
  });
});
