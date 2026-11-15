/**
 * Exports that `@tasfer/table` no longer offers, kept so 0.2 imports keep
 * working. None of them is part of the public API any more.
 *
 * @deprecated Each will be removed in a later release.
 */

export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  registerTableActions,
} from "../actions";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  deleteColumn,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  deleteRow,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  emptyTableSeed,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  insertColumn,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  insertRow,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  moveColumn,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  NEW_TABLE_COLUMNS,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  NEW_TABLE_ROWS,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  registerTableCommands,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  setColumnAlign,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  setColumnWidths,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  setTableWidth,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableCommand,
} from "../commands";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  serializeTableContentSelection,
} from "../content-selection";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  commitTableEdits,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableTarget,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableTargetForBlock,
} from "../context";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableBlockCodec,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableBlockNodeCodec,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableBlockSpec,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableStructuredKind,
} from "../data";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableEdge,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableEdgeBox,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableEdgeStrip,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableEdgeStrips,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  withinEdgeBox,
} from "../edge-adders";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  fitColumnWidths,
} from "../geometry";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  registerTableInputActions,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableInputRule,
} from "../input";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  decodeTableToken,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  escapeCell,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type GfmTable,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  matchGfmTable,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  printGfmTable,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  TABLE_BLOCK,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableSeedFromToken,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableSyntaxRule,
} from "../markdown";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableToolsOverlay,
} from "../overlays";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  parseClipboardGrid,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  readTableClipboard,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableClipboard,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableContentPaste,
} from "../paste";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellCaretX,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellFromPoint,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellLength,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellLineAtOffset,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellOffsetFromPoint,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellRangeRects,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellRect,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellRuns,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellsInRect,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellTextRange,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellWordRange,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  coveredCellIds,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  moveTableCaretVertically,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  rowNeighbourCell,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  stepTableCaret,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableCaretStep,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableCellRange,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableCellRect,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableEntryCaret,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableLineRange,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableRangeToContentSelection,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableSelectionFromPoint,
} from "../selection";
export {
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  buildTableDocument,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  CELL_NODE,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellColumnId,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cellRunsFromText,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  CELLS_SLOT,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  cloneTableDocument,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  COLUMN_NODE,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  COLUMNS_SLOT,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  columnWidth,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  MAX_TABLE_WIDTH,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  ROW_NODE,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  ROWS_SLOT,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  TABLE_NODE,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableCellSeed,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableContentIdForBlock,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableDocumentInit,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  type TableSeed,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  tableWidth,
  /** @deprecated Not part of the public API any more. It will be removed in a later release. */
  validateTableDocument,
} from "../structured";
