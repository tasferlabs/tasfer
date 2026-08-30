/**
 * Table layout geometry — pure column/row/cell measurement, no canvas.
 *
 * Split from the node so the whole size computation is testable without a
 * paint context, and so the height pass, paint, hit-test and the caret all read
 * ONE result. Every cell is ordinary prose, so this measures and wraps through
 * the engine's own text pipeline (`wrapText` / `measureTextUpToIndex`) rather
 * than a table-local approximation — otherwise a caret placed from these boxes
 * would drift from the glyphs `paint` draws.
 *
 * The table always fits the page width: there is no horizontal scroll in the
 * viewport (it scrolls vertically only), so a grid that overflowed would simply
 * be unreachable. Columns therefore split the available width evenly, except
 * where someone has dragged an edge — a stored width is the only thing that
 * makes one column wider than another. Text has no say in it: it wraps inside
 * whatever width its column has.
 */

import {
  CELL_TEXT_FIELD,
  columnAlign,
  columnWidth,
  readTable,
  type TableAlign,
  type TableView,
} from "./structured";
import type { FontFamily } from "@tasfer/editor/fonts";
import {
  getFontMetrics,
  measureTextUpToIndex,
  type WrappedLine,
  wrapText,
} from "@tasfer/editor/fonts";
import type { MarkRegistry } from "@tasfer/editor/rendering/marks";
import type { NodeLayout } from "@tasfer/editor/rendering/nodes/Node";
import { getTextDirection } from "@tasfer/editor/rtl";
import type { Char, MarkRange } from "@tasfer/editor/serlization/loadPage";
import type {
  FontMetrics,
  FontStyles,
  RenderedLine,
  TableBlockStyle,
} from "@tasfer/editor/state-types";
import {
  charRunsToChars,
  getVisibleTextFromChars,
} from "@tasfer/editor/sync/char-runs";
import type { StructuredDocument } from "@tasfer/editor/sync/structured-content";

/** One column's horizontal band, in block-local coordinates. */
export interface TableColumnLayout {
  /** Left edge of the column, measured from the block's content box. */
  readonly x: number;
  readonly width: number;
  /** The column's declared alignment; `null` is the default (leading edge). */
  readonly align: TableAlign | null;
}

/** One laid-out cell: its box, its resolved text, and its wrapped lines. */
export interface TableCellLayout {
  /**
   * The cell node's id, or `null` for a hole — a column this row has no cell
   * for (see `readTable`). A hole paints as an empty cell and takes no caret.
   */
  readonly cellId: string | null;
  readonly rowIndex: number;
  readonly columnIndex: number;
  /** The cell's full box (border to border), in block-local coordinates. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Left edge and width of the text area inside the cell's padding. */
  readonly textX: number;
  readonly textWidth: number;
  /** Document-order characters (tombstones included) of the cell's text field. */
  readonly chars: Char[];
  readonly marks: readonly MarkRange[];
  /**
   * Base direction of this cell's own text. Resolved per cell, not per block: a
   * table can pair an Arabic label column with a Latin data column, and each
   * should read from its own leading edge.
   */
  readonly direction: "rtl" | "ltr";
  /**
   * Wrapped line boxes in block-local coordinates. `x` is each line's LEFT edge
   * with the column's alignment already applied, so paint, the caret and the
   * hit-test all read the same edge instead of re-deriving the alignment three
   * times.
   */
  readonly lines: readonly RenderedLine[];
}

/**
 * The gap between a line's left edge and the cell's text area, for one column
 * alignment. `null` means "the reading direction's leading edge", which is what
 * an undecorated GFM column gets.
 */
export function alignOffset(
  align: TableAlign | null,
  direction: "rtl" | "ltr",
  textWidth: number,
  lineWidth: number,
): number {
  const slack = textWidth - lineWidth;
  // A line wider than its cell — a column squeezed below even its minimum, where
  // wrapping has no move left. Alignment is meaningless then, so pin the line's
  // READING start to the cell edge and let the tail overflow behind the clip:
  // aligning a negative slack would push the start out of the cell instead, and
  // the first characters are the ones worth keeping.
  if (slack < 0) return direction === "rtl" ? slack : 0;
  const resolved = align ?? (direction === "rtl" ? "right" : "left");
  if (resolved === "center") return slack / 2;
  return resolved === "right" ? slack : 0;
}

