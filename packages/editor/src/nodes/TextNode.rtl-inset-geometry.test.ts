import { notifyFontsChanged } from "../fonts";
import { getBlockTextContent } from "../node-shared";
import type { NodePaintCtx } from "../rendering/nodes/Node";
import { loadPage } from "../serlization/loadPage";
import { createInitialState } from "../state-utils";
import { resolveTheme } from "../styles";
import { ListNode } from "./ListNode";
import { QuoteNode } from "./QuoteNode";
import { TextNode, type TextNodeLayout, type TextualBlock } from "./TextNode";
import { beforeAll, describe, expect, it } from "vitest";

// Selection highlight, caret and click mapping must land on the glyphs the
// painter draws. RTL blocks with a leading inset (nested list indent, a quote's
// accent, a code box's padding) used to measure from a different text edge than
// the painter, so a double-clicked word lit up shifted toward the marker side.

// Length-proportional canvas stub (see TextNode.bidi-selection.test.ts): width
// == char count * K, so geometry is deterministic.
const K = 10;
function measure(t: string) {
  return {
    width: t.length * K,
    fontBoundingBoxAscent: 12,
    fontBoundingBoxDescent: 4,
  };
}
beforeAll(() => {
  const g = globalThis as unknown as {
    document: { createElement: () => unknown };
  };
  g.document.createElement = () =>
    ({
      getContext: () => ({
        measureText: measure,
        set font(_v: string) {},
        set direction(_v: string) {},
      }),
      style: {},
      setAttribute: () => {},
      appendChild: () => {},
    }) as unknown;
  notifyFontsChanged();
});

/** A 2D context that records every `fillText` with the direction in force, and
 * accepts everything else. */
