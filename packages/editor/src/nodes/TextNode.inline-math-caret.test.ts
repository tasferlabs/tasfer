/**
 * Inline-math chip hit-testing and selection geometry — atomic flat model.
 *
 * A chip is ONE anchor char, so the flat model has exactly two caret positions
 * around it: its edges. A flat click on the chip's body snaps to the NEAR edge
 * (never a phantom interior index); placing the caret INSIDE the formula is a
 * nested-content concern, resolved through `contentSelectionFromPoint` into a
 * ContentSelection addressing the chip's attached MathDocument. A whole-chip
 * flat selection must still highlight the full painted formula, not one
 * char-width sliver.
 */
import {
  createMathTestMarkRegistry,
  createMathTestState,
  loadMathPage,
} from "../__testutils__/math";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("TextNode inline-math chip flat hit-test snaps to the near edge", () => {
  const styles = resolveTheme({});
  const marks = createMathTestMarkRegistry();
  const node = new TextNode();

  // "aa $x^2$" → flat text `aa ￼`; the chip is the single anchor char [3, 4).
  const chipStart = 3;
  const chipEnd = 4;
  const block = loadMathPage("aa $x^2$").blocks[0] as TextualBlock;
  const layout = node.computeLayout(block, 1000, styles, undefined, marks);

  // The chip's painted advance is the full formula width between its two
  // boundary carets.
  const chipLeftX = node.caretRect(layout, chipStart, 0, 0).x;
  const chipRightX = node.caretRect(layout, chipEnd, 0, 0).x;
  const midY = layout.lines[0].y + layout.lines[0].height / 2;

  const hit = (x: number) =>
    node.positionFromPoint(block, layout, x, midY, 0, 0);

  it("reserves the formula's full width for the single anchor char", () => {
    // Sanity for everything below: the anchor char's advance is the rendered
    // formula, not a one-char sliver.
    expect(layout.chars.map((c) => c.char).join("")).toBe(
      `aa ${STRUCTURED_MARK_ANCHOR_CHAR}`,
    );
    expect(chipRightX - chipLeftX).toBeGreaterThan(10);
  });

  it("snaps a click on the chip's left half to its leading edge", () => {
    for (const frac of [0.1, 0.25, 0.45]) {
      expect(hit(chipLeftX + (chipRightX - chipLeftX) * frac)).toBe(chipStart);
    }
  });

  it("snaps a click on the chip's right half to its trailing edge", () => {
    for (const frac of [0.55, 0.75, 0.9]) {
      expect(hit(chipLeftX + (chipRightX - chipLeftX) * frac)).toBe(chipEnd);
    }
  });

  it("never resolves a flat index strictly inside the chip", () => {
    // Interior flat offsets don't exist — the run is one char wide.
    for (let frac = 0.05; frac < 1; frac += 0.1) {
      const index = hit(chipLeftX + (chipRightX - chipLeftX) * frac);
      expect([chipStart, chipEnd]).toContain(index);
    }
  });

  it("lands in the prose when clicking before the chip", () => {
    expect(hit(chipLeftX - 3)).toBeLessThanOrEqual(chipStart);
  });

  it("lands at/after the chip when clicking past its right edge", () => {
    expect(hit(chipRightX + 5)).toBeGreaterThanOrEqual(chipEnd);
  });
});