/** One row band and its cells, one per column (holes included). */
export interface TableRowLayout {
  readonly rowId: string;
  readonly y: number;
  readonly height: number;
  readonly cells: readonly TableCellLayout[];
}

/** The full table layout — the single geometry every pass reads. */
export interface TableLayout extends NodeLayout {
  readonly columns: readonly TableColumnLayout[];
  readonly rows: readonly TableRowLayout[];
  /** Top edge of the grid inside the block (below the outer flow margin). */
  readonly gridTop: number;
  /** The grid's own height, excluding the outer flow margins. */
  readonly gridHeight: number;
  readonly gridWidth: number;
  readonly style: TableBlockStyle;
  readonly fontMetrics: FontMetrics;
  readonly lineHeight: number;
  /** Cell boxes flattened in row-major order, for hit-testing. */
  readonly cells: readonly TableCellLayout[];
  // The measurement inputs, carried so the caret and hit-test passes re-measure
  // a cell exactly as this layout did (the same reason TextNodeLayout keeps
  // them) rather than re-deriving them from a theme they might read differently.
  readonly fontFamily: FontFamily;
  readonly fonts: FontStyles;
  readonly marks?: MarkRegistry;
}

/** Everything the geometry needs that is not the document itself. */
export interface TableLayoutCtx {
  readonly maxWidth: number;
  readonly style: TableBlockStyle;
  readonly fontFamily: FontFamily;
  readonly fonts: FontStyles;
  readonly marks?: MarkRegistry;
}

/**
 * Split `available` between weighted columns, none of them under `floor`.
 *
 * The weights are relative, so they are normalized to the width rather than
 * trusted to sum to it: half a grid's worth of stored fractions describes a
 * split, not a gap down the right-hand side. A column the split would put under
 * `floor` is settled there and the rest re-share what is left — repeatedly,
 * since settling one column can push the next under in turn.
 */
function allocate(
  weights: readonly number[],
  available: number,
  floor: number,
): number[] {
  const widths = weights.map(() => 0);
  const settled = weights.map(() => false);
  let room = available;
  let sharing = weights.length;
  let total = weights.reduce((sum, weight) => sum + weight, 0);

  for (;;) {
    let starved = false;
    for (let at = 0; at < weights.length; at++) {
      if (settled[at]) continue;
      const width =
        total > 0 ? (weights[at] * room) / total : room / Math.max(1, sharing);
      if (width >= floor) {
        widths[at] = width;
        continue;
      }
      // Settling changes what the columns still sharing get, so this pass's
      // earlier widths are stale — the next pass recomputes them all, and the
      // pass that settles nobody is the one whose numbers are consistent.
      settled[at] = true;
      widths[at] = floor;
      room -= floor;
      total -= weights[at];
      sharing -= 1;
      starved = true;
    }
    if (!starved || sharing === 0) return widths;
  }
}

/**
 * Fit `count` column widths into `available`.
 *
 * `fixed` carries each column's explicitly set width as a fraction of the grid
 * (`null` for automatic) — what a resize drag writes, and the ONLY thing that
 * makes one column wider than another. Columns nobody has touched split the
 * grid evenly and the text inside them wraps to whatever they got.
 *
 * Fitting columns to their content instead meant the grid rearranged itself
 * while someone typed: a cell's text growing moved columns in the rest of the
 * table, and a width the user had chosen by eye was taken back the moment the
 * text under it changed. A width is a decision, so it changes when the user
 * makes one.
 *
 * `minWidth` is the floor no column goes under, a dragged one included — and
 * including a document written on a wide screen and opened on a phone, where
 * the stored fractions scale down with the page. It yields only when the page
 * cannot hold even one floor per column: the columns then share what there is,
 * since a grid wider than the viewport could never be scrolled to.
 *
 * Widths are rounded to whole pixels with the rounding error carried forward,
 * so the columns always sum to exactly `available` on every peer.
 */
