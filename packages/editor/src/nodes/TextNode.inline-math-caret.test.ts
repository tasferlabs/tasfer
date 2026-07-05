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
import { startSelection, updateSelectionFocus } from "../selection";
import { loadPage } from "../serlization/loadPage";
import { createInitialState } from "../state-utils";
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

  describe("a selection confined within a chip hugs the selected row", () => {
    // "aa $\frac{a}{b}$": "aa " is 0..2, the chip `\frac{a}{b}` spans [3, 14).
    // Within the chip's LaTeX the numerator `a` is at offset 6 and the
    // denominator `b` at offset 9 → block indices 9 and 12.
    const fracBlock = loadPage("aa $\\frac{a}{b}$").blocks[0] as TextualBlock;
    const fracLayout = node.computeLayout(
      fracBlock,
      1000,
      styles,
      undefined,
      marks,
    );
    const lineHeight = fracLayout.lines[0].height;
    const rectsFor = (from: number, to: number) =>
      node.selectionRects(
        fracLayout,
        {
          anchor: { blockIndex: 0, textIndex: from },
          focus: { blockIndex: 0, textIndex: to },
          isForward: true,
        },
        0,
        0,
        0,
      );
    const bounds = (from: number, to: number) => {
      const rects = rectsFor(from, to);
      const top = Math.min(...rects.map((r) => r.y));
      const bottom = Math.max(...rects.map((r) => r.y + r.height));
      return { rects, top, bottom, height: bottom - top };
    };

    it("selecting the denominator highlights only the denominator row, not the whole fraction", () => {
      const denom = bounds(12, 13); // `b`
      expect(denom.rects.length).toBeGreaterThan(0);
      // The bug: the rect spanned the full (inflated) line box. It must now be
      // meaningfully shorter than that box.
      expect(denom.height).toBeLessThan(lineHeight * 0.7);
    });

    it("numerator and denominator selections sit on different rows", () => {
      const numer = bounds(9, 10); // `a`
      const denom = bounds(12, 13); // `b`
      // Numerator is drawn above the denominator (smaller y = higher on screen).
      expect(numer.top).toBeLessThan(denom.top);
      expect(numer.bottom).toBeLessThanOrEqual(denom.top + 1);
    });

    it("hit-testing a whole-chip selection reports the chip's full atomic box", () => {
      // The chip `\frac{a}{b}` spans [3, 14). Painting the full selection hugs the
      // glyph rows (tall fraction ⇒ a rect meaningfully shorter than the line box),
      // but the point-in-selection hit-test (`hitTest: true`) must report the whole
      // chip's advance at full line height — so a tap anywhere on the selected chip,
      // including the inflated padding between the numerator and denominator rows,
      // registers as touching the selection and opens the context menu.
      const paint = bounds(3, 14);
      expect(paint.height).toBeLessThan(lineHeight * 0.95);

      const hitRects = node.selectionRects(
        fracLayout,
        {
          anchor: { blockIndex: 0, textIndex: 3 },
          focus: { blockIndex: 0, textIndex: 14 },
          isForward: true,
        },
        0,
        0,
        0,
        true, // continuous
        true, // hitTest
      );
      const top = Math.min(...hitRects.map((r) => r.y));
      const bottom = Math.max(...hitRects.map((r) => r.y + r.height));
      expect(bottom - top).toBeCloseTo(lineHeight, 1);
      // Spans the chip's advance: left edge ≈ chip start caret, right ≈ chip end.
      const left = Math.min(...hitRects.map((r) => r.x));
      const right = Math.max(...hitRects.map((r) => r.x + r.width));
      expect(left).toBeCloseTo(node.caretRect(fracLayout, 3, 0, 0).x, 0);
      expect(right).toBeCloseTo(node.caretRect(fracLayout, 14, 0, 0).x, 0);
    });

    it("a partial sub-range keeps its tight glyph row even when hit-testing", () => {
      // Only the denominator `b` is selected: a tap must still land on that row,
      // not balloon to the whole chip — partial selections aren't atomic.
      const hitRects = node.selectionRects(
        fracLayout,
        {
          anchor: { blockIndex: 0, textIndex: 12 },
          focus: { blockIndex: 0, textIndex: 13 },
          isForward: true,
        },
        0,
        0,
        0,
        true, // continuous
        true, // hitTest
      );
      const top = Math.min(...hitRects.map((r) => r.y));
      const bottom = Math.max(...hitRects.map((r) => r.y + r.height));
      expect(bottom - top).toBeLessThan(lineHeight * 0.7);
    });
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

describe("inline-math chip range selection snaps to whole constructs", () => {
  // "aa $\frac{a}{b}$": the chip `\frac{a}{b}` spans block [3, 14). A drag /
  // Shift+Arrow endpoint that lands inside the chip's fraction must widen to the
  // whole construct, just like a block equation — you can't select PART of it.
  const dragSelect = (anchorIndex: number, focusIndex: number) => {
    const page = loadPage("aa $\\frac{a}{b}$");
    let state = createInitialState(page);
    state = startSelection(state, { blockIndex: 0, textIndex: anchorIndex });
    state = updateSelectionFocus(state, {
      blockIndex: 0,
      textIndex: focusIndex,
    });
    return state.document.selection;
  };

  it("widens a focus that lands in the chip's denominator to the whole chip", () => {
    // Anchor after the chip (block 14), focus into the denominator (block 12).
    const selection = dragSelect(14, 12);
    expect(selection?.anchor.textIndex).toBe(14);
    expect(selection?.focus.textIndex).toBe(3);
  });

  it("leaves a selection that stops at the chip's outer edge untouched", () => {
    // Selecting just the leading "aa " up to the chip's start is a legal edge.
    const selection = dragSelect(0, 3);
    expect(selection?.anchor.textIndex).toBe(0);
    expect(selection?.focus.textIndex).toBe(3);
  });
});

describe("inline-math chip magnifier caret-drag descends into fraction rows", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();

  // "aa $\frac{a}{b}$": chip [3, 14); numerator `a` → block 9, denominator `b` → 12.
  const block = loadPage("aa $\\frac{a}{b}$").blocks[0] as TextualBlock;
  const layout = node.computeLayout(block, 1000, styles, undefined, marks);
  const x = node.caretRect(layout, 9, 0, 0).x; // over the numerator/denominator
  const y0 = layout.lines[0].y;
  const y1 = y0 + layout.lines[0].height;

  // Drag mode + hysteresis anchor (current caret block index) are the trailing
  // args to positionFromPoint.
  const drag = (y: number, prev: number | null = null) =>
    node.positionFromPoint(block, layout, x, y, 0, 0, true, prev);

  it("a vertical drag descends into the numerator high and the denominator low", () => {
    // The whole point of A: dragging the caret up lands in the numerator (block 9),
    // down lands in the denominator (block 12).
    expect(drag(y0 + 1)).toBe(9);
    expect(drag(y1 - 1)).toBe(12);
  });

  it("holds the current row against wobble (hysteresis)", () => {
    // First y (scanning down) at which each resolution crosses numerator→denominator.
    const firstSwitch = (prev: number | null) => {
      for (let y = y0; y <= y1; y += 0.5) if (drag(y, prev) === 12) return y;
      return Infinity;
    };
    const freshSwitch = firstSwitch(null); // no current caret → no hysteresis
    const heldInNumerator = firstSwitch(9); // caret already in the numerator

    // A caret held in the numerator only crosses to the denominator once the
    // finger has travelled meaningfully FURTHER down than a fresh resolution
    // would — so a small wobble across the midpoint doesn't flip the row.
    expect(heldInNumerator).toBeGreaterThan(freshSwitch);
    // …but a decisive drag to the bottom of the chip still reaches the denominator.
    expect(drag(y1 - 1, 9)).toBe(12);
  });

  it("a precise tap still descends into the exact row", () => {
    // Tapping (no drag flag) resolves to an interior offset by exact row — the
    // hysteresis is a drag-only affordance.
    const tapped = node.positionFromPoint(block, layout, x, y0 + 2, 0, 0);
    expect(tapped).toBeGreaterThan(3); // strictly inside the chip [3, 14)
    expect(tapped).toBeLessThan(14);
  });
});

describe("inline-math chip drag holds steady at the chip's outer edge", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();

  // Chip first so its real (tex-measured) width anchors the geometry — jsdom
  // measures the plain-text tail as zero-width. "\frac{a}{b}" spans [0, 11);
  // numerator `a` stops at 6/7, denominator `b` at 9/10, boundaries 0 and 11.
  const block = loadPage("$\\frac{a}{b}$ aa").blocks[0] as TextualBlock;
  const layout = node.computeLayout(block, 1000, styles, undefined, marks);
  const chipRightX = node.caretRect(layout, 11, 0, 0).x;
  const numRect = node.caretRect(layout, 7, 0, 0);
  const numRowY = numRect.y + numRect.height / 2;

  const drag = (x: number, y: number, prev: number | null) =>
    node.positionFromPoint(block, layout, x, y, 0, 0, true, prev);

  it("a caret held in the numerator survives a wobble just past the chip's edge", () => {
    // The finger sits at the numerator row but drifts 2px past the chip's
    // x-extent. Pre-fix the x-range gate snapped straight to the boundary (11)
    // with no hysteresis; now tex's 2-D drag resolution keeps the nearer
    // numerator stop.
    const held = drag(chipRightX + 2, numRowY, 7);
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(11); // still interior…
    expect([6, 7]).toContain(held); // …on the numerator row

    // A fresh drag (no caret inside the chip) at the same point resolves
    // outside, as before.
    expect(drag(chipRightX + 2, numRowY, null)).toBe(11);
  });

  it("wobbling across the edge never oscillates interior↔boundary", () => {
    // Simulate the magnifier drag's frame loop: the resolved position feeds
    // back as the next frame's hysteresis anchor while the finger jitters
    // ±2px across the chip's right edge. Pre-fix this alternated between a
    // numerator stop and the outer boundary every frame — the reported
    // magnifier bounce at fraction edges.
    let prev = 7;
    const seen = new Set<number>();
    for (let frame = 0; frame < 8; frame++) {
      const x = chipRightX + (frame % 2 === 0 ? 2 : -2);
      prev = drag(x, numRowY, prev);
      seen.add(prev);
    }
    expect(seen.size).toBe(1);
  });

  it("a decisive drag out of the chip still releases the caret to the edge", () => {
    // Near the baseline (the chip's outer row) and decisively past the extent —
    // beyond the exit-hysteresis margin (0.3 × the chip's scaled font size) —
    // the boundary stop wins even against a held interior caret: the caret
    // comes to REST beside the chip instead of being trapped inside.
    const line = layout.lines[0];
    const baselineY = line.y + (line.baselineOffset ?? 0);
    expect(drag(chipRightX + 12, baselineY, 7)).toBe(11);
  });
});
