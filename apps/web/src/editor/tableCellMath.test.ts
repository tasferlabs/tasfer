/**
 * Inline math inside table cells, with the app's real feature composition.
 *
 * A cell's formula is a structured mark like a paragraph's: one anchor char in
 * the cell, and an attachment on the TABLE BLOCK (beside the table's own
 * document) holding the formula. These pin the property that keeps that safe:
 * every path that copies a table — import, snapshot clone, paste clone — leaves
 * each cell pointing at an attachment the copy actually owns, distinct per
 * formula, and Markdown comes back as written.
 */

import { appDataSchema } from "../appDataSchema";
import {
  getStructuredMathMarkSource,
  mathMarkContentId,
} from "@tasfer/math/data";
import { getTableDocument, readTable } from "@tasfer/table/structured";
import { cloneStructuredBlockContent } from "@tasfer/editor/actions/structured-marks";
import { loadPage, type Block } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import { rebuildState } from "@tasfer/editor/sync/reducer";
import { blocksToOps } from "@tasfer/editor/sync/snapshot-diff";
import {
  createCRDTbinding,
  createSyncEngine,
  type Operation,
} from "@tasfer/editor/sync/sync";
import type { Page } from "@tasfer/editor/serlization/loadPage";
import { TABLE_INSERT_ROW } from "@tasfer/table/commands";
import { appSchema } from "../editorSchema";
import { CELL_TEXT_FIELD } from "@tasfer/table/structured";
import { createNodeRegistry } from "@tasfer/editor";
import { insertText } from "@tasfer/editor/actions/actions";
import {
  buildClipboardPayload,
  pasteFromClipboardEvent,
} from "@tasfer/editor/actions/clipboard";
import { moveCursorToPosition } from "@tasfer/editor/selection";
import {
  tableCaretToContentSelection,
  tableCellIds,
} from "@tasfer/table/selection";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
} from "@tasfer/editor/actions/edit-actions";
import { resolveMarkRunsFromChars } from "@tasfer/editor/mark-runs";
import {
  createMarkRegistry,
  TOGGLE_STRONG,
} from "@tasfer/editor/rendering/marks";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import {
  getCharIdAtVisiblePosition,
  getVisibleTextFromRuns,
  iterateAllChars,
} from "@tasfer/editor/sync/char-runs";
import { invertOperations } from "@tasfer/editor/sync/inverse";
import { applyOp } from "@tasfer/editor/sync/reducer";
import { describe, expect, it } from "vitest";

const SOURCE = [
  "| Name | Formula |",
  "| --- | --- |",
  // Formulas in the math printer's canonical form, so the round trip is
  // byte-exact (a paragraph normalizes `x^2` the same way).
  "| square | ${x}^{2}$ |",
  "| both | $a$ and **b** $c$ |",
].join("\n");

/** The table block type comes from an optional feature, not the core union. */
function isTable(block: Block): boolean {
  return (block.type as string) === "table";
}

function tableIn(blocks: readonly Block[]): Block {
  const block = blocks.find(isTable);
  if (!block) throw new Error("expected a table block");
  return block;
}

/** Every math mark in the table's cells, with the formula it resolves to. */
function cellFormulas(block: Block): { contentId: string; latex: string }[] {
  const document = getTableDocument(block);
  if (!document) throw new Error("expected a table document");
  const found: { contentId: string; latex: string }[] = [];
  for (const row of readTable(document).rows) {
    for (const cell of row.cells) {
      for (const span of cell?.markFields?.text ?? []) {
        if (span.format.type !== "math") continue;
        found.push({
          contentId: mathMarkContentId(span.format) ?? "",
          latex:
            getStructuredMathMarkSource(span.format, block.structuredContent) ??
            "<missing>",
        });
      }
    }
  }
  return found;
}

function importTable(): Block {
  const page = loadPage(SOURCE, appDataSchema);
  expect(page.blocks).toHaveLength(1);
  return page.blocks[0];
}

