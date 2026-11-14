/**
 * The caret model inside a table: cell ↔ {@link ContentPoint} conversion, the
 * point-to-cell hit-test, and the motions that walk between cells.
 *
 * A table block stores nothing flat, so its caret is never a block text index —
 * it is always an identity-bearing address into one cell's text field. Keeping
 * that translation in one module means the hit-test, the caret rect, the arrow
 * keys and Tab all agree on where a cell's offsets are, and none of them has to
 * reach into the CRDT runs itself.
 */

import { type TableCellLayout, type TableLayout } from "./geometry";
import { CELL_TEXT_FIELD, readTable } from "./structured";
import {
  nextCodePointEnd,
  prevCodePointStart,
} from "@tasfer/editor/code-points";
import type { CharRun } from "@tasfer/editor/serlization/loadPage";
import type {
  ContentSelection,
  ContentTextPoint,
} from "@tasfer/editor/structured-selection";
import {
  getCharIdAtVisiblePosition,
  getVisibleOffsetAfterChar,
  getVisibleTextFromRuns,
} from "@tasfer/editor/sync/char-runs";
import type { StructuredDocument } from "@tasfer/editor/sync/structured-content";
import {
  textCaretRect,
  textLineIndexAt,
  textOffsetAtPoint,
  textRangeRects,
} from "@tasfer/editor/text-layout";
import {
  findWordBoundary,
  findWordEnd,
  findWordStart,
  isWordChar,
} from "@tasfer/editor/word-chars";

/**
 * A caret inside one cell: the cell node's id and a visible UTF-16 offset.
 * Because it names the cell, someone editing another cell never moves it.
 *
 * @group Caret and selection
 */
export interface TableCaret {
  readonly cellId: string;
  readonly offset: number;
}

/** A selected span, as the two carets that bound it. */
export interface TableCellRange {
  readonly anchor: TableCaret;
  readonly focus: TableCaret;
}

/** The character runs of one cell's text field, or `undefined` if it has none. */
export function cellRuns(
  document: StructuredDocument,
  cellId: string,
): CharRun[] | undefined {
  const runs = document.nodes[cellId]?.textFields[CELL_TEXT_FIELD];
  return runs ? [...runs] : undefined;
}

/** The visible length of one cell's text. */
export function cellLength(
  document: StructuredDocument,
  cellId: string,
): number {
  return getVisibleTextFromRuns(cellRuns(document, cellId)).length;
}

/**
 * Turn a cell caret into a {@link ContentTextPoint} that stays in place when
 * the text around it changes. An offset past the end of the cell is clamped to
 * its length. Returns `undefined` when the cell is not in `document`.
 *
 * `affinity` is `forward` by default. That keeps a caret at a line wrap on the
 * line being typed.
 *
 * @group Caret and selection
 */
export function tableCaretToContentPoint(
  document: StructuredDocument,
  blockId: string,
  caret: TableCaret,
  affinity: "forward" | "backward" = "forward",
): ContentTextPoint | undefined {
  const runs = cellRuns(document, caret.cellId);
  if (!runs) return undefined;
  const length = getVisibleTextFromRuns(runs).length;
  const offset = Math.max(0, Math.min(caret.offset, length));
  return {
    kind: "text",
    blockId,
    contentId: document.rootId,
    nodeId: caret.cellId,
    field: CELL_TEXT_FIELD,
    afterCharId: getCharIdAtVisiblePosition(runs, offset),
    affinity,
  };
}

/**
 * Turn a content point back into a cell caret: the cell and the offset in it.
 * Returns `undefined` when the point is not text in a cell of this table.
 *
 * @group Caret and selection
 */
export function tableCaretFromContentPoint(
  document: StructuredDocument,
  point: {
    readonly kind: string;
    readonly nodeId?: string;
    readonly field?: string;
    readonly afterCharId?: string | null;
  },
): TableCaret | undefined {
  if (point.kind !== "text") return undefined;
  if (!point.nodeId || point.field !== CELL_TEXT_FIELD) return undefined;
  const runs = cellRuns(document, point.nodeId);
  if (!runs) return undefined;
  const offset = getVisibleOffsetAfterChar(runs, point.afterCharId ?? null);
  if (offset === null) return undefined;
  return { cellId: point.nodeId, offset };
}

/**
 * A collapsed selection at one cell caret.
 *
 * @group Caret and selection
 */
