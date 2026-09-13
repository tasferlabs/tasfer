/**
 * Underline decorations inside a cell — what a spell checker publishes for a
 * misspelled word in a table. The underline runs under exactly that word.
 */

import { cellCaretX, tableCaretToContentPoint } from "./selection";
import { TableNode } from "./TableNode";
import {
  cellIds,
  editorOf,
  tableDocument,
  tableSource,
} from "./text-safety/harness";
import { setDecorationLayer } from "@tasfer/editor/rendering/decorations";
import type { EditorState } from "@tasfer/editor/state-types";
import { resolveTheme } from "@tasfer/editor/styles";
import { describe, expect, it } from "vitest";

const node = new TableNode();
const styles = resolveTheme({});
const CELL = 2;

function paint(state: EditorState) {
  const calls: { key: string; args: number[] }[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, key: string) => {
        if (key === "canvas") return {};
        if (key === "measureText") {
          return (text: string) => ({ width: text.length * 7 });
        }
        return (...args: number[]) => {
          calls.push({ key, args });
        };
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  const c = {
    state,
    block: state.document.page.blocks[0],
    blockIndex: 0,
    maxWidth: 600,
    isFirst: true,
    styles,
    marks: state.marks,
  };
  const layout = node.layout(c);
  node.paint(layout, {
    ...c,
    ctx,
    origin: { x: 0, y: 0 },
    requestRedraw: () => {},
  });
  return { calls, layout };
}

function withUnderline(state: EditorState, from: number, to: number) {
  const { block, document } = tableDocument(state);
  const cellId = cellIds(state)[CELL];
  const point = (offset: number) =>
    tableCaretToContentPoint(document, block.id, { cellId, offset })!;
  return {
    ...state,
    ui: {
      ...state.ui,
      decorations: setDecorationLayer(state.ui.decorations, "spell", [
        {
          kind: "range",
          range: { from: point(from), to: point(to) },
          color: "#e00",
          opacity: 1,
          style: { type: "underline", line: "wavy" },
        },
      ]),
    },
  } as EditorState;
}

describe("underline decorations in a cell", () => {
  it("draws a wavy underline under exactly the decorated word", () => {
    const plain = editorOf(tableSource("one twoo"));
    const decorated = withUnderline(plain, 4, 8);

    const before = paint(plain).calls.filter((c) => c.key === "stroke");
    const { calls, layout } = paint(decorated);
    expect(calls.filter((c) => c.key === "stroke").length).toBe(
      before.length + 1,
    );

    const cell = layout.cells[CELL];
    const left = cellCaretX(cell, 4);
    const right = cellCaretX(cell, 8);
    const xs = calls
      .filter((c) => c.key === "lineTo" || c.key === "moveTo")
      .map((c) => c.args[0]);
    const under = xs.filter((x) => x >= left - 0.5 && x <= right + 0.5);
    expect(under.length).toBeGreaterThan(2);
    expect(Math.min(...under)).toBeCloseTo(left, 0);
    expect(Math.max(...under)).toBeCloseTo(right, 0);
  });
});