describe("inline math in table cells", () => {
  it("imports each formula as its own attachment on the table block", () => {
    const formulas = cellFormulas(importTable());

    expect(formulas.map((formula) => formula.latex)).toEqual([
      "{x}^{2}",
      "a",
      "c",
    ]);
    expect(new Set(formulas.map((f) => f.contentId)).size).toBe(3);
  });

  it("round-trips through Markdown unchanged", () => {
    const block = importTable();
    expect(
      serializeToMarkdown([block], undefined, { schema: appDataSchema }),
    ).toBe(SOURCE);
  });

  it("keeps every formula when the imported page becomes operations", () => {
    let counter = 0;
    const ops = blocksToOps([importTable()], {
      pageId: "page",
      peerId: "import",
      nextId: () => `import:${counter++}`,
      getClock: () => ({ counter: counter++, peerId: "import" }),
      schema: appDataSchema,
    });
    const rebuilt = rebuildState("page", ops, appDataSchema);
    const block = tableIn(rebuilt.blocks);

    const formulas = cellFormulas(block);
    expect(formulas.map((formula) => formula.latex)).toEqual([
      "{x}^{2}",
      "a",
      "c",
    ]);
    // Each reference names an attachment THIS block holds.
    for (const { contentId } of formulas) {
      expect(block.structuredContent?.[contentId]).toBeDefined();
    }
    expect(
      serializeToMarkdown(rebuilt.blocks, undefined, {
        schema: appDataSchema,
      }),
    ).toBe(SOURCE);
  });

  it("re-points a cloned table's cells at the clone's own attachments", () => {
    const source = importTable();
    const binding = createCRDTbinding("page", "peer");
    const cloned = cloneStructuredBlockContent(
      source,
      "copy",
      binding,
      appDataSchema,
    );
    if (!cloned) throw new Error("expected a lossless clone");
    const copy: Block = {
      ...source,
      id: "copy",
      structuredContent: cloned.structuredContent,
    };

    const before = cellFormulas(source);
    const after = cellFormulas(copy);
    expect(after.map((formula) => formula.latex)).toEqual(
      before.map((formula) => formula.latex),
    );
    for (const { contentId } of after) {
      expect(copy.structuredContent?.[contentId]).toBeDefined();
      expect(before.some((formula) => formula.contentId === contentId)).toBe(
        false,
      );
    }
    // The ops alone rebuild the same thing on a peer.
    expect(
      cloned.ops.map((op) => op.edit.kind).every((k) => k === "document_init"),
    ).toBe(true);
  });
});

// ─── Editing around a formula ────────────────────────────────────────────────

/** The fixture cell holds `a ` + formula `x` + ` b`; the formula is offset 2. */
const EDIT_SOURCE = ["| A |", "| --- |", "| a $x$ b |"].join("\n");
const CHIP = 2;

function editorOver(source: string): EditorState {
  const page = loadPage(source, appSchema.data);
  return createInitialState(page, {
    schema: appSchema.data,
    nodes: createNodeRegistry(appSchema.nodes),
    marks: createMarkRegistry(appSchema.marks),
    crdtBinding: createCRDTbinding(page.id, "local"),
  });
}

function bodyCell(state: EditorState) {
  const block = tableIn(state.document.page.blocks);
  const document = getTableDocument(block)!;
  const cell = readTable(document).rows[1].cells[0]!;
  return { block, document, cell };
}

/** Caret (or range) at visible offsets in the body cell. */
function select(state: EditorState, anchor: number, focus = anchor) {
  const { block, document, cell } = bodyCell(state);
  const point = (offset: number) => ({
    kind: "text" as const,
    blockId: block.id,
    contentId: document.rootId,
    nodeId: cell.id,
    field: CELL_TEXT_FIELD,
    afterCharId: getCharIdAtVisiblePosition(
      [...cell.textFields[CELL_TEXT_FIELD]],
      offset,
    ),
    affinity: "forward" as const,
  });
  return updateContentSelection(state, {
    anchor: point(anchor),
    focus: point(focus),
  });
}

