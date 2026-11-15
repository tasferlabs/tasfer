/**
 * An inline formula inside a mixed Arabic/English line is painted where the
 * caret, click and highlight expect it.
 *
 * The line painter used to lay a line's pieces down in typing order, right to
 * left on an RTL line, so in `مرحبا Hello $x^2$ world اليوم` the formula landed
 * left of "Hello" instead of between "Hello" and "world".
 */
import { createMathTestState, loadMathPage } from "./__testutils__/math";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "@tasfer/editor/feature-facets";
import { notifyFontsChanged } from "@tasfer/editor/fonts";
import { getBlockTextContent } from "@tasfer/editor/node-shared";
import {
  TextNode,
  type TextNodeLayout,
  type TextualBlock,
} from "@tasfer/editor/nodes/TextNode";
import type { MarkReplacementPaintCtx } from "@tasfer/editor/rendering/marks";
import type { NodePaintCtx } from "@tasfer/editor/rendering/nodes/Node";
import { resolveTheme } from "@tasfer/editor/styles";
import { beforeAll, describe, expect, it } from "vitest";

// Length-proportional canvas stub so prose geometry is deterministic.
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

/** A 2D context that records prose `fillText` boxes and accepts the rest. */
function recordingContext() {
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
const ORIGIN = { x: 40, y: 30 };

function paintLine(markdown: string) {
  const node = new TextNode();
  const page = loadMathPage(markdown);
  const state = createMathTestState(page);
  const block = state.document.page.blocks[0] as TextualBlock;
  const layout = node.computeLayout(
    block,
    800,
    styles,
    undefined,
    state.marks,
  ) as TextNodeLayout;

  // Spy on this editor's formula painter (its own mark instance, nothing shared).
  const chips: { left: number; right: number }[] = [];
  for (const span of block.formats ?? []) {
    const mark = state.marks.get(span.format.type);
    const replacement = mark?.replacement;
    if (!mark || !replacement) continue;
    Object.defineProperty(mark, "replacement", {
      value: {
        ...replacement,
        paint(args: MarkReplacementPaintCtx) {
          const left = args.isRTL ? args.x - args.dims.width : args.x;
          chips.push({ left, right: left + args.dims.width });
          replacement.paint(args);
        },
      },
    });
  }

  const { ctx, texts } = recordingContext();
  const c: NodePaintCtx = {
    ctx,
    state,
    styles,
    block,
    blockIndex: 0,
    maxWidth: 800,
    isFirst: true,
    marks: state.marks,
    origin: ORIGIN,
    requestRedraw: () => {},
  };
  node.paint(layout, c);

  const text = getBlockTextContent(block);
  const chipAt = text.indexOf(STRUCTURED_MARK_ANCHOR_CHAR);
  const caretX = (i: number) => node.caretRect(layout, i, ORIGIN.x, ORIGIN.y).x;
  const word = (w: string) => {
    const piece = texts.find((t) => t.text.includes(w));
    expect(piece, `no painted piece holds "${w}"`).toBeDefined();
    return piece as { text: string; left: number; right: number };
  };
  return { layout, chips, chipAt, caretX, word };
}

describe("inline formula on a mixed-direction line", () => {
  it("RTL line: the formula paints between Hello and world, on its caret edges", () => {
    const r = paintLine("مرحبا Hello $x^2$ world اليوم");
    expect(r.layout.isRTL).toBe(true);
    expect(r.chips).toHaveLength(1);
    const chip = r.chips[0];
    const edgeA = r.caretX(r.chipAt);
    const edgeB = r.caretX(r.chipAt + 1);
    expect(chip.left).toBeCloseTo(Math.min(edgeA, edgeB), 3);
    expect(chip.right).toBeCloseTo(Math.max(edgeA, edgeB), 3);
    expect(r.word("Hello").right).toBeLessThanOrEqual(chip.left + 1e-6);
    expect(r.word("world").left).toBeGreaterThanOrEqual(chip.right - 1e-6);
  });

  it("LTR line with a bold Arabic word beside a formula", () => {
    const r = paintLine("Start here and **مرحبا** $x^2$ بكم the end of it");
    expect(r.layout.isRTL).toBe(false);
    expect(r.chips).toHaveLength(1);
    const chip = r.chips[0];
    const edgeA = r.caretX(r.chipAt);
    const edgeB = r.caretX(r.chipAt + 1);
    expect(chip.left).toBeCloseTo(Math.min(edgeA, edgeB), 3);
    expect(chip.right).toBeCloseTo(Math.max(edgeA, edgeB), 3);
  });
});
