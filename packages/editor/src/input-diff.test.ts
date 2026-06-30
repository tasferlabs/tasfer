import {
  clampMirrorStartToSpans,
  computeSurfaceDelta,
  currentWordStart,
  isEmptyDelta,
  isWordBoundaryChar,
  sentenceStartOffset,
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

describe("sentenceStartOffset", () => {
  it("is 0 when no sentence terminator precedes the caret", () => {
    expect(sentenceStartOffset("", 0)).toBe(0);
    expect(sentenceStartOffset("buy milk and eggs", 17)).toBe(0);
    // Mid first sentence — the whole prefix is one sentence.
    expect(sentenceStartOffset("buy milk and ", 13)).toBe(0);
  });

  it("starts after a terminator and its trailing whitespace", () => {
    // "Hello. World" — the second sentence starts at offset 7.
    expect(sentenceStartOffset("Hello. World", 12)).toBe(7);
    expect(sentenceStartOffset("Hello. World", 8)).toBe(7);
    expect(sentenceStartOffset("Done!  go", 9)).toBe(7);
  });

  it("is stable across the gap and the first char of a new sentence", () => {
    // Caret in the whitespace right after the terminator reports the gap end…
    expect(sentenceStartOffset("Hello. ", 7)).toBe(7);
    // …and stays there once the first character of the next sentence is typed,
    // so the mirrored surface the keyboard built is not rewritten.
    expect(sentenceStartOffset("Hello. w", 8)).toBe(7);
  });

  it("does not split on non-terminal punctuation (comma, semicolon)", () => {
    expect(sentenceStartOffset("one, two", 8)).toBe(0);
    expect(sentenceStartOffset("a; b", 4)).toBe(0);
  });

  it("uses only the most recent sentence boundary before the caret", () => {
    // "A. B. C" — caret at end sits in the third sentence (offset 6).
    expect(sentenceStartOffset("A. B. C", 7)).toBe(6);
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

describe("clampMirrorStartToSpans", () => {
  // An inline math chip `\frac{a}{b}` covering offsets [2, 13) in
  // `x \frac{a}{b} y`-style text — the protected source the surface must not
  // mirror into.
  const chip = [{ start: 2, end: 13 }];

  it("floors the word start at the chip's end when the caret is past it", () => {
    // Caret just after the chip: the word would walk back into the LaTeX, so the
    // mirror must start no earlier than the chip's end (an empty word → sentinel).
    expect(clampMirrorStartToSpans(chip, 13)).toBe(13);
    // Caret two chars past the chip ("…b} yz|"): the live word is only "yz".
    expect(clampMirrorStartToSpans(chip, 15)).toBe(13);
  });

  it("returns null when the caret sits strictly inside a chip", () => {
    // Anywhere in (start, end) is inside the LaTeX — no prose word at all.
    expect(clampMirrorStartToSpans(chip, 3)).toBeNull();
    expect(clampMirrorStartToSpans(chip, 12)).toBeNull();
  });

  it("treats the chip edges as outside the chip", () => {
    // Left edge: caret before the chip → unaffected (floor 0).
    expect(clampMirrorStartToSpans(chip, 2)).toBe(0);
    // Right edge handled above (floors to 13), confirming edges aren't "inside".
  });

  it("ignores chips that start after the caret", () => {
    expect(clampMirrorStartToSpans([{ start: 5, end: 10 }], 3)).toBe(0);
  });

  it("with no protected spans the start is unconstrained (floor 0)", () => {
    expect(clampMirrorStartToSpans([], 7)).toBe(0);
  });

  it("floors at the nearest preceding chip when several precede the caret", () => {
    const spans = [
      { start: 0, end: 3 },
      { start: 6, end: 9 },
    ];
    // Caret at 12: both chips precede it; the floor is the later chip's end.
    expect(clampMirrorStartToSpans(spans, 12)).toBe(9);
  });
});
