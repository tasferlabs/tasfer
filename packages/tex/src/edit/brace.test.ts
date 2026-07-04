/**
 * `escapeTypedBrace`: a brace typed into a formula becomes the visible escaped
 * symbol (`\{`/`\}`) unless the raw grouping token is structurally meant there —
 * completing a `\{` being typed, opening a control word's argument, or closing
 * a group the user opened raw.
 */
import { escapeTypedBrace } from "./brace";
import { describe, expect, it } from "vitest";

describe("escapeTypedBrace", () => {
  it("escapes a brace typed in plain math content", () => {
    expect(escapeTypedBrace("", 0, "{")).toBe("\\{");
    expect(escapeTypedBrace("x+1", 3, "{")).toBe("\\{");
    expect(escapeTypedBrace("x+1", 3, "}")).toBe("\\}");
  });

  it("does not claim non-brace characters", () => {
    expect(escapeTypedBrace("x", 1, "a")).toBeNull();
    expect(escapeTypedBrace("x", 1, "(")).toBeNull();
  });

  it("keeps a brace raw right after a typed backslash (completing \\{ itself)", () => {
    expect(escapeTypedBrace("\\", 1, "{")).toBeNull();
    expect(escapeTypedBrace("\\", 1, "}")).toBeNull();
  });

  it("keeps a brace raw after a control word (opening its argument)", () => {
    expect(escapeTypedBrace("\\text", 5, "{")).toBeNull();
    expect(escapeTypedBrace("\\begin", 6, "{")).toBeNull();
    expect(escapeTypedBrace("x\\fra", 5, "{")).toBeNull(); // in-progress command
  });

  it("escapes after a row-break \\\\ (its trailing \\ is no command intro)", () => {
    expect(escapeTypedBrace("a\\\\", 3, "{")).toBe("\\{");
  });

  it("keeps a } raw while a raw-opened group is unclosed", () => {
    expect(escapeTypedBrace("\\text{abc", 9, "}")).toBeNull();
  });

  it("escapes a } inside an already-balanced construct slot", () => {
    // Caret in the numerator: \frac{12|}{2} — the slot's own braces are
    // matched, so the keystroke means a literal brace, not closing the slot.
    expect(escapeTypedBrace("\\frac{12}{2}", "\\frac{12".length, "}")).toBe(
      "\\}",
    );
  });

  it("does not count escaped braces when balancing groups", () => {
    // `\{` is a symbol, not an opener: nothing is open, so the brace escapes.
    expect(escapeTypedBrace("\\{a", 3, "}")).toBe("\\}");
  });
});
