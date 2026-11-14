/**
 * Structural editing: add, remove and move rows and columns, set a column's
 * alignment, set its width, and create a table in the first place.
 *
 * Every command is a pure function from the current document to a batch of
 * {@link StructuredEdit}s plus the cell the caret should land in. Nothing here
 * touches editor state — the action wrappers at the bottom of the file hand the
 * batch to `commitTableEdits`, which is the same path a typed character takes,
 * so a structural edit merges, undoes and syncs exactly like a text edit.
 *
 * The guard rails are the grid's own invariants, not policy: a table keeps at
 * least one row and one column (an empty grid has nothing to put a caret in),
 * and there is no row above the header, because GFM has no way to write one.
 */

import {
  activeTableContext,
  type Claimed,
  commitTableEdits,
  type TableTarget,
  tableTargetForBlock,
} from "./context";
import {
  cellPosition,
  type TableCaret,
  tableCaretFromContentPoint,
  tableCaretToContentSelection,
  tableLineRange,
  tableRangeToContentSelection,
} from "./selection";
import {
  buildTableDocument,
  CELL_NODE,
  CELL_TEXT_FIELD,
  CELLS_SLOT,
  COLUMN_NODE,
  columnAlign,
  COLUMNS_SLOT,
  getTableDocument,
  readTable,
  ROW_NODE,
  ROWS_SLOT,
  type TableAlign,
  tableContentIdForBlock,
  type TableSeed,
} from "./structured";
import type { IdentityAllocator } from "@shared/identity";
import {
  type ActionBus,
  CONVERT_STRUCTURED_BLOCK,
  stateAction,
} from "@tasfer/editor/action-bus";
import { invalidateBlockCache } from "@tasfer/editor/rendering/renderer";
import { clearSelection, moveCursorToPosition } from "@tasfer/editor/selection";
import type { EditorState, Operation } from "@tasfer/editor/state-types";
import type { ContentPoint } from "@tasfer/editor/structured-selection";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { findBlockIndex } from "@tasfer/editor/sync/block-lookup";
import { isTextualBlock } from "@tasfer/editor/sync/block-registry";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import { deleteCharsInRange } from "@tasfer/editor/sync/crdt-utils";
import {
  generateKeyBetween,
  generateNKeysBetween,
} from "@tasfer/editor/sync/fractional-index";
import { applyOps } from "@tasfer/editor/sync/reducer";
import type {
  StructuredDocument,
  StructuredEdit,
  StructuredNode,
} from "@tasfer/editor/sync/structured-content";

/** Which side of the reference row/column a new one lands on. */
export type TableInsertSide = "before" | "after";

/**
 * What the table command functions return: the edits to make, and where the
 * caret goes afterwards. The `TABLE_*` actions apply it for you.
 */
export interface TableCommand {
  readonly edits: readonly StructuredEdit[];
  /** `undefined` leaves the caret where it is — the grid did not move under it. */
  readonly caret?: TableCaret;
}

/** The order key for a new sibling landing at `at` among `siblings`. */
function orderKeyAt(
  siblings: readonly StructuredNode[],
  at: number,
): string | undefined {
  const before = at > 0 ? siblings[at - 1]?.placement.orderKey : undefined;
  const after = siblings[at]?.placement.orderKey;
  try {
    return generateKeyBetween(before ?? null, after ?? null);
  } catch {
    // Two keys that cannot be split (a malformed remote document) would
    // otherwise throw through the action bus and take the keystroke with them.
    return undefined;
  }
}

/**
 * Build the edits that add an empty row before or after row `rowIndex`. Nothing
 * is applied yet. The matching `TABLE_*` action applies it. The
 * caret goes to the new row's first cell.
 *
 * Returns `undefined` for an empty table, and for `side: "before"` on the
 * header row. A row above the header would become the new header, because
 * Markdown tables treat the first row as the column titles. Hosts can read
 * `undefined` as "not available here".
 */
