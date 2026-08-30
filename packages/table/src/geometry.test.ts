import {
  alignOffset,
  fitColumnWidths,
  layoutTable,
  type TableLayoutCtx,
} from "./geometry";
import { matchGfmTable, tableSeedFromToken } from "./markdown";
import { buildTableDocument, cellRunsFromText } from "./structured";
import { createDeterministicIdentityAllocator } from "@shared/identity";
import { resolveTheme } from "@tasfer/editor/styles";
import { describe, expect, it } from "vitest";

const styles = resolveTheme({});

function ctx(maxWidth: number): TableLayoutCtx {
  return {
    maxWidth,
    style: styles.blocks.table,
    fontFamily: styles.fonts.defaultFamily,
    fonts: styles.fonts,
  };
}

/** A table whose cells hold the given plain strings; `rows[0]` is the header. */
function tableOf(rows: string[][]) {
  const identities = createDeterministicIdentityAllocator("geometry");
  return buildTableDocument(
    {
      aligns: rows[0].map(() => null),
      rows: rows.map((row) =>
        row.map((text) => ({ charRuns: cellRunsFromText(text, identities) })),
      ),
    },
    { contentId: "table-1", identityAllocator: identities },
  );
}

describe("fitColumnWidths", () => {
  const sum = (widths: readonly number[]) =>
    widths.reduce((total, width) => total + width, 0);

  it("splits the grid evenly when nobody has resized a column", () => {
    expect(fitColumnWidths(3, 600, [], 48)).toEqual([200, 200, 200]);
  });

  it("gives a resized column its fraction and splits the rest evenly", () => {
    // Dragging one edge must not move the columns nobody touched relative to
    // each other; they share what is left, equally, as they did before.
    const widths = fitColumnWidths(3, 600, [0.5, null, null], 48);

    expect(widths).toEqual([300, 150, 150]);
  });

  it("normalizes the fractions when every column is resized", () => {
    // 0.25 + 0.25 sums to half the grid; the split they describe is what
    // matters, so they are scaled up to fill it rather than leaving a gap.
    const widths = fitColumnWidths(2, 400, [0.25, 0.25], 48);

    expect(widths).toEqual([200, 200]);
  });

  it("yields a stored width rather than starve an untouched column", () => {
    // A 95% fraction would leave the second column 10px — under the 40px floor.
    // The stored width gives way: a column too narrow to hold a caret is the
    // worse outcome.
    const widths = fitColumnWidths(2, 200, [0.95, null], 40);

    expect(widths).toEqual([160, 40]);
  });

  it("never takes a column below the minimum width", () => {
    const widths = fitColumnWidths(2, 400, [0.01, null], 20);

    expect(widths).toEqual([20, 380]);
  });

  it("keeps the minimum as the page narrows, until it no longer fits", () => {
    // The same document on a phone: the fractions scale down with the page and
    // the narrow one lands on the floor instead of vanishing.
    const widths = fitColumnWidths(3, 260, [0.1, 0.45, 0.45], 48);

    expect(widths[0]).toBe(48);
    expect(sum(widths)).toBe(260);
  });

  it("shares the page evenly when it cannot hold one minimum per column", () => {
    // Eight columns at a 48px floor need 384px; the viewport has 100. The floor
    // yields, because a grid wider than the page could never be scrolled to.
    const widths = fitColumnWidths(4, 100, [], 48);

    expect(widths).toEqual([25, 25, 25, 25]);
  });

  it("keeps resized columns summing to the available width exactly", () => {
    const widths = fitColumnWidths(3, 333, [0.333, null, 0.333], 20);

    expect(sum(widths)).toBe(333);
  });

  it("always sums to exactly the available width despite rounding", () => {
    const widths = fitColumnWidths(3, 101, [], 10);

    expect(sum(widths)).toBe(101);
  });

  it("returns nothing for a table with no columns", () => {
    expect(fitColumnWidths(0, 500)).toEqual([]);
  });
});

