/**
 * Escaping a table into a fresh paragraph at the document edge.
 *
 * A table is a non-textual block: there is nothing to continue typing at its
 * top or bottom, so a document that begins or ends with one has to grow a
 * paragraph when the caret (or a click) moves past that edge. Otherwise a
 * document whose only block is a table is a trap — no way to write above or
 * below the grid.
 *
 * The pointer half rides the generic edge helpers in core; the keyboard half
 * has to be answered here, because the table claims the vertical moves.
 */

import { registerTableActions } from "./actions";
import { tableCaretToContentSelection, tableCellIds } from "./selection";
import { getTableDocument } from "./structured";
import { tableExtension } from "./table-extension";
import { createNodeRegistry } from "@tasfer/editor";
import { createActionBus } from "@tasfer/editor/action-bus";
import {
  createParagraphAbove,
  createParagraphAboveOnClick,
  createParagraphBelow,
  createParagraphBelowOnClick,
} from "@tasfer/editor/actions/edit-actions";
import {
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_PAGE_DOWN,
  MOVE_CURSOR_UP,
} from "@tasfer/editor/actions/keyboard-actions";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage, type Page } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { resolveTheme } from "@tasfer/editor/styles";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  const dom = (globalThis as unknown as { document: Record<string, unknown> })
    .document;
  if (!dom.body) dom.body = { appendChild: () => {}, removeChild: () => {} };
});

const schema = baseSchema.use(tableExtension());
const styles = resolveTheme({});
const MAX_WIDTH = 600;

const TABLE = [
  "| Fruit basket | Price |",
  "| --- | --- |",
  "| Green apples | 1.20 |",
  "| Pears | 2.40 |",
].join("\n");

const viewport: ViewportState = {
  width: MAX_WIDTH + styles.canvas.paddingLeft + styles.canvas.paddingRight,
  height: 800,
  scrollY: 0,
} as ViewportState;

function pageOf(source: string): Page {
  return loadPage(source, schema.data);
}

function busState(source: string): EditorState {
  const state = createInitialState(pageOf(source), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
  const bus = createActionBus();
  registerTableActions(bus);
  return { ...state, actionBus: bus };
}

function documentOf(state: EditorState, blockIndex = 0) {
  return getTableDocument(state.document.page.blocks[blockIndex])!;
}

/** Park a collapsed caret in the cell at `index`, `offset` characters in. */
function caretIn(
  state: EditorState,
  index: number,
  offset: number,
): EditorState {
  const document = documentOf(state);
  const selection = tableCaretToContentSelection(
    document,
    state.document.page.blocks[0].id,
    { cellId: tableCellIds(document)[index], offset },
  );
  return updateContentSelection(state, selection!);
}

function types(state: EditorState): string[] {
  return state.document.page.blocks.map((b) => b.type);
}

describe("keyboard — leaving a table at the document edge", () => {
  it("appends a paragraph on ArrowDown from the last row", () => {
    // Cell 4 is "Pears": the first cell of the last row.
    const state = caretIn(busState(TABLE), 4, 0);
    const moved = state.actionBus.dispatchState(MOVE_CURSOR_DOWN, state, {
      viewport,
    });

    expect(types(moved.state)).toEqual(["table", "paragraph"]);
    expect(moved.state.document.cursor?.position.blockIndex).toBe(1);
    expect(moved.state.document.contentSelection).toBeNull();
    expect(moved.ops.map((o) => o.op)).toEqual(["block_insert"]);
  });

  it("prepends a paragraph on ArrowUp from the first row", () => {
    const state = caretIn(busState(TABLE), 0, 0);
    const moved = state.actionBus.dispatchState(MOVE_CURSOR_UP, state, {
      viewport,
    });

    expect(types(moved.state)).toEqual(["paragraph", "table"]);
    expect(moved.state.document.cursor?.position.blockIndex).toBe(0);
    expect(moved.state.document.contentSelection).toBeNull();
    expect(moved.ops.map((o) => o.op)).toEqual(["block_insert"]);
  });

  it("steps between rows without growing the document", () => {
    const state = caretIn(busState(TABLE), 0, 0);
    const moved = state.actionBus.dispatchState(MOVE_CURSOR_DOWN, state, {
      viewport,
    });

    expect(types(moved.state)).toEqual(["table"]);
    expect(moved.ops).toEqual([]);
    expect(moved.state.document.contentSelection).not.toBeNull();
  });

  it("moves into an existing neighbour instead of adding one", () => {
    const state = caretIn(busState(`${TABLE}\n\nafter`), 4, 0);
    const before = types(state);
    const moved = state.actionBus.dispatchState(MOVE_CURSOR_DOWN, state, {
      viewport,
    });

    expect(types(moved.state)).toEqual(before);
    expect(moved.ops).toEqual([]);
    expect(moved.state.document.cursor?.position.blockIndex).toBe(1);
  });

  it("escapes on PageDown too, which a grid has no page for", () => {
    const state = caretIn(busState(TABLE), 4, 0);
    const moved = state.actionBus.dispatchState(MOVE_CURSOR_PAGE_DOWN, state, {
      viewport,
    });

    expect(types(moved.state)).toEqual(["table", "paragraph"]);
    expect(moved.state.document.cursor?.position.blockIndex).toBe(1);
  });

  it("leaves the escape to the table while a cell holds the caret", () => {
    // The flat cursor still names the table — it is the only block — so core's
    // own edge helper would otherwise fire from the first row and jump the
    // caret out of a grid the user is still walking down.
    const state = caretIn(busState(TABLE), 0, 0);
    const block = state.document.page.blocks[0];

    expect(createParagraphBelow(state, true, block).kind).toBe("fallthrough");
    expect(createParagraphAbove(state, true, block).kind).toBe("fallthrough");
  });
});

describe("pointer — clicking past a table at the document edge", () => {
  it("appends a paragraph when clicking below a trailing table", () => {
    const edge = createParagraphBelowOnClick(
      busState(TABLE),
      100_000,
      viewport,
    );

    expect(edge.kind).toBe("break");
    if (edge.kind !== "break") return;
    expect(types(edge.state)).toEqual(["table", "paragraph"]);
    expect(edge.state.document.cursor?.position.blockIndex).toBe(1);
  });

  it("prepends a paragraph when clicking above a leading table", () => {
    const edge = createParagraphAboveOnClick(busState(TABLE), -100, viewport);

    expect(edge.kind).toBe("break");
    if (edge.kind !== "break") return;
    expect(types(edge.state)).toEqual(["paragraph", "table"]);
    expect(edge.state.document.cursor?.position.blockIndex).toBe(0);
  });

  it("falls through when the click lands on the table itself", () => {
    expect(
      createParagraphBelowOnClick(busState(TABLE), -100, viewport).kind,
    ).toBe("fallthrough");
    expect(
      createParagraphAboveOnClick(busState(TABLE), 100_000, viewport).kind,
    ).toBe("fallthrough");
  });
});
