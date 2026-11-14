import { notifyFontsChanged } from "../fonts";
import { getBlockTextContent } from "../node-shared";
import type { NodePaintCtx } from "../rendering/nodes/Node";
import { loadPage } from "../serlization/loadPage";
import { createInitialState } from "../state-utils";
import { resolveTheme } from "../styles";
import { TextNode, type TextNodeLayout, type TextualBlock } from "./TextNode";
import { beforeAll, describe, expect, it } from "vitest";

// A formatted piece of a mixed Arabic/English line used to be painted in
// typing order, so `مرحبا **Hello** world اليوم` drew "world Hello" while the
// caret and the highlight (which follow the bidi order) expected "Hello world".
// Every painted piece must sit exactly where the selection highlight for the
// same characters sits, and its underline / strike / chip must go with it.

// Length-proportional canvas stub: width == char count * K, so geometry is
// deterministic and shaping-neutral.
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

interface PaintedText {
  text: string;
  left: number;
  right: number;
  direction: string;
}
interface PaintedSpan {
  kind: "line" | "chip";
  left: number;
  right: number;
}

/** A 2D context that records every `fillText` (with the direction in force),
 * every stroked line and every rounded chip; it accepts everything else. */
function recordingContext() {
  const texts: PaintedText[] = [];
  const spans: PaintedSpan[] = [];
  const stack: Record<string, unknown>[] = [];
  let pathXs: number[] = [];
  let chip: { left: number; right: number } | null = null;
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
      if (prop === "beginPath") {
        return () => {
          pathXs = [];
          chip = null;
        };
      }
      if (prop === "moveTo" || prop === "lineTo") {
        return (x: number) => pathXs.push(x);
      }
      if (prop === "roundRect") {
        return (x: number, _y: number, w: number) => {
          chip = { left: x, right: x + w };
        };
      }
      if (prop === "stroke") {
        return () => {
          if (pathXs.length >= 2) {
            spans.push({
              kind: "line",
              left: Math.min(...pathXs),
              right: Math.max(...pathXs),
            });
          }
        };
      }
      if (prop === "fill") {
        return () => {
          if (chip) spans.push({ kind: "chip", ...chip });
        };
      }
      if (prop === "fillText") {
        return (text: string, x: number) => {
          const width = measure(text).width;
          const align = target.textAlign;
          const dir = target.direction;
          const rightAligned =
            align === "right" ||
            (align === "start" && dir === "rtl") ||
            (align === "end" && dir === "ltr");
          texts.push({
            text,
            left: rightAligned ? x - width : x,
            right: rightAligned ? x : x + width,
            direction: String(dir),
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
  return { ctx, texts, spans };
}

const styles = resolveTheme({});
const MAX_WIDTH = 600;
const ORIGIN = { x: 40, y: 30 };

function paint(markdown: string) {
  const node = new TextNode();
  const page = loadPage(markdown);
  const state = createInitialState(page);
  const block = state.document.page.blocks[0] as TextualBlock;
  const text = getBlockTextContent(block);
  const layout = node.computeLayout(
    block,
    MAX_WIDTH,
    styles,
    undefined,
    state.marks,
  ) as TextNodeLayout;
  const { ctx, texts, spans } = recordingContext();
  const c: NodePaintCtx = {
    ctx,
    state,
    styles,
    block,
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    marks: state.marks,
    origin: ORIGIN,
    requestRedraw: () => {},
  };
  node.paint(layout, c);

  /** Where the selection highlight puts the characters `[from, to)`. */
  const highlight = (from: number, to: number) => {
    const rects = node.selectionRects(
      layout,
      {
        anchor: { blockIndex: 0, textIndex: from },
        focus: { blockIndex: 0, textIndex: to },
        isForward: true,
      },
      0,
      ORIGIN.x,
      ORIGIN.y,
    );
    return {
      left: Math.min(...rects.map((r) => r.x)),
      right: Math.max(...rects.map((r) => r.x + r.width)),
      width: rects.reduce((sum, r) => sum + r.width, 0),
    };
  };

  /** Painted box of the piece holding `word` (one piece per word here). */
  const paintedWord = (word: string) => {
    const piece = texts.find((t) => t.text.includes(word));
    expect(piece, `no painted piece holds "${word}"`).toBeDefined();
    const p = piece as PaintedText;
    const at = p.text.indexOf(word);
    // Inside one piece the glyphs read in the piece's own direction.
    const left =
      p.direction === "rtl"
        ? p.right - (at + word.length) * K
        : p.left + at * K;
    return { left, right: left + word.length * K, direction: p.direction };
  };

  return { layout, text, texts, spans, highlight, paintedWord };
}

/** Every painted piece covers exactly the highlight of its own characters. */
function expectPaintMatchesHighlight(r: ReturnType<typeof paint>) {
  const glyphs = r.texts.filter((t) => r.text.includes(t.text));
  expect(glyphs.length).toBeGreaterThan(0);
  // Map each piece back to its characters: longest first, each taking the
  // first occurrence no other piece has claimed (a word can appear twice).
  const claimed: boolean[] = new Array(r.text.length).fill(false);
  let from = 0;
  for (const g of [...glyphs].sort((a, b) => b.text.length - a.text.length)) {
    let start = r.text.indexOf(g.text);
    while (
      start >= 0 &&
      claimed.slice(start, start + g.text.length).some(Boolean)
    ) {
      start = r.text.indexOf(g.text, start + 1);
    }
    expect(start).toBeGreaterThanOrEqual(0);
    claimed.fill(true, start, start + g.text.length);
    const hl = r.highlight(start, start + g.text.length);
    // One unbroken box, in the same place as the painted text.
    expect(hl.right - hl.left).toBeCloseTo(hl.width, 3);
    expect(g.left).toBeCloseTo(hl.left, 3);
    expect(g.right).toBeCloseTo(hl.right, 3);
    from += g.text.length;
  }
  // Nothing was painted twice or skipped.
  expect(from).toBe(r.text.length);
}

describe("formatted pieces of a mixed-direction line paint in visual order", () => {
  const rtlLines: { name: string; markdown: string }[] = [
    { name: "bold", markdown: "مرحبا **Hello** world اليوم" },
    { name: "italic", markdown: "مرحبا *Hello* world اليوم" },
    { name: "inline code", markdown: "مرحبا `Hello` world اليوم" },
    {
      name: "link",
      markdown: "مرحبا [Hello](https://example.com) world اليوم",
    },
    { name: "strike", markdown: "مرحبا ~~Hello~~ world اليوم" },
    {
      name: "two marks side by side",
      markdown: "مرحبا **Hello** *world* اليوم",
    },
  ];

  for (const { name, markdown } of rtlLines) {
    it(`RTL line, LTR ${name} piece: "Hello" sits left of "world"`, () => {
      const r = paint(markdown);
      expect(r.layout.isRTL).toBe(true);
      const hello = r.paintedWord("Hello");
      const world = r.paintedWord("world");
      expect(hello.right).toBeLessThanOrEqual(world.left);
      // The English run is drawn left to right, so its edge spaces stay put.
      expect(hello.direction).toBe("ltr");
      expect(world.direction).toBe("ltr");
      expectPaintMatchesHighlight(r);
    });
  }

  it("the plain line (no marks) is cut at the direction change too, matching the highlight", () => {
    const r = paint("مرحبا Hello world اليوم");
    expect(r.paintedWord("Hello").right).toBeLessThanOrEqual(
      r.paintedWord("world").left,
    );
    expectPaintMatchesHighlight(r);
  });

  it("LTR line, RTL bold piece: the bold Arabic word reads first, on the right", () => {
    const r = paint("Hello there **مرحبا** بكم world and friends");
    expect(r.layout.isRTL).toBe(false);
    const first = r.paintedWord("مرحبا");
    const second = r.paintedWord("بكم");
    expect(first.left).toBeGreaterThanOrEqual(second.right);
    expect(first.direction).toBe("rtl");
    expectPaintMatchesHighlight(r);
  });

  it("a mark that crosses the direction change, LTR line", () => {
    const r = paint("**Bold that runs into عربي** then more text");
    expectPaintMatchesHighlight(r);
  });

  it("a mark that crosses the direction change, RTL line", () => {
    const r = paint("نص عربي **Bold into عربي** نهاية النص");
    expect(r.layout.isRTL).toBe(true);
    expectPaintMatchesHighlight(r);
  });

  it("link underline, strike line and code chip move with their word", () => {
    for (const [markdown, kind, pad] of [
      ["مرحبا [Hello](https://example.com) world اليوم", "line", 0],
      ["مرحبا ~~Hello~~ world اليوم", "line", 0],
      ["مرحبا `Hello` world اليوم", "chip", null],
    ] as const) {
      const r = paint(markdown);
      const hello = r.paintedWord("Hello");
      const deco = r.spans.filter((s) => s.kind === kind);
      expect(deco.length).toBeGreaterThan(0);
      const span = deco[deco.length - 1];
      // A chip pads both sides equally; a line hugs the text.
      const inset = pad ?? hello.left - span.left;
      expect(inset).toBeGreaterThanOrEqual(0);
      expect(span.left).toBeCloseTo(hello.left - inset, 3);
      expect(span.right).toBeCloseTo(hello.right + inset, 3);
    }
  });

  it("an Arabic word split by a mark keeps its pieces in typing order", () => {
    // مر**حب**ا: one direction only, so the pieces still run right to left.
    const r = paint("مر**حب**ا");
    const order = [...r.texts]
      .filter((t) => r.text.includes(t.text))
      .sort((a, b) => b.right - a.right)
      .map((t) => t.text);
    expect(order).toEqual(["مر", "حب", "ا"]);
    expectPaintMatchesHighlight(r);
  });
});