/** The cell as text, with `[…]` around what the math mark covers. */
function cellView(state: EditorState): string {
  const { block, cell } = bodyCell(state);
  const runs = [...cell.textFields[CELL_TEXT_FIELD]];
  const text = getVisibleTextFromRuns(runs);
  const math = new Array<boolean>(text.length).fill(false);
  for (const run of resolveMarkRunsFromChars(
    iterateAllChars(runs),
    cell.markFields?.[CELL_TEXT_FIELD] ?? [],
  )) {
    if (run.name !== "math") continue;
    for (let at = run.startIndex; at < run.endIndex; at++) math[at] = true;
  }
  let out = "";
  for (let at = 0; at < text.length; at++) {
    const char = math[at]
      ? `[${getStructuredMathMarkSource(
          { type: "math", attrs: { contentId: formulaIdAt(state, at) } },
          block.structuredContent,
        )}]`
      : text[at];
    out += char;
  }
  return out;
}

function formulaIdAt(state: EditorState, offset: number): string {
  const { cell } = bodyCell(state);
  const runs = [...cell.textFields[CELL_TEXT_FIELD]];
  const id = getCharIdAtVisiblePosition(runs, offset + 1);
  for (const span of cell.markFields?.[CELL_TEXT_FIELD] ?? []) {
    if (span.format.type === "math" && span.startCharId === id) {
      return mathMarkContentId(span.format) ?? "";
    }
  }
  return "";
}

describe("editing a cell that holds a formula", () => {
  it("shows the fixture as text around one formula", () => {
    expect(cellView(editorOver(EDIT_SOURCE))).toBe("a [x] b");
  });

  it("types on either side without growing the formula", () => {
    const state = editorOver(EDIT_SOURCE);
    expect(cellView(insertText(select(state, CHIP + 1), "z").state)).toBe(
      "a [x]z b",
    );
    expect(cellView(insertText(select(state, CHIP), "z").state)).toBe(
      "a z[x] b",
    );
  });

  it("removes the formula whole with one Backspace or Delete, and undo brings it back", () => {
    const state = editorOver(EDIT_SOURCE);
    for (const [action, at] of [
      [DELETE_BACKWARD, CHIP + 1],
      [DELETE_FORWARD, CHIP],
    ] as const) {
      const before = select(state, at);
      const result = before.actionBus.dispatchState(action, before);
      expect(cellView(result.state)).toBe("a  b");

      // The formula's attachment is still on the block, so the inverse ops —
      // what undo replays — restore the very same formula.
      const inverses = invertOperations(
        result.ops,
        before.document.page,
        (page, op) => applyOp(page, op, appSchema.data),
        before.CRDTbinding,
        appSchema.data,
      );
      let page = result.state.document.page;
      for (const op of inverses) page = applyOp(page, op, appSchema.data);
      expect(
        cellView({
          ...result.state,
          document: { ...result.state.document, page },
        }),
      ).toBe("a [x] b");
    }
  });

  it("keeps the formula when bold is toggled over it", () => {
    const state = select(editorOver(EDIT_SOURCE), 0, 5);
    const result = state.actionBus.dispatchState(TOGGLE_STRONG, state);
    expect(cellView(result.state)).toBe("a [x] b");
    const { cell } = bodyCell(result.state);
    expect(
      (cell.markFields?.[CELL_TEXT_FIELD] ?? [])
        .map((s) => s.format.type)
        .sort(),
    ).toEqual(["math", "strong"]);
  });
});

// ─── Copy and paste ──────────────────────────────────────────────────────────

/** Every cell, row-major, as text with `[latex]` for each formula. */
function cellsView(state: EditorState): string[] {
  const block = tableIn(state.document.page.blocks);
  const document = getTableDocument(block)!;
  return tableCellIds(document).map((cellId) => {
    const node = document.nodes[cellId];
    const runs = [...node.textFields[CELL_TEXT_FIELD]];
    const chars = [...iterateAllChars(runs)].filter((c) => !c.deleted);
    const spans = node.markFields?.[CELL_TEXT_FIELD] ?? [];
    return chars
      .map((char) => {
        const span = spans.find(
          (s) => s.format.type === "math" && s.startCharId === char.id,
        );
        if (!span) return char.char;
        return `[${getStructuredMathMarkSource(span.format, block.structuredContent) ?? "missing"}]`;
      })
      .join("");
  });
}

/** Every formula reference in the table, as content ids. */
function formulaIds(state: EditorState): string[] {
  const block = tableIn(state.document.page.blocks);
  return cellFormulas(block).map((formula) => formula.contentId);
}