describe("layoutTable", () => {
  it("fills the block width and lays columns edge to edge", () => {
    const layout = layoutTable(
      tableOf([
        ["a", "b"],
        ["c", "d"],
      ]),
      ctx(600),
    );

    expect(layout.columns).toHaveLength(2);
    expect(layout.columns[0].x).toBe(0);
    expect(layout.columns[0].x + layout.columns[0].width).toBe(
      layout.columns[1].x,
    );
    expect(layout.columns[1].x + layout.columns[1].width).toBe(600);
  });

  it("splits the width evenly however much text a column holds", () => {
    const layout = layoutTable(
      tableOf([
        ["id", "description"],
        ["1", "a much longer body cell than the other column"],
      ]),
      ctx(600),
    );

    expect(layout.columns.map((column) => column.width)).toEqual([300, 300]);
  });

  it("never moves a column edge because a cell's text changed", () => {
    // The reported bug: typing into a fresh table made the whole grid shift,
    // with plenty of empty room still in the cell. Nothing a cell holds — from
    // a single letter to a paragraph — may move an edge; only a drag does.
    const edges = (cells: string[]) =>
      layoutTable(tableOf([cells, ["", "", ""]]), ctx(700)).columns.map(
        (column) => column.width,
      );

    const empty = edges(["", "", ""]);
    expect(edges(["H", "", ""])).toEqual(empty);
    expect(edges(["Hello", "", ""])).toEqual(empty);
    expect(
      edges([
        "a cell whose text is far wider than a third of the whole grid",
        "",
        "",
      ]),
    ).toEqual(empty);
  });

  it("wraps a cell inside its column instead of widening it", () => {
    const layout = layoutTable(
      tableOf([
        [
          "a cell whose text is far wider than a third of the whole grid",
          "",
          "",
        ],
        ["", "", ""],
      ]),
      ctx(700),
    );

    expect(layout.rows[0].cells[0].lines.length).toBeGreaterThan(1);
  });

  it("sizes a row to its tallest cell and stacks rows without gaps", () => {
    const layout = layoutTable(
      tableOf([
        ["h", "h2"],
        [
          "short",
          "a sentence long enough that it has to wrap in a narrow column",
        ],
      ]),
      ctx(240),
    );

    const [header, body] = layout.rows;
    expect(body.cells[1].lines.length).toBeGreaterThan(1);
    expect(body.height).toBeGreaterThan(header.height);
    expect(body.y).toBe(header.y + header.height);
    expect(header.y).toBe(layout.style.marginTop);
  });

  it("measures every row at the same weight — no row is a header", () => {
    const layout = layoutTable(
      tableOf([["same"], ["same"], ["same"]]),
      ctx(400),
    );
    const widths = layout.rows.map((row) => row.cells[0].lines[0].width);

    expect(new Set(widths).size).toBe(1);
  });

  it("reports a height covering the grid and both outer margins", () => {
    const layout = layoutTable(tableOf([["a"], ["b"]]), ctx(400));
    const grid = layout.rows.reduce((total, row) => total + row.height, 0);

    expect(layout.gridHeight).toBe(grid);
    expect(layout.height).toBe(
      grid + layout.style.marginTop + layout.style.marginBottom,
    );
  });

  it("positions cell lines inside the cell's padding box", () => {
    const layout = layoutTable(tableOf([["hello"], ["world"]]), ctx(400));
    const cell = layout.rows[1].cells[0];
    const line = cell.lines[0];

    expect(line.x).toBe(cell.x + layout.style.cellPaddingX);
    expect(line.y).toBe(cell.y + layout.style.cellPaddingY);
    expect(cell.textWidth).toBe(cell.width - layout.style.cellPaddingX * 2);
  });

  it("keeps a hole addressable as an empty cell with no identity", () => {
    // Drop the second row's only cell, the shape a concurrent add-column
    // against add-row converges to.
    const document = tableOf([
      ["a", "b"],
      ["c", "d"],
    ]);
    const rowCell = Object.values(document.nodes).find(
      (node) => node.type === "cell" && node.placement.slot === "cells",
    )!;
    const pruned = {
      ...document,
      nodes: Object.fromEntries(
        Object.entries(document.nodes).filter(([id]) => id !== rowCell.id),
      ),
    };

    const layout = layoutTable(pruned, ctx(400));
    const holes = layout.cells.filter((cell) => cell.cellId === null);
    expect(holes).toHaveLength(1);
    expect(holes[0].lines.map((line) => line.text)).toEqual([""]);
  });

  it("carries the column alignment declared by the markdown", () => {
    const identities = createDeterministicIdentityAllocator("aligns");
    const parsed = matchGfmTable(
      "| a | b | c |\n| :- | :-: | -: |\n| 1 | 2 | 3 |",
      0,
    );
    const seed = tableSeedFromToken(parsed!.table, identities);
    const layout = layoutTable(
      buildTableDocument(seed, {
        contentId: "table-1",
        identityAllocator: identities,
      }),
      ctx(600),
    );

    expect(layout.columns.map((column) => column.align)).toEqual([
      "left",
      "center",
      "right",
    ]);
  });

  it("lays out nothing for an absent or empty document", () => {
    expect(layoutTable(undefined, ctx(600)).height).toBe(0);
    expect(layoutTable(undefined, ctx(600)).cells).toEqual([]);
  });
});

describe("alignOffset with a line wider than its cell", () => {
  // A column squeezed past the point wrapping can help: a single glyph cannot
  // be broken, so the line genuinely exceeds the cell. The offset must keep the
  // line's READING start on the cell edge — aligning the negative slack would
  // push the start outside instead, hiding the characters that matter most.
  it("pins an over-wide line to the leading edge in left-to-right text", () => {
    expect(alignOffset(null, "ltr", 10, 40)).toBe(0);
    expect(alignOffset("right", "ltr", 10, 40)).toBe(0);
    expect(alignOffset("center", "ltr", 10, 40)).toBe(0);
  });

  it("pins an over-wide line to the leading edge in right-to-left text", () => {
    // The line box is measured from its left edge, so the right-to-left reading
    // start sits at the cell's right border once the box is shifted left.
    expect(alignOffset(null, "rtl", 10, 40)).toBe(-30);
    expect(alignOffset("left", "rtl", 10, 40)).toBe(-30);
  });

  it("still aligns normally when the line fits", () => {
    expect(alignOffset(null, "ltr", 40, 10)).toBe(0);
    expect(alignOffset("right", "ltr", 40, 10)).toBe(30);
    expect(alignOffset("center", "ltr", 40, 10)).toBe(15);
    expect(alignOffset(null, "rtl", 40, 10)).toBe(30);
  });
});
