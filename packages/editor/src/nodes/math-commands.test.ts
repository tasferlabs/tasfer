/**
 * The `\` command catalog: every entry must parse cleanly (a typo'd template
 * would render as a red placeholder), the caret must land in the first empty
 * slot, and the filter must rank the obvious match first (typing `int` surfaces
 * `\int`, not `\sin`).
 */
import {
  allMathCommandsValid,
  filterMathCommands,
  MATH_COMMANDS,
  mathCommandCaretOffset,
  mathCommandInsertion,
} from "./math-commands";
import { isValidLatex } from "@cypherkit/tex";
import { describe, expect, it } from "vitest";

describe("math command catalog", () => {
  it("every command's latex parses with no unknown commands", () => {
    expect(allMathCommandsValid()).toBe(true);
    // Per-entry assertion so a failure names the offender.
    for (const c of MATH_COMMANDS) {
      expect(isValidLatex(c.latex), `${c.id}: ${c.latex}`).toBe(true);
    }
  });

  it("command ids are unique", () => {
    const ids = MATH_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("caret offset lands inside the first empty slot", () => {
    // \frac{}{}: first slot is between the first pair of braces.
    expect(mathCommandCaretOffset("\\frac{}{}")).toBe("\\frac{".length);
    // ^{}: caret between the braces.
    expect(mathCommandCaretOffset("^{}")).toBe(2);
    // No slot → caret at the end.
    expect(mathCommandCaretOffset("\\alpha")).toBe("\\alpha".length);
  });

  it("filtering ranks the exact command first", () => {
    const int = filterMathCommands("int");
    expect(int[0].id).toBe("int");
    // The other integrals still match (prefix of keyword/id).
    expect(int.map((c) => c.id)).toEqual(
      expect.arrayContaining(["iint", "iiint"]),
    );
  });

  it("filtering matches keywords, not just ids", () => {
    expect(filterMathCommands("power").map((c) => c.id)).toContain("^");
    expect(filterMathCommands("greek").length).toBeGreaterThan(10);
  });

  it("an empty query returns the curated browse tier in order", () => {
    const browse = filterMathCommands("");
    // The browse list is the curated prefix of the full catalog: same order,
    // stopping where the generated symbol/operator tier begins.
    expect(browse.length).toBeGreaterThan(0);
    expect(browse.length).toBeLessThan(MATH_COMMANDS.length);
    browse.forEach((c, i) => expect(c.id).toBe(MATH_COMMANDS[i].id));
  });

  it("engine symbols outside the curated tier are findable (\\degree)", () => {
    const degree = filterMathCommands("degree");
    expect(degree[0]?.id).toBe("degree");
    expect(degree[0]?.latex).toBe("\\degree");
    // The glyph is a search keyword, so pasting it into the drawer works too.
    expect(filterMathCommands("°").map((c) => c.id)).toContain("degree");
  });

  it("engine operators outside the curated tier are findable (\\liminf)", () => {
    const liminf = filterMathCommands("liminf");
    expect(liminf[0]?.id).toBe("liminf");
    // \lim-like operators get a subscript slot, matching the curated \lim_{}.
    expect(liminf[0]?.latex).toBe("\\liminf_{}");
  });

  it("a non-matching query returns nothing", () => {
    expect(filterMathCommands("zzzznope")).toHaveLength(0);
  });
});

describe("mathCommandInsertion", () => {
  it("appends a separator space before a following letter (a\\pi|a)", () => {
    // Committing \pi directly before `a` would fuse into the unknown \pia.
    expect(mathCommandInsertion("\\pi", "a")).toEqual({
      text: "\\pi ",
      // The command+separator is one token with no interior caret stop, so the
      // caret lands after the space.
      caretOffset: 4,
    });
    expect(mathCommandInsertion("\\degree", "C")).toEqual({
      text: "\\degree ",
      caretOffset: 8,
    });
    // The separated result is valid LaTeX; the fused one is what we're avoiding.
    expect(isValidLatex("a\\pi a")).toBe(true);
    expect(isValidLatex("a\\pia")).toBe(false);
  });

  it("inserts verbatim when nothing follows or the next char can't fuse", () => {
    expect(mathCommandInsertion("\\pi", "")).toEqual({
      text: "\\pi",
      caretOffset: 3,
    });
    // Digits and symbols already terminate a control word on their own.
    expect(mathCommandInsertion("\\pi", "2")).toEqual({
      text: "\\pi",
      caretOffset: 3,
    });
    expect(mathCommandInsertion("\\pi", "+")).toEqual({
      text: "\\pi",
      caretOffset: 3,
    });
  });

  it("inserts verbatim when the latex doesn't end in a control word", () => {
    // A trailing brace/script can't swallow a following letter, and the caret
    // stays in the first empty slot.
    expect(mathCommandInsertion("\\frac{}{}", "a")).toEqual({
      text: "\\frac{}{}",
      caretOffset: "\\frac{".length,
    });
    expect(mathCommandInsertion("^{}", "x")).toEqual({
      text: "^{}",
      caretOffset: 2,
    });
  });
});