export function tableCaretToContentSelection(
  document: StructuredDocument,
  blockId: string,
  caret: TableCaret,
  affinity: "forward" | "backward" = "forward",
): ContentSelection | undefined {
  const point = tableCaretToContentPoint(document, blockId, caret, affinity);
  return point ? { anchor: point, focus: point } : undefined;
}

/**
 * A selection from `anchor` to `focus`, two carets in this table. Returns
 * `undefined` when either cell is not in `document`. The anchor sticks to the
 * character before it, so it stays put while the focus moves.
 */
export function tableRangeToContentSelection(
  document: StructuredDocument,
  blockId: string,
  anchor: TableCaret,
  focus: TableCaret,
): ContentSelection | undefined {
  const anchorPoint = tableCaretToContentPoint(
    document,
    blockId,
    anchor,
    "backward",
  );
  const focusPoint = tableCaretToContentPoint(document, blockId, focus);
  return anchorPoint && focusPoint
    ? { anchor: anchorPoint, focus: focusPoint }
    : undefined;
}

/**
 * The cell containing `local`, or the nearest one when the point is outside.
 * The cell can be a hole (`cellId` is `null`). Returns `undefined` for a table
 * with no rows.
 */
export function cellFromPoint(
  layout: TableLayout,
  local: { readonly x: number; readonly y: number },
): TableCellLayout | undefined {
  if (layout.rows.length === 0) return undefined;
  let row = layout.rows[0];
  for (const candidate of layout.rows) {
    // Clamp vertically: a point above the grid lands in the first row, below it
    // in the last, so a drag that leaves the table still resolves a cell.
    row = candidate;
    if (local.y < candidate.y + candidate.height) break;
  }
  if (local.y < layout.rows[0].y) row = layout.rows[0];

  let cell = row.cells[0];
  for (const candidate of row.cells) {
    cell = candidate;
    if (local.x < candidate.x + candidate.width) break;
  }
  if (local.x < row.cells[0].x) cell = row.cells[0];
  return cell;
}

/** The line of a cell a caret at `offset` sits on, or the last line. */
export function cellLineAtOffset(
  cell: TableCellLayout,
  offset: number,
): number {
  const line = textLineIndexAt(cell.text, offset);
  return line >= 0 ? line : Math.max(0, cell.lines.length - 1);
}

/**
 * How tall a caret standing in a cell should be.
 *
 * Text height (ascent + descent), anchored at the line top — the same measure a
 * paragraph caret uses. A cell's line box is taller than that, because it also
 * carries the row's leading, so drawing the caret at `line.height` would make
 * the caret in a cell visibly taller than the one in the prose beside it.
 *
 * Falls back the way `layoutTable` does when a font reports no usable metrics.
 */
export function cellCaretHeight(layout: TableLayout): number {
  const { fontMetrics, style } = layout;
  const ascent = Number.isFinite(fontMetrics.ascent)
    ? fontMetrics.ascent
    : style.fontSize * 0.8;
  const descent = Number.isFinite(fontMetrics.descent)
    ? fontMetrics.descent
    : style.fontSize * 0.2;
  return ascent + descent;
}

/**
 * Block-local x of a caret at `offset` in `cell` — measured by the engine, so it
 * lands on the glyph boundary paint drew, in mixed-direction lines too.
 */
export function cellCaretX(cell: TableCellLayout, offset: number): number {
  return cell.textX + textCaretRect(cell.text, offset).x;
}

/**
 * The highlight over `[from, to)` inside one cell, in block-local coordinates:
 * one rect per line, or per direction run where a line mixes directions.
 */
export function cellRangeRects(
  cell: TableCellLayout,
  from: number,
  to: number,
): { x: number; y: number; width: number; height: number; baseline: number }[] {
  return textRangeRects(cell.text, from, to).flatMap((rect) =>
    rect.width > 0 && rect.height > 0
      ? [
          {
            x: cell.textX + rect.x,
            y: cell.textY + rect.y,
            width: rect.width,
            height: rect.height,
            baseline: cell.textY + (rect.baseline ?? rect.y),
          },
        ]
      : [],
  );
}

/**
 * The offset in `cell` nearest to a block-local point. A point above the text
 * (in the cell's top padding) resolves on the first line, below it on the last.
 * Never lands between the halves of an emoji.
 */
export function cellOffsetFromPoint(
  cell: TableCellLayout,
  local: { readonly x: number; readonly y: number },
): number {
  return textOffsetAtPoint(
    cell.text,
    local.x - cell.textX,
    Math.max(0, local.y - cell.textY),
  );
}

