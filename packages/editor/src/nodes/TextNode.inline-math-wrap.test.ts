/**
 * Inline-math chip line wrapping — whole-unit only.
 *
 * A chip is ONE atomic flat char (the anchor) whose measured advance is the
 * full formula width, so the line breaker can only move the chip as a whole:
 * it never splits a formula at its internal operators. A chip wider than the
 * available width overflows its line instead of breaking, exactly like an
 * unbreakable word. This replaces the old operator-breakpoint reflow
 * (`MarkReplacement.breakpoints`), which existed only for the flat-LaTeX chip
 * model.
 */
import {
  createMathTestMarkRegistry,
  loadMathPage,
} from "../__testutils__/math";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("TextNode inline-math wrap — chip is one unbreakable unit", () => {
  const styles = resolveTheme({});
  const marks = createMathTestMarkRegistry();
  const node = new TextNode();

  // A formula with many top-level operators. Under the old model every `+` was
  // a legal wrap point; now none of them are.
  const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p";

  const layoutAt = (content: string, width: number) => {
    const block = loadMathPage(content).blocks[0] as TextualBlock;
    return {
      block,
      layout: node.computeLayout(block, width, styles, undefined, marks),
    };
  };

  it("keeps a wide formula on one line when it fits", () => {
    const { layout } = layoutAt(`$${latex}$`, 4000);
    expect(layout.lines.length).toBe(1);
  });

  it("overflows a formula wider than the line instead of splitting it", () => {
    const { layout } = layoutAt(`$${latex}$`, 120);
    // The chip is the block's only char; were operator breakpoints still
    // consulted this would wrap onto several lines. It must stay one line...
    expect(layout.lines.length).toBe(1);
    expect(layout.lines[0].text).toBe(STRUCTURED_MARK_ANCHOR_CHAR);
    // ...whose single anchor char really is wider than the available width
    // (i.e. the one-line result is an overflow, not a fit).
    const left = node.caretRect(layout, 0, 0, 0).x;
    const right = node.caretRect(layout, 1, 0, 0).x;
    expect(right - left).toBeGreaterThan(120);
  });

  it("wraps a chip preceded by prose to its own line, whole", () => {
    const { layout } = layoutAt(`hello $${latex}$ tail`, 120);
    // Prose before, the whole chip alone on its line (it fits nowhere else),
    // prose after — the formula's operators never leak across lines.
    const chipLine = layout.lines.find((line) =>
      line.text.includes(STRUCTURED_MARK_ANCHOR_CHAR),
    );
    expect(chipLine).toBeDefined();
    expect(chipLine?.text).toBe(STRUCTURED_MARK_ANCHOR_CHAR);
    const joined = layout.lines.map((line) => line.text).join("");
    expect(joined.startsWith("hello")).toBe(true);
    expect(joined.includes("tail")).toBe(true);
  });

  it("keeps the chip atomic in an RTL paragraph too", () => {
    // The old model split chips at operators in LTR only; now both directions
    // share the same whole-unit rule, so an RTL host wraps the chip whole.
    const { layout } = layoutAt(`مرحبا بالعالم وأهلا $${latex}$`, 120);
    expect(layout.isRTL).toBe(true);
    const chipLine = layout.lines.find((line) =>
      line.text.includes(STRUCTURED_MARK_ANCHOR_CHAR),
    );
    expect(chipLine?.text).toBe(STRUCTURED_MARK_ANCHOR_CHAR);
  });

  it("grows the chip's line box around the formula", () => {
    const { layout } = layoutAt(`hello $\\frac{\\frac{a}{b}}{c}$ tail`, 4000);
    // The fraction is taller than the prose line height, and the line grows
    // around the chip as a unit (there are no per-fragment slices anymore).
    expect(layout.lines.length).toBe(1);
    expect(layout.lines[0].height).toBeGreaterThan(layout.lineHeight);
  });

  it("places the caret at the wrapped chip's own line", () => {
    const { layout } = layoutAt(`hello $${latex}$ tail`, 120);
    const chipLine = layout.lines.find((line) =>
      line.text.includes(STRUCTURED_MARK_ANCHOR_CHAR),
    );
    expect(chipLine).toBeDefined();
    if (!chipLine) return;
    // The chip's leading edge caret sits in the chip line's vertical band, not
    // up on the prose line the chip wrapped away from.
    const caret = node.caretRect(layout, chipLine.startIndex, 0, 0);
    expect(caret.y).toBeGreaterThanOrEqual(chipLine.y - 1);
    expect(caret.y).toBeLessThanOrEqual(chipLine.y + chipLine.height + 1);
  });
});
