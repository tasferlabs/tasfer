/**
 * The touch magnifier drag moving a lone caret between paragraphs and table
 * cells.
 *
 * A caret has no anchor to keep inside one attachment, so the drag follows the
 * finger into a cell, out of it, and into a different table — each target
 * answering in its own caret currency.
 */

import {
  tableCaretFromContentPoint,
  tableCaretToContentSelection,
  tableCellIds,
} from "./selection";
import { getTableDocument } from "./structured";
import { tableExtension } from "./table-extension";
import { createActionBus } from "@tasfer/editor/action-bus";
import { dragCaretToPoint } from "@tasfer/editor/events/touchEvents";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import {
  getContentSelectionFromViewport,
  getTextPositionFromViewport,
  updateCursor,
} from "@tasfer/editor/selection";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
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
const viewport: ViewportState = {
  width: MAX_WIDTH + styles.canvas.paddingLeft + styles.canvas.paddingRight,
  height: 2000,
  scrollY: 0,
} as ViewportState;

const SOURCE = [
  "Intro words here",
  "",
  "| First | Second |",
  "| --- | --- |",
  "| one two | x |",
  "",
  "Middle words",
  "",
  "| Other | Table |",
  "| --- | --- |",
  "| three | y |",
].join("\n");

function initialState(): EditorState {
  const state = createInitialState(loadPage(SOURCE, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
  return { ...state, actionBus: createActionBus() };
}

const X = styles.canvas.paddingLeft + 12;

function tables(state: EditorState) {
  return state.document.page.blocks.filter(
    (block) => (block.type as string) === "table",
  );
}

/** Where the caret sits, as a readable label. */
function caretOf(state: EditorState): string | null {
  const content = state.document.contentSelection;
  if (content) {
    const tableIndex = tables(state).findIndex(
      (block) => block.id === content.focus.blockId,
    );
    const document = getTableDocument(tables(state)[tableIndex])!;
    const caret = tableCaretFromContentPoint(document, content.focus)!;
    return `table${tableIndex}:cell${tableCellIds(document).indexOf(caret.cellId)}`;
  }
  const position = state.document.cursor?.position;
  return position ? `block${position.blockIndex}` : null;
}

/** The first y (scanning down) whose hit resolves to `label`. */
function yOf(state: EditorState, label: string): number {
  for (let y = 0; y < viewport.height; y += 2) {
    const content = getContentSelectionFromViewport(
      X,
      y,
      state,
      viewport,
      "touch",
    );
    const probe = content
      ? updateContentSelection(state, content)
      : (() => {
          const position = getTextPositionFromViewport(X, y, state, viewport);
          return position ? updateCursor(state, position) : state;
        })();
    if (caretOf(probe) === label) return y + 1;
  }
  throw new Error(`no point resolves to ${label}`);
}

function inCell(state: EditorState, tableIndex: number, cell: number) {
  const block = tables(state)[tableIndex];
  const document = getTableDocument(block)!;
  return updateContentSelection(
    state,
    tableCaretToContentSelection(document, block.id, {
      cellId: tableCellIds(document)[cell],
      offset: 0,
    })!,
  );
}

describe("magnifier caret drag across table cells", () => {
  it("drags a paragraph caret into a cell", () => {
    const start = updateCursor(initialState(), { blockIndex: 0, textIndex: 2 });
    const next = dragCaretToPoint(
      start,
      X,
      yOf(start, "table0:cell2"),
      viewport,
    );

    expect(next && caretOf(next)).toBe("table0:cell2");
    expect(next!.document.cursor).toBeNull();
  });

  it("drags a cell caret out to the paragraph below", () => {
    const start = inCell(initialState(), 0, 2);
    const middle = start.document.page.blocks.findIndex(
      (block) =>
        block.type === "paragraph" && block !== start.document.page.blocks[0],
    );
    const next = dragCaretToPoint(
      start,
      X,
      yOf(start, `block${middle}`),
      viewport,
    );

    expect(next && caretOf(next)).toBe(`block${middle}`);
    expect(next!.document.contentSelection).toBeNull();
  });

  it("drags a cell caret into a different table", () => {
    const start = inCell(initialState(), 0, 0);
    const next = dragCaretToPoint(
      start,
      X,
      yOf(start, "table1:cell2"),
      viewport,
    );

    expect(next && caretOf(next)).toBe("table1:cell2");
  });

  it("still moves between cells of one table", () => {
    const start = inCell(initialState(), 0, 0);
    const next = dragCaretToPoint(
      start,
      X,
      yOf(start, "table0:cell2"),
      viewport,
    );

    expect(next && caretOf(next)).toBe("table0:cell2");
  });
});
