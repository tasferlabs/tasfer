import { shouldUseKeyboardPlaceholder } from "./node-shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      ontouchstart: null,
      matchMedia: () => ({ matches: false }),
    },
  });
});

afterAll(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("paragraph placeholder input capability", () => {
  it("uses the slash hint after a touch-first editor detects hardware input", () => {
    expect(shouldUseKeyboardPlaceholder(false)).toBe(false);
    expect(shouldUseKeyboardPlaceholder(true)).toBe(true);
  });
});
