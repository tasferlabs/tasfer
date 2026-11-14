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

export {
  TABLE_DELETE_COLUMN,
  TABLE_DELETE_ROW,
  TABLE_INSERT_COLUMN,
  TABLE_INSERT_ROW,
  TABLE_MOVE_COLUMN,
  TABLE_SELECT_COLUMN,
  TABLE_SELECT_ROW,
  TABLE_SET_COLUMN_ALIGN,
  type TableInsertSide,
  type TableShape,
  tableShapeAt,
  type TableTargetPayload,
} from "./commands";
export { tableContentSelectionKind } from "./content-selection";
export { activeTableContext, type TableContext } from "./context";
export {
  type TableBlockAttrs,
  type TableDataExtension,
  tableDataExtension,
} from "./data";
export {
  layoutTable,
  type TableCellLayout,
  type TableColumnLayout,
  type TableLayout,
  type TableLayoutCtx,
  type TableRowLayout,
} from "./geometry";
export { createTableInputRule, type TableInputOptions } from "./input";
export { TABLE_TOOLS_OVERLAY, type TableToolsOverlayData } from "./overlays";
export {
  type TableCaret,
  tableCaretFromContentPoint,
  tableCaretToContentPoint,
  tableCaretToContentSelection,
  tableCellIds,
} from "./selection";
export {
  CELL_TEXT_FIELD,
  cellText,
  columnAlign,
  getTableDocument,
  readTable,
  TABLE_STRUCTURED_KIND,
  type TableAlign,
  type TableRowView,
  type TableView,
} from "./structured";
export {
  tableExtension,
  type TableFeatureExtension,
  type TableFeatureOptions,
} from "./table-extension";
export { type TableBlock, TableNode } from "./TableNode";
