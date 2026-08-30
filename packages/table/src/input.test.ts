/**
 * Editing inside a cell: typing, deleting, and what the emitted operations do
 * when a second peer replays them.
 */

import { registerTableInputActions, tableInputRule } from "./input";
import { cellText, getTableDocument, readTable } from "./structured";
import { tableExtension } from "./table-extension";
import { createNodeRegistry } from "@tasfer/editor";
import { createActionBus } from "@tasfer/editor/action-bus";
import { insertText } from "@tasfer/editor/actions/actions";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_TO_LINE_END,
  DELETE_TO_LINE_START,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  SPLIT_BLOCK,
} from "@tasfer/editor/actions/edit-actions";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { applyOps } from "@tasfer/editor/sync/reducer";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());

const TABLE = ["| A | B |", "| --- | --- |", "| one | two |"].join("\n");

function stateOf(source: string): EditorState {
  const bus = createActionBus();
  registerTableInputActions(bus);
  const state = createInitialState(loadPage(source, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
  return { ...state, actionBus: bus };
}

/** Cell ids in row-major order. */
function cells(state: EditorState): string[] {
  const document = getTableDocument(state.document.page.blocks[0])!;
  return readTable(document).rows.flatMap((row) =>
    row.cells.filter((cell) => cell !== undefined).map((cell) => cell.id),
  );
}

/** Put the caret at `offset` in the cell at row-major index `at`. */
function caretIn(state: EditorState, at: number, offset: number): EditorState {
  return rangeIn(state, at, offset, at, offset);
}

/** Select from one (cell, offset) to another. */
function rangeIn(
  state: EditorState,
  anchorCell: number,
  anchorOffset: number,
  focusCell: number,
  focusOffset: number,
): EditorState {
  const block = state.document.page.blocks[0];
  const document = getTableDocument(block)!;
  const ids = cells(state);
  const point = (cellIndex: number, offset: number) => {
    const runs = [...document.nodes[ids[cellIndex]].textFields.text];
    let seen = 0;
    let afterCharId: string | null = null;
    for (const run of runs) {
      for (let index = 0; index < run.text.length; index++) {
        if (seen === offset) break;
        seen++;
        afterCharId = `${run.peerId}:${run.startCounter + index}`;
      }
    }
    return {
      kind: "text" as const,
      blockId: block.id,
      contentId: document.rootId,
      nodeId: ids[cellIndex],
      field: "text",
      afterCharId: offset === 0 ? null : afterCharId,
      affinity: "forward" as const,
    };
  };
  return updateContentSelection(state, {
    anchor: point(anchorCell, anchorOffset),
    focus: point(focusCell, focusOffset),
  });
}

/** Every cell's text, row by row. */
function grid(state: EditorState): string[][] {
  const document = getTableDocument(state.document.page.blocks[0])!;
  return readTable(document).rows.map((row) =>
    row.cells.map((cell) => (cell ? cellText(document, cell) : "")),
  );
}

describe("typing in a cell", () => {
  it("claims the input whenever the caret is in a cell", () => {
    const outside = stateOf(TABLE);
    expect(tableInputRule.owns?.({ state: outside, input: "x" })).toBe(false);

    const inside = caretIn(outside, 0, 0);
    expect(tableInputRule.owns?.({ state: inside, input: "x" })).toBe(true);
  });

  it("inserts at the caret and leaves the caret after the text", () => {
    const state = caretIn(stateOf(TABLE), 2, 3); // end of "one"
    const result = insertText(state, "!");

    expect(grid(result.state)[1][0]).toBe("one!");
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0].op).toBe("content_edit");

    const next = insertText(result.state, "?");
    expect(grid(next.state)[1][0]).toBe("one!?");
  });

  it("inserts in the middle without disturbing the rest", () => {
    const state = caretIn(stateOf(TABLE), 2, 1);

    expect(grid(insertText(state, "XY").state)[1][0]).toBe("oXYne");
  });

  it("replaces a selected range inside one cell", () => {
    const state = rangeIn(stateOf(TABLE), 2, 0, 2, 3);

    expect(grid(insertText(state, "1").state)[1][0]).toBe("1");
  });

  it("clears every cell a cross-cell selection covers", () => {
    const state = rangeIn(stateOf(TABLE), 0, 0, 3, 3);
    const result = insertText(state, "x");

    expect(grid(result.state)).toEqual([
      ["x", ""],
      ["", ""],
    ]);
  });

  it("never touches the block's own flat storage", () => {
    const state = caretIn(stateOf(TABLE), 0, 1);
    const block = insertText(state, "zz").state.document.page.blocks[0];

    expect("charRuns" in block ? block.charRuns : []).toEqual([]);
  });

  it("round-trips typed text back to markdown", () => {
    const state = caretIn(stateOf(TABLE), 1, 1);
    const result = insertText(state, "!");

    expect(
      serializeToMarkdown(result.state.document.page.blocks, undefined, {
        schema: schema.data,
      }),
    ).toBe(["| A | B! |", "| --- | --- |", "| one | two |"].join("\n"));
  });

  it("carries the whole edit in the operations it emits", () => {
    const state = caretIn(stateOf(TABLE), 2, 3);
    const result = insertText(state, " more");
    expect(grid(result.state)[1][0]).toBe("one more");

    // A peer sees only the operations. Replaying them against the pre-edit page
    // must reproduce the author's document exactly — nothing may live only in
    // the local state.
    const replayed = applyOps(
      loadPage(TABLE, schema.data),
      result.ops,
      schema.data,
    );

    expect(getTableDocument(replayed.blocks[0])).toEqual(
      getTableDocument(result.state.document.page.blocks[0]),
    );
  });
});