describe("TextNode inline-math chip selection highlight", () => {
  const styles = resolveTheme({});
  const marks = createMathTestMarkRegistry();
  const node = new TextNode();

  // A tall chip so glyph-hugging vs full-line-box heights are distinguishable.
  // "aa $\frac{a}{b}$" → chip anchor at [3, 4).
  const block = loadMathPage("aa $\\frac{a}{b}$").blocks[0] as TextualBlock;
  const layout = node.computeLayout(block, 1000, styles, undefined, marks);
  const chipStart = 3;
  const chipEnd = 4;
  const chipLeftX = node.caretRect(layout, chipStart, 0, 0).x;
  const chipRightX = node.caretRect(layout, chipEnd, 0, 0).x;
  const lineHeight = layout.lines[0].height;

  const rectsFor = (hitTest: boolean) =>
    node.selectionRects(
      layout,
      {
        anchor: { blockIndex: 0, textIndex: chipStart },
        focus: { blockIndex: 0, textIndex: chipEnd },
        isForward: true,
      },
      0,
      0,
      0,
      true, // continuous
      hitTest,
    );

  it("a whole-chip flat selection spans the full formula width", () => {
    // The selection covers ONE flat char, but its highlight must cover the
    // whole painted formula — the anchor's advance — not a text-char width.
    const rects = rectsFor(false);
    expect(rects.length).toBeGreaterThan(0);
    const left = Math.min(...rects.map((r) => r.x));
    const right = Math.max(...rects.map((r) => r.x + r.width));
    expect(left).toBeCloseTo(chipLeftX, 0);
    expect(right).toBeCloseTo(chipRightX, 0);
  });

  it("the point-in-selection hit-test reports the chip's full atomic box", () => {
    // Painting hugs the glyph rows, but a tap anywhere on the selected chip —
    // including the padding between a fraction's rows — must register as
    // touching the selection (context-menu opening). `hitTest: true` therefore
    // reports the full line-height box across the chip's advance.
    const paintRects = rectsFor(false);
    const paintTop = Math.min(...paintRects.map((r) => r.y));
    const paintBottom = Math.max(...paintRects.map((r) => r.y + r.height));
    expect(paintBottom - paintTop).toBeLessThan(lineHeight);

    const hitRects = rectsFor(true);
    const top = Math.min(...hitRects.map((r) => r.y));
    const bottom = Math.max(...hitRects.map((r) => r.y + r.height));
    expect(bottom - top).toBeCloseTo(lineHeight, 1);
    const left = Math.min(...hitRects.map((r) => r.x));
    const right = Math.max(...hitRects.map((r) => r.x + r.width));
    expect(left).toBeCloseTo(chipLeftX, 0);
    expect(right).toBeCloseTo(chipRightX, 0);
  });
});

describe("TextNode inline-math chip interior resolves through nested content selection", () => {
  const styles = resolveTheme({});
  const node = new TextNode();

  // A fraction: the numerator and denominator are distinct nested text fields,
  // so vertical descent is observable in the returned ContentPoints.
  const state = createMathTestState(loadMathPage("aa $\\frac{a}{b}$"));
  const block = state.document.page.blocks[0] as TextualBlock;
  const layout = node.computeLayout(
    block,
    1000,
    styles,
    undefined,
    state.marks,
  );
  const chipLeftX = node.caretRect(layout, 3, 0, 0).x;
  const chipRightX = node.caretRect(layout, 4, 0, 0).x;
  const midX = (chipLeftX + chipRightX) / 2;
  const line = layout.lines[0];

  const nestedHit = (y: number) =>
    node.contentSelectionFromPoint(
      layout,
      { x: midX, y },
      {
        state,
        block,
        blockIndex: 0,
        maxWidth: 1000,
        isFirst: true,
        styles,
        marks: state.marks,
      },
      { pointerType: "mouse" },
    );

  it("a point over the chip returns a selection into the chip's attachment", () => {
    const selection = nestedHit(layout.insetY + line.y + line.height / 2);
    expect(selection).not.toBeNull();
    // The point addresses the mark's supplemental document, by contentId.
    const contentId = block.formats.find((f) => f.format.type === "math")
      ?.format.attrs?.contentId;
    expect(contentId).toBeDefined();
    expect(selection?.focus.contentId).toBe(contentId);
  });

  it("descends into the numerator high and the denominator low", () => {
    const high = nestedHit(layout.insetY + line.y + line.height * 0.2);
    const low = nestedHit(layout.insetY + line.y + line.height * 0.8);
    expect(high).not.toBeNull();
    expect(low).not.toBeNull();
    // Different rows land in different nested text nodes — the vertical
    // descent the flat model can no longer express.
    expect(high?.focus.kind).toBe("text");
    expect(low?.focus.kind).toBe("text");
    if (high?.focus.kind !== "text" || low?.focus.kind !== "text") return;
    expect(high.focus.nodeId).not.toBe(low.focus.nodeId);
  });

  it("a point off the chip resolves no nested selection", () => {
    const selection = nestedHit(layout.insetY + line.y + line.height / 2);
    expect(selection).not.toBeNull();
    const outside = node.contentSelectionFromPoint(
      layout,
      { x: chipLeftX - 3, y: layout.insetY + line.y + line.height / 2 },
      {
        state,
        block,
        blockIndex: 0,
        maxWidth: 1000,
        isFirst: true,
        styles,
        marks: state.marks,
      },
      { pointerType: "mouse" },
    );
    expect(outside).toBeNull();
  });
});
