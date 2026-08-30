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
import { measureTextUpToIndex } from "@tasfer/editor/fonts";
import type { CharRun } from "@tasfer/editor/serlization/loadPage";
import type {
  ContentSelection,
  ContentTextPoint,
} from "@tasfer/editor/structured-selection";
import {
  getCharIdAtVisiblePosition,
  getVisibleOffsetAfterChar,
  getVisibleTextFromChars,
  getVisibleTextFromRuns,
} from "@tasfer/editor/sync/char-runs";
import type { StructuredDocument } from "@tasfer/editor/sync/structured-content";
import {
  findWordBoundary,
  findWordEnd,
  findWordStart,
  isWordChar,
} from "@tasfer/editor/word-chars";

/** A caret inside one cell: the cell node's id and a visible UTF-16 offset. */
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
 * Address a cell caret as a stable {@link ContentTextPoint}.
 *
 * `affinity` is `forward` by default: a caret typed into is the leading edge of
 * what comes next, which is also what keeps a caret at a wrap boundary on the
 * line the user is typing on.
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

/** Resolve a nested point back to the cell and offset it addresses. */
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

/** A collapsed selection at one cell caret. */
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
 * A two-ended selection between two cell carets.
 *
 * Both ends are addressed the same way a caret is, so a range produced by a
 * drag, by Shift+Arrow or by a double-click is one and the same shape — which
 * is what lets the selection band, the mark toggles and the deletes all read it
 * through {@link tableCaretFromContentPoint} without caring which gesture made
 * it. The anchor takes `backward` affinity so it stays glued to the character
 * the range starts AFTER while the focus moves.
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

/** The cell containing `local`, or the nearest one when the point is outside. */
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

/** The line of a cell that owns `offset`, or the last line. */
export function cellLineAtOffset(
  cell: TableCellLayout,
  offset: number,
): number {
  for (let at = 0; at < cell.lines.length; at++) {
    const line = cell.lines[at];
    if (offset <= line.endIndex) return at;
  }
  return Math.max(0, cell.lines.length - 1);
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

/** Measured x (block-local) of `offset` within one of the cell's lines. */
export function cellOffsetX(
  layout: TableLayout,
  cell: TableCellLayout,
  lineIndex: number,
  offset: number,
): number {
  const line = cell.lines[lineIndex];
  if (!line) return cell.textX;
  const advance = measureTextUpToIndex(
    cell.chars,
    cell.marks,
    line.startIndex,
    Math.max(line.startIndex, Math.min(offset, line.endIndex)),
    layout.style.fontSize,
    layout.style.fontWeight,
    layout.fontFamily,
    layout.fonts,
    0,
    layout.marks,
  );
  // Measured from the line's own edge, which already carries the column's
  // alignment — so the caret lands on the glyphs paint actually drew.
  return cell.direction === "rtl"
    ? line.x + line.width - advance
    : line.x + advance;
}

/**
 * The offset in `cell` nearest to a block-local point.
 *
 * Measures forward from the line start and takes the nearest character
 * boundary, mirroring the search for a right-to-left cell so an Arabic cell's
 * caret lands where the glyphs actually are. Whole code points only — a caret
 * never splits a surrogate pair.
 */
export function cellOffsetFromPoint(
  layout: TableLayout,
  cell: TableCellLayout,
  local: { readonly x: number; readonly y: number },
): number {
  if (cell.lines.length === 0) return 0;
  let lineIndex = 0;
  for (let at = 0; at < cell.lines.length; at++) {
    lineIndex = at;
    if (local.y < cell.lines[at].y + cell.lines[at].height) break;
  }
  const line = cell.lines[lineIndex];
  const rtl = cell.direction === "rtl";
  const target = rtl ? line.x + line.width - local.x : local.x - line.x;

  const weight = layout.style.fontWeight;
  const text = getVisibleTextFromChars(cell.chars);
  let best = line.startIndex;
  let bestDistance = Math.abs(target);
  let offset = line.startIndex;
  while (offset < line.endIndex) {
    offset = Math.min(
      line.endIndex,
      nextCodePointEnd(text, Math.max(offset, line.startIndex)),
    );
    const advance = measureTextUpToIndex(
      cell.chars,
      cell.marks,
      line.startIndex,
      offset,
      layout.style.fontSize,
      weight,
      layout.fontFamily,
      layout.fonts,
      0,
      layout.marks,
    );
    const distance = Math.abs(target - advance);
    if (distance < bestDistance) {
      best = offset;
      bestDistance = distance;
    }
  }
  return best;
}

/** Where a pointer lands inside the table, as a collapsed nested selection. */
export function tableSelectionFromPoint(
  layout: TableLayout,
  local: { readonly x: number; readonly y: number },
  document: StructuredDocument,
  blockId: string,
): ContentSelection | null {
  const cell = cellFromPoint(layout, local);
  if (!cell?.cellId) return null;
  const offset = cellOffsetFromPoint(layout, cell, local);
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

/** The cell ids of a table in row-major order — the order Tab walks. */
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

/** The cell at a grid position, or `undefined` for a hole or out of range. */
export function cellAt(
  document: StructuredDocument,
  row: number,
  column: number,
): string | undefined {
  return readTable(document).rows[row]?.cells[column]?.id;
}

/**
 * Step a cell caret through the table's text.
 *
 * `backward`/`forward` are logical: they walk the text in storage order and
 * cross into the previous/next cell at a cell's edges, so arrow order and Tab
 * order stay the same walk. The action layer maps the LEFT and RIGHT keys onto
 * them, swapping the two in a right-to-left cell.
 *
 * Returns `undefined` when there is nowhere to go — the very start or end of
 * the table, or a caret already at the requested edge — so the caller can let
 * the key fall through and leave the table instead of dead-ending in it.
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
 * The word around `caret`, as a pair of carets in the same cell.
 *
 * What a double-click selects. The boundaries come from the engine's own word
 * walk, so a cell and a paragraph agree on where a word ends; a caret that is
 * not on a word (a click in the trailing space of a cell) collapses onto itself
 * rather than reaching across to the previous one.
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
  layout: TableLayout,
  cell: TableCellLayout,
  lineIndex: number,
  x: number,
): number {
  const line = cell.lines[lineIndex];
  if (!line) return 0;
  return cellOffsetFromPoint(layout, cell, { x, y: line.y + line.height / 2 });
}

/**
 * Move a cell caret one visual row.
 *
 * A tall cell is walked line by line first; only a cell's own top and bottom
 * lines hand the caret to the row above or below, so a wrapped cell behaves
 * like the paragraph it is. The caret keeps its horizontal position across the
 * move. Returns `undefined` at the table's top and bottom edges, where the
 * caller escapes to the surrounding document.
 *
 * `unit: "cell"` skips the inner line walk and lands in the neighbouring row
 * outright — what a selection that already covers whole cells extends by, where
 * the lines inside a covered cell are not stops of their own.
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
  const x = cellOffsetX(layout, cell, lineIndex, caret.offset);
  const nextLine = direction === "up" ? lineIndex - 1 : lineIndex + 1;
  if (unit === "line" && nextLine >= 0 && nextLine < cell.lines.length) {
    return { ...caret, offset: offsetNearestX(layout, cell, nextLine, x) };
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
    offset: offsetNearestX(layout, neighbour, landing, x),
  };
}

/**
 * The caret a table takes when the document caret arrives from `direction`:
 * the first row's leading cell entering downward, the last row's leading cell
 * entering upward. `x` is the horizontal position the caret arrives at, so it
 * lands under the column the user was already in.
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
    offset: offsetNearestX(layout, target, lineIndex, x),
  };
}
