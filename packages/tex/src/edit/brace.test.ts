/**
 * `escapeTypedBrace`: a brace typed into a formula becomes the visible escaped
 * symbol (`\{`/`\}`) unless the raw grouping token is structurally meant there —
 * completing a `\{` being typed, opening a control word's argument, or closing
 * a group the user opened raw.
 */
import { balanceBraces, escapeTypedBrace } from "./brace";
import { parse } from "../parse/parser";
import { describe, expect, it } from "vitest";

/** Apply balanceBraces' inserts to get the healed string. */
function balanced(latex: string): string {
  return balanceBraces(latex).inserts.reduce((s, i) => s + i.text, latex);
}

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

describe("balanceBraces", () => {
  it("no-ops on already-balanced source", () => {
    for (const s of ["", "x+1", "\\frac{a}{b}", "\\sqrt{x^{2}+1}", "{a{b}c}"]) {
      expect(balanceBraces(s).changed).toBe(false);
      expect(balanced(s)).toBe(s);
    }
  });

  it("closes a single unclosed group", () => {
    expect(balanced("\\frac{a}{b")).toBe("\\frac{a}{b}");
    expect(balanced("{abc")).toBe("{abc}");
  });

  it("closes several nested unclosed groups innermost-first", () => {
    expect(balanced("\\frac{a{b{c")).toBe("\\frac{a{b{c}}}");
  });

  it("heals the reported right-side dead end (extra caret stop past the frac)", () => {
    const broken = "\\frac{a}{b}+\\sqrt{H}-\\frac{aaaa}{bbbb+\\frac{a}{b}";
    const healed = balanced(broken);
    expect(healed).toBe(broken + "}");
    // The healed source parses to the SAME shape (render-neutral): only the
    // closing brace — a caret stop past the construct — is added.
    const drop = (k: string, v: unknown) => (k === "span" ? undefined : v);
    expect(JSON.stringify(parse(healed), drop)).toBe(
      JSON.stringify(parse(broken), drop),
    );
  });

  it("ignores stray closing braces and escaped braces", () => {
    // A stray `}` the parser already drops isn't an opener to match.
    expect(balanceBraces("a}b").changed).toBe(false);
    // `\{` is a literal glyph, not a grouping opener.
    expect(balanceBraces("\\{a").changed).toBe(false);
  });

  it("is idempotent", () => {
    const once = balanced("\\frac{a{b");
    expect(balanced(once)).toBe(once);
  });
});
