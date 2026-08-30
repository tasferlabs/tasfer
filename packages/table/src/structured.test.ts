/**
 * The table's CRDT shape: reading it, validating it, copying it — and the
 * concurrency case the whole design exists for.
 */

import { tableDataExtension } from "./data";
import {
  buildTableDocument,
  CELL_NODE,
  CELLS_SLOT,
  cellText,
  cloneTableDocument,
  COLUMN_NODE,
  COLUMNS_SLOT,
  getTableDocument,
  readTable,
  ROW_NODE,
  ROWS_SLOT,
  tableContentIdForBlock,
  tableDocumentInit,
  type TableSeed,
  validateTableDocument,
} from "./structured";
import { createDeterministicIdentityAllocator } from "@shared/identity";
import { getBaseDataSchema } from "@tasfer/editor/baseDataSchema";
import { generateKeyBetween } from "@tasfer/editor/sync/fractional-index";
import { canonicalizeStructuredDocument } from "@tasfer/editor/sync/structured-content";
import {
  applyStructuredEdit,
  type StructuredDocument,
} from "@tasfer/editor/sync/structured-content";
import { createCRDTbinding, createSyncEngine } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

const CONTENT_ID = "block0/table";

/** An n×m table of empty cells. */
function emptyTable(columns: number, rows: number): StructuredDocument {
  const seed: TableSeed = {
    aligns: Array.from({ length: columns }, () => null),
    rows: Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => ({ charRuns: [] })),
    ),
  };
  return buildTableDocument(seed, {
    contentId: CONTENT_ID,
    identityAllocator: createDeterministicIdentityAllocator("test"),
  });
}

/** The grid as text, with `null` for a cell the row does not have. */
function grid(document: StructuredDocument): (string | null)[][] {
  return readTable(document).rows.map((row) =>
    row.cells.map((cell) => (cell ? cellText(document, cell) : null)),
  );
}

describe("reading a table", () => {
  it("pairs every cell with its column", () => {
    const document = emptyTable(2, 2);
    const view = readTable(document);

    expect(view.columns).toHaveLength(2);
    expect(view.rows).toHaveLength(2);
    expect(grid(document)).toEqual([
      ["", ""],
      ["", ""],
    ]);
  });

  it("orders cells by column, not by the order they were stored in", () => {
    let document = emptyTable(2, 1);
    const view = readTable(document);
    const [first, second] = view.columns;
    const row = view.rows[0];

    // Swap which column each cell names; their sibling order is untouched.
    document = applyStructuredEdit(document, {
      kind: "node_attr_set",
      nodeId: row.cells[0]!.id,
      key: "columnId",
      value: second.id,
    });
    document = applyStructuredEdit(document, {
      kind: "node_attr_set",
      nodeId: row.cells[1]!.id,
      key: "columnId",
      value: first.id,
    });

    const swapped = readTable(document);
    expect(swapped.rows[0].cells[0]!.id).toBe(row.cells[1]!.id);
    expect(swapped.rows[0].cells[1]!.id).toBe(row.cells[0]!.id);
  });

  it("reports a missing cell as a hole rather than shifting the row", () => {
    let document = emptyTable(2, 1);
    const row = readTable(document).rows[0];
    document = applyStructuredEdit(document, {
      kind: "node_delete",
      nodeId: row.cells[0]!.id,
    });

    expect(grid(document)).toEqual([[null, ""]]);
  });

  it("hides a deleted row", () => {
    let document = emptyTable(1, 2);
    document = applyStructuredEdit(document, {
      kind: "node_delete",
      nodeId: readTable(document).rows[0].node.id,
    });

    expect(readTable(document).rows).toHaveLength(1);
  });

  it("reads nothing from a document whose root is not a table", () => {
    const document = emptyTable(1, 1);
    const broken = { ...document, rootId: "nope" };

    expect(readTable(broken).columns).toEqual([]);
  });
});

describe("validation", () => {
  it("accepts a well-formed table", () => {
    expect(validateTableDocument(emptyTable(2, 2))).toBeDefined();
  });

  it("rejects a cell naming a column that does not exist", () => {
    const document = emptyTable(1, 1);
    const cell = readTable(document).rows[0].cells[0]!;
    const broken = applyStructuredEdit(document, {
      kind: "node_attr_set",
      nodeId: cell.id,
      key: "columnId",
      value: "ghost",
    });

    expect(validateTableDocument(broken)).toBeUndefined();
  });

  it("rejects a cell parented to something other than a row", () => {
    const document = emptyTable(1, 1);
    const view = readTable(document);
    const broken = applyStructuredEdit(document, {
      kind: "node_move",
      nodeId: view.rows[0].cells[0]!.id,
      placement: {
        parentId: view.columns[0].id,
        slot: CELLS_SLOT,
        orderKey: "a0",
      },
    });

    expect(validateTableDocument(broken)).toBeUndefined();
  });

  it("rejects an unknown node type", () => {
    const document = emptyTable(1, 1);
    const broken = applyStructuredEdit(document, {
      kind: "node_insert",
      node: {
        id: "stray",
        type: "sheet",
        placement: {
          parentId: CONTENT_ID,
          slot: ROWS_SLOT,
          orderKey: "z0",
        },
      },
    });

    expect(validateTableDocument(broken)).toBeUndefined();
  });
});

