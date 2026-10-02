/**
 * The chord syntax and the rebindable keymap.
 *
 * Every case stubs `navigator`: Node reports a Mac `navigator.platform`, so an
 * unpinned case would silently test whichever machine runs it.
 */

import { builtInKeymapClaims, keymapCommandIn } from "./events/keysEvents";
import {
  defaultKeymap,
  keymapCommandFor,
  matchesShortcut,
  normalizeShortcut,
  type ShortcutEvent,
  shortcutFromEvent,
} from "./keymap";
import { baseSchema } from "./schema";
import type { Block, Page } from "./serlization/loadPage";
import { createInitialState } from "./state-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

function usePlatform(platform: "MacIntel" | "Win32"): void {
  vi.stubGlobal("navigator", { platform, userAgent: platform });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function key(
  code: string,
  key: string,
  mods: Partial<
    Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>
  > = {},
): ShortcutEvent & { key: string } {
  return {
    code,
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
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

describe("matchesShortcut", () => {
  it("reads mod as ⌘ on Apple and Ctrl elsewhere, exclusively", () => {
    expect(
      matchesShortcut(key("KeyB", "b", { metaKey: true }), "mod+b", true),
    ).toBe(true);
    expect(
      matchesShortcut(key("KeyB", "b", { ctrlKey: true }), "mod+b", true),
    ).toBe(false);
    expect(
      matchesShortcut(key("KeyB", "b", { ctrlKey: true }), "mod+b", false),
    ).toBe(true);
    expect(
      matchesShortcut(
        key("KeyB", "b", { ctrlKey: true, metaKey: true }),
        "mod+b",
        false,
      ),
    ).toBe(false);
  });

  it("needs exactly the listed modifiers", () => {
    const shifted = key("KeyB", "B", { metaKey: true, shiftKey: true });
    expect(matchesShortcut(shifted, "mod+b", true)).toBe(false);
    expect(matchesShortcut(shifted, "mod+shift+b", true)).toBe(true);
  });

  it("matches letters and punctuation on the physical key", () => {
    // ⌘B on an Arabic layout types ب; ⌘; types ك.
    expect(
      matchesShortcut(key("KeyB", "ب", { metaKey: true }), "mod+b", true),
    ).toBe(true);
    expect(
      matchesShortcut(key("Semicolon", "ك", { metaKey: true }), "mod+;", true),
    ).toBe(true);
    // ⇧. types ">" but is still the Period key.
    expect(
      matchesShortcut(
        key("Period", ">", { metaKey: true, shiftKey: true }),
        "mod+shift+.",
        true,
      ),
    ).toBe(true);
  });

  it("matches named keys on the key value", () => {
    expect(
      matchesShortcut(
        key("F10", "F10", { shiftKey: true }),
        "shift+f10",
        false,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(key("ContextMenu", "ContextMenu"), "contextmenu", false),
    ).toBe(true);
    expect(
      matchesShortcut(
        key("ArrowRight", "ArrowRight", {
          ctrlKey: true,
          metaKey: true,
          shiftKey: true,
        }),
        "mod+ctrl+shift+arrowright",
        true,
      ),
    ).toBe(true);
  });
});

describe("shortcutFromEvent", () => {
  it("writes the command key as mod, in canonical order", () => {
    expect(
      shortcutFromEvent(
        key("KeyB", "b", { metaKey: true, shiftKey: true }),
        true,
      ),
    ).toBe("mod+shift+b");
    expect(
      shortcutFromEvent(
        key("KeyB", "b", { ctrlKey: true, altKey: true }),
        false,
      ),
    ).toBe("mod+alt+b");
    expect(shortcutFromEvent(key("KeyA", "a", { ctrlKey: true }), true)).toBe(
      "ctrl+a",
    );
  });

  it("names the physical key, not the character", () => {
    expect(
      shortcutFromEvent(key("Semicolon", "ك", { metaKey: true }), true),
    ).toBe("mod+;");
    expect(
      shortcutFromEvent(
        key("KeyB", "∫", { metaKey: true, altKey: true }),
        true,
      ),
    ).toBe("mod+alt+b");
    expect(shortcutFromEvent(key("Space", " ", { ctrlKey: true }), false)).toBe(
      "mod+space",
    );
    expect(shortcutFromEvent(key("F2", "F2"), false)).toBe("f2");
  });

  it("is null while only modifiers are down", () => {
    expect(
      shortcutFromEvent(key("MetaLeft", "Meta", { metaKey: true }), true),
    ).toBeNull();
    expect(
      shortcutFromEvent(key("ShiftLeft", "Shift", { shiftKey: true }), true),
    ).toBeNull();
  });

  it("round-trips through matchesShortcut", () => {
    for (const apple of [true, false]) {
      const e = key("Period", ">", {
        [apple ? "metaKey" : "ctrlKey"]: true,
        shiftKey: true,
      });
      const chord = shortcutFromEvent(e, apple)!;
      expect(matchesShortcut(e, chord, apple)).toBe(true);
    }
  });
});

describe("normalizeShortcut", () => {
  it("makes two spellings of one chord equal", () => {
    expect(normalizeShortcut("Shift+Mod+B", true)).toBe("mod+shift+b");
    expect(normalizeShortcut("cmd+b", true)).toBe("mod+b");
    expect(normalizeShortcut("ctrl+b", false)).toBe("mod+b");
    expect(normalizeShortcut("hyper+b", false)).toBeNull();
  });
});

describe("keymapCommandFor", () => {
  it("answers the defaults with no overrides", () => {
    usePlatform("Win32");
    expect(keymapCommandFor({}, key("KeyZ", "z", { ctrlKey: true }))).toBe(
      "undo",
    );
    expect(keymapCommandFor({}, key("KeyY", "y", { ctrlKey: true }))).toBe(
      "redo",
    );
    expect(
      keymapCommandFor(
        {},
        key("ArrowRight", "ArrowRight", { altKey: true, shiftKey: true }),
      ),
    ).toBe("expandSelection");
  });

  it("moves a command to its new chord and frees the old one", () => {
    usePlatform("MacIntel");
    const overrides = { toggleStrong: ["mod+shift+b"] };
    expect(
      keymapCommandFor(overrides, key("KeyB", "b", { metaKey: true })),
    ).toBeNull();
    expect(
      keymapCommandFor(
        overrides,
        key("KeyB", "B", { metaKey: true, shiftKey: true }),
      ),
    ).toBe("toggleStrong");
  });

  it("unbinds a command given no chords", () => {
    usePlatform("MacIntel");
    expect(
      keymapCommandFor({ selectAll: [] }, key("KeyA", "a", { metaKey: true })),
    ).toBeNull();
  });

  it("differs per platform only for the selection ladder", () => {
    const mac = defaultKeymap(true);
    const win = defaultKeymap(false);
    expect(mac.expandSelection).not.toEqual(win.expandSelection);
    expect(mac.toggleStrong).toEqual(win.toggleStrong);
  });
});

describe("an editor's keymap", () => {
  it("claims a rebound chord and lets the old one through to the host", () => {
    usePlatform("MacIntel");
    const state = createInitialState(page, {
      schema: baseSchema.data,
      keymap: { toggleStrong: ["mod+shift+b"] },
    });
    expect(
      builtInKeymapClaims(state, key("KeyB", "b", { metaKey: true })),
    ).toBe(false);
    expect(
      builtInKeymapClaims(
        state,
        key("KeyB", "B", { metaKey: true, shiftKey: true }),
      ),
    ).toBe(true);
  });

  it("claims a chord without Ctrl/Cmd once a command is bound to it", () => {
    usePlatform("Win32");
    const state = createInitialState(page, {
      schema: baseSchema.data,
      keymap: { openContextMenu: ["alt+m"] },
    });
    expect(keymapCommandIn(state, key("KeyM", "m", { altKey: true }))).toBe(
      "openContextMenu",
    );
  });

  it("still drops a formatting command the schema has no mark for", () => {
    usePlatform("MacIntel");
    const state = createInitialState(page, {
      schema: baseSchema.restrict({ blocks: ["heading1"], marks: [] }).data,
      keymap: { toggleStrong: ["mod+shift+b"] },
    });
    expect(
      keymapCommandIn(
        state,
        key("KeyB", "B", { metaKey: true, shiftKey: true }),
      ),
    ).toBeNull();
  });
});
