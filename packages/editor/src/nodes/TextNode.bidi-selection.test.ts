import { notifyFontsChanged } from "../fonts";
import { createDefaultMarkRegistry } from "../rendering/marks";
import { loadPage } from "../serlization/loadPage";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { beforeAll, describe, expect, it } from "vitest";

// Length-proportional canvas stub: measured width == char count * K. This makes
// selection geometry deterministic and shaping-neutral, so the assertions test
// the bidi REORDERING, not real font metrics.
const K = 10;
beforeAll(() => {
  const g = globalThis as unknown as {
    document: { createElement: () => unknown };
  };
  g.document.createElement = () =>
    ({
      getContext: () => ({
        measureText: (t: string) => ({
          width: t.length * K,
          fontBoundingBoxAscent: 12,
          fontBoundingBoxDescent: 4,
        }),
        set font(_v: string) {},
        set direction(_v: string) {},
      }),
      style: {},
      setAttribute: () => {},
      appendChild: () => {},
    }) as unknown;
  notifyFontsChanged();
});

describe("bidi-aware selection rectangles", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();

  function rectsFor(content: string, from: number, to: number) {
    const block = loadPage(content).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 2000, styles, undefined, marks);
    const rects = node.selectionRects(
      layout,
      {
        anchor: { blockIndex: 0, textIndex: from },
        focus: { blockIndex: 0, textIndex: to },
        isForward: true,
      },
      0,
      100, // originX
      0,
      true,
    );
    return { layout, rects };
  }

  it("word order is visually reversed inside an embedded RTL run (the bug)", () => {
    // "اااا. اتاااار aaaaa ..." is an LTR line; the two Arabic words + "." join
    // into ONE rtl run, so word1 renders visually RIGHT and word2 visually LEFT.
    const content = "اااا. اتاااار aaaaa hello world foo bar baz";
    const word1 = rectsFor(content, 0, 4).rects; // "اااا"
    const word2 = rectsFor(content, 6, 13).rects; // "اتاااار"
    expect(word1.length).toBeGreaterThan(0);
    expect(word2.length).toBeGreaterThan(0);
    // The clicked second word must highlight to the LEFT of the first word.
    expect(word2[0].x).toBeLessThan(word1[0].x);
    // And both rects have real width.
    expect(word2[0].width).toBeGreaterThan(0);
    expect(word1[0].width).toBeGreaterThan(0);
  });

  it("pure LTR selection is a single left-anchored rect (regression)", () => {
    const { rects } = rectsFor("hello world foo", 0, 5); // "hello"
    expect(rects.length).toBe(1);
    expect(rects[0].width).toBeCloseTo(5 * K, 3);
  });

  it("pure RTL line selects the word at the right edge (regression)", () => {
    // All-Arabic line → RTL; word sits at the right edge.
    const { layout, rects } = rectsFor("مرحبا بالعالم", 0, 5); // first word
    expect(layout.isRTL).toBe(true);
    expect(rects.length).toBe(1);
    expect(rects[0].width).toBeCloseTo(5 * K, 3);
  });

  it("selecting across a bidi boundary yields separate rects per run", () => {
    // Select from inside the Arabic run through into the Latin run.
    const content = "اااا. اتاااار aaaaa hello world foo bar baz";
    const { rects } = rectsFor(content, 6, 18); // word2 + " aaaa"
    // At least two rects: one for the RTL segment, one for the LTR segment.
    expect(rects.length).toBeGreaterThanOrEqual(2);
  });

  const CONTENT = "اااا. اتاااار aaaaa hello world foo bar baz";

  function build(content: string) {
    const block = loadPage(content).blocks[0] as TextualBlock;
    const layout = node.computeLayout(block, 2000, styles, undefined, marks);
    return { block, layout };
  }

  it("caret in an embedded RTL word sits visually left of an earlier word", () => {
    const { layout } = build(CONTENT);
    const c1 = node.caretRect(layout, 2, 100, 0); // inside word1 (اااا)
    const c2 = node.caretRect(layout, 9, 100, 0); // inside word2 (اتاااار)
    // Word2 is logically later but visually LEFT (reversed inside the rtl run).
    expect(c2.x).toBeLessThan(c1.x);
  });

  it("hit-test round-trips a caret x back to its logical index (bidi line)", () => {
    const { block, layout } = build(CONTENT);
    for (const idx of [2, 9, 22]) {
      const caret = node.caretRect(layout, idx, 100, 0);
      const pos = node.positionFromPoint(
        block,
        layout,
        caret.x,
        caret.y + 2,
        100,
        0,
      );
      expect(pos).toBe(idx);
    }
  });
});
