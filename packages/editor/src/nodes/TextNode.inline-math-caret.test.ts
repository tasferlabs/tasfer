/**
 * Clicking an inline-math chip places the caret INSIDE the formula.
 *
 * A chip's boundary indices (`startIndex`/`endIndex`) are shared with the
 * surrounding text, so a caret there renders outside the chip. A click on the
 * chip therefore resolves to a strictly-interior position — clicking anywhere on
 * the formula lands inside it; the surrounding text/space is how you land
 * outside.
 */
import { createDefaultMarkRegistry } from "../rendering/marks";
import { loadPage } from "../serlization/loadPage";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("TextNode inline-math chip click → inside", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();

  // "aa $x^2$": "aa " is indices 0..2, the chip "x^2" spans [3, 6).
  const chipStart = 3;
  const chipEnd = 6;
  const block = loadPage("aa $x^2$").blocks[0] as TextualBlock;
  const layout = node.computeLayout(block, 1000, styles, undefined, marks);

  // Boundary carets sit at the chip's painted x-range edges.
  const chipLeftX = node.caretRect(layout, chipStart, 0, 0).x;
  const chipRightX = node.caretRect(layout, chipEnd, 0, 0).x;
  const midY = layout.lines[0].y + layout.lines[0].height / 2;

  const hit = (x: number) =>
    node.positionFromPoint(block, layout, x, midY, 0, 0);

  it("lands inside the chip for a click anywhere on its body", () => {
    for (let frac = 0.05; frac < 1; frac += 0.1) {
      const x = chipLeftX + (chipRightX - chipLeftX) * frac;
      const index = hit(x);
      expect(index).toBeGreaterThan(chipStart); // strictly inside
      expect(index).toBeLessThan(chipEnd);
    }
  });

  it("lands outside when clicking the text before the chip", () => {
    expect(hit(chipLeftX - 5)).toBeLessThanOrEqual(chipStart);
  });

  it("lands outside (at/after the chip) when clicking past its right edge", () => {
    expect(hit(chipRightX + 5)).toBeGreaterThanOrEqual(chipEnd);
  });

  it("a single-char chip has no interior, so a click falls to its edge", () => {
    const single = loadPage("aa $x$").blocks[0] as TextualBlock;
    const l = node.computeLayout(single, 1000, styles, undefined, marks);
    const start = 3;
    const leftX = node.caretRect(l, start, 0, 0).x;
    const y = l.lines[0].y + l.lines[0].height / 2;
    const index = node.positionFromPoint(single, l, leftX + 1, y, 0, 0);
    expect(index).toBe(start);
  });

  it("a selection edge inside a chip aligns with the caret there, not the chip's atomic edge", () => {
    // Selecting up to an interior chip offset must highlight to the glyph-accurate
    // x the caret sits at — not snap to the chip's left/right edge (the inline-math
    // selection-rendering bug). The selection's right edge should match caretRect.
    const interior = chipStart + 1; // strictly inside "x^2"
    const caretX = node.caretRect(layout, interior, 0, 0).x;
    const rects = node.selectionRects(
      layout,
      {
        anchor: { blockIndex: 0, textIndex: 0 },
        focus: { blockIndex: 0, textIndex: interior },
        isForward: true,
      },
      0,
      0,
      0,
    );
    expect(rects).toHaveLength(1);
    const right = rects[0].x + rects[0].width;
    expect(right).toBeCloseTo(caretX, 1);
    // And it must NOT equal the chip's right edge (which is where the old atomic
    // measure would have snapped it).
    const chipRight = node.caretRect(layout, chipEnd, 0, 0).x;
    expect(Math.abs(right - chipRight)).toBeGreaterThan(1);
  });
});
