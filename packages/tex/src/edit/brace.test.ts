/**
 * `escapeTypedBrace`: a brace typed into a formula becomes the visible escaped
 * symbol (`\{`/`\}`) unless the raw grouping token is structurally meant there —
 * completing a `\{` being typed, opening a control word's argument, or closing
 * a group the user opened raw.
 */
import {
  backslashFusesWith,
  balanceBraces,
  escapeTypedBrace,
  typedBraceSkipsCloser,
} from "./brace";
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

describe("typedBraceSkipsCloser", () => {
  it("skips the auto-inserted closer flush at the caret", () => {
    // `\text{hi|}` — caret before the group's `}`. Typing `}` steps over it.
    expect(typedBraceSkipsCloser("\\text{hi}", "\\text{hi".length)).toBe(true);
    // Empty just-materialized argument `\text{|}`.
    expect(typedBraceSkipsCloser("\\text{}", "\\text{".length)).toBe(true);
    // A construct slot's closer (`\frac{a|}{b}`).
    expect(typedBraceSkipsCloser("\\frac{a}{b}", "\\frac{a".length)).toBe(true);
  });

  it("does NOT skip when there is no open group to close", () => {
    // A stray `}` with nothing open: it is not a slot closer.
    expect(typedBraceSkipsCloser("a}", 1)).toBe(false);
    // Caret AFTER the closer (`\text{hi}|`) — nothing at the caret to skip.
    expect(typedBraceSkipsCloser("\\text{hi}", "\\text{hi}".length)).toBe(
      false,
    );
    // The char at the offset isn't a `}` at all.
    expect(typedBraceSkipsCloser("\\text{hi}", "\\text{h".length)).toBe(false);
  });

  it("does NOT treat an escaped `\\}` glyph as a skippable closer", () => {
    // `\{a\}` set notation — the `}` at this offset is the second half of a `\}`
    // literal glyph (no token starts there), not a grouping closer, so a typed
    // `}` must not skip. Offset points at that `}` (`\`,`{`,`a`,`\` = 4 chars).
    expect(typedBraceSkipsCloser("\\{a\\}", "\\{a\\".length)).toBe(false);
  });
});

describe("backslashFusesWith", () => {
  it("fuses with a grouping brace", () => {
    expect(backslashFusesWith("\\frac{}{}", "\\frac{".length)).toBe(true); // before `}`
    expect(backslashFusesWith("\\frac{}{}", "\\frac{}".length)).toBe(true); // before `{`
  });

  it("fuses with a matrix column separator (the reported bug)", () => {
    // `\begin{matrix}a&b\end{matrix}` — caret after `a`, before the `&`.
    const latex = "\\begin{matrix}a&b\\end{matrix}";
    expect(backslashFusesWith(latex, latex.indexOf("&"))).toBe(true);
  });

  it("fuses with a script operator", () => {
    expect(backslashFusesWith("x^2", 1)).toBe(true); // before `^`
    expect(backslashFusesWith("x_2", 1)).toBe(true); // before `_`
  });

  it("fuses with a \\sqrt[…] index bracket (parser-structural, not a lexer token)", () => {
    // `\sqrt[3]{x}` — caret before `]`. Fusing it into `\]` makes the index run
    // past the bracket and swallow the `{x}` radicand.
    const latex = "\\sqrt[3]{x}";
    expect(backslashFusesWith(latex, latex.indexOf("]"))).toBe(true);
    expect(backslashFusesWith(latex, latex.indexOf("["))).toBe(true);
    // A plain interval bracket is guarded too — harmless (just a space before it).
    expect(backslashFusesWith("[0,1]", "[0,1".length)).toBe(true);
  });

  it("fuses with a row break ONLY inside an environment", () => {
    const inMatrix = "\\begin{matrix}a\\\\b\\end{matrix}";
    expect(backslashFusesWith(inMatrix, inMatrix.indexOf("\\\\"))).toBe(true);
    // Outside an environment the lexer keeps the two `\`s separate, so no fusion.
    expect(backslashFusesWith("a\\\\b", 1)).toBe(false);
    expect(backslashFusesWith("a\\frac{x}{y}", 1)).toBe(false); // `\` before `\frac`
  });

  it("does NOT fuse with a letter (that starts a command name) or an ordinary atom", () => {
    expect(backslashFusesWith("xy", 1)).toBe(false); // before a letter
    expect(backslashFusesWith("a+b", 1)).toBe(false); // before `+`
    expect(backslashFusesWith("a2", 1)).toBe(false); // before a digit
    expect(backslashFusesWith("a b", 1)).toBe(false); // before a space
    expect(backslashFusesWith("x", 1)).toBe(false); // end of string
    // A prime is parser-structural, but a separator would detach it from its base
    // rather than repair it, so it is intentionally not guarded (see the docs).
    expect(backslashFusesWith("x'", 1)).toBe(false); // before a prime
  });
});
