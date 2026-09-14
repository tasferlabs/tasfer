/**
 * Pasting into a table, and the copies that feed it.
 *
 * Driven through the engine's own clipboard entry points — `buildClipboardPayload`
 * for a copy, `pasteFromClipboardEvent` for a paste — so these cover the whole
 * seam: the table's slice, core's rich flavors, core offering the paste back to
 * the table's kind, and the table spreading it.
 */

import { registerTableActions } from "./actions";
import {
  registerTableCommands,
  TABLE_SELECT_COLUMN,
  TABLE_SELECT_ROW,
} from "./commands";
import { registerTableInputActions } from "./input";
import { parseClipboardGrid, readTableClipboard } from "./paste";
import { tableCaretToContentSelection, tableCellIds } from "./selection";
import { cellText, getTableDocument, readTable } from "./structured";
import { tableExtension } from "./table-extension";
import { createNodeRegistry } from "@tasfer/editor";
import { createActionBus } from "@tasfer/editor/action-bus";
import {
  buildClipboardPayload,
  type ClipboardPayload,
  pasteFromClipboardEvent,
} from "@tasfer/editor/actions/clipboard";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { applyOps } from "@tasfer/editor/sync/reducer";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());

const TABLE = [
  "| Fruit | Price |",
  "| --- | --- |",
  "| **Apples** | 1.20 |",
  "| Pears | [2.40](https://example.com) |",
].join("\n");

function stateOf(source: string): EditorState {
  const bus = createActionBus();
  registerTableActions(bus);
  registerTableInputActions(bus);
  registerTableCommands(bus);
  const state = createInitialState(loadPage(source, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
  });
  return { ...state, actionBus: bus };
}

function tableIndex(state: EditorState): number {
  return state.document.page.blocks.findIndex(
    (block) => !block.deleted && (block.type as string) === "table",
  );
}

function documentOf(state: EditorState) {
  return getTableDocument(state.document.page.blocks[tableIndex(state)])!;
}

/** Every cell's text, row by row. */
function grid(state: EditorState): string[][] {
  const document = documentOf(state);
  return readTable(document).rows.map((row) =>
    row.cells.map((cell) => (cell ? cellText(document, cell) : "")),
  );
}

/** The table as Markdown — what shows formatting survived. */
function markdownOf(state: EditorState): string {
  return serializeToMarkdown(
    [state.document.page.blocks[tableIndex(state)]],
    undefined,
    { schema: schema.data },
  );
}

