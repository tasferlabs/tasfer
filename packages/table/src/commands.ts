/**
 * Structural editing: add and remove rows and columns, set a column's
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

/** A structural edit batch and where the caret belongs once it has applied. */
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
 * Add a row.
 *
 * `side: "before"` on the header row is refused rather than clamped: the row
 * above the header would silently BECOME the header — GFM writes the first row
 * as the column titles and has no syntax for anything above it — and an
 * "insert above" gesture that renames every column is not what was asked for.
 * Hosts read the `undefined` as "this command is unavailable here".
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
 * Remove a row, tombstoning the row node alone.
 *
 * Its cells stay in the store: a deleted parent is not traversable, so they are
 * already invisible, and leaving them is what makes undo a single un-tombstone
 * that brings the row's text back with it.
 */
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

/** Add a column, and the cell it needs in every existing row. */
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
 * Remove a column.
 *
 * Only the column node is tombstoned. Cells naming it are left alone: a cell
 * whose column is gone resolves to no position and simply stops being read, so
 * the single delete both hides the column everywhere and restores it — text and
 * all — when undone.
 */
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

/** Set (or, with `null`, clear) a column's alignment. */
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
 * Set explicit widths, as fractions of the grid, on one or more columns.
 *
 * A fraction rather than a pixel count because the grid is re-fitted to whatever
 * width the page has: the same document opens on a phone and a desktop, and a
 * stored pixel width would mean one of them is wrong. `null` returns a column to
 * automatic sizing.
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

/** The blank grid a freshly created table starts as. */
export function emptyTableSeed(rows: number, columns: number): TableSeed {
  return {
    aligns: Array.from({ length: columns }, () => null),
    rows: Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => ({ charRuns: [] })),
    ),
  };
}

/** The default shape a new table is created with: a header and two body rows. */
export const NEW_TABLE_ROWS = 3;
export const NEW_TABLE_COLUMNS = 3;

// ── Action bus ───────────────────────────────────────────────────────────────

/** Target a command at an explicit cell, or (by default) at the caret's own. */
export interface TableTargetPayload {
  /**
   * The table to act on. Omitted, the command takes the one the caret is in —
   * which is what a menu anchored to the caret wants. An on-canvas control
   * names its own block instead: the pointer can be over a table the caret is
   * nowhere near, and "the caret's table" would then edit the wrong grid.
   */
  readonly blockId?: string;
  readonly rowIndex?: number;
  readonly columnIndex?: number;
}

export const TABLE_INSERT_ROW = stateAction<
  TableTargetPayload & { readonly side: TableInsertSide }
>("table-insert-row", (state) => ({ state, ops: [] }));

export const TABLE_DELETE_ROW = stateAction<TableTargetPayload>(
  "table-delete-row",
  (state) => ({ state, ops: [] }),
);

export const TABLE_INSERT_COLUMN = stateAction<
  TableTargetPayload & { readonly side: TableInsertSide }
>("table-insert-column", (state) => ({ state, ops: [] }));

export const TABLE_DELETE_COLUMN = stateAction<TableTargetPayload>(
  "table-delete-column",
  (state) => ({ state, ops: [] }),
);

export const TABLE_SET_COLUMN_ALIGN = stateAction<
  TableTargetPayload & { readonly align: TableAlign | null }
>("table-set-column-align", (state) => ({ state, ops: [] }));

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
 */
export interface TableShape {
  readonly rows: number;
  readonly columns: number;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly align: TableAlign | null;
}

/**
 * Read a table's shape at a nested caret.
 *
 * Takes the document and the point rather than editor state, because that pair
 * is what a host already holds — `query.content(blockId, contentId)` and
 * `state.contentSelection.focus` — and it keeps this readable from a React
 * render, which has no business touching the engine's internal state.
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

/** Register the structural commands and table creation on one editor's bus. */
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
    TABLE_SET_COLUMN_ALIGN,
    run((_state, context, target, payload) =>
      setColumnAlign(context.document, target.column, payload.align),
    ),
    100,
  );

  bus.registerState(
    CONVERT_STRUCTURED_BLOCK,
    (state, { blockIndex, type }) =>
      convertBlockToTable(state, blockIndex, type),
    100,
  );
}
