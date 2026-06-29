import {
  computeSurfaceDelta,
  currentWordStart,
  isEmptyDelta,
  isWordBoundaryChar,
  SURFACE_SENTINEL,
} from "./input-diff";
import { describe, expect, it } from "vitest";

// Apply a delta the way the editor does, to assert round-trips.
function applyDelta(
  prev: string,
  d: ReturnType<typeof computeSurfaceDelta>,
): string {
  return prev.slice(0, d.deleteStart) + d.insert + prev.slice(d.deleteEnd);
}

describe("isWordBoundaryChar", () => {
  it("treats whitespace, NBSP, and undefined as boundaries", () => {
    expect(isWordBoundaryChar(" ")).toBe(true);
    expect(isWordBoundaryChar("\t")).toBe(true);
    expect(isWordBoundaryChar("\n")).toBe(true);
    expect(isWordBoundaryChar(SURFACE_SENTINEL)).toBe(true); // the leading sentinel
    expect(isWordBoundaryChar(undefined)).toBe(true);
  });

  it("treats letters, digits, and punctuation-in-word as non-boundaries", () => {
    expect(isWordBoundaryChar("a")).toBe(false);
    expect(isWordBoundaryChar("Z")).toBe(false);
    expect(isWordBoundaryChar("7")).toBe(false);
    expect(isWordBoundaryChar("'")).toBe(false);
  });
});

describe("currentWordStart", () => {
  it("finds the start of the word ending at the caret", () => {
    expect(currentWordStart("hello world", 11)).toBe(6); // "world"
    expect(currentWordStart("hello world", 5)).toBe(0); // "hello"
    expect(currentWordStart("hello", 3)).toBe(0); // mid "hello"
  });

  it("returns the caret when the caret sits on a boundary", () => {
    expect(currentWordStart("hello world", 6)).toBe(6); // just after the space
    expect(currentWordStart("hi ", 3)).toBe(3);
  });

  it("clamps out-of-range carets", () => {
    expect(currentWordStart("abc", 99)).toBe(0);
    expect(currentWordStart("abc", -1)).toBe(0);
  });
});

describe("computeSurfaceDelta", () => {
  it("reports no change for identical strings", () => {
    const d = computeSurfaceDelta("hello", "hello");
    expect(isEmptyDelta(d)).toBe(true);
    expect(applyDelta("hello", d)).toBe("hello");
  });

  it("detects a single appended character (typing)", () => {
    const d = computeSurfaceDelta("hel", "hell");
    expect(d).toEqual({ deleteStart: 3, deleteEnd: 3, insert: "l" });
    expect(applyDelta("hel", d)).toBe("hell");
  });

  it("detects a suffix deletion (backspace)", () => {
    const d = computeSurfaceDelta("hello", "hell");
    expect(d).toEqual({ deleteStart: 4, deleteEnd: 5, insert: "" });
    expect(applyDelta("hello", d)).toBe("hell");
  });

  it("detects a whole-word deletion (delete-word)", () => {
    const d = computeSurfaceDelta("hello", "");
    expect(d).toEqual({ deleteStart: 0, deleteEnd: 5, insert: "" });
    expect(applyDelta("hello", d)).toBe("");
  });

  it("detects an autocorrect swap that keeps a common prefix", () => {
    const d = computeSurfaceDelta("teh", "the");
    expect(applyDelta("teh", d)).toBe("the");
    // Common prefix "t" only; "eh" -> "he".
    expect(d.deleteStart).toBe(1);
    expect(d.deleteEnd).toBe(3);
    expect(d.insert).toBe("he");
  });

  it("detects a predictive-text completion (prefix preserved, suffix added)", () => {
    const d = computeSurfaceDelta("hel", "hello");
    expect(d).toEqual({ deleteStart: 3, deleteEnd: 3, insert: "lo" });
    expect(applyDelta("hel", d)).toBe("hello");
  });

  it("uses the common suffix to localize an internal change", () => {
    const d = computeSurfaceDelta("cat", "cart");
    expect(applyDelta("cat", d)).toBe("cart");
    // prefix "ca", suffix "t" -> insert "r" at offset 2.
    expect(d).toEqual({ deleteStart: 2, deleteEnd: 2, insert: "r" });
  });

  it("round-trips a full replacement with no common affixes", () => {
    const d = computeSurfaceDelta("abc", "xyz");
    expect(d).toEqual({ deleteStart: 0, deleteEnd: 3, insert: "xyz" });
    expect(applyDelta("abc", d)).toBe("xyz");
  });

  it("does not split an astral character (emoji) at the edit boundary", () => {
    const rocket = "\u{1F680}"; // 🚀, a surrogate pair
    const prev = `a${rocket}b`;
    const next = `a${rocket}cb`; // insert "c" before the trailing "b"
    const d = computeSurfaceDelta(prev, next);
    expect(applyDelta(prev, d)).toBe(next);
    // The emoji must remain intact on both sides of the edit.
    expect(prev.slice(0, d.deleteStart)).toContain(rocket);
  });

  it("replaces an emoji without leaving a dangling surrogate", () => {
    const a = "\u{1F600}"; // 😀
    const b = "\u{1F601}"; // 😁
    const d = computeSurfaceDelta(a, b);
    const out = applyDelta(a, d);
    expect(out).toBe(b);
    // No lone surrogate left behind.
    expect(out.length).toBe(2);
  });
});
