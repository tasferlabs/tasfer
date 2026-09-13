import { notifyFontsChanged } from "../fonts";
import {
  type RangeDecoration,
  setDecorationLayer,
} from "../rendering/decorations";
import { createDefaultMarkRegistry } from "../rendering/marks";
import type { NodePaintCtx } from "../rendering/nodes/Node";
import { loadPage } from "../serlization/loadPage";
import { createInitialState } from "../state-utils";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { beforeAll, describe, expect, it } from "vitest";

// Length-proportional canvas stub (see TextNode.bidi-selection.test.ts): width
// == char count * K, so wrapping and bidi geometry are deterministic.
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

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
}

/** A recording 2D context: every drawing method is logged with the fill and
 * stroke style in force; every property set is accepted. */
function recordingContext() {
  const calls: Call[] = [];
  const stack: Record<string, unknown>[] = [];
  const props: Record<string, unknown> = {
    fillStyle: "#000",
    strokeStyle: "#000",
    globalAlpha: 1,
    lineWidth: 1,
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
      if (prop in target) return target[prop];
      return (...args: unknown[]) =>
        calls.push({
          name: prop,
          args,
          fillStyle: target.fillStyle,
          strokeStyle: target.strokeStyle,
        });
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("range decoration styles in TextNode.paint", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();
  // Arabic and Latin words on one line, narrow enough to wrap: several line
  // boxes, each split into one rect per bidi run.
  const CONTENT = "مرحبا بالعالم hello world سلام عليكم foo bar";
  const MAX_WIDTH = 200;
  const ORIGIN = { x: 40, y: 30 };
  const COLOR = "#e11d48";

  function setup(style: RangeDecoration["style"]) {
    const page = loadPage(CONTENT);
    const block = page.blocks[0] as TextualBlock;
    let state = createInitialState(page);
    const deco: RangeDecoration = {
      kind: "range",
      range: {
        from: { block: block.id, offset: 0 },
        to: { block: block.id, offset: CONTENT.length },
      },
      color: COLOR,
      ...(style ? { style } : {}),
    };
    state = {
      ...state,
      ui: {
        ...state.ui,
        decorations: setDecorationLayer({}, "test", [deco]),
      },
    };
    const layout = node.computeLayout(
      block,
      MAX_WIDTH,
      styles,
      undefined,
      marks,
    );
    const rects = node.selectionRects(
      layout,
      {
        anchor: { blockIndex: 0, textIndex: 0 },
        focus: { blockIndex: 0, textIndex: CONTENT.length },
        isForward: true,
      },
      0,
      ORIGIN.x,
      ORIGIN.y,
    );
    const { ctx, calls } = recordingContext();
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
    return { layout, rects, calls };
  }

  it("emits a baseline for every rect of a wrapped mixed-direction block", () => {
    const { layout, rects } = setup(undefined);
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(rects.length).toBeGreaterThan(layout.lines.length);
    for (const rect of rects) {
      expect(rect.baseline).toBeDefined();
      expect(rect.baseline!).toBeGreaterThan(rect.y);
      expect(rect.baseline!).toBeLessThan(rect.y + rect.height);
    }
  });

  it("strokes one underline per rect and fills nothing for an underline decoration", () => {
    const { rects, calls } = setup({ type: "underline", line: "wavy" });
    const strokes = calls.filter(
      (call) => call.name === "stroke" && call.strokeStyle === COLOR,
    );
    expect(strokes).toHaveLength(rects.length);
    const fills = calls.filter(
      (call) =>
        (call.name === "fillRect" || call.name === "fill") &&
        call.fillStyle === COLOR,
    );
    expect(fills).toHaveLength(0);
    // Each underline starts at its rect's left edge, below its baseline.
    const moves = calls.filter(
      (call) => call.name === "moveTo" && call.strokeStyle === COLOR,
    );
    expect(moves.map((call) => call.args[0]).sort()).toEqual(
      rects.map((rect) => rect.x).sort(),
    );
    for (const [i, rect] of rects.entries()) {
      expect(moves[i].args[1] as number).toBeGreaterThan(rect.baseline!);
    }
  });

  it("keeps the translucent fill for a fill decoration", () => {
    const { rects, calls } = setup(undefined);
    const fills = calls.filter(
      (call) => call.name === "fillRect" && call.fillStyle === COLOR,
    );
    expect(fills).toHaveLength(rects.length);
    expect(fills.map((call) => call.args.slice(0, 4))).toEqual(
      rects.map((rect) => [rect.x, rect.y, rect.width, rect.height]),
    );
    expect(
      calls.some(
        (call) => call.name === "stroke" && call.strokeStyle === COLOR,
      ),
    ).toBe(false);
  });
});
