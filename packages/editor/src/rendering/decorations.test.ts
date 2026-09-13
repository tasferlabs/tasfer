import { loadPage } from "../serlization/loadPage";
import { resolveTheme } from "../styles";
import { isTextualBlock } from "../sync/block-registry";
import {
  allDecorations,
  boxDecorationRect,
  type Decoration,
  decorationPointBlockId,
  decorationsForBlock,
  paintDecorationRects,
  type RangeDecoration,
  resolveDecorationPoint,
  setDecorationLayer,
} from "./decorations";
import { describe, expect, it } from "vitest";

describe("character-anchored decorations", () => {
  it("stays attached to the same character when text is inserted before it", () => {
    const page = loadPage("abcd");
    const block = page.blocks[0];
    if (!block || !isTextualBlock(block) || !block.charRuns[0]) {
      throw new Error("expected a textual block");
    }
    const run = block.charRuns[0];
    const point = {
      blockId: block.id,
      afterCharId: `${run.peerId}:${run.startCounter + 1}`,
    };

    expect(resolveDecorationPoint(point, page)?.textIndex).toBe(2);

    const shiftedPage = {
      ...page,
      blocks: page.blocks.map((candidate) =>
        candidate.id === block.id
          ? {
              ...candidate,
              charRuns: [
                { peerId: "peer", startCounter: 1, text: "x" },
                ...block.charRuns,
              ],
            }
          : candidate,
      ),
    };
    expect(resolveDecorationPoint(point, shiftedPage)?.textIndex).toBe(3);

    const deletedAnchorPage = {
      ...page,
      blocks: page.blocks.map((candidate) =>
        candidate.id === block.id
          ? {
              ...candidate,
              charRuns: block.charRuns.map((candidateRun, index) =>
                index === 0
                  ? { ...candidateRun, deletedMask: [0b00000010] }
                  : candidateRun,
              ),
            }
          : candidate,
      ),
    };
    expect(resolveDecorationPoint(point, deletedAnchorPage)?.textIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Range decoration styles
// ---------------------------------------------------------------------------

interface CanvasCall {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
  readonly globalAlpha: unknown;
  readonly lineWidth: unknown;
  readonly lineDash: readonly number[];
}

/** A canvas context stand-in that records every drawing call with the state
 * (fill/stroke style, alpha, line width, dash) in force when it was made. */
function recordingContext() {
  const calls: CanvasCall[] = [];
  let lineDash: number[] = [];
  const stack: Record<string, unknown>[] = [];
  const props: Record<string, unknown> = {
    fillStyle: "#000",
    strokeStyle: "#000",
    globalAlpha: 1,
    lineWidth: 1,
  };
  const record = (name: string, args: unknown[]): void => {
    calls.push({
      name,
      args,
      fillStyle: props.fillStyle,
      strokeStyle: props.strokeStyle,
      globalAlpha: props.globalAlpha,
      lineWidth: props.lineWidth,
      lineDash: [...lineDash],
    });
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
      if (prop === "setLineDash") {
        return (dash: number[]) => {
          lineDash = dash;
        };
      }
      if (prop in target) return target[prop];
      return (...args: unknown[]) => record(prop, args);
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const paintStyles = resolveTheme({});

function flatRange(block: string, from: number, to: number) {
  return {
    from: { block, offset: from },
    to: { block, offset: to },
  };
}

describe("paintDecorationRects", () => {
  const rects = [
    { x: 10, y: 20, width: 40, height: 18, baseline: 34 },
    { x: 50, y: 20, width: 30, height: 18, baseline: 34 },
  ];

  it("fills exactly like the selection wash when no style is given", () => {
    const { ctx, calls } = recordingContext();
    paintDecorationRects(
      ctx,
      rects,
      { kind: "range", range: flatRange("b", 0, 1), color: "#f00" },
      paintStyles,
    );
    const fills = calls.filter((call) => call.name === "fillRect");
    expect(fills).toHaveLength(2);
    expect(fills[0].fillStyle).toBe("#f00");
    expect(fills[0].globalAlpha).toBe(paintStyles.selection.remoteOpacity);
    expect(fills[0].args).toEqual([10, 20, 40, 18]);
    expect(calls.some((call) => call.name === "stroke")).toBe(false);
  });

  it("treats an explicit fill style the same as none, honouring opacity", () => {
    const { ctx, calls } = recordingContext();
    paintDecorationRects(
      ctx,
      rects,
      {
        kind: "range",
        range: flatRange("b", 0, 1),
        color: "#0f0",
        opacity: 0.5,
        style: { type: "fill" },
      },
      paintStyles,
    );
    const fills = calls.filter((call) => call.name === "fillRect");
    expect(fills).toHaveLength(2);
    expect(fills[1].globalAlpha).toBe(0.5);
  });

  it("strokes one solid underline per rect, opaque, hanging from the baseline", () => {
    const { ctx, calls } = recordingContext();
    paintDecorationRects(
      ctx,
      rects,
      {
        kind: "range",
        range: flatRange("b", 0, 1),
        color: "#00f",
        style: { type: "underline", line: "solid" },
      },
      paintStyles,
    );
    expect(calls.some((call) => call.name === "fillRect")).toBe(false);
    const strokes = calls.filter((call) => call.name === "stroke");
    expect(strokes).toHaveLength(2);
    expect(strokes[0].strokeStyle).toBe("#00f");
    expect(strokes[0].globalAlpha).toBe(1);
    expect(strokes[0].lineWidth).toBe(1);
    expect(strokes[0].lineDash).toEqual([]);
    const moves = calls.filter((call) => call.name === "moveTo");
    const lines = calls.filter((call) => call.name === "lineTo");
    expect(moves.map((call) => call.args[0])).toEqual([10, 50]);
    expect(lines.map((call) => call.args[0])).toEqual([50, 80]);
    // Below the baseline (34), on a half pixel so a 1px line stays crisp.
    const y = moves[0].args[1] as number;
    expect(y).toBeGreaterThan(34);
    expect(y % 1).toBe(0.5);
    expect(lines[0].args[1]).toBe(y);
  });

  it("scales dash patterns and thickness from the style", () => {
    const { ctx, calls } = recordingContext();
    paintDecorationRects(
      ctx,
      rects,
      {
        kind: "range",
        range: flatRange("b", 0, 1),
        color: "#00f",
        style: { type: "underline", line: "dotted", thickness: 2 },
      },
      paintStyles,
    );
    const strokes = calls.filter((call) => call.name === "stroke");
    expect(strokes[0].lineWidth).toBe(2);
    expect(strokes[0].lineDash).toEqual([2, 4]);

    const dashed = recordingContext();
    paintDecorationRects(
      dashed.ctx,
      rects,
      {
        kind: "range",
        range: flatRange("b", 0, 1),
        color: "#00f",
        style: { type: "underline", line: "dashed" },
      },
      paintStyles,
    );
    expect(
      dashed.calls.filter((call) => call.name === "stroke")[0].lineDash,
    ).toEqual([3, 2]);
  });

  it("phase-locks a wavy underline so adjacent rects tile seamlessly", () => {
    const { ctx, calls } = recordingContext();
    paintDecorationRects(
      ctx,
      rects,
      {
        kind: "range",
        range: flatRange("b", 0, 1),
        color: "#00f",
        style: { type: "underline", line: "wavy" },
      },
      paintStyles,
    );
    const strokes = calls.filter((call) => call.name === "stroke");
    expect(strokes).toHaveLength(2);
    const moves = calls.filter((call) => call.name === "moveTo");
    const lines = calls.filter((call) => call.name === "lineTo");
    expect(moves).toHaveLength(2);
    // The first rect's last sample is the second rect's first sample.
    const secondMoveIndex = calls.indexOf(moves[1]);
    const lastOfFirst = calls
      .slice(0, secondMoveIndex)
      .filter((call) => call.name === "lineTo")
      .at(-1);
    expect(lastOfFirst?.args).toEqual(moves[1].args);
    // Amplitude ≈ thickness around the underline's centre.
    const ys = lines.map((call) => call.args[1] as number);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2, 5);
  });

  it("underlines near the bottom edge of a rect with no baseline", () => {
    const { ctx, calls } = recordingContext();
    paintDecorationRects(
      ctx,
      [{ x: 0, y: 100, width: 10, height: 20 }],
      {
        kind: "range",
        range: flatRange("b", 0, 1),
        color: "#00f",
        style: { type: "underline", line: "solid" },
      },
      paintStyles,
    );
    const y = calls.find((call) => call.name === "moveTo")?.args[1] as number;
    expect(y).toBeGreaterThan(100 + 20 * 0.8);
    expect(y).toBeLessThan(120 + 2);
  });

  it("boxDecorationRect keeps an underline inside the box's bottom edge", () => {
    const deco = {
      color: "#00f",
      style: { type: "underline", line: "solid", thickness: 2 },
    } as const;
    const rect = boxDecorationRect(
      { x: 0, y: 100, width: 50, height: 300 },
      deco,
    );
    expect(rect).toMatchObject({ x: 0, y: 100, width: 50, height: 300 });
    const { ctx, calls } = recordingContext();
    paintDecorationRects(ctx, [rect], deco, paintStyles);
    const y = calls.find((call) => call.name === "moveTo")?.args[1] as number;
    expect(y).toBeLessThanOrEqual(400);
    expect(y).toBeGreaterThan(400 - 4);
  });
});

// ---------------------------------------------------------------------------
// Per-block index
// ---------------------------------------------------------------------------

describe("decorationsForBlock", () => {
  const range = (from: string, to: string, color: string): RangeDecoration => ({
    kind: "range",
    range: { from: { block: from, offset: 0 }, to: { block: to, offset: 1 } },
    color,
  });

  it("returns a block's own decorations plus every block-spanning range", () => {
    const layers = setDecorationLayer({}, "search", [
      range("a", "a", "a1"),
      range("a", "c", "span"),
      range("b", "b", "b1"),
      { kind: "block", block: "b", color: "b2" },
      {
        kind: "caret",
        point: { blockId: "c", afterCharId: null },
        color: "c1",
      },
    ]);
    expect(decorationsForBlock(layers, "a").map((d) => d.color)).toEqual([
      "a1",
      "span",
    ]);
    expect(decorationsForBlock(layers, "b").map((d) => d.color)).toEqual([
      "span",
      "b1",
      "b2",
    ]);
    expect(decorationsForBlock(layers, "c").map((d) => d.color)).toEqual([
      "span",
      "c1",
    ]);
    // A block nothing addresses still sees the spanning range: it may lie
    // between the endpoints, and only the painter knows block order.
    expect(decorationsForBlock(layers, "zzz").map((d) => d.color)).toEqual([
      "span",
    ]);
  });

  it("indexes structured and character-anchored endpoints by their block", () => {
    const layers = setDecorationLayer({}, "presence", [
      {
        kind: "range",
        range: {
          from: {
            kind: "text",
            blockId: "m",
            contentId: "eq",
            nodeId: "n",
            field: "text",
            afterCharId: null,
            affinity: "forward",
          },
          to: {
            kind: "text",
            blockId: "m",
            contentId: "eq",
            nodeId: "n",
            field: "text",
            afterCharId: "p:2",
            affinity: "forward",
          },
        },
        color: "m1",
      },
      {
        kind: "range",
        range: {
          from: { blockId: "t", afterCharId: null },
          to: { blockId: "t", afterCharId: "p:3" },
        },
        color: "t1",
      },
    ]);
    expect(decorationsForBlock(layers, "m").map((d) => d.color)).toEqual([
      "m1",
    ]);
    expect(decorationsForBlock(layers, "t").map((d) => d.color)).toEqual([
      "t1",
    ]);
    expect(decorationsForBlock(layers, "x")).toHaveLength(0);
  });

  it("preserves layer insertion order across layers and the spanning bucket", () => {
    let layers = setDecorationLayer({}, "first", [
      range("a", "a", "f1"),
      range("a", "b", "f-span"),
    ]);
    layers = setDecorationLayer(layers, "second", [
      range("a", "a", "s1"),
      range("b", "a", "s-span"),
    ]);
    expect(decorationsForBlock(layers, "a").map((d) => d.color)).toEqual([
      "f1",
      "f-span",
      "s1",
      "s-span",
    ]);
    expect([...allDecorations(layers)].map((d) => d.color)).toEqual([
      "f1",
      "f-span",
      "s1",
      "s-span",
    ]);
  });

  it("derives the index once per store identity and memoises per block", () => {
    const layers = setDecorationLayer({}, "search", [range("a", "a", "a1")]);
    const first = decorationsForBlock(layers, "a");
    expect(decorationsForBlock(layers, "a")).toBe(first);
    expect(decorationsForBlock(layers, "none")).toBe(
      decorationsForBlock(layers, "none"),
    );

    const replaced = setDecorationLayer(layers, "search", [
      range("a", "a", "a2"),
    ]);
    expect(replaced).not.toBe(layers);
    expect(decorationsForBlock(replaced, "a").map((d) => d.color)).toEqual([
      "a2",
    ]);
    // The old store's answer is untouched by the replacement.
    expect(decorationsForBlock(layers, "a")).toBe(first);
    expect(first.map((d) => d.color)).toEqual(["a1"]);
  });

  it("hands a block only its own share of a page-wide decoration store", () => {
    // 2000 decorations spread over 400 blocks, five per block, across two
    // layers, plus two ranges that span blocks (which every block must see).
    const blocks = Array.from({ length: 400 }, (_, i) => `block-${i}`);
    const search: Decoration[] = [];
    const other: Decoration[] = [];
    for (const [i, block] of blocks.entries()) {
      for (let k = 0; k < 3; k++)
        search.push(range(block, block, `s${i}.${k}`));
      for (let k = 0; k < 2; k++) other.push(range(block, block, `o${i}.${k}`));
    }
    search.push(range("block-0", "block-399", "wide"));
    other.push(range("block-10", "block-20", "narrow"));
    let layers = setDecorationLayer({}, "search", search);
    layers = setDecorationLayer(layers, "other", other);
    expect([...allDecorations(layers)]).toHaveLength(2002);

    const own = decorationsForBlock(layers, "block-137");
    expect(own).toHaveLength(7);
    expect(own.map((d) => d.color)).toEqual([
      "s137.0",
      "s137.1",
      "s137.2",
      "wide",
      "o137.0",
      "o137.1",
      "narrow",
    ]);
    for (const deco of own) {
      if (deco.kind !== "range") throw new Error("expected range decorations");
      const from = decorationPointBlockId(deco.range.from);
      const to = decorationPointBlockId(deco.range.to);
      expect(from === "block-137" || from !== to).toBe(true);
    }
  });
});