describe("deleting in a cell", () => {
  it("removes the character before the caret", () => {
    let state = caretIn(stateOf(TABLE), 2, 3);
    state = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;

    expect(grid(state)[1][0]).toBe("on");
  });

  it("removes the character after the caret", () => {
    let state = caretIn(stateOf(TABLE), 2, 0);
    state = state.actionBus.dispatchState(DELETE_FORWARD, state).state;

    expect(grid(state)[1][0]).toBe("ne");
  });

  it("holds at a cell's edge rather than merging cells or deleting the block", () => {
    let state = caretIn(stateOf(TABLE), 2, 0);
    state = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;

    expect(grid(state)).toEqual([
      ["A", "B"],
      ["one", "two"],
    ]);
    expect(state.document.page.blocks).toHaveLength(1);
  });

  it("clears a selected range", () => {
    let state = rangeIn(stateOf(TABLE), 2, 1, 2, 3);
    state = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;

    expect(grid(state)[1][0]).toBe("o");
  });

  it("leaves a table alone when the caret is elsewhere", () => {
    const state = stateOf(TABLE);
    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);

    expect(result.state).toBe(state);
  });
});

describe("word and line deletes in a cell", () => {
  const WORDS = ["| A | B |", "| --- | --- |", "| one two | x |"].join("\n");

  it("takes the word before the caret", () => {
    let state = caretIn(stateOf(WORDS), 2, 7);
    state = state.actionBus.dispatchState(DELETE_WORD_BACKWARD, state).state;

    expect(grid(state)[1][0]).toBe("one ");
  });

  it("takes the word after the caret", () => {
    let state = caretIn(stateOf(WORDS), 2, 4);
    state = state.actionBus.dispatchState(DELETE_WORD_FORWARD, state).state;

    expect(grid(state)[1][0]).toBe("one ");
  });

  it("clears back to the cell's start", () => {
    let state = caretIn(stateOf(WORDS), 2, 4);
    state = state.actionBus.dispatchState(DELETE_TO_LINE_START, state).state;

    expect(grid(state)[1][0]).toBe("two");
  });

  it("clears on to the cell's end", () => {
    let state = caretIn(stateOf(WORDS), 2, 4);
    state = state.actionBus.dispatchState(DELETE_TO_LINE_END, state).state;

    expect(grid(state)[1][0]).toBe("one ");
  });

  it("clears a selected range instead, like the plain deletes", () => {
    let state = rangeIn(stateOf(WORDS), 2, 0, 2, 4);
    state = state.actionBus.dispatchState(DELETE_WORD_BACKWARD, state).state;

    expect(grid(state)[1][0]).toBe("two");
  });

  it("holds at a cell's edge rather than reaching into the neighbour", () => {
    for (const action of [DELETE_WORD_BACKWARD, DELETE_TO_LINE_START]) {
      let state = caretIn(stateOf(WORDS), 2, 0);
      state = state.actionBus.dispatchState(action, state).state;

      expect(grid(state)).toEqual([
        ["A", "B"],
        ["one two", "x"],
      ]);
      expect(state.document.page.blocks).toHaveLength(1);
    }
  });

  it("never holds the table whole the way plain Backspace does", () => {
    let state = caretIn(stateOf(WORDS), 0, 0);
    state = state.actionBus.dispatchState(DELETE_WORD_BACKWARD, state).state;

    // The nested caret survives, so the key was claimed inside the cell rather
    // than escalating to the block sentinel plain Backspace raises there.
    expect(state.document.contentSelection).not.toBeNull();
    expect(state.document.selection?.isCollapsed ?? true).toBe(true);
  });

  it("leaves a table alone when the caret is elsewhere", () => {
    const state = stateOf(WORDS);

    for (const action of [
      DELETE_WORD_BACKWARD,
      DELETE_WORD_FORWARD,
      DELETE_TO_LINE_START,
      DELETE_TO_LINE_END,
    ]) {
      expect(state.actionBus.dispatchState(action, state).state).toBe(state);
    }
  });
});

