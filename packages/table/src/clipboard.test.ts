/**
 * Copy and cut inside a table.
 *
 * The clipboard side is `./content-selection`; the document side of a cut is
 * the engine's `CUT`, which routes a nested range through the table's input
 * rule (`./input`) rather than the flat delete. Both halves are exercised here
 * the way the native `cut` handler runs them: build the payload, then dispatch
 * `CUT` on the same state.
 */

import { registerTableActions } from "./actions";
import { registerTableInputActions } from "./input";
import { tableCaretToContentSelection, tableCellIds } from "./selection";
import { cellText, getTableDocument, readTable } from "./structured";
import { tableExtension } from "./table-extension";
import { createNodeRegistry } from "@tasfer/editor";
import { createActionBus } from "@tasfer/editor/action-bus";
import {
  buildClipboardPayload,
  getSelectionPlainText,
} from "@tasfer/editor/actions/clipboard";
import { CUT } from "@tasfer/editor/actions/input-actions";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { applyOps } from "@tasfer/editor/sync/reducer";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());

const TABLE = [
  "| Fruit | Price |",
  "| --- | --- |",
  "| Apples | 1.20 |",
  "| Pears | 2.40 |",
].join("\n");

function stateOf(source: string): EditorState {
  const bus = createActionBus();
  registerTableActions(bus);
  registerTableInputActions(bus);
  const state = createInitialState(loadPage(source, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
  return { ...state, actionBus: bus };
}

function documentOf(state: EditorState) {
  return getTableDocument(state.document.page.blocks[0])!;
}

/** Every cell's text, row by row. */
function grid(state: EditorState): string[][] {
  const document = documentOf(state);
  return readTable(document).rows.map((row) =>
    row.cells.map((cell) => (cell ? cellText(document, cell) : "")),
  );
}

/** Select from (cell, offset) to (cell, offset), cells in row-major order. */
function select(
  state: EditorState,
  from: readonly [number, number],
  to: readonly [number, number],
): EditorState {
  const document = documentOf(state);
  const blockId = state.document.page.blocks[0].id;
  const order = tableCellIds(document);
  const point = ([cell, offset]: readonly [number, number]) =>
    tableCaretToContentSelection(document, blockId, {
      cellId: order[cell],
      offset,
    })!.anchor;
  return updateContentSelection(state, {
    anchor: point(from),
    focus: point(to),
  });
}

describe("copying from a table", () => {
  it("copies the characters of a range inside one cell", () => {
    const state = select(stateOf(TABLE), [2, 0], [2, 3]);
    expect(buildClipboardPayload(state)?.plainText).toBe("App");
    // The accessible input mirrors the same text, so the browser has a
    // selection to fire `copy`/`cut` for.
    expect(getSelectionPlainText(state)).toBe("App");
  });

  it("copies covered cells whole, tab-separated within a row", () => {
    // From the middle of "Apples" to the middle of "2.40": the range spans
    // cells, so each covered cell is taken whole, in the grid's own shape.
    const state = select(stateOf(TABLE), [2, 3], [5, 2]);
    expect(buildClipboardPayload(state)?.plainText).toBe(
      "Apples\t1.20\nPears\t2.40",
    );
  });
});

describe("cutting from a table", () => {
  it("removes the characters of a range inside one cell", () => {
    const state = select(stateOf(TABLE), [2, 0], [2, 3]);
    const cut = state.actionBus.dispatchState(CUT, state);

    expect(grid(cut.state)[1]).toEqual(["les", "1.20"]);
    expect(cut.ops.length).toBeGreaterThan(0);
  });

  it("clears every covered cell of a range spanning cells", () => {
    const state = select(stateOf(TABLE), [2, 3], [5, 2]);
    const payload = buildClipboardPayload(state);
    const cut = state.actionBus.dispatchState(CUT, state);

    // The clipboard got the cells; the grid kept its shape and lost their text.
    expect(payload?.plainText).toBe("Apples\t1.20\nPears\t2.40");
    expect(grid(cut.state)).toEqual([
      ["Fruit", "Price"],
      ["", ""],
      ["", ""],
    ]);
    // The caret lands at the start of the first cleared cell.
    const focus = cut.state.document.contentSelection?.focus;
    expect(focus?.kind === "text" && focus.nodeId).toBe(
      tableCellIds(documentOf(cut.state))[2],
    );
  });

  it("cuts a backwards range the same as a forwards one", () => {
    const state = select(stateOf(TABLE), [5, 2], [2, 3]);
    const cut = state.actionBus.dispatchState(CUT, state);

    expect(grid(cut.state)).toEqual([
      ["Fruit", "Price"],
      ["", ""],
      ["", ""],
    ]);
  });

  it("emits operations a peer can replay", () => {
    const state = select(stateOf(TABLE), [2, 0], [3, 4]);
    const cut = state.actionBus.dispatchState(CUT, state);

    const peer = applyOps(loadPage(TABLE, schema.data), cut.ops, schema.data);
    const document = getTableDocument(peer.blocks[0])!;
    expect(
      readTable(document).rows.map((row) =>
        row.cells.map((cell) => (cell ? cellText(document, cell) : "")),
      ),
    ).toEqual(grid(cut.state));
    expect(grid(cut.state)[1]).toEqual(["", ""]);
  });

  it("does nothing on a collapsed caret", () => {
    const state = select(stateOf(TABLE), [2, 2], [2, 2]);
    const cut = state.actionBus.dispatchState(CUT, state);

    expect(buildClipboardPayload(state)).toBeNull();
    expect(grid(cut.state)).toEqual(grid(state));
    expect(cut.ops).toEqual([]);
  });
});