export function insertRow(
  document: StructuredDocument,
  identities: IdentityAllocator,
  rowIndex: number,
  side: TableInsertSide,
): TableCommand | undefined {
  const view = readTable(document);
  if (view.columns.length === 0 || view.rows.length === 0) return undefined;
  const reference = Math.max(0, Math.min(rowIndex, view.rows.length - 1));
  const at = side === "before" ? reference : reference + 1;
  if (at === 0) return undefined;

  const orderKey = orderKeyAt(
    view.rows.map((row) => row.node),
    at,
  );
  if (orderKey === undefined) return undefined;

  const rowId = identities.nextId();
  const edits: StructuredEdit[] = [
    {
      kind: "node_insert",
      node: {
        id: rowId,
        type: ROW_NODE,
        placement: { parentId: document.rootId, slot: ROWS_SLOT, orderKey },
        attrs: {},
        textFields: {},
      },
    },
  ];
  const cellKeys = generateNKeysBetween(null, null, view.columns.length);
  const cellIds = view.columns.map(() => identities.nextId());
  view.columns.forEach((column, at) => {
    edits.push({
      kind: "node_insert",
      node: {
        id: cellIds[at],
        type: CELL_NODE,
        placement: {
          parentId: rowId,
          slot: CELLS_SLOT,
          orderKey: cellKeys[at],
        },
        attrs: { columnId: column.id },
        textFields: { [CELL_TEXT_FIELD]: [] },
      },
    });
  });
  return { edits, caret: { cellId: cellIds[0], offset: 0 } };
}

/**
 * Build the edit that removes row `rowIndex`. Nothing is applied yet. The matching `TABLE_*` action applies it. The caret moves to the next
 * row, or to the one above if this was the last row.
 *
 * Returns `undefined` when the table has only one row or the row does not
 * exist. One undo brings the row back with its text.
 */
// Only the row node is tombstoned. Its cells stay in the store: a deleted
// parent is not traversable, so they are already invisible, and leaving them
// makes undo a single un-tombstone.
export function deleteRow(
  document: StructuredDocument,
  rowIndex: number,
): TableCommand | undefined {
  const view = readTable(document);
  // The last row is the table itself; removing it is a block delete, which the
  // engine already offers, not a structural edit inside the grid.
  if (view.rows.length <= 1) return undefined;
  const row = view.rows[rowIndex];
  if (!row) return undefined;

  const landing = view.rows[rowIndex + 1] ?? view.rows[rowIndex - 1];
  const cell = landing?.cells.find((candidate) => candidate !== undefined);
  return {
    edits: [{ kind: "node_delete", nodeId: row.node.id }],
    caret: cell ? { cellId: cell.id, offset: 0 } : undefined,
  };
}

/**
 * Build the edits that add an empty column before or after column
 * `columnIndex`, with a new cell in every row. Nothing is applied yet. The matching `TABLE_*` action applies it. The caret goes to the new
 * column's header cell. Returns `undefined` for an empty table.
 */
export function insertColumn(
  document: StructuredDocument,
  identities: IdentityAllocator,
  columnIndex: number,
  side: TableInsertSide,
): TableCommand | undefined {
  const view = readTable(document);
  if (view.columns.length === 0 || view.rows.length === 0) return undefined;
  const reference = Math.max(0, Math.min(columnIndex, view.columns.length - 1));
  const at = side === "before" ? reference : reference + 1;

  const orderKey = orderKeyAt(view.columns, at);
  if (orderKey === undefined) return undefined;

  const columnId = identities.nextId();
  const edits: StructuredEdit[] = [
    {
      kind: "node_insert",
      node: {
        id: columnId,
        type: COLUMN_NODE,
        placement: { parentId: document.rootId, slot: COLUMNS_SLOT, orderKey },
        attrs: {},
        textFields: {},
      },
    },
  ];

  // Where a new cell sits among its row's siblings does not decide which column
  // it belongs to — `readTable` resolves that by the `columnId` it names — so
  // each lands after the row's last cell, and the grid still reads in order.
  const cellIds: string[] = [];
  for (const row of view.rows) {
    const siblings = row.cells.filter(
      (cell): cell is StructuredNode => cell !== undefined,
    );
    const last = siblings[siblings.length - 1]?.placement.orderKey ?? null;
    let cellKey: string;
    try {
      cellKey = generateKeyBetween(last, null);
    } catch {
      return undefined;
    }
    const cellId = identities.nextId();
    cellIds.push(cellId);
    edits.push({
      kind: "node_insert",
      node: {
        id: cellId,
        type: CELL_NODE,
        placement: {
          parentId: row.node.id,
          slot: CELLS_SLOT,
          orderKey: cellKey,
        },
        attrs: { columnId },
        textFields: { [CELL_TEXT_FIELD]: [] },
      },
    });
  }
  // Land in the new column's header cell, which is where its title goes.
  return { edits, caret: { cellId: cellIds[0], offset: 0 } };
}

