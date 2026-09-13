/**
 * Recorded cell text geometry: where the caret, a click, a highlight and an
 * up/down arrow land inside table cells.
 *
 * Cells lay their text out through the same engine as paragraphs. This suite
 * records the numbers so any change to where a caret or a click lands in a
 * cell shows up as a snapshot diff, reviewed in the change that causes it.
 */
import type { TableLayout } from "./geometry";
import {
  cellRangeRects,
  moveTableCaretVertically,
  tableCaretFromContentPoint,
  tableEntryCaret,
} from "./selection";
import { getTableDocument } from "./structured";
import { tableExtension } from "./table-extension";
import { type TableBlock, TableNode } from "./TableNode";
import { createNodeRegistry } from "@tasfer/editor";
import { notifyFontsChanged } from "@tasfer/editor/fonts";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { createInitialState } from "@tasfer/editor/state-utils";
import { resolveTheme } from "@tasfer/editor/styles";
import { getVisibleTextFromChars } from "@tasfer/editor/sync/char-runs";
import { beforeAll, describe, expect, it } from "vitest";

// Width depends on WHICH characters are measured, so an off-by-one offset
// shows as a different x instead of hiding behind uniform advances.
beforeAll(() => {
  const g = globalThis as unknown as {
    document: { createElement: () => unknown };
  };
  g.document.createElement = () =>
    ({
      getContext: () => ({
        measureText: (t: string) => {
          let width = 0;
          for (let i = 0; i < t.length; i++) width += 5 + (t.charCodeAt(i) % 7);
          return {
            width,
            fontBoundingBoxAscent: 12,
            fontBoundingBoxDescent: 4,
          };
        },
        set font(_v: string) {},
        set direction(_v: string) {},
      }),
      style: {},
      setAttribute: () => {},
      appendChild: () => {},
    }) as unknown;
  notifyFontsChanged();
});

const schema = baseSchema.use(tableExtension());
const styles = resolveTheme({});
const node = new TableNode();

const SOURCE = [
  "| Name | Centre | Right |",
  "| :--- | :---: | ---: |",
  "| hello world wrapping text | مرحبا بالعالم | a👍b 🇸🇦 c |",
  "| mixed مرحبا text | **bold** and *it* | |",
  "| عربي with english | x | long long long long words here |",
].join("\n");

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
function roundAll<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "number" ? round(v) : v)),
  );
}

describe("recorded cell geometry", () => {
  for (const maxWidth of [600, 300]) {
    it(`at ${maxWidth}px`, () => {
      const page = loadPage(SOURCE, schema.data);
      const state = createInitialState(page, {
        schema: schema.data,
        nodes: createNodeRegistry(schema.nodes),
        marks: createMarkRegistry(schema.marks),
      });
      const block = state.document.page.blocks[0] as unknown as TableBlock;
      const document = getTableDocument(block)!;
      const ctx = {
        state,
        block,
        blockIndex: 0,
        maxWidth,
        isFirst: true,
        styles,
        marks: state.marks,
      };
      const layout = node.layout({
        ...ctx,
        block: state.document.page.blocks[0],
      }) as TableLayout;

      const cells = layout.cells
        .filter((cell) => cell.cellId)
        .map((cell) => {
          const cellId = cell.cellId!;
          const length = getVisibleTextFromChars(cell.chars).length;
          const caretAt = (offset: number) =>
            node.contentCaretRect(
              layout,
              {
                kind: "text",
                blockId: block.id,
                contentId: document.rootId,
                nodeId: cellId,
                field: "text",
                afterCharId:
                  offset === 0
                    ? null
                    : cell.chars.filter((c) => !c.deleted)[offset - 1].id,
                affinity: "forward",
              },
              { ...ctx, origin: { x: 0, y: 0 } },
            );
          const carets = Array.from({ length: length + 1 }, (_, offset) =>
            caretAt(offset),
          );

          const points: [number, number, number | null][] = [];
          const ys = [cell.y + 1, cell.y + cell.height - 1];
          for (const line of cell.lines) ys.push(line.y + line.height / 2);
          for (const y of ys) {
            for (let x = cell.x - 4; x <= cell.x + cell.width + 4; x += 5) {
              const selection = node.contentSelectionFromPoint(
                layout,
                { x, y },
                ctx,
                { pointerType: "mouse" },
              );
              const caret =
                selection &&
                tableCaretFromContentPoint(document, selection.focus);
              points.push([
                x,
                y,
                caret?.cellId === cellId ? caret.offset : null,
              ]);
            }
          }

          const ranges: unknown[] = [];
          for (let from = 0; from <= length; from += 3) {
            for (let to = from + 1; to <= length; to += 4) {
              ranges.push([from, to, cellRangeRects(cell, from, to)]);
            }
          }

          const vertical = Array.from({ length: length + 1 }, (_, offset) => [
            moveTableCaretVertically(layout, { cellId, offset }, "up"),
            moveTableCaretVertically(layout, { cellId, offset }, "down"),
          ]);

          return {
            direction: cell.direction,
            lines: cell.lines,
            carets,
            points,
            ranges,
            vertical,
          };
        });

      const entries: unknown[] = [];
      for (let x = -10; x <= maxWidth + 10; x += 15) {
        entries.push([
          x,
          tableEntryCaret(layout, "down", x),
          tableEntryCaret(layout, "up", x),
        ]);
      }

      const cellIndex = new Map(
        layout.cells.map((cell, at) => [cell.cellId, at]),
      );
      // Cell ids are random per load; the grid position is what is stable.
      const stable = JSON.parse(
        JSON.stringify({ cells, entries }, (key, v) =>
          key === "cellId" ? cellIndex.get(v) : v,
        ),
      );
      expect(roundAll(stable)).toMatchSnapshot();
    });
  }
});