/**
 * Where a pointer at block-local `local` lands, as a caret in a cell. A point
 * outside the grid lands in the nearest cell. Returns `null` when it lands on a
 * hole or the table has no rows.
 */
export function tableSelectionFromPoint(
  layout: TableLayout,
  local: { readonly x: number; readonly y: number },
  document: StructuredDocument,
  blockId: string,
): ContentSelection | null {
  const cell = cellFromPoint(layout, local);
  if (!cell?.cellId) return null;
  const offset = cellOffsetFromPoint(cell, local);
  return (
    tableCaretToContentSelection(document, blockId, {
      cellId: cell.cellId,
      offset,
    }) ?? null
  );
}

/** A caret motion that needs only the document — no layout, no measurement. */
export type TableCaretStep =
  | "backward"
  | "forward"
  | "word-backward"
  | "word-forward"
  | "next-cell"
  | "previous-cell"
  | "cell-start"
  | "cell-end";

/**
 * The cell ids of a table in row-major order — the order Tab walks.
 *
 * @group Caret and selection
 */
export function tableCellIds(document: StructuredDocument): string[] {
  const ids: string[] = [];
  for (const row of readTable(document).rows) {
    for (const cell of row.cells) {
      if (cell) ids.push(cell.id);
    }
  }
  return ids;
}

/** Where a cell sits in the grid, or `undefined` if it is not in this table. */
export function cellPosition(
  document: StructuredDocument,
  cellId: string,
): { readonly row: number; readonly column: number } | undefined {
  const rows = readTable(document).rows;
  for (let row = 0; row < rows.length; row++) {
    const column = rows[row].cells.findIndex((cell) => cell?.id === cellId);
    if (column >= 0) return { row, column };
  }
  return undefined;
}

/**
 * The next cell to the left (`delta: -1`) or right (`1`) in the same row,
 * skipping holes. Returns `undefined` at the row's edge, or when the cell is
 * not in the table. It never wraps onto the next row.
 */
export function rowNeighbourCell(
  document: StructuredDocument,
  cellId: string,
  delta: -1 | 1,
): string | undefined {
  const at = cellPosition(document, cellId);
  if (!at) return undefined;
  const cells = readTable(document).rows[at.row]?.cells ?? [];
  for (
    let column = at.column + delta;
    column >= 0 && column < cells.length;
    column += delta
  ) {
    const cell = cells[column];
    if (cell) return cell.id;
  }
  return undefined;
}

/** The cell at a grid position, or `undefined` for a hole or out of range. */
export function cellAt(
  document: StructuredDocument,
  row: number,
  column: number,
): string | undefined {
  return readTable(document).rows[row]?.cells[column]?.id;
}

/**
 * A rectangle of cells, as inclusive row and column bounds.
 *
 * A selection across cells covers a rectangle, as in a spreadsheet. Dragging
 * down from a header cell selects that column, not every cell in between. Copy,
 * paste, delete and the mark toggles all act on this rectangle.
 */