/**
 * Build the edit that removes column `columnIndex`. Nothing is applied yet. The matching `TABLE_*` action applies it. The caret moves to
 * the header cell of the column next to it.
 *
 * Returns `undefined` when the table has only one column or the column does not
 * exist. One undo brings the column back with its text.
 */
// Only the column node is tombstoned. Cells naming it are left alone: a cell
// whose column is gone resolves to no position and stops being read.
export function deleteColumn(
  document: StructuredDocument,
  columnIndex: number,
): TableCommand | undefined {
  const view = readTable(document);
  if (view.columns.length <= 1) return undefined;
  const column = view.columns[columnIndex];
  if (!column) return undefined;

  const landingIndex =
    columnIndex + 1 < view.columns.length ? columnIndex + 1 : columnIndex - 1;
  const cell = view.rows[0]?.cells[landingIndex];
  return {
    edits: [{ kind: "node_delete", nodeId: column.id }],
    caret: cell ? { cellId: cell.id, offset: 0 } : undefined,
  };
}

/**
 * Build the edit that moves column `columnIndex` so it ends up at
 * `targetIndex`. Nothing is applied yet. The matching `TABLE_*` action applies it.
 *
 * `targetIndex` is where the column sits after the move, counted in the grid as
 * it is now. So `moveColumn(document, 0, 2)` on `A B C` gives `B C A`. A target
 * past either end is clamped to the first or last column. For "move left" pass
 * `columnIndex - 1`, and for "move right" `columnIndex + 1`.
 *
 * Returns `undefined` when the column does not exist or would not move. The
 * cells move with their column, and the caret stays in its cell.
 */
// One node_move of the column node and nothing else: a cell names its column by
// id, so cells come along. The move only re-keys the column among its siblings,
// which is why two peers moving two different columns at once still converge.
export function moveColumn(
  document: StructuredDocument,
  columnIndex: number,
  targetIndex: number,
): TableCommand | undefined {
  const view = readTable(document);
  const column = view.columns[columnIndex];
  if (!column) return undefined;
  const target = Math.max(0, Math.min(targetIndex, view.columns.length - 1));
  if (target === columnIndex) return undefined;

  // The gap the column lands in, in the order with the column taken out —
  // the same order the grid has once the move applies.
  const others = view.columns.filter((_candidate, at) => at !== columnIndex);
  const orderKey = orderKeyAt(others, target);
  if (orderKey === undefined) return undefined;

  return {
    edits: [
      {
        kind: "node_move",
        nodeId: column.id,
        placement: { parentId: document.rootId, slot: COLUMNS_SLOT, orderKey },
      },
    ],
    // The caret's cell moves with its column, so the caret stays with it.
    caret: undefined,
  };
}

/**
 * Set (or, with `null`, clear) a column's alignment.
 */
export function setColumnAlign(
  document: StructuredDocument,
  columnIndex: number,
  align: TableAlign | null,
): TableCommand | undefined {
  const column = readTable(document).columns[columnIndex];
  if (!column) return undefined;
  return {
    edits: [
      align === null
        ? { kind: "node_attr_delete", nodeId: column.id, key: "align" }
        : {
            kind: "node_attr_set",
            nodeId: column.id,
            key: "align",
            value: align,
          },
    ],
  };
}

/**
 * Build the edits that set the width of one or more columns, as a fraction of
 * the table's width. Use `null` to return a column to automatic width.
 * Fractions, not pixels, keep the layout right on both a phone and a desktop.
 * Columns that do not exist are skipped. Returns `undefined` when none are
 * left.
 */
export function setColumnWidths(
  document: StructuredDocument,
  widths: ReadonlyArray<{
    readonly columnIndex: number;
    readonly fraction: number | null;
  }>,
): TableCommand | undefined {
  const columns = readTable(document).columns;
  const edits: StructuredEdit[] = [];
  for (const { columnIndex, fraction } of widths) {
    const column = columns[columnIndex];
    if (!column) continue;
    edits.push(
      fraction === null
        ? { kind: "node_attr_delete", nodeId: column.id, key: "width" }
        : {
            kind: "node_attr_set",
            nodeId: column.id,
            key: "width",
            value: fraction,
          },
    );
  }
  return edits.length > 0 ? { edits } : undefined;
}

/**
 * Build the edit that sets how wide the whole table is drawn, in page widths:
 * `1.5` is half again as wide as the page. Pass `null` to go back to the
 * automatic width. A width of 1 or less, or above {@link MAX_TABLE_WIDTH}, is
 * drawn at the automatic width. Page widths keep the table right on both a
 * phone and a desktop (see {@link tableWidth}). Returns `undefined` when the
 * document has no table in it.
 */
