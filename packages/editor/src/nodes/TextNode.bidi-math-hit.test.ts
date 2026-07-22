/**
 * Inline-math chips inside mixed-direction (bidi) lines.
 *
 * A chip embedded in an RTL/bidi paragraph is reordered visually away from its
 * logical position, so clicks resolve through the bidi hit-test path. The chip
 * is one atomic anchor char: a click on its body must snap to one of its two
 * flat EDGES (the near one), never to a run boundary elsewhere in the line and
 * never to a phantom interior index. Double-click selection treats the chip as
 * the word it visually is — the whole run — in LTR and RTL alike.
 */
import {
  createMathTestMarkRegistry,
  createMathTestState,
  loadMathPage,
} from "../__testutils__/math";
import { selectWordAtPosition } from "../actions/actions";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("TextNode inline-math chip click inside a bidi line", () => {
  const styles = resolveTheme({});
  const marks = createMathTestMarkRegistry();
  const node = new TextNode();

  const chipRange = (layout: ReturnType<TextNode["computeLayout"]>) => {
    const text = layout.chars.map((c) => c.char).join("");
    const start = text.indexOf(STRUCTURED_MARK_ANCHOR_CHAR);
    return { start, end: start + 1 };
  };

  const snapsToChipEdges = (
    block: TextualBlock,
    layout: ReturnType<TextNode["computeLayout"]>,
  ) => {
    const { start, end } = chipRange(layout);
    const line =
      layout.lines.find((l) => start >= l.startIndex && start < l.endIndex) ??
      layout.lines[layout.lines.length - 1];
    const eA = node.caretRect(layout, start, 0, 0).x;
    const eB = node.caretRect(layout, end, 0, 0).x;
    const midY = line.y + line.height / 2;
    const lo = Math.min(eA, eB);
    const hi = Math.max(eA, eB);
    expect(hi - lo).toBeGreaterThan(5); // the anchor carries the formula width
    for (let frac = 0.2; frac < 1; frac += 0.2) {
      const x = lo + (hi - lo) * frac;
      const index = node.positionFromPoint(block, layout, x, midY, 0, 0);
      // Atomic: the answer must sit AT a chip edge. jsdom measures Arabic
      // glyphs as zero-width, which can collapse several prose boundaries onto
      // the chip edge's exact x — nearest-stop resolution may then report one
      // of those coincident indices, so compare by caret geometry, not index.
      const caretX = node.caretRect(layout, index, 0, 0).x;
      expect([eA, eB]).toContain(caretX);
    }
  };

  it("Arabic prose + Latin word + chip on a wide line (mixed runs)", () => {
    // The Latin word forces a real bidi split, so the chip resolves through
    // the reordered-run hit path.
    const block = loadMathPage("اااا abc $x^2$").blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 1000, styles, undefined, marks);
    expect(layout.isRTL).toBe(true);
    snapsToChipEdges(block, layout);
  });

  it("Arabic prose + chip on a wide line", () => {
    const block = loadMathPage("اااا $x^2$").blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 1000, styles, undefined, marks);
    expect(layout.isRTL).toBe(true);
    snapsToChipEdges(block, layout);
  });

  it("Arabic prose + chip on a narrow line (chip pushed by wrap)", () => {
    const block = loadMathPage("اااا اتاااار كلمة أخرى $x^2$")
      .blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 120, styles, undefined, marks);
    expect(layout.isRTL).toBe(true);
    expect(layout.lines.length).toBeGreaterThan(1);
    snapsToChipEdges(block, layout);
  });

  // Double-click (selectWordAtPosition): the chip's only flat positions are
  // its edges, and an offset resting on either edge selects the run whole —
  // construct-level sub-selection lives in the nested model now.
  const wholeChip = (content: string) => {
    const page = loadMathPage(content);
    const block = page.blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 1000, styles, undefined, marks);
    const { start, end } = chipRange(layout);
    const state = createMathTestState(page);
    const sel = selectWordAtPosition(state, {
      blockIndex: 0,
      textIndex: start,
    }).document.selection;
    return { sel, start, end };
  };

  it("double-click on the chip selects the whole chip (LTR)", () => {
    const { sel, start, end } = wholeChip("aa $x^2$");
    expect(sel?.anchor.textIndex).toBe(start);
    expect(sel?.focus.textIndex).toBe(end);
  });

  it("double-click on the chip selects the whole chip (RTL/bidi)", () => {
    const { sel, start, end } = wholeChip("اااا $x^2$");
    expect(sel?.anchor.textIndex).toBe(start);
    expect(sel?.focus.textIndex).toBe(end);
  });

  it("a multi-construct formula is still one flat word — the whole chip", () => {
    // `\sqrt{x}+1` is several constructs, but the flat model sees one anchor
    // char: word selection cannot take "just the \sqrt{x}" anymore.
    const { sel, start, end } = wholeChip("aa $\\sqrt{x}+1$");
    expect(end - start).toBe(1);
    expect(sel?.anchor.textIndex).toBe(start);
    expect(sel?.focus.textIndex).toBe(end);
  });
});

// A double-click resolved from the POINT (a tap on the chip's glyph box) must
// also select the run whole, even where the resolved OFFSET would land on a
// boundary shared with the surrounding prose. `wordRangeFromPoint` answers for
// points over a replacement run; `selectWordAtPosition` applies a caller-
// resolved point range verbatim.
describe("TextNode double-click on a chip by point", () => {
  const styles = resolveTheme({});
  const marks = createMathTestMarkRegistry();
  const node = new TextNode();

  it("resolves the whole run from a point anywhere over the chip", () => {
    const page = loadMathPage("$\\det$ aa");
    const block = page.blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 1000, styles, undefined, marks);
    const text = layout.chars.map((c) => c.char).join("");
    expect(text.startsWith(STRUCTURED_MARK_ANCHOR_CHAR)).toBe(true);
    // The chip occupies block indices [0, 1); its drawn x-extent is between
    // the caret rects at those edges.
    const leftX = node.caretRect(layout, 0, 0, 0).x;
    const rightX = node.caretRect(layout, 1, 0, 0).x;
    const line = layout.lines[0];
    const midY = layout.insetY + line.y + line.height / 2;
    let hits = 0;
    for (let f = 0.15; f < 1; f += 0.15) {
      const x = leftX + (rightX - leftX) * f;
      const range = node.wordRangeFromPoint(layout, x, midY, 0, 0);
      expect(range).toEqual({ start: 0, end: 1 });
      hits++;
    }
    expect(hits).toBeGreaterThan(0);
  });

  it("selectWordAtPosition applies a caller-resolved point range verbatim", () => {
    const page = loadMathPage("$\\det$ aa");
    const state = createMathTestState(page);
    const sel = selectWordAtPosition(
      state,
      { blockIndex: 0, textIndex: 0 },
      { start: 0, end: 1 },
    ).document.selection;
    expect(sel?.anchor.textIndex).toBe(0);
    expect(sel?.focus.textIndex).toBe(1);
  });

  it("without the point range, a boundary offset still selects the chip whole", () => {
    const page = loadMathPage("$\\det$ aa");
    const state = createMathTestState(page);
    const sel = selectWordAtPosition(state, {
      blockIndex: 0,
      textIndex: 0,
    }).document.selection;
    expect(sel?.anchor.textIndex).toBe(0);
    expect(sel?.focus.textIndex).toBe(1);
  });
});
