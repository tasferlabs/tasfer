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

  it("an empty query returns the whole catalog in order", () => {
    expect(filterMathCommands("")).toHaveLength(MATH_COMMANDS.length);
    expect(filterMathCommands("")[0].id).toBe(MATH_COMMANDS[0].id);
  });

  it("a non-matching query returns nothing", () => {
    expect(filterMathCommands("zzzznope")).toHaveLength(0);
  });
});
