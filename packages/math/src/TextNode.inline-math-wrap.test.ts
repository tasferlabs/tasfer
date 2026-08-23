/**
 * Inline-math chip line wrapping — reflow at the formula's own break points.
 *
 * A chip is ONE atomic flat char (the anchor) whose formula lives in an
 * attachment, so it cannot be sliced by character index. The wrap slices its
 * canonical SOURCE instead: the first slice rides with the anchor char, each
 * continuation slice opens a line it owns no character on, and the text after
 * the formula resumes beside its last row. A formula with no top-level break
 * (a lone construct) still moves as one unit and overflows rather than
 * splitting.
 */
import { createMathTestMarkRegistry, loadMathPage } from "./__testutils__/math";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "@tasfer/editor/feature-facets";
import { TextNode, type TextualBlock } from "@tasfer/editor/nodes/TextNode";
import { resolveTheme } from "@tasfer/editor/styles";
import { describe, expect, it } from "vitest";

describe("TextNode inline-math wrap — a formula reflows across lines", () => {
  const styles = resolveTheme({});
  const marks = createMathTestMarkRegistry();
  const node = new TextNode();

  // A formula with many top-level operators — every `+` is a legal wrap point.
  const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p";
  // One construct, no top-level break: nothing to reflow at.
  const atomic = "\\frac{\\frac{a}{b}}{c}";

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
    expect(layout.lines[0].leadOffset).toBeUndefined();
  });

  it("reflows a formula wider than the line into continuation rows", () => {
    const { layout } = layoutAt(`$${latex}$`, 120);
    expect(layout.lines.length).toBeGreaterThan(1);
    // The anchor char sits on the first row; every later row is a lead slice
    // that owns no character at all.
    expect(layout.lines[0].text).toBe(STRUCTURED_MARK_ANCHOR_CHAR);
    for (const line of layout.lines.slice(1)) {
      expect(line.text).toBe("");
      expect(line.leadOffset).toBeGreaterThan(0);
    }
    // Every row fits the line — the point of reflowing rather than overflowing.
    for (const line of layout.lines)
      expect(line.width).toBeLessThanOrEqual(120);
    // The slices tile the source, in order and without gaps.
    const slices = layout.lineSlices.flatMap((s) => [
      ...(s.lead ? [s.lead] : []),
      ...s.anchored.values(),
    ]);
    expect(slices[0].sourceStart).toBe(0);
    expect(slices[slices.length - 1].sourceEnd).toBe(latex.length);
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i].sourceStart).toBe(slices[i - 1].sourceEnd);
    }
  });

  it("overflows a formula that has no break point instead of splitting it", () => {
    const { layout } = layoutAt(`$${atomic}$`, 10);
    expect(layout.lines.length).toBe(1);
    expect(layout.lines[0].text).toBe(STRUCTURED_MARK_ANCHOR_CHAR);
    const left = node.caretRect(layout, 0, 0, 0).x;
    const right = node.caretRect(layout, 1, 0, 0).x;
    expect(right - left).toBeGreaterThan(10);
  });

  it("resumes the trailing prose beside the formula's last row", () => {
    const { layout } = layoutAt(`hello $${latex}$ tail`, 120);
    const last = layout.lines[layout.lines.length - 1];
    expect(last.text).toContain("tail");
    // The trailing text starts past the last row rather than at the line edge.
    expect(last.leadOffset).toBeGreaterThan(0);
    const joined = layout.lines.map((line) => line.text).join("");
    expect(joined.startsWith("hello")).toBe(true);
    // The caret at the chip's trailing edge rests on that last row, past its
    // slice — not up on the row the anchor char lives on.
    const anchorIndex = joined.indexOf(STRUCTURED_MARK_ANCHOR_CHAR);
    const trailing = node.caretRect(layout, anchorIndex + 1, 0, 0);
    expect(trailing.y).toBeGreaterThanOrEqual(last.y);
    expect(trailing.x).toBeGreaterThanOrEqual(last.leadOffset ?? 0);
  });

  it("keeps the chip atomic in an RTL paragraph", () => {
    // A formula is an atomic LTR box inside a bidi line — the model browsers,
    // KaTeX and MathJax all use — so an RTL host wraps the chip whole.
    const { layout } = layoutAt(`مرحبا بالعالم وأهلا $${latex}$`, 120);
    expect(layout.isRTL).toBe(true);
    const chipLine = layout.lines.find((line) =>
      line.text.includes(STRUCTURED_MARK_ANCHOR_CHAR),
    );
    expect(chipLine?.text).toBe(STRUCTURED_MARK_ANCHOR_CHAR);
    expect(layout.lines.every((line) => line.leadOffset === undefined)).toBe(
      true,
    );
  });

  it("grows the chip's line box around the formula", () => {
    const { layout } = layoutAt(`hello $\\frac{\\frac{a}{b}}{c}$ tail`, 4000);
    // The fraction is taller than the prose line height, and the line grows
    // around the chip as a unit.
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
    // The chip's leading edge caret sits in the chip line's vertical band.
    const caret = node.caretRect(layout, chipLine.startIndex, 0, 0);
    expect(caret.y).toBeGreaterThanOrEqual(chipLine.y - 1);
    expect(caret.y).toBeLessThanOrEqual(chipLine.y + chipLine.height + 1);
  });
});