export function fitColumnWidths(
  count: number,
  available: number,
  fixed: readonly (number | null)[] = [],
  minWidth = 0,
): number[] {
  if (count <= 0) return [];
  const floor = Math.max(0, Math.min(minWidth, available / count));

  // An untouched column's weight is its share of whatever the stored fractions
  // leave, so a grid nobody has resized has equal weights and splits evenly.
  let pinnedTotal = 0;
  let autoCount = 0;
  for (let at = 0; at < count; at++) {
    const fraction = fixed[at] ?? null;
    if (fraction === null) autoCount += 1;
    else pinnedTotal += fraction;
  }
  const autoShare =
    autoCount > 0 ? Math.max(0, 1 - pinnedTotal) / autoCount : 0;
  const exact = allocate(
    Array.from({ length: count }, (_, at) => fixed[at] ?? autoShare),
    available,
    floor,
  );

  // Round the running total rather than each width, so every column stays
  // within a pixel of its exact share AND the widths sum to `available` — a
  // per-width round would leave a seam the border pass could not close.
  const widths: number[] = [];
  let exactEdge = 0;
  let roundedEdge = 0;
  for (let at = 0; at < exact.length; at++) {
    exactEdge += exact[at];
    const edge = at === exact.length - 1 ? available : Math.round(exactEdge);
    widths.push(Math.max(0, edge - roundedEdge));
    roundedEdge = edge;
  }
  return widths;
}