export function setTableWidth(
  document: StructuredDocument,
  width: number | null,
): TableCommand | undefined {
  if (!document.nodes[document.rootId]) return undefined;
  return {
    edits: [
      width === null
        ? { kind: "node_attr_delete", nodeId: document.rootId, key: "width" }
        : {
            kind: "node_attr_set",
            nodeId: document.rootId,
            key: "width",
            value: width,
          },
    ],
  };
}

/** The blank grid a freshly created table starts as. */
export function emptyTableSeed(rows: number, columns: number): TableSeed {
  return {
    aligns: Array.from({ length: columns }, () => null),
    rows: Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => ({ charRuns: [] })),
    ),
  };
}

/** How many rows a new table starts with: a header and two body rows. */
export const NEW_TABLE_ROWS = 3;
/** How many columns a new table starts with. */
export const NEW_TABLE_COLUMNS = 3;

// ── Action bus ───────────────────────────────────────────────────────────────

/**
 * Target a command at an explicit cell, or (by default) at the caret's own.
 *
 * Every `TABLE_*` action takes these fields. A change made by one syncs,
 * merges and undoes just like typing a character. When an action cannot apply,
 * such as deleting the only row, it changes nothing. Use {@link tableShapeAt}
 * to disable such a control ahead of time.
 *
 * @example
 * ```ts
 * import { TABLE_INSERT_ROW, TABLE_SELECT_COLUMN } from "@tasfer/table";
 *
 * // Add a row below the caret's row.
 * editor.dispatch(TABLE_INSERT_ROW, { side: "after" });
 * // Select the third column of the caret's table.
 * editor.dispatch(TABLE_SELECT_COLUMN, { columnIndex: 2 });
 * ```
 */
export interface TableTargetPayload {
  /**
   * The id of the table block to act on. Leave it out to act on the table the
   * caret is in, as a menu next to the caret would. A control drawn on the
   * canvas should pass its own block, since the pointer can be over a different
   * table than the caret.
   */
  readonly blockId?: string;
  /**
   * The row to act on, counted from 0. Row 0 is the header row. Leave it out
   * to use the caret's row.
   */
  readonly rowIndex?: number;
  /**
   * The column to act on, counted from 0. Leave it out to use the caret's
   * column.
   */
  readonly columnIndex?: number;
}

/**
 * Add an empty row above (`side: "before"`) or below (`side: "after"`) the
 * target row. Nothing happens when asked to add a row above the header row.
 */
export const TABLE_INSERT_ROW = stateAction<
  TableTargetPayload & { readonly side: TableInsertSide }
>("table-insert-row", (state) => ({ state, ops: [] }));

/** Delete the target row. Nothing happens when it is the table's only row. */
export const TABLE_DELETE_ROW = stateAction<TableTargetPayload>(
  "table-delete-row",
  (state) => ({ state, ops: [] }),
);

/**
 * Add an empty column before (`side: "before"`) or after (`side: "after"`)
 * the target column.
 */
export const TABLE_INSERT_COLUMN = stateAction<
  TableTargetPayload & { readonly side: TableInsertSide }
>("table-insert-column", (state) => ({ state, ops: [] }));

/**
 * Delete the target column. Nothing happens when it is the table's only
 * column.
 */
export const TABLE_DELETE_COLUMN = stateAction<TableTargetPayload>(
  "table-delete-column",
  (state) => ({ state, ops: [] }),
);

/**
 * Move the target column so it ends up at `to`. The column's cells move with
 * it, and the caret stays in its cell.
 *
 * `to` is where the column sits after the move, counted in the grid as it is
 * now. So moving column 0 of `A B C` to 2 gives `B C A`. A `to` past either end
 * goes to the first or last column. For "move left" pass the column's index
 * minus 1, and for "move right" its index plus 1.
 *
 * Dragging a column by its grip on the canvas dispatches this on release.
 */
export const TABLE_MOVE_COLUMN = stateAction<
  TableTargetPayload & { readonly to: number }
>("table-move-column", (state) => ({ state, ops: [] }));

/**
 * Align the target column's text left, center or right. Pass `align: null` to
 * clear the setting.
 */
export const TABLE_SET_COLUMN_ALIGN = stateAction<
  TableTargetPayload & { readonly align: TableAlign | null }
>("table-set-column-align", (state) => ({ state, ops: [] }));

/**
 * Select the whole target row, ready to copy, cut, clear or format as one. It
 * changes no content.
 */
