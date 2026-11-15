import { CodeNode } from "./CodeNode";
import type { CodeBlock } from "@tasfer/editor/nodes/code-block";
import type { TextNodeLayout } from "@tasfer/editor/nodes/TextNode";
import type { NodePaintCtx } from "@tasfer/editor/rendering/nodes/Node";
import { createInitialState } from "@tasfer/editor/state-utils";
import { resolveTheme } from "@tasfer/editor/styles";
import { describe, expect, it } from "vitest";

// An RTL code block (an all-Arabic comment, say) must keep its box padding on
// both sides and put the selection highlight, caret and click mapping on the
// glyphs the painter draws. It used to paint with double padding on the right
// and none on the left, while the highlight measured from yet another edge.

const MAX_WIDTH = 400;
const ORIGIN = { x: 40, y: 30 };

function codeBlock(text: string): CodeBlock {
  return {
    id: "code-1",
    orderKey: "a0",
    deleted: false,
    type: "code",
    charRuns: [{ peerId: "peer", startCounter: 0, text }],
    formats: [],
    language: "",
  };
}

/** Records each `fillText`'s horizontal extent under the direction in force. */
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
    font: "",
    canvas: { width: 1000, height: 1000 },
  };
  let measureText: ((t: string) => { width: number }) | null = null;
  const ctx = new Proxy(props, {
    get(target, prop: string) {
      if (prop === "save") return () => stack.push({ ...target });
      if (prop === "restore") {
        return () => {
          const saved = stack.pop();
          if (saved) Object.assign(target, saved);
        };
      }
      if (prop === "measureText") return (t: string) => measureText!(t);
      if (prop === "setLineDash" || prop === "getLineDash") return () => [];
      if (prop === "fillText") {
        return (text: string, x: number) => {
          const width = measureText!(text).width;
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
  // Measure with the same stub canvas the engine measures with.
  const measuring = document
    .createElement("canvas")
    .getContext("2d") as CanvasRenderingContext2D;
  measureText = (t) => measuring.measureText(t);
  return { ctx, texts };
}

function paintAndMeasure(text: string) {
  const styles = resolveTheme({});
  const node = new CodeNode();
  const block = codeBlock(text);
  const state = createInitialState({ id: "p", title: "t", blocks: [block] });
  const layout = node.computeLayout(block, MAX_WIDTH, styles) as TextNodeLayout;
  const { ctx, texts } = textRecordingContext();
  const c: NodePaintCtx = {
    ctx,
    state,
    styles,
    block: state.document.page.blocks[0],
    blockIndex: 0,
    maxWidth: MAX_WIDTH,
    isFirst: true,
    marks: state.marks,
    origin: ORIGIN,
    requestRedraw: () => {},
  };
  node.paint(layout, c);
  const glyphs = texts.filter((t) => t.text.trim() && text.includes(t.text));
  expect(glyphs.length).toBeGreaterThan(0);
  const painted = {
    left: Math.min(...glyphs.map((g) => g.left)),
    right: Math.max(...glyphs.map((g) => g.right)),
  };
  const rects = node.selectionRects(
    layout,
    {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: text.length },
      isForward: true,
    },
    0,
    ORIGIN.x,
    ORIGIN.y,
  );
  const selected = {
    left: Math.min(...rects.map((r) => r.x)),
    right: Math.max(...rects.map((r) => r.x + r.width)),
  };
  const line = layout.lines[0];
  const midY = ORIGIN.y + layout.insetY + line.y + line.height / 2;
  const startEdgeX = layout.isRTL ? painted.right - 1 : painted.left + 1;
  return {
    styles,
    layout,
    painted,
    selected,
    caretAtStart: node.caretRect(layout, 0, ORIGIN.x, ORIGIN.y).x,
    clickedOffset: node.positionFromPoint(
      block,
      layout,
      startEdgeX,
      midY,
      ORIGIN.x,
      ORIGIN.y,
    ),
  };
}

describe("RTL code block geometry", () => {
  it("puts the highlight, caret and click on the painted Arabic text", () => {
    const r = paintAndMeasure("تعليق بالعربية");
    expect(r.layout.isRTL).toBe(true);
    expect(r.selected.left).toBeCloseTo(r.painted.left, 3);
    expect(r.selected.right).toBeCloseTo(r.painted.right, 3);
    expect(r.caretAtStart).toBeCloseTo(r.painted.right, 3);
    expect(r.clickedOffset).toBe(0);
  });

  it("keeps the same box padding on the line-start side in both directions", () => {
    const ltr = paintAndMeasure("const a = 1;");
    const rtl = paintAndMeasure("تعليق بالعربية");
    const paddingX = ltr.styles.blocks.code.paddingX;
    expect(ltr.painted.left - ORIGIN.x).toBeCloseTo(paddingX, 3);
    expect(ORIGIN.x + MAX_WIDTH - rtl.painted.right).toBeCloseTo(paddingX, 3);
    expect(rtl.layout.adjustedMaxWidth).toBe(ltr.layout.adjustedMaxWidth);
    expect(ltr.layout.adjustedMaxWidth).toBe(MAX_WIDTH - 2 * paddingX);
  });
});
