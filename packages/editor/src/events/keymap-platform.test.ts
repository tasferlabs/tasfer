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

function paragraph(text: string): Page {
  return {
    id: "page-1",
    title: "t",
    blocks: [
      {
        id: "p-1",
        orderKey: "a0",
        deleted: false,
        type: "paragraph",
        charRuns: [{ peerId: "peer", startCounter: 0, text }],
        formats: [],
      } as unknown as Block,
    ],
  };
}

/** "hello world here" with the caret parked between "world" and " here". */
function stateAt(textIndex: number, text = "hello world here"): EditorState {
  const base = createInitialState(paragraph(text), { schema: baseSchema.data });
  return {
    ...base,
    view: { ...base.view, isFocused: true },
    document: {
      ...base.document,
      cursor: { position: { blockIndex: 0, textIndex }, lastUpdate: 0 },
    },
  };
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