export const TABLE_SELECT_ROW = stateAction<TableTargetPayload>(
  "table-select-row",
  (state) => ({ state, ops: [] }),
);

/**
 * Select the target column whole. Pressing a column's move grip without
 * dragging it dispatches this too, so the grip that picks a column up also
 * picks it out.
 */
export const TABLE_SELECT_COLUMN = stateAction<TableTargetPayload>(
  "table-select-column",
  (state) => ({ state, ops: [] }),
);

/** Park a nested range over a whole row or column of `target`'s table. */
function selectTableLine(
  state: EditorState,
  target: TableTarget,
  axis: "row" | "column",
  index: number,
): Claimed {
  const range = tableLineRange(target.document, axis, index);
  const selection =
    range &&
    tableRangeToContentSelection(
      target.document,
      target.block.id,
      range.anchor,
      range.focus,
    );
  if (!selection) return { state, ops: [], handled: true };
  return {
    state: updateContentSelection(clearSelection(state), {
      ...selection,
      lastUpdate: Date.now(),
    }),
    ops: [],
    handled: true,
  };
}

/** Where in the grid a command acts: the payload's cell, else the caret's. */
function targetCell(
  target: TableTarget,
  payload: TableTargetPayload,
): { readonly row: number; readonly column: number } {
  const at = target.caret
    ? cellPosition(target.document, target.caret.cellId)
    : undefined;
  return {
    row: payload.rowIndex ?? at?.row ?? 0,
    column: payload.columnIndex ?? at?.column ?? 0,
  };
}

/** The table a dispatch addresses: the block it names, else the caret's own. */
function commandTarget(
  state: EditorState,
  payload: TableTargetPayload,
): TableTarget | undefined {
  return payload.blockId === undefined
    ? activeTableContext(state)
    : tableTargetForBlock(state, payload.blockId);
}

/**
 * The shape of a table around one caret, for a host drawing its own controls:
 * how big the grid is, where the caret sits in it, and that column's alignment.
 * Everything a row/column panel needs to label and enable itself.
 *
 * Some commands do nothing in some places. Disable "delete row" when `rows`
 * is 1, "delete column" when `columns` is 1, and "add row above" when
 * `rowIndex` is 0. A row above the header is not allowed, because Markdown
 * tables always use the first row as the column titles.
 */
export interface TableShape {
  readonly rows: number;
  readonly columns: number;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly align: TableAlign | null;
}

/**
 * Read the shape of the table around a caret: its size, the caret's row and
 * column, and that column's alignment. Pass the table's document, from
 * `query.content(blockId, contentId)`, and the caret point, from
 * `state.contentSelection.focus`. It is safe to call during a React render.
 * Returns `undefined` when the point is not in one of the table's cells.
 */
export function tableShapeAt(
  document: StructuredDocument,
  point: ContentPoint,
): TableShape | undefined {
  const caret = tableCaretFromContentPoint(document, point);
  if (!caret) return undefined;
  const view = readTable(document);
  const at = cellPosition(document, caret.cellId);
  if (!at) return undefined;
  const column = view.columns[at.column];
  return {
    rows: view.rows.length,
    columns: view.columns.length,
    rowIndex: at.row,
    columnIndex: at.column,
    align: column ? columnAlign(column) : null,
  };
}

/**
 * Convert a plain block into a new, empty table.
 *
 * Core offers every conversion to the owning feature first, because a generic
 * morph would produce a `table` block with no attachment — a grid with no
 * columns, which paints as nothing. Claiming the seam is what lets a table be
 * created the same way every other block type is: the slash menu, a toolbar, or
 * `setBlock({ type: "table" })`.
 */
