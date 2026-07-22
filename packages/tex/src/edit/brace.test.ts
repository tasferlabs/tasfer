/**
 * `escapeTypedBrace`: a brace typed into a formula ALWAYS becomes the visible
 * escaped symbol (`\{`/`\}`) — even flush after a command word — with one raw
 * exception: completing a `\{` the user is typing themselves. (Closing a group
 * opened raw in pasted/imported source is the other, non-typing, raw case.)
 */
import {
  backslashFusesWith,
  balanceBraces,
  escapeStrayCloseBraces,
  escapeTypedBrace,
  escapeTypedReserved,
  inRawTextArg,
  strayCloseBraceInserts,
} from "./brace";
import { layoutMath, caretStops } from "../index";
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

  it("escapes a brace after a command word — a typed { never opens an argument", () => {
    // `\text{`, `\begin{`, `\frac{` no longer auto-open an argument: a typed brace
    // is always a literal glyph, so it escapes. Constructs get their `{}` slots
    // from materialization/paste, not from this single-char typing path.
    expect(escapeTypedBrace("\\text", 5, "{")).toBe("\\{");
    expect(escapeTypedBrace("\\begin", 6, "{")).toBe("\\{");
    expect(escapeTypedBrace("\\frac", 5, "{")).toBe("\\{");
    // In-progress and dead-end runs escape too — no special case remains.
    expect(escapeTypedBrace("\\tex", 4, "{")).toBe("\\{");
    expect(escapeTypedBrace("x\\fra", 5, "{")).toBe("\\{");
    expect(escapeTypedBrace("\\asdf", 5, "{")).toBe("\\{");
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

describe("escapeTypedReserved", () => {
  it("escapes $, #, % and & to their literal glyphs", () => {
    expect(escapeTypedReserved("x+1", 3, "$")).toBe("\\$");
    expect(escapeTypedReserved("x+1", 3, "#")).toBe("\\#");
    expect(escapeTypedReserved("x+1", 3, "%")).toBe("\\%");
    expect(escapeTypedReserved("x+1", 3, "&")).toBe("\\&");
    expect(escapeTypedReserved("", 0, "&")).toBe("\\&");
  });

  it("does not claim other characters (braces, scripts, backslash, letters)", () => {
    for (const c of ["{", "}", "^", "_", "\\", "a", "1", "~"]) {
      expect(escapeTypedReserved("x", 1, c)).toBeNull();
    }
  });

  it("keeps the char raw right after a lone backslash (completing the escape)", () => {
    // `\` + `&` is the user typing `\&` themselves — don't double-escape.
    expect(escapeTypedReserved("\\", 1, "&")).toBeNull();
    expect(escapeTypedReserved("a\\", 2, "$")).toBeNull();
  });

  it("still escapes after a row-break \\\\ (not a lone escaping backslash)", () => {
    expect(escapeTypedReserved("a\\\\", 3, "&")).toBe("\\&");
  });

  it("keeps a & raw inside a matrix environment (real column separator)", () => {
    const inMatrix = "\\begin{matrix}a".length; // caret after the first cell
    expect(escapeTypedReserved("\\begin{matrix}a", inMatrix, "&")).toBeNull();
  });

  it("escapes a & once the environment has closed", () => {
    const after = "\\begin{matrix}a\\end{matrix}".length;
    expect(
      escapeTypedReserved("\\begin{matrix}a\\end{matrix}", after, "&"),
    ).toBe("\\&");
  });

  it("keeps $/#/% raw right after a backslash but escapes them otherwise", () => {
    // Non-& reserved chars are never column separators, so only the
    // escape-completion exception applies.
    expect(escapeTypedReserved("\\begin{matrix}", 14, "$")).toBe("\\$");
    expect(escapeTypedReserved("\\", 1, "%")).toBeNull();
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

describe("escapeStrayCloseBraces", () => {
  it("no-ops on source with no stray close", () => {
    for (const s of [
      "",
      "x+1",
      "\\frac{a}{b}",
      "{a{b}c}",
      "{abc",
      "\\}",
      "\\{",
    ]) {
      expect(escapeStrayCloseBraces(s)).toBe(s);
    }
  });

  it("escapes a lone stray close to its literal glyph", () => {
    expect(escapeStrayCloseBraces("}")).toBe("\\}");
    expect(escapeStrayCloseBraces("}}")).toBe("\\}\\}");
    expect(escapeStrayCloseBraces("a}b")).toBe("a\\}b");
  });

  it("leaves a matched close alone and escapes only the excess", () => {
    // The first `}` closes `{a`; the second matches nothing.
    expect(escapeStrayCloseBraces("{a}}")).toBe("{a}\\}");
    expect(escapeStrayCloseBraces("\\frac{a}{b}}")).toBe("\\frac{a}{b}\\}");
  });

  it("is idempotent", () => {
    const once = escapeStrayCloseBraces("}a}");
    expect(escapeStrayCloseBraces(once)).toBe(once);
  });

  it("makes an all-stray-close source editable — the reported $$}$$ dead cell", () => {
    // Before: `}` parses to nothing, so the layout has zero caret stops — a
    // blank block the caret can't enter. After escaping it is a real brace glyph.
    expect(caretStops(layoutMath("}", { fontSize: 18 }))).toHaveLength(0);
    const safe = escapeStrayCloseBraces("}");
    expect(
      caretStops(layoutMath(safe, { fontSize: 18 })).length,
    ).toBeGreaterThan(0);
  });

  it("strayCloseBraceInserts gives the CRDT-op form (a `\\` before each stray)", () => {
    expect(strayCloseBraceInserts("x+1")).toEqual([]);
    expect(strayCloseBraceInserts("}")).toEqual([{ at: 0, text: "\\" }]);
    expect(strayCloseBraceInserts("a}b}")).toEqual([
      { at: 1, text: "\\" },
      { at: 3, text: "\\" },
    ]);
    // A matched close is not an insert; only the excess is.
    expect(strayCloseBraceInserts("{a}}")).toEqual([{ at: 3, text: "\\" }]);
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

  it("fuses with a letter (which it would swallow into the command name)", () => {
    // `\`+`int` → the command `\int`, the existing letters gone — so a separator
    // is wedged. This is the fix for `\frac{\pia}{b}`-style letter fusion.
    expect(backslashFusesWith("xy", 1)).toBe(true); // before a letter
    expect(backslashFusesWith("int", 0)).toBe(true);
  });

  it("fuses with an ordinary atom (digit or operator)", () => {
    // `\+`/`\2` are unknown single-char commands that absorb the atom; guarding
    // them keeps `+`/`2` as their own atoms.
    expect(backslashFusesWith("a+b", 1)).toBe(true); // before `+`
    expect(backslashFusesWith("a2", 1)).toBe(true); // before a digit
  });

  it("does NOT fuse with whitespace or end-of-string", () => {
    expect(backslashFusesWith("a b", 1)).toBe(false); // before a space
    expect(backslashFusesWith("x", 1)).toBe(false); // end of string
  });

  it("does NOT fuse with a prime (a separator would detach it from its base)", () => {
    expect(backslashFusesWith("x'", 1)).toBe(false); // before a prime
  });
});

describe("inRawTextArg", () => {
  it("is true anywhere inside a `\\text{…}` body, flush against either brace", () => {
    // `\text{ab}` — body chars are at offsets 6 (`a`) and 7 (`b`); the closing
    // `}` is at 8. Inside spans just-after `{` (6) through the `}` position (8).
    expect(inRawTextArg("\\text{ab}", 6)).toBe(true); // flush after `{`
    expect(inRawTextArg("\\text{ab}", 7)).toBe(true); // mid-body
    expect(inRawTextArg("\\text{ab}", 8)).toBe(true); // flush before `}`
  });

  it("is false in math mode: before the body and just past the closing `}`", () => {
    expect(inRawTextArg("\\text{ab}", 5)).toBe(false); // on the `{`
    expect(inRawTextArg("\\text{ab}", 9)).toBe(false); // just past `}` (math again)
    expect(inRawTextArg("x+1", 2)).toBe(false); // no text run at all
  });

  it("covers the whole \\text font family and \\operatorname", () => {
    expect(inRawTextArg("\\textbf{x}", 8)).toBe(true);
    expect(inRawTextArg("\\texttt{x}", 8)).toBe(true);
    expect(inRawTextArg("\\operatorname{x}", 14)).toBe(true);
  });

  it("tracks nested braces and an unterminated (mid-edit) body", () => {
    // Nested group inside the text body stays inside until the OUTER `}`.
    expect(inRawTextArg("\\text{a{b}c}", 9)).toBe(true); // inside the nested `{b}`
    expect(inRawTextArg("\\text{a{b}c}", 11)).toBe(true); // after it, before outer `}`
    // Unterminated body (the closing brace not yet typed) extends to the end.
    expect(inRawTextArg("\\text{ab", 8)).toBe(true);
  });

  it("does not treat an escaped brace inside the body as the terminator", () => {
    // `\{` is a literal glyph, not a group boundary, so the body runs to the real
    // closing `}` — the offset after `\{` is still inside.
    expect(inRawTextArg("\\text{a\\{b}", 9)).toBe(true);
  });
});
