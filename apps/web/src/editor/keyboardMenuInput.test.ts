import { describe, expect, it } from "vitest";
import { shouldOpenKeyboardMenu } from "./keyboardMenuInput";

describe("keyboard-driven menus", () => {
  it("opens on a touch-first device for a physical keyboard", () => {
    expect(shouldOpenKeyboardMenu(true, "hardware-keyboard")).toBe(true);
  });

  it("stays hidden for software-keyboard input on a touch-first device", () => {
    expect(shouldOpenKeyboardMenu(true, "input-surface")).toBe(false);
  });

  it("keeps desktop behavior for every text-input path", () => {
    expect(shouldOpenKeyboardMenu(false, "hardware-keyboard")).toBe(true);
    expect(shouldOpenKeyboardMenu(false, "input-surface")).toBe(true);
    expect(shouldOpenKeyboardMenu(false)).toBe(true);
  });
});