function textRecordingContext() {
  const texts: { text: string; left: number; right: number }[] = [];
  const stack: Record<string, unknown>[] = [];
  const props: Record<string, unknown> = {
    fillStyle: "#000",
    strokeStyle: "#000",
    globalAlpha: 1,
    lineWidth: 1,
    direction: "ltr",
    textAlign: "start",
    canvas: { width: 1000, height: 1000 },
  };
  const ctx = new Proxy(props, {
    get(target, prop: string) {
      if (prop === "save") return () => stack.push({ ...target });
      if (prop === "restore") {
        return () => {
          const saved = stack.pop();
          if (saved) Object.assign(target, saved);
        };
      }
      if (prop === "measureText") return measure;
      if (prop === "setLineDash" || prop === "getLineDash") return () => [];
      if (prop === "fillText") {
        return (text: string, x: number) => {
          const width = measure(text).width;
          // "start" aligns to the right edge under rtl (the painter's default).
          const rightAligned =
            target.textAlign === "right" ||
            (target.textAlign === "start" && target.direction === "rtl") ||
            (target.textAlign === "end" && target.direction === "ltr");
          texts.push({
            text,
            left: rightAligned ? x - width : x,
            right: rightAligned ? x : x + width,
          });
        };
      }
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}

const styles = resolveTheme({});
const MAX_WIDTH = 400;
const ORIGIN = { x: 40, y: 30 };

/** Lay out and paint block `index` of `markdown`; return where its own text was
 * drawn alongside the geometry the caret/selection/hit-test passes report. */
function paintAndMeasure(node: TextNode, markdown: string, index: number) {
  const page = loadPage(markdown);
  const state = createInitialState(page);
  const block = state.document.page.blocks[index] as TextualBlock;
  const text = getBlockTextContent(block);
  const layout = node.computeLayout(
    block,
    MAX_WIDTH,
    styles,
    undefined,
    state.marks,
  ) as TextNodeLayout;

  const { ctx, texts } = textRecordingContext();
  const c: NodePaintCtx = {
    ctx,
    state,
    styles,
    block,
    blockIndex: index,
    maxWidth: MAX_WIDTH,
    isFirst: index === 0,
    marks: state.marks,
    origin: ORIGIN,
    requestRedraw: () => {},
  };
  node.paint(layout, c);
  // The block's own glyphs — not a list marker ("1.") or a placeholder.
  const glyphs = texts.filter((t) => t.text.trim() && text.includes(t.text));
  expect(glyphs.length).toBeGreaterThan(0);
  const painted = {
    left: Math.min(...glyphs.map((g) => g.left)),
    right: Math.max(...glyphs.map((g) => g.right)),
  };

  const rects = node.selectionRects(
    layout,
    {
      anchor: { blockIndex: index, textIndex: 0 },
      focus: { blockIndex: index, textIndex: text.length },
      isForward: true,
    },
    index,
    ORIGIN.x,
    ORIGIN.y,
  );
  const selected = {
    left: Math.min(...rects.map((r) => r.x)),
    right: Math.max(...rects.map((r) => r.x + r.width)),
  };
  const caretAtStart = node.caretRect(layout, 0, ORIGIN.x, ORIGIN.y).x;
  const firstLine = layout.lines[0];
  const lineMidY =
    ORIGIN.y + layout.insetY + firstLine.y + firstLine.height / 2;
  // A click just inside the painted line-start edge resolves to offset 0.
  const startEdgeX = layout.isRTL ? painted.right - 2 : painted.left + 2;
  const clickedOffset = node.positionFromPoint(
    block,
    layout,
    startEdgeX,
    lineMidY,
    ORIGIN.x,
    ORIGIN.y,
  );
  return { layout, painted, selected, caretAtStart, clickedOffset, text };
}

describe("RTL text geometry matches the painted glyphs in inset blocks", () => {
  const cases: {
    name: string;
    node: TextNode;
    markdown: string;
    index: number;
  }[] = [
    {
      name: "plain paragraph",
      node: new TextNode(),
      markdown: "فقرة عربية",
      index: 0,
    },
    {
      name: "top-level bullet",
      node: new ListNode(),
      markdown: "- العنصر الأول",
      index: 0,
    },
    {
      name: "nested bullet",
      node: new ListNode(),
      markdown: "- العنصر الأول\n  - عنصر فرعي",
      index: 1,
    },
    {
      name: "deeper Hebrew bullet",
      node: new ListNode(),
      markdown: "- א\n  - ב\n    - פריט משנה",
      index: 2,
    },
    {
      name: "nested numbered item",
      node: new ListNode(),
      markdown: "1. الخطوة\n   1. الخطوة الثانية",
      index: 1,
    },
    {
      name: "todo item",
      node: new ListNode(),
      markdown: "- [ ] مهمة لم تنجز",
      index: 0,
    },
    {
      name: "quote",
      node: new QuoteNode(),
      markdown: "> الحكمة ضالة المؤمن",
      index: 0,
    },
    {
      name: "mixed Arabic + English bullet",
      node: new ListNode(),
      markdown: "- a\n  - العنصر الثاني مع English في المنتصف",
      index: 1,
    },
  ];

  for (const { name, node, markdown, index } of cases) {
    it(`${name}: highlight, caret and click sit on the painted text`, () => {
      const r = paintAndMeasure(node, markdown, index);
      expect(r.layout.isRTL).toBe(true);
      expect(r.selected.left).toBeCloseTo(r.painted.left, 3);
      expect(r.selected.right).toBeCloseTo(r.painted.right, 3);
      // RTL text starts at its right edge.
      expect(r.caretAtStart).toBeCloseTo(r.painted.right, 3);
      expect(r.clickedOffset).toBe(0);
    });
  }

  it("a quote mirrors its padding: RTL leaves the accent gap the LTR side has", () => {
    const quote = new QuoteNode();
    const ltr = paintAndMeasure(quote, "> abcd", 0);
    const rtl = paintAndMeasure(quote, "> ابجد", 0);
    const ltrGap = ltr.painted.left - ORIGIN.x;
    const rtlGap = ORIGIN.x + MAX_WIDTH - rtl.painted.right;
    expect(ltrGap).toBeGreaterThan(0);
    expect(rtlGap).toBeCloseTo(ltrGap, 3);
    // And both wrap to the same width.
    expect(rtl.layout.adjustedMaxWidth).toBe(ltr.layout.adjustedMaxWidth);
  });
});