function convertBlockToTable(
  state: EditorState,
  blockIndex: number,
  targetType: string,
): Claimed | undefined {
  if (targetType !== "table" || state.ui.composition) return undefined;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return undefined;
  // A block already carrying attachments (an inline formula) has content that
  // an empty grid would strand; core leaves those conversions refused.
  if (
    block.structuredContent &&
    Object.keys(block.structuredContent).length > 0
  ) {
    return undefined;
  }

  const operationBase = () => ({
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
  });
  const ops: Operation[] = [];
  let page = state.document.page;

  // A table holds no flat text, so the block's prose is cleared — the same
  // bargain every conversion to an atomic block makes.
  const visibleLength = getVisibleTextFromRuns(block.charRuns).length;
  if (visibleLength > 0) {
    const deleted = deleteCharsInRange(
      page,
      block.id,
      0,
      visibleLength,
      state.CRDTbinding,
    );
    ops.push(deleted.op);
    page = deleted.newPage;
  }

  const setType: Operation = {
    op: "block_set",
    ...operationBase(),
    blockId: block.id,
    field: "type",
    value: "table",
  };
  ops.push(setType);
  page = applyOps(page, [setType], state.schema);

  const contentId = tableContentIdForBlock(block.id);
  const attach: Operation = {
    op: "content_edit",
    ...operationBase(),
    blockId: block.id,
    contentId,
    edit: {
      kind: "document_init",
      document: buildTableDocument(
        emptyTableSeed(NEW_TABLE_ROWS, NEW_TABLE_COLUMNS),
        { contentId, identityAllocator: state.CRDTbinding },
      ),
    },
  };
  ops.push(attach);
  page = applyOps(page, [attach], state.schema);

  const converted = page.blocks[findBlockIndex(page, block.id)];
  if (converted) invalidateBlockCache(converted);
  let next: EditorState = { ...state, document: { ...state.document, page } };
  next = clearSelection(next);

  // The caret lands in the header's first cell — the column titles are what a
  // new table is waiting for.
  const document = converted ? getTableDocument(converted) : undefined;
  const first = document ? readTable(document).rows[0]?.cells[0] : undefined;
  const selection =
    document && first
      ? tableCaretToContentSelection(document, block.id, {
          cellId: first.id,
          offset: 0,
        })
      : undefined;
  next = selection
    ? updateContentSelection(next, { ...selection, lastUpdate: Date.now() })
    : moveCursorToPosition(next, blockIndex, 0);
  return { state: next, ops, handled: true };
}

/**
 * Add the `TABLE_*` actions, such as {@link TABLE_INSERT_ROW}, to one editor's
 * action bus. It also lets a text block be turned into a new, empty table.
 */
export function registerTableCommands(bus: ActionBus): void {
  const run =
    <P extends TableTargetPayload>(
      build: (
        state: EditorState,
        context: TableTarget,
        target: { readonly row: number; readonly column: number },
        payload: P,
      ) => TableCommand | undefined,
    ) =>
    (state: EditorState, payload: P): Claimed | undefined => {
      const context = commandTarget(state, payload);
      if (!context) return undefined;
      const command = build(
        state,
        context,
        targetCell(context, payload),
        payload,
      );
      // A refused command still claims the dispatch: the dispatch DID resolve a
      // table, so there is no other handler that should answer for it.
      if (!command) return { state, ops: [], handled: true };
      return commitTableEdits(state, context, command.edits, command.caret);
    };

  bus.registerState(
    TABLE_INSERT_ROW,
    run((state, context, target, payload) =>
      insertRow(context.document, state.CRDTbinding, target.row, payload.side),
    ),
    100,
  );
  bus.registerState(
    TABLE_DELETE_ROW,
    run((_state, context, target) => deleteRow(context.document, target.row)),
    100,
  );
  bus.registerState(
    TABLE_INSERT_COLUMN,
    run((state, context, target, payload) =>
      insertColumn(
        context.document,
        state.CRDTbinding,
        target.column,
        payload.side,
      ),
    ),
    100,
  );
  bus.registerState(
    TABLE_DELETE_COLUMN,
    run((_state, context, target) =>
      deleteColumn(context.document, target.column),
    ),
    100,
  );
  bus.registerState(
    TABLE_MOVE_COLUMN,
    run((_state, context, target, payload) =>
      moveColumn(context.document, target.column, payload.to),
    ),
    100,
  );
  bus.registerState(
    TABLE_SET_COLUMN_ALIGN,
    run((_state, context, target, payload) =>
      setColumnAlign(context.document, target.column, payload.align),
    ),
    100,
  );

  const select =
    (axis: "row" | "column") =>
    (state: EditorState, payload: TableTargetPayload): Claimed | undefined => {
      const target = commandTarget(state, payload);
      if (!target) return undefined;
      const at = targetCell(target, payload);
      return selectTableLine(
        state,
        target,
        axis,
        axis === "row" ? at.row : at.column,
      );
    };
  bus.registerState(TABLE_SELECT_ROW, select("row"), 100);
  bus.registerState(TABLE_SELECT_COLUMN, select("column"), 100);

  bus.registerState(
    CONVERT_STRUCTURED_BLOCK,
    (state, { blockIndex, type }) =>
      convertBlockToTable(state, blockIndex, type),
    100,
  );
}