/** A caret or range between (cell, offset) points, cells row-major. */
function selectCells(
  state: EditorState,
  from: readonly [number, number],
  to: readonly [number, number] = from,
): EditorState {
  const block = tableIn(state.document.page.blocks);
  const document = getTableDocument(block)!;
  const order = tableCellIds(document);
  const point = ([cell, offset]: readonly [number, number]) =>
    tableCaretToContentSelection(document, block.id, {
      cellId: order[cell],
      offset,
    })!.anchor;
  return updateContentSelection(state, {
    anchor: point(from),
    focus: point(to),
  });
}

function copyThenPaste(source: EditorState, target: EditorState) {
  const payload = buildClipboardPayload(source);
  if (!payload) throw new Error("expected something to copy");
  const result = pasteFromClipboardEvent(target, {} as ClipboardEvent, {
    text: payload.plainText,
    html: payload.html,
    imageFile: null,
  });
  if (!result) throw new Error("expected the paste to land");
  return result;
}

/** Every formula reference resolves on its own block, and none is shared. */
function expectOwnedFormulas(state: EditorState) {
  const block = tableIn(state.document.page.blocks);
  const ids = formulaIds(state);
  for (const id of ids) expect(block.structuredContent?.[id]).toBeDefined();
  expect(new Set(ids).size).toBe(ids.length);
}

const GRID = [
  "| A | B |",
  "| --- | --- |",
  "| a $x$ | $y$ |",
  "| one | two |",
].join("\n");

describe("copying and pasting a formula into a cell", () => {
  it("pastes a formula copied from part of another cell as its own formula", () => {
    const state = editorOver(GRID);
    // Copy "a [x]" from the first body cell, paste at the end of "one".
    const copied = selectCells(state, [2, 0], [2, 3]);
    const pasted = copyThenPaste(copied, selectCells(state, [4, 3]));

    expect(cellsView(pasted.state)).toEqual([
      "A",
      "B",
      "a [x]",
      "[y]",
      "onea [x]",
      "two",
    ]);
    expectOwnedFormulas(pasted.state);
  });

  it("pastes a copied grid with its formulas, each re-addressed", () => {
    const state = editorOver(GRID);
    const copied = selectCells(state, [2, 0], [3, 1]);
    const pasted = copyThenPaste(copied, selectCells(state, [4, 0]));

    expect(cellsView(pasted.state)).toEqual([
      "A",
      "B",
      "a [x]",
      "[y]",
      "a [x]",
      "[y]",
    ]);
    expectOwnedFormulas(pasted.state);
  });

  it("pastes a formula copied from a paragraph", () => {
    const paragraph = editorOver("see $z$ here");
    const copied = {
      ...moveCursorToPosition(paragraph, 0, 0),
      document: {
        ...paragraph.document,
        selection: {
          anchor: { blockIndex: 0, textIndex: 0 },
          focus: { blockIndex: 0, textIndex: 6 },
          isForward: true,
          isCollapsed: false,
          lastUpdate: 0,
        },
      },
    };
    const pasted = copyThenPaste(copied, selectCells(editorOver(GRID), [5, 3]));

    expect(cellsView(pasted.state)[5]).toBe("twosee [z] ");
    expectOwnedFormulas(pasted.state);
  });

  it("rebuilds the pasted formulas from the operations alone", () => {
    const state = editorOver(GRID);
    const copied = selectCells(state, [2, 0], [3, 1]);
    const target = selectCells(state, [4, 0]);
    const pasted = copyThenPaste(copied, target);

    let page = target.document.page;
    for (const op of pasted.ops) page = applyOp(page, op, appSchema.data);
    const replica = {
      ...pasted.state,
      document: { ...pasted.state.document, page },
    };
    expect(cellsView(replica)).toEqual(cellsView(pasted.state));
    expectOwnedFormulas(replica);
  });

  it("pastes copied cells into prose as a new table that owns its formulas", () => {
    const table = editorOver(GRID);
    const copied = selectCells(table, [2, 0], [3, 1]);
    const prose = moveCursorToPosition(editorOver("hello"), 0, 5);
    const pasted = copyThenPaste(copied, prose);

    const tables = pasted.state.document.page.blocks.filter(
      (b) => isTable(b) && !b.deleted,
    );
    expect(tables).toHaveLength(1);
    const formulas = cellFormulas(tables[0]);
    expect(formulas.map((f) => f.latex)).toEqual(["x", "y"]);
    for (const { contentId } of formulas) {
      expect(tables[0].structuredContent?.[contentId]).toBeDefined();
    }
  });

  it("pastes part of a cell into prose as an inline formula", () => {
    const table = editorOver(GRID);
    const copied = selectCells(table, [2, 0], [2, 3]);
    const prose = moveCursorToPosition(editorOver("hello"), 0, 5);
    const pasted = copyThenPaste(copied, prose);

    expect(
      serializeToMarkdown(pasted.state.document.page.blocks, undefined, {
        schema: appDataSchema,
      }),
    ).toBe("helloa $x$");
  });
});