/** Lay out a whole table document at `maxWidth`. */
export function layoutTable(
  document: StructuredDocument | undefined,
  ctx: TableLayoutCtx,
): TableLayout {
  const view: TableView = document
    ? readTable(document)
    : { root: undefined, columns: [], rows: [] };
  const { style } = ctx;
  const fontMetrics = getFontMetrics(
    style.fontSize,
    style.fontWeight,
    ctx.fontFamily,
    ctx.fonts,
  );
  const lineHeight = fontMetrics.fontSize * style.lineHeight;
  const ascent = Number.isFinite(fontMetrics.ascent)
    ? fontMetrics.ascent
    : style.fontSize * 0.8;
  const descent = Number.isFinite(fontMetrics.descent)
    ? fontMetrics.descent
    : style.fontSize * 0.2;
  const rowLineHeight = Math.max(lineHeight, ascent + descent);

  const empty: TableLayout = {
    height: 0,
    lines: [],
    maxWidth: ctx.maxWidth,
    columns: [],
    rows: [],
    gridTop: 0,
    gridHeight: 0,
    gridWidth: 0,
    style,
    fontMetrics,
    lineHeight: rowLineHeight,
    cells: [],
    fontFamily: ctx.fontFamily,
    fonts: ctx.fonts,
    marks: ctx.marks,
  };
  if (view.columns.length === 0 || view.rows.length === 0) return empty;

  // Per-cell text resolved once: the width pass, the wrap pass and paint all
  // read these arrays, so a cell is never converted from runs twice.
  const text = view.rows.map((row) =>
    row.cells.map((cell) => {
      if (!cell) return { chars: [] as Char[], marks: [] as MarkRange[] };
      return {
        chars: charRunsToChars([...(cell.textFields[CELL_TEXT_FIELD] ?? [])]),
        marks: (cell.markFields?.[CELL_TEXT_FIELD] ?? []) as MarkRange[],
      };
    }),
  );
  const padding = style.cellPaddingX * 2;
  // No pass over the cells to size the columns: the grid is split evenly unless
  // a column carries a width someone dragged it to. Cell text only decides how
  // it wraps inside the width its column already has.
  const widths = fitColumnWidths(
    view.columns.length,
    ctx.maxWidth,
    view.columns.map(columnWidth),
    style.minColumnWidth,
  );
  const columns: TableColumnLayout[] = [];
  let x = 0;
  for (let at = 0; at < widths.length; at++) {
    columns.push({
      x,
      width: widths[at],
      align: columnAlign(view.columns[at]),
    });
    x += widths[at];
  }

  const rows: TableRowLayout[] = [];
  const cells: TableCellLayout[] = [];
  const lines: RenderedLine[] = [];
  let y = style.marginTop;
  for (let rowIndex = 0; rowIndex < view.rows.length; rowIndex++) {
    const row = view.rows[rowIndex];
    const rowCells: TableCellLayout[] = [];
    // Two passes over the row: wrap every cell to learn the tallest, then
    // position the boxes. A cell's lines are top-aligned within the row, so the
    // second pass only needs the row's own top.
    const wrapped: { lines: WrappedLine[]; height: number }[] = [];
    for (let column = 0; column < columns.length; column++) {
      const cell = text[rowIndex][column];
      const textWidth = Math.max(1, columns[column].width - padding);
      const cellLines =
        cell.chars.length > 0
          ? wrapText(
              cell.chars,
              cell.marks,
              textWidth,
              style.fontSize,
              style.fontWeight,
              ctx.fontFamily,
              ctx.fonts,
              0,
              null,
              ctx.marks,
            )
          : [{ text: "", consumedSpace: false }];
      wrapped.push({
        lines: cellLines,
        height: cellLines.length * rowLineHeight,
      });
    }
    const contentHeight = wrapped.reduce(
      (tallest, cell) => Math.max(tallest, cell.height),
      rowLineHeight,
    );
    const rowHeight = Math.round(contentHeight + style.cellPaddingY * 2);

    for (let column = 0; column < columns.length; column++) {
      const cell = view.rows[rowIndex].cells[column];
      const content = text[rowIndex][column];
      const box = columns[column];
      const textX = box.x + style.cellPaddingX;
      const textWidth = Math.max(1, box.width - padding);
      const direction = getTextDirection(
        getVisibleTextFromChars(content.chars),
      );
      const cellLines: RenderedLine[] = [];
      let lineY = y + style.cellPaddingY;
      let textIndex = 0;
      for (const line of wrapped[column].lines) {
        const width = measureTextUpToIndex(
          content.chars,
          content.marks,
          textIndex,
          textIndex + line.text.length,
          style.fontSize,
          style.fontWeight,
          ctx.fontFamily,
          ctx.fonts,
          0,
          ctx.marks,
        );
        cellLines.push({
          text: line.text,
          // The line's TRUE width, not one clamped to the cell: clamping made an
          // over-wide line claim it fit, so the caret and the hit-test both
          // placed themselves against a box the glyphs had already left.
          x: textX + alignOffset(box.align, direction, textWidth, width),
          y: lineY,
          width,
          height: rowLineHeight,
          baselineOffset: ascent,
          startIndex: textIndex,
          endIndex: textIndex + line.text.length,
        });
        lineY += rowLineHeight;
        textIndex += line.text.length;
        if (line.consumedSpace) textIndex += 1;
      }
      const layout: TableCellLayout = {
        cellId: cell?.id ?? null,
        rowIndex,
        columnIndex: column,
        x: box.x,
        y,
        width: box.width,
        height: rowHeight,
        textX,
        textWidth,
        chars: content.chars,
        marks: content.marks,
        direction,
        lines: cellLines,
      };
      rowCells.push(layout);
      cells.push(layout);
      lines.push(...cellLines);
    }

    rows.push({
      rowId: row.node.id,
      y,
      height: rowHeight,
      cells: rowCells,
    });
    y += rowHeight;
  }

  const gridHeight = y - style.marginTop;
  return {
    height: gridHeight + style.marginTop + style.marginBottom,
    lines,
    maxWidth: ctx.maxWidth,
    columns,
    rows,
    gridTop: style.marginTop,
    gridHeight,
    gridWidth: ctx.maxWidth,
    style,
    fontMetrics,
    lineHeight: rowLineHeight,
    cells,
    fontFamily: ctx.fontFamily,
    fonts: ctx.fonts,
    marks: ctx.marks,
  };
}
