/**
 * Structural editing: rows, columns, alignment, widths, and creating a table.
 *
 * The assertions run through the action bus rather than the pure builders where
 * the caret matters, because "where the caret lands" is half of what these
 * commands are for.
 */

import {
  deleteColumn,
  deleteRow,
  emptyTableSeed,
  insertColumn,
  insertRow,
  moveColumn,
  registerTableCommands,
  setColumnAlign,
  setColumnWidths,
  TABLE_DELETE_COLUMN,
  TABLE_DELETE_ROW,
  TABLE_INSERT_COLUMN,
  TABLE_INSERT_ROW,
  TABLE_MOVE_COLUMN,
  TABLE_SET_COLUMN_ALIGN,
  tableShapeAt,
} from "./commands";
import { registerTableInputActions } from "./input";
import {
  buildTableDocument,
  cellText,
  columnAlign,
  columnWidth,
  getTableDocument,
  readTable,
} from "./structured";
import { tableExtension } from "./table-extension";
import { createDeterministicIdentityAllocator } from "@shared/identity";
import { createNodeRegistry } from "@tasfer/editor";
import {
  CONVERT_STRUCTURED_BLOCK,
  createActionBus,
} from "@tasfer/editor/action-bus";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import { applyOps } from "@tasfer/editor/sync/reducer";
import {
  applyStructuredEdits,
  type StructuredDocument,
} from "@tasfer/editor/sync/structured-content";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());

const TABLE = [
  "| A | B |",
  "| --- | --- |",
  "| one | two |",
  "| three | four |",
].join("\n");

