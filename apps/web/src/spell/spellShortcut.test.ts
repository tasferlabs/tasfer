import { describe, expect, it } from "vitest";
import { spellShortcutFor, spellShortcutKeys } from "./spellShortcut";

const key = (
  code: string,
  mods: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {},
) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("spellShortcutFor", () => {
  it("Cmd+. is fix-or-next on Apple, Ctrl+. elsewhere", () => {
    expect(spellShortcutFor(key("Period", { metaKey: true }), true)).toBe(
      "fixOrNext",
    );
    expect(spellShortcutFor(key("Period", { ctrlKey: true }), false)).toBe(
      "fixOrNext",
    );
  });

  it("Shift adds 'previous'", () => {
    expect(
      spellShortcutFor(key("Period", { metaKey: true, shiftKey: true }), true),
    ).toBe("prev");
    expect(
      spellShortcutFor(key("Period", { ctrlKey: true, shiftKey: true }), false),
    ).toBe("prev");
  });

  it("the other platform's modifier is not the chord", () => {
    // Bare Ctrl+. on a Mac belongs to the OS / other apps.
    expect(spellShortcutFor(key("Period", { ctrlKey: true }), true)).toBeNull();
    expect(
      spellShortcutFor(key("Period", { metaKey: true }), false),
    ).toBeNull();
    // Both held at once is not the chord either.
    expect(
      spellShortcutFor(key("Period", { metaKey: true, ctrlKey: true }), true),
    ).toBeNull();
  });

  it("ignores Alt, other keys and the bare period", () => {
    expect(
      spellShortcutFor(key("Period", { metaKey: true, altKey: true }), true),
    ).toBeNull();
    expect(spellShortcutFor(key("Period"), true)).toBeNull();
    expect(
      spellShortcutFor(key("Semicolon", { metaKey: true }), true),
    ).toBeNull();
    expect(spellShortcutFor(key("KeyF", { ctrlKey: true }), false)).toBeNull();
  });

  it("prints the chord per platform", () => {
    expect(spellShortcutKeys(true)).toEqual(["⌘", "."]);
    expect(spellShortcutKeys(false)).toEqual(["Ctrl", "."]);
  });
});