/** Select from (cell, offset) to (cell, offset), cells in row-major order. */
function select(
  state: EditorState,
  from: readonly [number, number],
  to: readonly [number, number] = from,
): EditorState {
  const document = documentOf(state);
  const blockId = state.document.page.blocks[tableIndex(state)].id;
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

function paste(
  state: EditorState,
  flavors: { readonly text: string; readonly html?: string },
) {
  const result = pasteFromClipboardEvent(state, {} as ClipboardEvent, {
    text: flavors.text,
    html: flavors.html ?? "",
    imageFile: null,
  });
  expect(result).not.toBeNull();
  return result!;
}

function pastePayload(state: EditorState, payload: ClipboardPayload) {
  return paste(state, { text: payload.plainText, html: payload.html });
}

describe("reading a clipboard as a table", () => {
  it("splits tabs into cells and line breaks into rows", () => {
    expect(parseClipboardGrid("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("ignores the trailing line break a spreadsheet appends", () => {
    expect(parseClipboardGrid("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("reads quoted cells holding tabs, line breaks and quotes", () => {
    expect(parseClipboardGrid('"x\ty"\t"say ""hi"""\n"two\nlines"\tz')).toEqual(
      [
        ["x\ty", 'say "hi"'],
        ["two lines", "z"],
      ],
    );
  });

  it("keeps a quote that does not wrap the whole cell literal", () => {
    expect(parseClipboardGrid('"quoted" tail\tb')).toEqual([
      ['"quoted" tail', "b"],
    ]);
  });

  it("takes text with no tab or line break as one cell's worth", () => {
    expect(readTableClipboard("hello", undefined)).toEqual({
      kind: "inline",
      source: "hello",
      rich: false,
    });
  });

  it("takes a Tasfer GFM table as a formatted grid", () => {
    expect(
      readTableClipboard("a\tb", "| **a** | b |\n| --- | --- |\n"),
    ).toEqual({ kind: "grid", rows: [["**a**", "b"]], rich: true });
  });
});

describe("copying cells", () => {
  it("puts the rectangle on the clipboard as a formatted table", () => {
    // The first column of both body rows.
    const payload = buildClipboardPayload(
      select(stateOf(TABLE), [2, 0], [4, 0]),
    );

    expect(payload?.plainText).toBe("Apples\nPears");
    expect(payload?.markdown).toBe(
      ["| **Apples** |", "| --- |", "| Pears |"].join("\n"),
    );
    expect(payload?.html).toContain("<table>");
    expect(payload?.html).toContain("<strong>Apples</strong>");
  });

  it("copies part of a cell as formatted text", () => {
    const payload = buildClipboardPayload(
      select(stateOf(TABLE), [2, 0], [2, 3]),
    );

    expect(payload?.plainText).toBe("App");
    expect(payload?.markdown).toBe("**App**");
  });
});

describe("selecting a row or a column", () => {
  it("selects the caret's row whole", () => {
    const state = select(stateOf(TABLE), [4, 1]);
    const selected = state.actionBus.dispatchState(TABLE_SELECT_ROW, state, {});

    expect(selected.ops).toEqual([]);
    expect(buildClipboardPayload(selected.state)?.plainText).toBe(
      "Pears\t2.40",
    );
  });

  it("selects a named column whole, header included", () => {
    const state = select(stateOf(TABLE), [0, 0]);
    const selected = state.actionBus.dispatchState(TABLE_SELECT_COLUMN, state, {
      columnIndex: 1,
    });

    expect(buildClipboardPayload(selected.state)?.plainText).toBe(
      "Price\n1.20\n2.40",
    );
  });
});

describe("pasting cells into a table", () => {
  it("overwrites the cells a copied column lands on, formatting and all", () => {
    const source = stateOf(TABLE);
    const column = source.actionBus.dispatchState(
      TABLE_SELECT_COLUMN,
      select(source, [0, 0]),
      { columnIndex: 0 },
    ).state;
    const payload = buildClipboardPayload(column)!;

    // Paste over the second column: same shape, so nothing grows.
    const pasted = pastePayload(select(source, [1, 0]), payload);

    expect(grid(pasted.state)).toEqual([
      ["Fruit", "Fruit"],
      ["Apples", "Apples"],
      ["Pears", "Pears"],
    ]);
    expect(markdownOf(pasted.state)).toContain("| **Apples** | **Apples** |");
    // The link the second column had is gone with the text it was on.
    expect(markdownOf(pasted.state)).not.toContain("example.com");
  });

  it("starts from the top-left corner of a selected range", () => {
    const state = select(stateOf(TABLE), [5, 0], [3, 0]);
    const pasted = paste(state, { text: "x\ny" });

    expect(grid(pasted.state)).toEqual([
      ["Fruit", "Price"],
      ["Apples", "x"],
      ["Pears", "y"],
    ]);
  });

  it("grows the table when the grid runs past its edges", () => {
    const state = select(stateOf(TABLE), [5, 0]);
    const pasted = paste(state, { text: "a\tb\nc\td\n" });

    expect(grid(pasted.state)).toEqual([
      ["Fruit", "Price", ""],
      ["Apples", "1.20", ""],
      ["Pears", "a", "b"],
      ["", "c", "d"],
    ]);
  });

  it("takes spreadsheet text literally, never as Markdown", () => {
    const state = select(stateOf(TABLE), [2, 0]);
    const pasted = paste(state, { text: "*.ts\t**x**" });

    expect(grid(pasted.state)[1]).toEqual(["*.ts", "**x**"]);
  });

  it("leaves the pasted block selected", () => {
    const state = select(stateOf(TABLE), [2, 0]);
    const pasted = paste(state, { text: "a\tb\nc\td" });

    expect(buildClipboardPayload(pasted.state)?.plainText).toBe("a\tb\nc\td");
  });

  it("emits operations a peer can replay to the same grid", () => {
    const state = select(stateOf(TABLE), [5, 0]);
    const pasted = paste(state, { text: "a\tb\nc\td" });

    const peer = applyOps(
      loadPage(TABLE, schema.data),
      pasted.ops,
      schema.data,
    );
    const document = getTableDocument(peer.blocks[0])!;
    expect(
      readTable(document).rows.map((row) =>
        row.cells.map((cell) => (cell ? cellText(document, cell) : "")),
      ),
    ).toEqual(grid(pasted.state));
  });
});

describe("pasting one cell's worth", () => {
  it("inserts plain text at the caret like typing", () => {
    const state = select(stateOf(TABLE), [4, 2]);
    const pasted = paste(state, { text: "-!-" });

    expect(grid(pasted.state)[2][0]).toBe("Pe-!-ars");
  });

  it("replaces a range inside the cell", () => {
    const state = select(stateOf(TABLE), [4, 0], [4, 5]);
    const pasted = paste(state, { text: "Plums" });

    expect(grid(pasted.state)[2][0]).toBe("Plums");
  });

  it("keeps the formatting of part of a cell copied here", () => {
    const source = stateOf(TABLE);
    const payload = buildClipboardPayload(select(source, [2, 0], [2, 3]))!;

    const pasted = pastePayload(select(source, [4, 5]), payload);

    expect(grid(pasted.state)[2][0]).toBe("PearsApp");
    expect(markdownOf(pasted.state)).toContain("| Pears**App** |");
  });
});

describe("pasting copied cells into prose", () => {
  it("rebuilds them as a table of their own", () => {
    const source = stateOf(TABLE);
    const payload = buildClipboardPayload(select(source, [2, 0], [5, 0]))!;

    const prose = stateOf("Before");
    const at = {
      ...prose,
      document: {
        ...prose.document,
        cursor: {
          position: { blockIndex: 0, textIndex: "Before".length },
          lastUpdate: 0,
        },
      },
    };
    const pasted = pastePayload(at, payload);

    expect(grid(pasted.state)).toEqual([
      ["Apples", "1.20"],
      ["Pears", "2.40"],
    ]);
    expect(markdownOf(pasted.state)).toContain("| **Apples** | 1.20 |");
  });
});
