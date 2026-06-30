/**
 * Inline-math reflow: a wide inline formula breaks across paragraph lines at its
 * top-level operators (instead of overflowing as one atomic chip), and the
 * caret/hit-test follow the reflowed slices. Pairs with the engine-level
 * `packages/tex` breakpoints/wrap tests.
 */
import { createDefaultMarkRegistry } from "../rendering/marks";
import { loadPage } from "../serlization/loadPage";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("TextNode inline-math reflow", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();

  // A formula with many top-level operators and no spaces, so every wrap is a
  // math break (which consumes no character) — the line texts concatenate back
  // to the source.
  const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p";

  it("keeps a wide formula on one line when it fits", () => {
    const block = loadPage(`$${latex}$`).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 4000, styles, undefined, marks);
    expect(layout.lines.length).toBe(1);
  });

  it("splits a wide formula across lines at operators", () => {
    const block = loadPage(`$${latex}$`).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 120, styles, undefined, marks);

    expect(layout.lines.length).toBeGreaterThan(1);
    // No characters lost or duplicated: math breaks consume no space.
    expect(layout.lines.map((l) => l.text).join("")).toBe(latex);
    // Every continuation line leads with the operator it broke before.
    for (let i = 1; i < layout.lines.length; i++) {
      expect("+-=".includes(layout.lines[i].text[0])).toBe(true);
    }
  });

  it("grows each line's height around its math fragment", () => {
    const block = loadPage(`$${latex}$`).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 120, styles, undefined, marks);
    for (const line of layout.lines) {
      expect(line.height).toBeGreaterThan(layout.lineHeight * 0.9);
    }
  });

  it("stacks the wrapped lines top to bottom with no overlap", () => {
    const block = loadPage(`$${latex}$`).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 120, styles, undefined, marks);
    for (let i = 1; i < layout.lines.length; i++) {
      expect(layout.lines[i].y).toBe(
        layout.lines[i - 1].y + layout.lines[i - 1].height,
      );
    }
  });

  it("places a caret deep in the formula on its continuation line", () => {
    const block = loadPage(`$${latex}$`).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 120, styles, undefined, marks);
    const lastLine = layout.lines[layout.lines.length - 1];

    // A caret index that lives on the last wrapped line (its char range).
    const idx = Math.floor((lastLine.startIndex + lastLine.endIndex) / 2);
    const caret = node.caretRect(layout, idx, 0, 0);
    // The caret sits within the last line's vertical band, not up on line 0.
    expect(caret.y).toBeGreaterThanOrEqual(lastLine.y - 1);
    expect(caret.y).toBeLessThanOrEqual(lastLine.y + lastLine.height + 1);
    expect(caret.exact).toBe(true);
  });

  it("round-trips a click on a continuation line back into the formula", () => {
    const block = loadPage(`$${latex}$`).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 120, styles, undefined, marks);
    const lastLine = layout.lines[layout.lines.length - 1];

    // Click near the middle of the last line; we should land at an index that
    // belongs to that line (i.e. inside the formula's last fragment).
    const caretMid = node.caretRect(
      layout,
      Math.floor((lastLine.startIndex + lastLine.endIndex) / 2),
      0,
      0,
    );
    const hit = node.positionFromPoint(
      block,
      layout,
      caretMid.x,
      caretMid.y + caretMid.height / 2,
      0,
      0,
    );
    expect(hit).toBeGreaterThanOrEqual(lastLine.startIndex);
    expect(hit).toBeLessThanOrEqual(lastLine.endIndex);
  });

  it("flows trailing text after the last fragment, not the whole formula", () => {
    // Text after a wrapped chip continues from the last fragment's line.
    const block = loadPage(`$${latex}$ tail`).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 120, styles, undefined, marks);
    const joined = layout.lines.map((l) => l.text).join("");
    // "tail" survives intact somewhere after the formula.
    expect(joined.includes("tail")).toBe(true);
  });
});
