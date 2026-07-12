/**
 * RTL fallback for inline-math reflow.
 *
 * Internal line-breaking of inline math is an LTR-only feature here. In a
 * right-to-left line a formula stays an atomic LTR box — the model every
 * mainstream system uses (browsers/KaTeX/MathJax keep inline math an atomic
 * inline-block; bidi TeX places it as one LTR box) — because the RTL
 * caret/selection/paint paths treat a chip atomically, so splitting it in
 * `wrapText` would only diverge from them. An atomic chip still wraps as a WHOLE
 * unit. This pins that an RTL paragraph does NOT split a wide chip at its
 * operators, while the LTR counterpart (see `TextNode.inline-math-wrap.test.ts`)
 * does.
 */
import {
  createMathTestMarkRegistry,
  loadMathPage,
} from "../__testutils__/math";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("TextNode inline-math reflow — RTL keeps the chip atomic", () => {
  const styles = resolveTheme({});
  const marks = createMathTestMarkRegistry();
  const node = new TextNode();

  // A wide formula made of top-level operators (an LTR line would split it at
  // every `+`), embedded after Arabic text so the line resolves as RTL.
  const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p";

  it("does not split a wide chip at operators in an RTL line", () => {
    const block = loadMathPage(`مرحبا بالعالم وأهلا $${latex}$`)
      .blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 120, styles, undefined, marks);
    expect(layout.isRTL).toBe(true);

    // The chip is atomic: no continuation line begins with one of the formula's
    // top-level operators (which is exactly what the LTR split produces).
    for (let i = 1; i < layout.lines.length; i++) {
      const first = layout.lines[i].text[0];
      // A line may start with the Arabic word or the whole chip, never a bare
      // operator carved out of the middle of the formula.
      expect("+-=".includes(first)).toBe(false);
    }
  });

  it("LTR control: the same formula DOES split at operators", () => {
    const block = loadMathPage(`hello $${latex}$`).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 120, styles, undefined, marks);
    expect(layout.isRTL).toBe(false);
    const splitLeads = layout.lines
      .slice(1)
      .some((l) => "+-=".includes(l.text[0]));
    expect(splitLeads).toBe(true);
  });
});
