/**
 * @tasfer/table — the table block for `@tasfer/editor`.
 *
 * Compose the feature into a schema:
 *
 *   const schema = baseSchema.use(tableExtension());
 *
 * Headless consumers (workers, Markdown tooling, the CLI) want the canvas-free
 * half instead, from `@tasfer/table/data`:
 *
 *   const schema = baseDataSchema.extend(tableDataExtension());
 *
 * A table's content — columns, rows and the rich text of every cell — lives in
 * one structured CRDT attachment on its block; see `./structured` for the shape
 * and the reasoning behind it.
 *
 * Host chrome drives the grid through the `TABLE_*` actions in `./commands` and
 * reads it back with `tableShapeAt`; everything else — the caret, typing, the
 * column-resize drag, the outer-edge "add" strips — the node owns.
 */

export { registerTableActions } from "./actions";
export {
  deleteColumn,
  deleteRow,
  emptyTableSeed,
  insertColumn,
  insertRow,
  moveColumn,
  NEW_TABLE_COLUMNS,
  NEW_TABLE_ROWS,
  registerTableCommands,
  setColumnAlign,
  setColumnWidths,
  TABLE_DELETE_COLUMN,
  TABLE_DELETE_ROW,
  TABLE_INSERT_COLUMN,
  TABLE_INSERT_ROW,
  TABLE_MOVE_COLUMN,
  TABLE_SET_COLUMN_ALIGN,
  type TableCommand,
  type TableInsertSide,
  type TableShape,
  tableShapeAt,
  type TableTargetPayload,
} from "./commands";
export {
  serializeTableContentSelection,
  tableContentSelectionKind,
} from "./content-selection";
export {
  activeTableContext,
  commitTableEdits,
  type TableContext,
  type TableTarget,
  tableTargetForBlock,
} from "./context";
export {
  type TableBlockAttrs,
  tableBlockCodec,
  tableBlockNodeCodec,
  tableBlockSpec,
  type TableDataExtension,
  tableDataExtension,
  tableStructuredKind,
} from "./data";
export {
  type TableEdge,
  type TableEdgeBox,
  type TableEdgeStrip,
  tableEdgeStrips,
  withinEdgeBox,
} from "./edge-adders";
export {
  alignOffset,
  fitColumnWidths,
  layoutTable,
  type TableCellLayout,
  type TableColumnLayout,
  type TableLayout,
  type TableLayoutCtx,
  type TableRowLayout,
} from "./geometry";
export {
  createTableInputRule,
  registerTableInputActions,
  type TableInputOptions,
  tableInputRule,
} from "./input";
export {
  decodeTableToken,
  escapeCell,
  type GfmTable,
  matchGfmTable,
  printGfmTable,
  TABLE_BLOCK,
  tableSeedFromToken,
  tableSyntaxRule,
} from "./markdown";
export {
  type CellWrap,
  type CellWrapRevert,
  detectCellMarkdown,
  TABLE_MARKDOWN_RULE,
} from "./markdown-shortcuts";
export {
  TABLE_TOOLS_OVERLAY,
  tableToolsOverlay,
  type TableToolsOverlayData,
} from "./overlays";
export {
  cellFromPoint,
  cellLength,
  cellLineAtOffset,
  cellOffsetFromPoint,
  cellOffsetX,
  cellRuns,
  cellTextRange,
  cellWordRange,
  moveTableCaretVertically,
  stepTableCaret,
  type TableCaret,
  tableCaretFromContentPoint,
  type TableCaretStep,
  tableCaretToContentPoint,
  tableCaretToContentSelection,
  tableCellIds,
  type TableCellRange,
  tableEntryCaret,
  tableRangeToContentSelection,
  tableSelectionFromPoint,
} from "./selection";
export {
  buildTableDocument,
  CELL_NODE,
  CELL_TEXT_FIELD,
  cellColumnId,
  cellRunsFromText,
  CELLS_SLOT,
  cellText,
  cloneTableDocument,
  COLUMN_NODE,
  columnAlign,
  COLUMNS_SLOT,
  columnWidth,
  getTableDocument,
  readTable,
  ROW_NODE,
  ROWS_SLOT,
  TABLE_NODE,
  TABLE_STRUCTURED_KIND,
  type TableAlign,
  type TableCellSeed,
  tableContentIdForBlock,
  tableDocumentInit,
  type TableRowView,
  type TableSeed,
  type TableView,
  validateTableDocument,
} from "./structured";
export {
  tableExtension,
  type TableFeatureExtension,
  type TableFeatureOptions,
} from "./table-extension";
export { type TableBlock, TableNode } from "./TableNode";