export interface TableCellRect {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** The rectangle two cells span, or `undefined` if either is not in the grid. */
export function cellRect(
  document: StructuredDocument,
  anchorCellId: string,
  focusCellId: string,
): TableCellRect | undefined {
  const anchor = cellPosition(document, anchorCellId);
  const focus = cellPosition(document, focusCellId);
  if (!anchor || !focus) return undefined;
  return {
    top: Math.min(anchor.row, focus.row),
    left: Math.min(anchor.column, focus.column),
    bottom: Math.max(anchor.row, focus.row),
    right: Math.max(anchor.column, focus.column),
  };
}

/**
 * The cells a rectangle covers, row by row, left to right. A hole (a cell a
 * row does not have) owns no text and is skipped.
 */
export function cellsInRect(
  document: StructuredDocument,
  rect: TableCellRect,
): string[] {
  const ids: string[] = [];
  const rows = readTable(document).rows;
  for (let row = rect.top; row <= rect.bottom; row++) {
    const cells = rows[row]?.cells ?? [];
    for (let column = rect.left; column <= rect.right; column++) {
      const cell = cells[column];
      if (cell) ids.push(cell.id);
    }
  }
  return ids;
}

/**
 * The ids of the cells in the rectangle between the two carets' cells, row by
 * row, left to right. Holes are skipped. Empty when either cell is not in the
 * table.
 */
export function coveredCellIds(
  document: StructuredDocument,
  anchor: TableCaret,
  focus: TableCaret,
): string[] {
  const rect = cellRect(document, anchor.cellId, focus.cellId);
  return rect ? cellsInRect(document, rect) : [];
}

/**
 * The carets that select a whole row (`axis: "row"`) or a whole column: from
 * the start of its first cell to the end of its last. `undefined` when the
 * index is outside the grid or the line has no cell at all.
 */
export function tableLineRange(
  document: StructuredDocument,
  axis: "row" | "column",
  index: number,
): TableCellRange | undefined {
  const view = readTable(document);
  const cells =
    axis === "row"
      ? (view.rows[index]?.cells ?? [])
      : index >= 0 && index < view.columns.length
        ? view.rows.map((row) => row.cells[index])
        : [];
  const present = cells.filter((cell) => cell !== undefined);
  const first = present[0];
  const last = present[present.length - 1];
  if (!first || !last) return undefined;
  return {
    anchor: { cellId: first.id, offset: 0 },
    focus: { cellId: last.id, offset: cellLength(document, last.id) },
  };
}

/**
 * Move a cell caret one step through the table's text.
 *
 * `backward` and `forward` follow the text's stored order, and cross into the
 * previous or next cell at a cell's edge. Tab walks the cells in the same
 * order. In a right-to-left cell, swap them for the Left and Right keys.
 *
 * Returns `undefined` when there is nowhere to go: at the very start or end of
 * the table, or when the caret is already at the edge asked for. The caller can
 * then let the key move the caret out of the table.
 */
export function stepTableCaret(
  document: StructuredDocument,
  caret: TableCaret,
  motion: TableCaretStep,
): TableCaret | undefined {
  const runs = cellRuns(document, caret.cellId);
  if (!runs) return undefined;
  const text = getVisibleTextFromRuns(runs);
  const length = text.length;
  const order = tableCellIds(document);
  const at = order.indexOf(caret.cellId);
  if (at < 0) return undefined;

  const intoPrevious = (): TableCaret | undefined => {
    const previous = order[at - 1];
    if (previous === undefined) return undefined;
    return { cellId: previous, offset: cellLength(document, previous) };
  };
  const intoNext = (): TableCaret | undefined => {
    const next = order[at + 1];
    return next === undefined ? undefined : { cellId: next, offset: 0 };
  };

  switch (motion) {
    case "cell-start":
      return caret.offset === 0 ? undefined : { ...caret, offset: 0 };
    case "cell-end":
      return caret.offset === length ? undefined : { ...caret, offset: length };
    case "previous-cell":
      return intoPrevious();
    case "next-cell":
      return intoNext();
    case "backward":
      return caret.offset > 0
        ? { ...caret, offset: prevCodePointStart(text, caret.offset) }
        : intoPrevious();
    case "forward":
      return caret.offset < length
        ? { ...caret, offset: nextCodePointEnd(text, caret.offset) }
        : intoNext();
    // Word steps ask the engine's own boundary walk, so Alt+Arrow stops in the
    // same places inside a cell as it does in the paragraph above the table —
    // including the scripts whose word shape is not spaces (CJK, vocalized
    // Arabic). At a cell's edge they cross exactly as the character steps do.
    case "word-backward":
      return caret.offset > 0
        ? { ...caret, offset: findWordBoundary(text, caret.offset, "left") }
        : intoPrevious();
    case "word-forward":
      return caret.offset < length
        ? { ...caret, offset: findWordBoundary(text, caret.offset, "right") }
        : intoNext();
  }
}

/**
 * The word at `caret`, as two carets in the same cell. This is what a
 * double-click selects. Words end where they do in a paragraph.
 *
 * A caret just after a word, on the space after it or at the end of the cell,
 * takes that word. Returns `undefined` when there is no word there, or when the
 * cell is not in `document`.
 */
export function cellWordRange(
  document: StructuredDocument,
  caret: TableCaret,
): TableCellRange | undefined {
  const runs = cellRuns(document, caret.cellId);
  if (!runs) return undefined;
  const text = getVisibleTextFromRuns(runs);
  const at = Math.max(0, Math.min(caret.offset, text.length));
  const span =
    at < text.length && isWordChar(text[at])
      ? { from: findWordStart(text, at), to: findWordEnd(text, at) }
      : // Not on a word but just after one — a double-click on the space that
        // follows it, or past the end of the cell's text. Native text fields
        // take the word that ended there, and so does the prose beside the
        // table.
        at > 0 && isWordChar(text[at - 1])
        ? { from: findWordStart(text, at), to: at }
        : undefined;
  if (!span || span.from === span.to) return undefined;
  return {
    anchor: { cellId: caret.cellId, offset: span.from },
    focus: { cellId: caret.cellId, offset: span.to },
  };
}

/** The whole of one cell's text, as a pair of carets — what a triple-click takes. */
export function cellTextRange(
  document: StructuredDocument,
  caret: TableCaret,
): TableCellRange | undefined {
  const runs = cellRuns(document, caret.cellId);
  if (!runs) return undefined;
  return {
    anchor: { cellId: caret.cellId, offset: 0 },
    focus: {
      cellId: caret.cellId,
      offset: getVisibleTextFromRuns(runs).length,
    },
  };
}

function cellById(
  layout: TableLayout,
  cellId: string,
): TableCellLayout | undefined {
  return layout.cells.find((cell) => cell.cellId === cellId);
}

/** The cell in `columnIndex` of the row `delta` away, skipping holes. */
function verticalNeighbour(
  layout: TableLayout,
  cell: TableCellLayout,
  delta: number,
): TableCellLayout | undefined {
  for (
    let row = cell.rowIndex + delta;
    row >= 0 && row < layout.rows.length;
    row += delta
  ) {
    const candidate = layout.rows[row].cells[cell.columnIndex];
    if (candidate?.cellId) return candidate;
  }
  return undefined;
}

/** The offset in `cell` whose x on `lineIndex` is closest to `x`. */
function offsetNearestX(
  cell: TableCellLayout,
  lineIndex: number,
  x: number,
): number {
  const line = cell.lines[lineIndex];
  if (!line) return 0;
  return cellOffsetFromPoint(cell, { x, y: line.y + line.height / 2 });
}

/**
 * Move a cell caret up or down one line. In a cell with wrapped text, the caret
 * moves line by line first. From a cell's top or bottom line it goes to the
 * cell above or below. The caret keeps its horizontal position.
 *
 * Returns `undefined` at the table's top or bottom edge, so the caller can move
 * the caret out of the table.
 *
 * With `unit: "cell"`, it skips the lines and goes straight to the next row.
 * Use it to grow a selection that already covers whole cells.
 */
export function moveTableCaretVertically(
  layout: TableLayout,
  caret: TableCaret,
  direction: "up" | "down",
  unit: "line" | "cell" = "line",
): TableCaret | undefined {
  const cell = cellById(layout, caret.cellId);
  if (!cell?.cellId) return undefined;
  const lineIndex = cellLineAtOffset(cell, caret.offset);
  const x = cellCaretX(cell, caret.offset);
  const nextLine = direction === "up" ? lineIndex - 1 : lineIndex + 1;
  if (unit === "line" && nextLine >= 0 && nextLine < cell.lines.length) {
    return { ...caret, offset: offsetNearestX(cell, nextLine, x) };
  }
  const neighbour = verticalNeighbour(
    layout,
    cell,
    direction === "up" ? -1 : 1,
  );
  if (!neighbour?.cellId) return undefined;
  const landing =
    direction === "up" ? Math.max(0, neighbour.lines.length - 1) : 0;
  return {
    cellId: neighbour.cellId,
    offset: offsetNearestX(neighbour, landing, x),
  };
}

/**
 * Where the caret lands when it moves into the table from the text around it.
 * Moving `down` lands on the first line of the first row. Moving `up` lands on
 * the last line of the last row. `x` is the caret's block-local horizontal
 * position, so it lands in the cell under it, at the nearest offset. Returns
 * `undefined` when the table has no rows, or that row has no cells.
 */
export function tableEntryCaret(
  layout: TableLayout,
  direction: "up" | "down",
  x: number,
): TableCaret | undefined {
  const row =
    direction === "down" ? layout.rows[0] : layout.rows[layout.rows.length - 1];
  if (!row) return undefined;
  let target = row.cells.find((cell) => cell.cellId !== null);
  for (const cell of row.cells) {
    if (!cell.cellId) continue;
    if (x >= cell.x) target = cell;
  }
  if (!target?.cellId) return undefined;
  const lineIndex =
    direction === "down" ? 0 : Math.max(0, target.lines.length - 1);
  return {
    cellId: target.cellId,
    offset: offsetNearestX(target, lineIndex, x),
  };
}