// ─── Two peers ───────────────────────────────────────────────────────────────

const PAGE_ID = "cell-math";

/** A page imported once, opened by any peer, replayed in any arrival order. */
function replicatedPage(source: string) {
  const importer = createCRDTbinding(PAGE_ID, "importer");
  const importOps = blocksToOps(loadPage(source, appDataSchema).blocks, {
    pageId: PAGE_ID,
    peerId: importer.getPeerId(),
    nextId: importer.nextId,
    getClock: importer.getClock,
    schema: appDataSchema,
  });
  function replay(...batches: Operation[][]): Page {
    const engine = createSyncEngine(
      createCRDTbinding(PAGE_ID, "observer"),
      appDataSchema,
    );
    engine.loadOperations(importOps);
    for (const batch of batches) engine.apply(batch);
    return engine.getState();
  }
  function open(peerId: string): EditorState {
    const binding = createCRDTbinding(PAGE_ID, peerId);
    for (const op of importOps) binding.advanceClock(op.clock);
    return createInitialState(replay(), {
      schema: appSchema.data,
      nodes: createNodeRegistry(appSchema.nodes),
      marks: createMarkRegistry(appSchema.marks),
      crdtBinding: binding,
    });
  }
  return { replay, open };
}

function concurrently(
  source: string,
  first: (state: EditorState) => { state: EditorState; ops: Operation[] },
  second: (state: EditorState) => { state: EditorState; ops: Operation[] },
) {
  const page = replicatedPage(source);
  const a = first(page.open("peer-a"));
  const b = second(page.open("peer-b"));
  const oneWay = page.replay(a.ops, b.ops);
  const otherWay = page.replay(b.ops, a.ops);
  const table = (p: Page) => tableIn(p.blocks);
  // The whole block — the table's document and every formula beside it.
  expect(table(oneWay).structuredContent).toEqual(
    table(otherWay).structuredContent,
  );
  return { ...a.state, document: { ...a.state.document, page: oneWay } };
}

describe("two peers editing cells that hold formulas", () => {
  it("one pastes a formula while the other types in the same cell", () => {
    const merged = concurrently(
      GRID,
      (s) =>
        copyThenPaste(selectCells(s, [2, 0], [2, 3]), selectCells(s, [4, 3])),
      (s) => insertText(selectCells(s, [4, 0]), "Z"),
    );
    expect(cellsView(merged)[4]).toBe("Zonea [x]");
    expectOwnedFormulas(merged);
  });

  it("both paste the same formula: each keeps its own", () => {
    const paste = (s: EditorState) =>
      copyThenPaste(selectCells(s, [2, 0], [2, 3]), selectCells(s, [5, 3]));
    const merged = concurrently(GRID, paste, paste);
    expect(cellsView(merged)[5]).toBe("twoa [x]a [x]");
    expectOwnedFormulas(merged);
  });

  it("one removes a formula while the other inserts a row", () => {
    const merged = concurrently(
      GRID,
      (s) => {
        const at = selectCells(s, [2, 3]);
        return at.actionBus.dispatchState(DELETE_BACKWARD, at);
      },
      (s) => {
        const at = selectCells(s, [3, 0]);
        return at.actionBus.dispatchState(TABLE_INSERT_ROW, at, {
          side: "after",
        });
      },
    );
    expect(cellsView(merged)).toEqual([
      "A",
      "B",
      "a ",
      "[y]",
      "",
      "",
      "one",
      "two",
    ]);
    expectOwnedFormulas(merged);
  });
});