describe("Enter in a cell", () => {
  it("moves down a row instead of splitting the block", () => {
    let state = caretIn(stateOf(TABLE), 0, 1);
    state = state.actionBus.dispatchState(SPLIT_BLOCK, state).state;

    expect(state.document.page.blocks).toHaveLength(1);
    const focus = state.document.contentSelection!.focus;
    expect("nodeId" in focus ? focus.nodeId : null).toBe(cells(state)[2]);
  });

  it("is claimed but inert on the last row", () => {
    let state = caretIn(stateOf(TABLE), 2, 0);
    const before = state.document.page.blocks.length;
    state = state.actionBus.dispatchState(SPLIT_BLOCK, state).state;

    expect(state.document.page.blocks).toHaveLength(before);
  });
});

describe("holding the table whole", () => {
  /** Core's node-selection sentinel: non-collapsed, but both ends one position. */
  function heldWhole(state: EditorState, blockIndex = 0): boolean {
    const selection = state.document.selection;
    if (!selection || selection.isCollapsed) return false;
    return (
      selection.anchor.blockIndex === blockIndex &&
      selection.focus.blockIndex === blockIndex &&
      selection.anchor.textIndex === selection.focus.textIndex
    );
  }

  it("selects the table when Backspace starts the first cell", () => {
    // The first press must show what the second one will take, rather than
    // deleting outright or — as it used to — doing nothing at all.
    let state = caretIn(stateOf(TABLE), 0, 0);
    state = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;

    expect(heldWhole(state)).toBe(true);
    // The nested caret must be gone, or the table's own handlers would keep
    // claiming keys and the follow-up press would never reach core.
    expect(state.document.contentSelection).toBeNull();
    expect(state.document.cursor).not.toBeNull();
  });

  it("emits no operations for holding the table", () => {
    const state = caretIn(stateOf(TABLE), 0, 0);
    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);

    // Selecting a block is not a document mutation; nothing should sync.
    expect(result.ops).toEqual([]);
  });

  it("still does nothing at the start of any other cell", () => {
    let state = caretIn(stateOf(TABLE), 1, 0); // second header cell
    state = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;

    expect(heldWhole(state)).toBe(false);
    expect(state.document.contentSelection).not.toBeNull();
    expect(grid(state)).toEqual([
      ["A", "B"],
      ["one", "two"],
    ]);
  });

  it("does not hold the table on forward Delete at the first cell", () => {
    // Forward-Delete has no block to fall into, so it stays inert — the same
    // asymmetry the block equation has.
    let state = caretIn(stateOf(TABLE), 0, 0);
    state = state.actionBus.dispatchState(DELETE_FORWARD, state).state;

    expect(heldWhole(state)).toBe(false);
  });

  it("deletes nothing from the grid when it holds the table", () => {
    let state = caretIn(stateOf(TABLE), 0, 0);
    state = state.actionBus.dispatchState(DELETE_BACKWARD, state).state;

    const document = getTableDocument(state.document.page.blocks[0])!;
    expect(readTable(document).rows).toHaveLength(2);
  });
});
