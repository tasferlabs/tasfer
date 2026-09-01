/**
 * Which Ctrl/Cmd chords the input surface may swallow.
 *
 * The keydown handler used to carry its own hardcoded list of "editor
 * shortcuts", so a chord the keymap never acted on was still eaten, and a
 * chord the keymap did act on could be missing. `builtInKeymapClaims` is the
 * keymap's own answer; these pin what it claims, what it lets through to the
 * host, and that a schema without a mark frees that mark's chord.
 */

import { baseSchema } from "../schema";
import type { Block, Page } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { builtInKeymapClaims } from "./keysEvents";
import { afterEach, describe, expect, it, vi } from "vitest";

function usePlatform(platform: "MacIntel" | "Win32"): void {
  vi.stubGlobal("navigator", { platform, userAgent: platform });
}

const page: Page = {
  id: "page-1",
  title: "t",
  blocks: [
    {
      id: "p-1",
      orderKey: "a0",
      deleted: false,
      type: "paragraph",
      charRuns: [{ peerId: "peer", startCounter: 0, text: "hello" }],
      formats: [],
    } as unknown as Block,
  ],
};

function full(): EditorState {
  return createInitialState(page, { schema: baseSchema.data });
}

/** A title field: headings only, no inline marks at all. */
function plain(): EditorState {
  return createInitialState(page, {
    schema: baseSchema.restrict({ blocks: ["heading1"], marks: [] }).data,
  });
}

type Mods = Partial<
  Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>
>;

function chord(code: string, mods: Mods = {}) {
  return {
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

describe("builtInKeymapClaims", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("claims the chords the keymap acts on", () => {
    usePlatform("Win32");
    const state = full();
    for (const code of ["KeyZ", "KeyY", "KeyA", "KeyB", "KeyI", "KeyE"]) {
      expect(builtInKeymapClaims(state, chord(code, { ctrlKey: true }))).toBe(
        true,
      );
    }
    expect(
      builtInKeymapClaims(
        state,
        chord("KeyX", { ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    expect(
      builtInKeymapClaims(
        state,
        chord("KeyZ", { ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
  });

  it("lets every other chord through to the host", () => {
    usePlatform("Win32");
    const state = full();
    for (const code of ["KeyS", "KeyK", "KeyF", "Period", "Backslash"]) {
      expect(builtInKeymapClaims(state, chord(code, { ctrlKey: true }))).toBe(
        false,
      );
    }
    // Plain cut and copy must reach the browser's native clipboard events.
    expect(builtInKeymapClaims(state, chord("KeyX", { ctrlKey: true }))).toBe(
      false,
    );
    expect(builtInKeymapClaims(state, chord("KeyC", { ctrlKey: true }))).toBe(
      false,
    );
    // A shifted toggle is not the toggle.
    expect(
      builtInKeymapClaims(
        state,
        chord("KeyB", { ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });

  it("never claims a chord with Alt down — AltGr types a character", () => {
    usePlatform("Win32");
    expect(
      builtInKeymapClaims(
        full(),
        chord("KeyB", { ctrlKey: true, altKey: true }),
      ),
    ).toBe(false);
  });

  it("frees a mark's chord when the schema has no such mark", () => {
    usePlatform("Win32");
    const state = plain();
    expect(builtInKeymapClaims(state, chord("KeyB", { ctrlKey: true }))).toBe(
      false,
    );
    expect(builtInKeymapClaims(state, chord("KeyI", { ctrlKey: true }))).toBe(
      false,
    );
    // Undo is not a mark: still the editor's.
    expect(builtInKeymapClaims(state, chord("KeyZ", { ctrlKey: true }))).toBe(
      true,
    );
  });

  it("reads ⌘ as the command key on macOS and bare ⌃ as the emacs set", () => {
    usePlatform("MacIntel");
    const state = full();
    expect(builtInKeymapClaims(state, chord("KeyB", { metaKey: true }))).toBe(
      true,
    );
    expect(builtInKeymapClaims(state, chord("KeyB", { ctrlKey: true }))).toBe(
      true,
    );
    expect(builtInKeymapClaims(state, chord("KeyK", { ctrlKey: true }))).toBe(
      true,
    );
    // ⌘K is the host's; ⌃K with ⌘ down is neither.
    expect(builtInKeymapClaims(state, chord("KeyK", { metaKey: true }))).toBe(
      false,
    );
    expect(
      builtInKeymapClaims(
        state,
        chord("KeyK", { ctrlKey: true, metaKey: true }),
      ),
    ).toBe(false);
  });

  it("treats Ctrl as a host modifier on Windows, emacs codes included", () => {
    usePlatform("Win32");
    expect(builtInKeymapClaims(full(), chord("KeyK", { ctrlKey: true }))).toBe(
      false,
    );
  });
});
