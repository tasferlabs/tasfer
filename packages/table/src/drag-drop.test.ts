/**
 * Dragging text onto the grid.
 *
 * The drop has to resolve to the cell under the pointer. Resolved the flat way —
 * an offset into the block's own text — it addressed text a table block does not
 * have: the dragged range was removed from its paragraph and the insert landed
 * nowhere, so the text simply disappeared.
 */

import { registerTableInputActions } from "./input";
import { cellText, getTableDocument, readTable } from "./structured";
import { tableExtension } from "./table-extension";
import { createNodeRegistry } from "@tasfer/editor";
import { createActionBus } from "@tasfer/editor/action-bus";
import { DROP_TEXT } from "@tasfer/editor/actions/drag-actions";
import { dropTargetAt } from "@tasfer/editor/events/dragEvents";
import { getBlockHeight } from "@tasfer/editor/rendering/renderer";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { getEditorStyles } from "@tasfer/editor/styles";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());

const SOURCE = [
  "hello world",
  "",
  "| A | B |",
  "| --- | --- |",
  "| one | two |",
].join("\n");

const viewport: ViewportState = {
  scrollY: 0,
  width: 800,
  height: 600,
  documentHeight: 600,
};

function stateOf(source: string): EditorState {
  const bus = createActionBus();
  registerTableInputActions(bus);
  const state = createInitialState(loadPage(source, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
  return { ...state, actionBus: bus };
}

/** Select `[start, end)` in the first block. */
function selectInFirstBlock(
  state: EditorState,
  start: number,
  end: number,
): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      cursor: { position: { blockIndex: 0, textIndex: end }, lastUpdate: 0 },
      selection: {
        anchor: { blockIndex: 0, textIndex: start },
        focus: { blockIndex: 0, textIndex: end },
        isForward: true,
        isCollapsed: false,
        lastUpdate: 0,
      },
    },
  };
}

/** The document's blocks are: the paragraph, the blank line it left, the table. */
const TABLE_BLOCK = 2;

/** Every cell's text, row by row. */
function cells(state: EditorState): string[] {
  const document = getTableDocument(state.document.page.blocks[TABLE_BLOCK])!;
  return readTable(document).rows.flatMap((row) =>
    row.cells.map((cell) => (cell ? cellText(document, cell) : "")),
  );
}

function markdown(state: EditorState): string {
  return serializeToMarkdown(state.document.page.blocks, undefined, {
    schema: schema.data,
  });
}

/** A point at the very start of the first body cell. */
function pointInFirstBodyCell(state: EditorState) {
  const styles = getEditorStyles(state);
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const blocks = state.view.visibleBlocks;
  let top = styles.canvas.paddingTop;
  for (let index = 0; index < TABLE_BLOCK; index++) {
    top += getBlockHeight(
      state.nodes,
      state.marks,
      blocks[index],
      maxWidth,
      styles,
      index === 0,
    );
  }
  const height = getBlockHeight(
    state.nodes,
    state.marks,
    blocks[TABLE_BLOCK],
    maxWidth,
    styles,
    false,
  );
  return {
    x: styles.canvas.paddingLeft + 1,
    // Three quarters down the grid: the body row, below the header.
    y: top + height * 0.75,
  };
}

/** " world", the tail of the first paragraph. */
const SOURCE_RANGE = {
  start: { blockIndex: 0, textIndex: 5 },
  end: { blockIndex: 0, textIndex: 11 },
};
const PAYLOAD = { plainText: " world", html: "", markdown: " world" };

describe("dropping text into a table cell", () => {
  it("resolves the drop to the cell under the pointer", () => {
    const state = stateOf(SOURCE);
    const { x, y } = pointInFirstBodyCell(state);

    const target = dropTargetAt(state, viewport, x, y, undefined, null);

    expect(target?.kind).toBe("content");
  });

  it("moves the dragged text into the cell instead of losing it", () => {
    const state = selectInFirstBlock(stateOf(SOURCE), 5, 11);
    const { x, y } = pointInFirstBodyCell(state);
    const target = dropTargetAt(
      state,
      viewport,
      x,
      y,
      undefined,
      SOURCE_RANGE,
    )!;

    const result = state.actionBus.dispatchState(DROP_TEXT, state, {
      source: SOURCE_RANGE,
      target,
      payload: PAYLOAD,
    });

    expect(cells(result.state)).toEqual(["A", "B", " worldone", "two"]);
    expect(markdown(result.state)).toContain("|  worldone | two |");
    expect(result.ops.length).toBeGreaterThan(0);
  });

  it("leaves the source alone when the drop is a copy", () => {
    const state = selectInFirstBlock(stateOf(SOURCE), 5, 11);
    const { x, y } = pointInFirstBodyCell(state);
    const target = dropTargetAt(state, viewport, x, y, undefined, null)!;

    const result = state.actionBus.dispatchState(DROP_TEXT, state, {
      source: null,
      target,
      payload: PAYLOAD,
    });

    expect(cells(result.state)).toEqual(["A", "B", " worldone", "two"]);
    expect(markdown(result.state)).toContain("hello world");
  });

  it("refuses a drop into a table the drag is carrying away", () => {
    // The whole table is inside the dragged range, so its cells go with it —
    // there is nothing left to drop into.
    const state = stateOf(SOURCE);
    const { x, y } = pointInFirstBodyCell(state);

    const target = dropTargetAt(state, viewport, x, y, undefined, {
      start: { blockIndex: 0, textIndex: 0 },
      end: { blockIndex: TABLE_BLOCK, textIndex: 0 },
    });

    expect(target).toBeNull();
  });
});