function stateOf(source: string): EditorState {
  const bus = createActionBus();
  registerTableCommands(bus);
  registerTableInputActions(bus);
  const state = createInitialState(loadPage(source, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
  return { ...state, actionBus: bus };
}

/** The grid shape at the caret, the way a host reads it. */
function shapeOf(state: EditorState): ReturnType<typeof tableShapeAt> {
  const focus = state.document.contentSelection?.focus;
  return focus ? tableShapeAt(documentOf(state), focus) : undefined;
}

function documentOf(state: EditorState): StructuredDocument {
  const block = state.document.page.blocks.find(
    (candidate) => (candidate.type as string) === "table",
  );
  const document = block ? getTableDocument(block) : undefined;
  if (!document) throw new Error("no table in this state");
  return document;
}

/** Every cell's text, row by row. */
function grid(state: EditorState): string[][] {
  const document = documentOf(state);
  return readTable(document).rows.map((row) =>
    row.cells.map((cell) => (cell ? cellText(document, cell) : "")),
  );
}

function gridOf(document: StructuredDocument): string[][] {
  return readTable(document).rows.map((row) =>
    row.cells.map((cell) => (cell ? cellText(document, cell) : "")),
  );
}

/** Put the caret at the start of the cell at (row, column). */
function caretAt(state: EditorState, row: number, column: number): EditorState {
  const block = state.document.page.blocks.find(
    (candidate) => (candidate.type as string) === "table",
  )!;
  const document = getTableDocument(block)!;
  const cell = readTable(document).rows[row].cells[column]!;
  const point = {
    kind: "text" as const,
    blockId: block.id,
    contentId: document.rootId,
    nodeId: cell.id,
    field: "text",
    afterCharId: null,
    affinity: "forward" as const,
  };
  return updateContentSelection(state, { anchor: point, focus: point });
}

function identities() {
  return createDeterministicIdentityAllocator("commands-test");
}

describe("rows", () => {
  it("adds a row below and lands the caret in it", () => {
    const state = caretAt(stateOf(TABLE), 1, 0);
    const result = state.actionBus.dispatchState(TABLE_INSERT_ROW, state, {
      side: "after",
    });

    expect(grid(result.state)).toEqual([
      ["A", "B"],
      ["one", "two"],
      ["", ""],
      ["three", "four"],
    ]);
    expect(shapeOf(result.state)).toMatchObject({
      rows: 4,
      rowIndex: 2,
      columnIndex: 0,
    });
  });

  it("adds a row above, except above the header", () => {
    const document = documentOf(stateOf(TABLE));
    const added = insertRow(document, identities(), 2, "before");
    expect(gridOf(applyStructuredEdits(document, added!.edits))).toEqual([
      ["A", "B"],
      ["one", "two"],
      ["", ""],
      ["three", "four"],
    ]);

    // Nothing can go above the header: GFM writes the first row as the column
    // titles and has no syntax for a row before them.
    expect(insertRow(document, identities(), 0, "before")).toBeUndefined();
  });

  it("removes a row and keeps the caret in the grid", () => {
    const state = caretAt(stateOf(TABLE), 1, 1);
    const result = state.actionBus.dispatchState(TABLE_DELETE_ROW, state, {});

    expect(grid(result.state)).toEqual([
      ["A", "B"],
      ["three", "four"],
    ]);
    expect(shapeOf(result.state)?.rowIndex).toBe(1);
  });

  it("refuses to remove the only row", () => {
    const single = ["| A | B |", "| --- | --- |"].join("\n");
    expect(deleteRow(documentOf(stateOf(single)), 0)).toBeUndefined();
  });
});

describe("columns", () => {
  it("adds a column with a cell in every row", () => {
    const state = caretAt(stateOf(TABLE), 0, 0);
    const result = state.actionBus.dispatchState(TABLE_INSERT_COLUMN, state, {
      side: "after",
    });

    expect(grid(result.state)).toEqual([
      ["A", "", "B"],
      ["one", "", "two"],
      ["three", "", "four"],
    ]);
    // The caret lands in the new column's header cell — its title is what a new
    // column is waiting for.
    expect(shapeOf(result.state)).toMatchObject({
      columns: 3,
      rowIndex: 0,
      columnIndex: 1,
    });
  });

  it("adds a column before the reference one", () => {
    const document = documentOf(stateOf(TABLE));
    const added = insertColumn(document, identities(), 0, "before");

    expect(gridOf(applyStructuredEdits(document, added!.edits))).toEqual([
      ["", "A", "B"],
      ["", "one", "two"],
      ["", "three", "four"],
    ]);
  });

  it("removes a column", () => {
    const state = caretAt(stateOf(TABLE), 1, 1);
    const result = state.actionBus.dispatchState(
      TABLE_DELETE_COLUMN,
      state,
      {},
    );

    expect(grid(result.state)).toEqual([["A"], ["one"], ["three"]]);
  });

  it("refuses to remove the only column", () => {
    const single = ["| A |", "| --- |", "| one |"].join("\n");
    expect(deleteColumn(documentOf(stateOf(single)), 0)).toBeUndefined();
  });

  it("hides a removed column's cells without erasing them", () => {
    const document = documentOf(stateOf(TABLE));
    const removed = deleteColumn(document, 0)!;
    const after = applyStructuredEdits(document, removed.edits);

    expect(gridOf(after)).toEqual([["B"], ["two"], ["four"]]);
    // The cells are still there, which is what makes undoing the delete a
    // single un-tombstone that brings the column's text back with it.
    expect(
      Object.values(after.nodes).filter((node) => node.type === "cell"),
    ).toHaveLength(6);
  });
});

describe("moving a column", () => {
  const WIDE = [
    "| A | B | C |",
    "| --- | --- | --- |",
    "| one | two | three |",
  ].join("\n");

  it("lands the column at the index it was sent to", () => {
    const document = documentOf(stateOf(WIDE));

    expect(
      gridOf(applyStructuredEdits(document, moveColumn(document, 0, 2)!.edits)),
    ).toEqual([
      ["B", "C", "A"],
      ["two", "three", "one"],
    ]);
    expect(
      gridOf(applyStructuredEdits(document, moveColumn(document, 2, 0)!.edits)),
    ).toEqual([
      ["C", "A", "B"],
      ["three", "one", "two"],
    ]);
    expect(
      gridOf(applyStructuredEdits(document, moveColumn(document, 0, 1)!.edits)),
    ).toEqual([
      ["B", "A", "C"],
      ["two", "one", "three"],
    ]);
  });

  it("is one move of the column node and nothing else", () => {
    const document = documentOf(stateOf(WIDE));
    const moved = moveColumn(document, 0, 2)!;

    // The cells name their column by id, so they need no edit of their own.
    expect(moved.edits).toHaveLength(1);
    expect(moved.edits[0]).toMatchObject({
      kind: "node_move",
      nodeId: readTable(document).columns[0].id,
    });
    // The column keeps everything it carried.
    const aligned = applyStructuredEdits(
      document,
      setColumnAlign(document, 0, "right")!.edits,
    );
    const after = applyStructuredEdits(
      aligned,
      moveColumn(aligned, 0, 2)!.edits,
    );
    expect(columnAlign(readTable(after).columns[2])).toBe("right");
  });

  it("refuses a move that changes nothing, and clamps one past the edge", () => {
    const document = documentOf(stateOf(WIDE));
    expect(moveColumn(document, 1, 1)).toBeUndefined();
    expect(moveColumn(document, 5, 0)).toBeUndefined();
    // Past the last index is the last index — "move right" from the last
    // column has nowhere to go.
    expect(moveColumn(document, 2, 9)).toBeUndefined();
    expect(
      gridOf(
        applyStructuredEdits(document, moveColumn(document, 0, 9)!.edits),
      )[0],
    ).toEqual(["B", "C", "A"]);
  });

  it("keeps the caret in its cell, which travels with the column", () => {
    const state = caretAt(stateOf(WIDE), 1, 0);
    const result = state.actionBus.dispatchState(TABLE_MOVE_COLUMN, state, {
      to: 2,
    });

    expect(result.claimed).toBe(true);
    expect(grid(result.state)[1]).toEqual(["two", "three", "one"]);
    expect(shapeOf(result.state)).toMatchObject({
      rowIndex: 1,
      columnIndex: 2,
    });
    expect(
      serializeToMarkdown(result.state.document.page.blocks, undefined, {
        schema: schema.data,
      }),
    ).toBe(
      ["| B | C | A |", "| --- | --- | --- |", "| two | three | one |"].join(
        "\n",
      ),
    );
  });

  it("targets the table a payload names rather than the caret's", () => {
    const two = [WIDE, "", TABLE].join("\n");
    const state = caretAt(stateOf(two), 0, 0);
    const second = state.document.page.blocks.find(
      (block, at) => at > 0 && (block.type as string) === "table",
    )!;
    const result = state.actionBus.dispatchState(TABLE_MOVE_COLUMN, state, {
      blockId: second.id,
      columnIndex: 0,
      to: 1,
    });

    expect(gridOf(getTableDocument(second)!)[0]).toEqual(["A", "B"]);
    const moved = result.state.document.page.blocks.find(
      (block) => block.id === second.id,
    )!;
    expect(gridOf(getTableDocument(moved)!)).toEqual([
      ["B", "A"],
      ["two", "one"],
      ["four", "three"],
    ]);
    // The caret's own table is untouched.
    expect(grid(result.state)[0]).toEqual(["A", "B", "C"]);
  });

  it("converges when two peers move different columns at once", () => {
    const seed = documentOf(stateOf(WIDE));
    const first = moveColumn(seed, 0, 2)!.edits; // A to the end
    const second = moveColumn(seed, 2, 0)!.edits; // C to the front

    const oneWay = applyStructuredEdits(
      applyStructuredEdits(seed, first),
      second,
    );
    const otherWay = applyStructuredEdits(
      applyStructuredEdits(seed, second),
      first,
    );

    expect(gridOf(oneWay)).toEqual(gridOf(otherWay));
    expect(gridOf(oneWay)[0]).toEqual(["C", "B", "A"]);
  });
});

describe("alignment and width", () => {
  it("sets and clears a column's alignment", () => {
    const state = caretAt(stateOf(TABLE), 0, 1);
    const aligned = state.actionBus.dispatchState(
      TABLE_SET_COLUMN_ALIGN,
      state,
      { align: "right" },
    );

    expect(
      serializeToMarkdown(aligned.state.document.page.blocks, undefined, {
        schema: schema.data,
      }),
    ).toContain("| --- | ---: |");

    const cleared = aligned.state.actionBus.dispatchState(
      TABLE_SET_COLUMN_ALIGN,
      aligned.state,
      { align: null },
    );
    expect(
      columnAlign(readTable(documentOf(cleared.state)).columns[1]),
    ).toBeNull();
  });

  it("stores widths as fractions and reads back only sane ones", () => {
    const document = documentOf(stateOf(TABLE));
    const sized = applyStructuredEdits(
      document,
      setColumnWidths(document, [{ columnIndex: 0, fraction: 0.7 }])!.edits,
    );
    expect(columnWidth(readTable(sized).columns[0])).toBe(0.7);

    // A fraction outside (0, 1) is not a width this version understands, so the
    // column falls back to automatic sizing rather than being clamped.
    const absurd = applyStructuredEdits(
      sized,
      setColumnWidths(sized, [{ columnIndex: 0, fraction: 4 }])!.edits,
    );
    expect(columnWidth(readTable(absurd).columns[0])).toBeNull();
  });

  it("clears a width back to automatic", () => {
    const document = documentOf(stateOf(TABLE));
    const sized = applyStructuredEdits(
      document,
      setColumnWidths(document, [{ columnIndex: 1, fraction: 0.25 }])!.edits,
    );
    const auto = applyStructuredEdits(
      sized,
      setColumnWidths(sized, [{ columnIndex: 1, fraction: null }])!.edits,
    );

    expect(columnWidth(readTable(auto).columns[1])).toBeNull();
  });

  it("leaves the markdown alone — a width is presentation, not content", () => {
    const state = stateOf(TABLE);
    const before = serializeToMarkdown(state.document.page.blocks, undefined, {
      schema: schema.data,
    });
    const document = documentOf(state);
    const sized = applyStructuredEdits(
      document,
      setColumnWidths(document, [{ columnIndex: 0, fraction: 0.8 }])!.edits,
    );

    expect(gridOf(sized)).toEqual(gridOf(document));
    expect(before).toContain("| A | B |");
  });

  it("refuses an alignment on a column that is not there", () => {
    expect(
      setColumnAlign(documentOf(stateOf(TABLE)), 9, "left"),
    ).toBeUndefined();
  });
});

describe("creating a table", () => {
  it("converts a paragraph into an empty grid with the caret in it", () => {
    const state = stateOf("hello");
    const result = state.actionBus.dispatchState(
      // The conversion seam core offers before it attempts a generic morph.
      CONVERT_STRUCTURED_BLOCK,
      state,
      { blockIndex: 0, type: "table" },
    );

    expect(result.claimed).toBe(true);
    expect(grid(result.state)).toEqual([
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
    ]);
    // The block's prose is cleared — a table holds no flat text.
    const converted = result.state.document.page.blocks[0] as {
      charRuns?: Parameters<typeof getVisibleTextFromRuns>[0];
    };
    expect(getVisibleTextFromRuns(converted.charRuns)).toBe("");
    expect(shapeOf(result.state)).toMatchObject({
      rows: 3,
      columns: 3,
      rowIndex: 0,
      columnIndex: 0,
    });
  });

  it("leaves other target types to whoever owns them", () => {
    const state = stateOf("hello");
    const result = state.actionBus.dispatchState(
      CONVERT_STRUCTURED_BLOCK,
      state,
      { blockIndex: 0, type: "quote" },
    );

    expect(result.claimed).toBe(false);
  });

  it("seeds a blank grid of the requested shape", () => {
    const seed = emptyTableSeed(2, 4);
    const document = buildTableDocument(seed, { contentId: "content:table" });

    expect(gridOf(document)).toEqual([
      ["", "", "", ""],
      ["", "", "", ""],
    ]);
  });
});

describe("the operations alone carry a structural edit", () => {
  it("reproduces an added row on a peer that only replays them", () => {
    const state = caretAt(stateOf(TABLE), 1, 0);
    const result = state.actionBus.dispatchState(TABLE_INSERT_ROW, state, {
      side: "after",
    });
    expect(result.ops.length).toBeGreaterThan(0);

    const peer = applyOps(
      loadPage(TABLE, schema.data),
      result.ops,
      schema.data,
    );
    const document = getTableDocument(peer.blocks[0])!;

    expect(gridOf(document)).toEqual(grid(result.state));
  });

  it("reproduces a moved column the same way", () => {
    const state = caretAt(stateOf(TABLE), 0, 0);
    const result = state.actionBus.dispatchState(TABLE_MOVE_COLUMN, state, {
      to: 1,
    });
    expect(result.ops).toHaveLength(1);

    const peer = applyOps(
      loadPage(TABLE, schema.data),
      result.ops,
      schema.data,
    );
    expect(gridOf(getTableDocument(peer.blocks[0])!)).toEqual([
      ["B", "A"],
      ["two", "one"],
      ["four", "three"],
    ]);
  });

  it("reproduces a removed column the same way", () => {
    const state = caretAt(stateOf(TABLE), 0, 0);
    const result = state.actionBus.dispatchState(
      TABLE_DELETE_COLUMN,
      state,
      {},
    );

    const peer = applyOps(
      loadPage(TABLE, schema.data),
      result.ops,
      schema.data,
    );
    expect(gridOf(getTableDocument(peer.blocks[0])!)).toEqual([
      ["B"],
      ["two"],
      ["four"],
    ]);
  });
});