describe("cloning into a new identity domain", () => {
  it("re-points every cell at the copied column", () => {
    const source = emptyTable(2, 2);
    const clone = cloneTableDocument(
      source,
      "block1/table",
      createDeterministicIdentityAllocator("clone"),
    );

    // The copy must still read as a 2×2 grid — which it only can if `columnId`
    // was rewritten; verbatim attrs would leave every cell orphaned.
    expect(validateTableDocument(clone)).toBeDefined();
    expect(grid(clone)).toEqual([
      ["", ""],
      ["", ""],
    ]);
    const sourceIds = new Set(Object.keys(source.nodes));
    for (const id of Object.keys(clone.nodes)) {
      if (id !== clone.rootId) expect(sourceIds.has(id)).toBe(false);
    }
  });
});

describe("concurrent structural edits", () => {
  /**
   * The case column identities exist for: one peer adds a column while another
   * adds a row. Positional cells could not merge these — the new row would have
   * one fewer cell than every other row, and nothing would say which column it
   * was missing. Here the answer is exact, and both peers agree on it.
   */
  it("converges when one peer adds a column and another adds a row", () => {
    const schema = getBaseDataSchema().extend(tableDataExtension());
    const authorBinding = createCRDTbinding("page", "author");
    const author = createSyncEngine(authorBinding, schema);
    const block = author.createBlockInsert("a0", "table");
    author.emit([block]);
    const contentId = tableContentIdForBlock(block.blockId);
    author.emit([
      author.createContentEdit(
        block.blockId,
        contentId,
        tableDocumentInit(
          {
            aligns: [null, null],
            rows: [
              [{ charRuns: [] }, { charRuns: [] }],
              [{ charRuns: [] }, { charRuns: [] }],
            ],
          },
          { contentId, identityAllocator: authorBinding },
        ),
      ),
    ]);

    const editorBinding = createCRDTbinding("page", "editor");
    const editor = createSyncEngine(editorBinding, schema);
    editor.loadOperations(author.getOperations());

    const start = readTable(getTableDocument(author.getState().blocks[0])!);
    const lastColumnKey =
      start.columns[start.columns.length - 1].placement.orderKey;
    const lastRowKey =
      start.rows[start.rows.length - 1].node.placement.orderKey;

    // Author appends a column, with a cell in each row it knows about.
    const newColumnId = authorBinding.nextId();
    author.emit([
      author.createContentEdit(block.blockId, contentId, {
        kind: "node_insert",
        node: {
          id: newColumnId,
          type: COLUMN_NODE,
          placement: {
            parentId: contentId,
            slot: COLUMNS_SLOT,
            orderKey: generateKeyBetween(lastColumnKey, null),
          },
        },
      }),
      ...start.rows.map((row) =>
        author.createContentEdit(block.blockId, contentId, {
          kind: "node_insert" as const,
          node: {
            id: authorBinding.nextId(),
            type: CELL_NODE,
            placement: {
              parentId: row.node.id,
              slot: CELLS_SLOT,
              orderKey: generateKeyBetween(
                row.cells[row.cells.length - 1]!.placement.orderKey,
                null,
              ),
            },
            attrs: { columnId: newColumnId },
            textFields: { text: [] },
          },
        }),
      ),
    ]);

    // Concurrently, the editor appends a row with a cell per column it knows.
    const newRowId = editorBinding.nextId();
    editor.emit([
      editor.createContentEdit(block.blockId, contentId, {
        kind: "node_insert",
        node: {
          id: newRowId,
          type: ROW_NODE,
          placement: {
            parentId: contentId,
            slot: ROWS_SLOT,
            orderKey: generateKeyBetween(lastRowKey, null),
          },
        },
      }),
      ...start.columns.map((column, at) =>
        editor.createContentEdit(block.blockId, contentId, {
          kind: "node_insert" as const,
          node: {
            id: editorBinding.nextId(),
            type: CELL_NODE,
            placement: {
              parentId: newRowId,
              slot: CELLS_SLOT,
              orderKey: generateKeyBetween(at === 0 ? null : "a" + at, null),
            },
            attrs: { columnId: column.id },
            textFields: { text: [] },
          },
        }),
      ),
    ]);

    author.loadOperations(editor.getOperations());
    editor.loadOperations(author.getOperations());

    const authorTable = getTableDocument(author.getState().blocks[0])!;
    const editorTable = getTableDocument(editor.getState().blocks[0])!;

    // Byte-identical state on both peers.
    expect(JSON.stringify(canonicalizeStructuredDocument(authorTable))).toBe(
      JSON.stringify(canonicalizeStructuredDocument(editorTable)),
    );

    // Three columns, three rows, and exactly one hole: the row the editor added
    // has no cell for the column the author added at the same moment.
    const merged = readTable(authorTable);
    expect(merged.columns).toHaveLength(3);
    expect(merged.rows).toHaveLength(3);
    expect(grid(authorTable)).toEqual([
      ["", "", ""],
      ["", "", ""],
      ["", "", null],
    ]);
    expect(validateTableDocument(authorTable)).toBeDefined();
  });
});
