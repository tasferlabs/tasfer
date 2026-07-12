import {
  createMathTestMarkRegistry,
  loadMathPage,
} from "../__testutils__/math";
import { resolveTheme } from "../styles";
import { getInlineMathDims } from "./math";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("TextNode inline-math line metrics", () => {
  const styles = resolveTheme({});
  const marks = createMathTestMarkRegistry();
  const node = new TextNode();

  it("expands the line and block for a tall matrix", () => {
    const latex = "\\begin{bmatrix}2&2\\\\2&2\\end{bmatrix}";
    const block = loadMathPage(`before $${latex}$ after`)
      .blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 1000, styles, undefined, marks);
    const line = layout.lines[0];
    const dims = getInlineMathDims(latex, layout.textStyle.fontSize)!;

    expect(line.height).toBeGreaterThan(layout.lineHeight);
    expect(line.height).toBeGreaterThanOrEqual(dims.height);
    expect(line.baselineOffset).toBeGreaterThanOrEqual(
      dims.height - dims.depthBelowBaseline,
    );
    expect(layout.height).toBe(
      layout.insetY + line.height + layout.textStyle.paddingBottom,
    );
  });

  it("positions following wrapped lines after the expanded math line", () => {
    const block = loadMathPage(
      "one two three $\\begin{bmatrix}2&2\\\\2&2\\end{bmatrix}$ four five six",
    ).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 80, styles, undefined, marks);

    expect(layout.lines.length).toBeGreaterThan(1);
    for (let i = 1; i < layout.lines.length; i++) {
      expect(layout.lines[i].y).toBe(
        layout.lines[i - 1].y + layout.lines[i - 1].height,
      );
    }
  });

  it("aligns a boundary caret with text instead of the expanded line top", () => {
    const latex = "\\begin{bmatrix}2&2\\\\2&2\\end{bmatrix}";
    const block = loadMathPage(`aa $${latex}$`).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 1000, styles, undefined, marks);
    const line = layout.lines[0];
    const caret = node.caretRect(layout, 3, 0, 0);
    const textAscent = Number.isFinite(layout.fontMetrics.ascent)
      ? layout.fontMetrics.ascent
      : layout.textStyle.fontSize * 0.8;

    expect(caret.y).toBeCloseTo(line.y + line.baselineOffset! - textAscent);
    expect(caret.y).toBeGreaterThan(line.y);
  });
});
