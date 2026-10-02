import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnPrefsStore } from "@/app/contexts/OwnPrefsContext";
import { Shortcuts } from "./ShortcutsContext";

/** Just enough of the synced prefs store: a map, with change listeners. */
function fakeStore(): OwnPrefsStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  let snapshot = {};
  return {
    values,
    get: <T>(key: string, fallback: T) => {
      const v = values.get(key);
      return v === undefined || v === null ? fallback : (v as T);
    },
    set: (key: string, value: unknown) => {
      values.set(key, value);
      snapshot = {};
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snapshot,
  } as unknown as OwnPrefsStore & { values: Map<string, unknown> };
}

function keydown(
  code: string,
  key: string,
  mods: Partial<
    Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>
  > = {},
) {
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

beforeEach(() => {
  vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Win32" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Shortcuts", () => {
  it("answers the defaults until a command is changed", () => {
    const shortcuts = new Shortcuts(fakeStore());
    expect(shortcuts.bindings("app.commandPalette")).toEqual(["mod+k"]);
    expect(
      shortcuts.matches(
        "app.commandPalette",
        keydown("KeyK", "k", { ctrlKey: true }),
      ),
    ).toBe(true);
    expect(shortcuts.isChanged("app.commandPalette")).toBe(false);
  });

  it("moves a command to a new chord, synced as one key", () => {
    const store = fakeStore();
    const shortcuts = new Shortcuts(store);
    shortcuts.set("app.commandPalette", ["Ctrl+P"]);
    expect(store.values.get("shortcut.app.commandPalette")).toEqual(["mod+p"]);
    expect(
      shortcuts.matches(
        "app.commandPalette",
        keydown("KeyK", "k", { ctrlKey: true }),
      ),
    ).toBe(false);
    expect(
      shortcuts.matches(
        "app.commandPalette",
        keydown("KeyP", "p", { ctrlKey: true }),
      ),
    ).toBe(true);
  });

  it("stores nothing when the chords are the defaults again", () => {
    const store = fakeStore();
    const shortcuts = new Shortcuts(store);
    shortcuts.set("redo", ["mod+p"]);
    shortcuts.set("redo", ["mod+shift+z", "mod+y"]);
    expect(store.values.get("shortcut.redo")).toBeNull();
    expect(shortcuts.isChanged("redo")).toBe(false);
  });

  it("unbinds with an empty list and resets back", () => {
    const shortcuts = new Shortcuts(fakeStore());
    shortcuts.set("editor.find", []);
    expect(shortcuts.bindings("editor.find")).toEqual([]);
    expect(shortcuts.isChanged("editor.find")).toBe(true);
    shortcuts.reset("editor.find");
    expect(shortcuts.bindings("editor.find")).toEqual(["mod+f"]);
  });

  it("never changes a locked command", () => {
    const store = fakeStore();
    const shortcuts = new Shortcuts(store);
    shortcuts.set("editor.copy", ["mod+j"]);
    expect(store.values.size).toBe(0);
    expect(shortcuts.bindings("editor.copy")).toEqual(["mod+c"]);
  });

  it("finds the other commands on a chord, however it is spelled", () => {
    const shortcuts = new Shortcuts(fakeStore());
    const ids = shortcuts
      .conflicts("Ctrl+B", "app.commandPalette")
      .map((c) => c.id);
    expect(ids).toEqual(["editor.toggleStrong"]);
    expect(shortcuts.conflicts("mod+b", "editor.toggleStrong")).toEqual([]);
  });

  it("hands the editor only the keymap commands that changed", () => {
    const shortcuts = new Shortcuts(fakeStore());
    shortcuts.set("editor.toggleStrong", ["mod+shift+b"]);
    shortcuts.set("app.commandPalette", ["mod+p"]);
    shortcuts.set("undo", []);
    expect(shortcuts.keymapOverrides()).toEqual({
      toggleStrong: ["mod+shift+b"],
      undo: [],
    });
  });

  it("stands every shortcut down while paused", () => {
    const shortcuts = new Shortcuts(fakeStore());
    const e = keydown("KeyK", "k", { ctrlKey: true });
    const resume = shortcuts.pause();
    expect(shortcuts.matches("app.commandPalette", e)).toBe(false);
    resume();
    resume();
    expect(shortcuts.matches("app.commandPalette", e)).toBe(true);
  });

  it("answers the defaults with no store at all", () => {
    const shortcuts = new Shortcuts(null);
    shortcuts.set("app.commandPalette", ["mod+p"]);
    expect(shortcuts.bindings("app.commandPalette")).toEqual(["mod+k"]);
  });
});
