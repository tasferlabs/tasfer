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
import { INSERT_MATH_COMMAND } from "@tasfer/math/actions";
import {
  getStructuredMathMarkSource,
  mathMarkContentId,
} from "@tasfer/math/data";
import { getTableDocument, readTable } from "@tasfer/table/structured";
import { cloneStructuredBlockContent } from "@tasfer/editor/actions/structured-marks";
import { loadPage, type Block } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import { serializeToText } from "@tasfer/editor/serlization/textSerializer";
import { rebuildState } from "@tasfer/editor/sync/reducer";
import { blocksToOps } from "@tasfer/editor/sync/snapshot-diff";
import {
  createCRDTbinding,
  createSyncEngine,
  type Operation,
} from "@tasfer/editor/sync/sync";
import type { Page } from "@tasfer/editor/serlization/loadPage";
import { TABLE_DELETE_ROW, TABLE_INSERT_ROW } from "@tasfer/table/commands";
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
  EXIT_BLOCK,
  SPLIT_BLOCK,
} from "@tasfer/editor/actions/edit-actions";
import {
  MOVE_CONTENT_TAB,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
  MOVE_TO_LINE_START,
} from "@tasfer/editor/actions/keyboard-actions";
import { runFieldAsParagraph } from "@tasfer/editor/text-field-paragraph";
import {
  activeTableContext,
  cellField,
  selectTableBlock,
} from "@tasfer/table/context";
import { resolveMarkRunsFromChars } from "@tasfer/editor/mark-runs";
import {
  createMarkRegistry,
  TOGGLE_MARK,
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

/**
 * Every math mark still showing in the table's cells, with the formula it
 * resolves to. A mark whose anchor was deleted is a removed formula — its
 * attachment goes with it, exactly as in a paragraph.
 */
function cellFormulas(block: Block): { contentId: string; latex: string }[] {
  const document = getTableDocument(block);
  if (!document) throw new Error("expected a table document");
  const found: { contentId: string; latex: string }[] = [];
  for (const row of readTable(document).rows) {
    for (const cell of row.cells) {
      const removed = new Set(
        [...iterateAllChars([...(cell?.textFields.text ?? [])])]
          .filter((char) => char.deleted)
          .map((char) => char.id),
      );
      for (const span of cell?.markFields?.text ?? []) {
        if (span.format.type !== "math") continue;
        if (removed.has(span.startCharId)) continue;
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

  it("types flush against the formula into it, as a paragraph does", () => {
    const state = editorOver(EDIT_SOURCE);
    expect(cellView(insertText(select(state, CHIP + 1), "z").state)).toBe(
      "a [xz] b",
    );
    expect(cellView(insertText(select(state, CHIP), "z").state)).toBe(
      "a [zx] b",
    );
    // A space is prose: it leaves the formula alone.
    expect(cellView(insertText(select(state, CHIP + 1), " ").state)).toBe(
      "a [x]  b",
    );
  });

  it("reaches into the formula with Backspace or Delete, as a paragraph does, and undo brings it back", () => {
    const state = editorOver(EDIT_SOURCE);
    for (const [action, at] of [
      [DELETE_BACKWARD, CHIP + 1],
      [DELETE_FORWARD, CHIP],
    ] as const) {
      const before = select(state, at);
      const result = before.actionBus.dispatchState(action, before);
      expect(cellView(result.state)).toBe("a [] b");

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

  it("removes a formula's attachment only after the cell drops its mark", () => {
    // Backspace until the formula is gone, gathering every op.
    let state = select(editorOver(EDIT_SOURCE), CHIP + 1);
    const ops: Operation[] = [];
    for (let press = 0; press < 4 && cellView(state).includes("["); press++) {
      const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
      state = result.state;
      ops.push(...result.ops);
    }
    expect(cellView(state)).toBe("a  b");
    const rootId = getTableDocument(
      tableIn(state.document.page.blocks),
    )!.rootId;
    const removed = ops.findIndex(
      (op) =>
        op.op === "content_edit" &&
        op.contentId !== rootId &&
        op.edit.kind === "document_delete",
    );
    expect(removed).toBeGreaterThan(-1);
    // Nothing touches the cell after its formula's attachment is gone.
    expect(
      ops
        .slice(removed + 1)
        .some((op) => op.op === "content_edit" && op.contentId === rootId),
    ).toBe(false);
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

// ─── Typing a formula ────────────────────────────────────────────────────────

const TYPE_SOURCE = ["| A |", "| --- |", "| q |"].join("\n");

/** Type `text` one keystroke at a time, the way a keyboard does. */
function typeIn(state: EditorState, text: string, literal = false) {
  const ops: Operation[] = [];
  for (const char of text) {
    const result = insertText(
      state,
      char,
      literal ? { inlineMarkdown: false } : undefined,
    );
    state = result.state;
    ops.push(...result.ops);
  }
  return { state, ops };
}

describe("typing a formula in a cell", () => {
  it("turns a typed `$x$` into a formula, the way a paragraph does", () => {
    const typed = typeIn(select(editorOver(TYPE_SOURCE), 1), "$x$");
    expect(cellView(typed.state)).toBe("q[x]");
    expectOwnedFormulas(typed.state);

    // The caret lands after the formula, where a letter continues it — the
    // same as in a paragraph — and a space leaves it.
    expect(cellView(insertText(typed.state, "z").state)).toBe("q[xz]");
    expect(cellView(insertText(typed.state, " ").state)).toBe("q[x] ");
    expect(
      serializeToMarkdown(typed.state.document.page.blocks, undefined, {
        schema: appDataSchema,
      }),
    ).toBe(["| A |", "| --- |", "| q$x$ |"].join("\n"));
  });

  it("also takes the euro alias", () => {
    const typed = typeIn(select(editorOver(TYPE_SOURCE), 1), "\u20acx\u20ac");
    expect(cellView(typed.state)).toBe("q[x]");
  });

  it("rebuilds the typed formula from the operations alone", () => {
    const start = select(editorOver(TYPE_SOURCE), 1);
    const typed = typeIn(start, "$x$");
    let page = start.document.page;
    for (const op of typed.ops) page = applyOp(page, op, appSchema.data);
    const replica = {
      ...typed.state,
      document: { ...typed.state.document, page },
    };
    expect(cellView(replica)).toBe("q[x]");
    expectOwnedFormulas(replica);
  });

  it("undo of the closing `$` gives the typed source back", () => {
    const before = typeIn(select(editorOver(TYPE_SOURCE), 1), "$x").state;
    const closed = insertText(before, "$");
    expect(cellView(closed.state)).toBe("q[x]");
    const inverses = invertOperations(
      closed.ops,
      before.document.page,
      (page, op) => applyOp(page, op, appSchema.data),
      before.CRDTbinding,
      appSchema.data,
    );
    let page = closed.state.document.page;
    for (const op of inverses) page = applyOp(page, op, appSchema.data);
    expect(
      cellView({
        ...closed.state,
        document: { ...closed.state.document, page },
      }),
    ).toBe("q$x");
  });

  it("wraps a selection in a formula when `$` is typed over it", () => {
    const state = select(editorOver(TYPE_SOURCE), 0, 1);
    const wrapped = insertText(state, "$", { wrapSelection: true });
    expect(cellView(wrapped.state)).toBe("[q]");
    expectOwnedFormulas(wrapped.state);
  });

  it("keeps dollars literal when inline markdown is off", () => {
    const typed = typeIn(select(editorOver(TYPE_SOURCE), 1), "$x$", true);
    expect(cellView(typed.state)).toBe("q$x$");
  });

  it("types a second formula beside the first, each with its own attachment", () => {
    const typed = typeIn(select(editorOver(EDIT_SOURCE), 5), " $y$");
    expect(cellView(typed.state)).toBe("a [x] b [y]");
    expectOwnedFormulas(typed.state);
  });
});

// ─── The Math button in a cell ───────────────────────────────────────────────

function toggleMath(state: EditorState) {
  return state.actionBus.dispatchState(TOGGLE_MARK, state, { name: "math" });
}

describe("turning on math in a cell, as the Math button does", () => {
  it("turns the selected text into a formula", () => {
    const toggled = toggleMath(select(editorOver(TYPE_SOURCE), 0, 1));
    expect(cellView(toggled.state)).toBe("[q]");
    expectOwnedFormulas(toggled.state);
    expect(
      serializeToMarkdown(toggled.state.document.page.blocks, undefined, {
        schema: appDataSchema,
      }),
    ).toBe(["| A |", "| --- |", "| $q$ |"].join("\n"));
  });

  it("turns part of a cell into a formula and keeps the rest as text", () => {
    const source = ["| A |", "| --- |", "| a+b = c |"].join("\n");
    const toggled = toggleMath(select(editorOver(source), 0, 3));
    expect(cellView(toggled.state)).toBe("[a+b] = c");
    expectOwnedFormulas(toggled.state);
  });

  it("rebuilds the new formula from the operations alone", () => {
    const start = select(editorOver(TYPE_SOURCE), 0, 1);
    const toggled = toggleMath(start);
    let page = start.document.page;
    for (const op of toggled.ops) page = applyOp(page, op, appSchema.data);
    const replica = {
      ...toggled.state,
      document: { ...toggled.state.document, page },
    };
    expect(cellView(replica)).toBe("[q]");
    expectOwnedFormulas(replica);
  });

  it("undo gives the plain text back", () => {
    const start = select(editorOver(TYPE_SOURCE), 0, 1);
    const toggled = toggleMath(start);
    const inverses = invertOperations(
      toggled.ops,
      start.document.page,
      (page, op) => applyOp(page, op, appSchema.data),
      start.CRDTbinding,
      appSchema.data,
    );
    let page = toggled.state.document.page;
    for (const op of inverses) page = applyOp(page, op, appSchema.data);
    expect(
      cellView({ ...toggled.state, document: { ...toggled.state.document, page } }),
    ).toBe("q");
  });

  it("at a bare caret, makes what is typed next a formula", () => {
    const armed = toggleMath(select(editorOver(TYPE_SOURCE), 1));
    expect(armed.ops).toEqual([]);
    const typed = typeIn(armed.state, "x");
    expect(cellView(typed.state)).toBe("q[x]");
    expectOwnedFormulas(typed.state);
  });

  it("does nothing over a range across cells", () => {
    const state = selectCells(editorOver(GRID), [2, 0], [3, 3]);
    const toggled = toggleMath(state);
    expect(toggled.ops).toEqual([]);
    expect(cellsView(toggled.state)).toEqual(cellsView(state));
    expect(toggled.state.ui.activeMarksMode).toEqual(state.ui.activeMarksMode);
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

  it("puts a pasted formula's mark on once", () => {
    const state = editorOver(GRID);
    const copied = selectCells(state, [2, 0], [2, 3]);
    const pasted = copyThenPaste(copied, selectCells(state, [4, 3]));
    const formulaMarks = pasted.ops.filter(
      (op) =>
        op.op === "content_edit" &&
        op.edit.kind === "mark_set" &&
        op.edit.value &&
        op.edit.mark.type === "math",
    );
    expect(formulaMarks).toHaveLength(1);
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

  it("one types a formula while the other types in the same cell", () => {
    const merged = concurrently(
      GRID,
      (s) => typeIn(selectCells(s, [4, 3]), "$z$"),
      (s) => insertText(selectCells(s, [4, 0]), "Z"),
    );
    expect(cellsView(merged)[4]).toBe("Zone[z]");
    expectOwnedFormulas(merged);
  });

  it("one removes a formula while the other inserts a row", () => {
    const merged = concurrently(
      GRID,
      (s) => {
        // As in a paragraph, the first Backspace empties the one-symbol
        // formula and the second takes the empty formula away.
        const at = selectCells(s, [2, 3]);
        const first = at.actionBus.dispatchState(DELETE_BACKWARD, at);
        const second = first.state.actionBus.dispatchState(
          DELETE_BACKWARD,
          first.state,
        );
        return { state: second.state, ops: [...first.ops, ...second.ops] };
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

// ─── Editing inside a formula ────────────────────────────────────────────────

type Key = readonly [string, (state: EditorState) => StateStep];
type StateStep = { state: EditorState; ops: Operation[] };

const press =
  (action: typeof MOVE_CURSOR_LEFT): Key[1] =>
  (state) =>
    state.actionBus.dispatchState(action, state);
const typed =
  (text: string): Key[1] =>
  (state) =>
    insertText(state, text);

/** Run `keys` in order, gathering every op. */
function run(state: EditorState, keys: readonly Key[]) {
  const ops: Operation[] = [];
  const steps: { inside: boolean; text: string }[] = [];
  for (const [, key] of keys) {
    const result = key(state);
    state = result.state;
    ops.push(...result.ops);
    steps.push({ inside: insideFormula(state), text: "" });
  }
  return { state, ops, steps };
}

/** Whether the caret is in a formula's own tree, not the surrounding text. */
function insideFormula(state: EditorState): boolean {
  const focus = state.document.contentSelection?.focus;
  if (!focus) return false;
  const block = state.document.page.blocks.find((b) => b.id === focus.blockId);
  return block?.structuredContent?.[focus.contentId]?.kind === "math";
}

/** The body cell's Markdown, or a lone paragraph's. */
function proseOf(state: EditorState): string {
  const markdown = serializeToMarkdown(state.document.page.blocks, undefined, {
    schema: appDataSchema,
  });
  const line = markdown.split("\n").at(-1) ?? "";
  return line.startsWith("| ") ? line.slice(2, -2) : line;
}

/** The body cell with the caret just after its formula (`a [x]| b`). */
function afterCellFormula(): EditorState {
  return select(editorOver(EDIT_SOURCE), CHIP + 1);
}

/** The same text as a paragraph, caret just after its formula. */
function afterParagraphFormula(): EditorState {
  return moveCursorToPosition(editorOver("a $x$ b"), 0, CHIP + 1);
}

/** Every step, as Markdown and where the caret is. */
function trace(state: EditorState, keys: readonly Key[]) {
  const out: string[] = [];
  for (const [name, key] of keys) {
    state = key(state).state;
    out.push(
      `${name} → ${proseOf(state)}${insideFormula(state) ? " (in formula)" : ""}`,
    );
  }
  return out;
}

describe("editing inside a cell's formula, as a paragraph does", () => {
  const keys: Key[] = [
    ["←", press(MOVE_CURSOR_LEFT)],
    ["y", typed("y")],
    ["^", typed("^")],
    ["2", typed("2")],
    ["⌫", press(DELETE_BACKWARD)],
    ["→", press(MOVE_CURSOR_RIGHT)],
    ["→", press(MOVE_CURSOR_RIGHT)],
    ["→", press(MOVE_CURSOR_RIGHT)],
    ["z", typed("z")],
  ];

  it("enters, edits the tree and leaves exactly as a paragraph's formula", () => {
    const cell = trace(afterCellFormula(), keys);
    expect(cell).toEqual(trace(afterParagraphFormula(), keys));
    // Spot-check the shared answer, so the comparison is about something.
    expect(cell[0]).toBe("← → a $x$ b (in formula)");
    expect(cell[3]).toBe("2 → a $x{y}^{2}$ b (in formula)");
    expect(cell.at(-1)).toBe("z → a $x{y}^{}$ zb");
  });

  it("starts typing into the formula from Home, as a paragraph does", () => {
    const home: Key[] = [
      ["←", press(MOVE_CURSOR_LEFT)],
      ["Home", press(MOVE_TO_LINE_START)],
      ["q", typed("q")],
    ];
    expect(trace(afterCellFormula(), home)).toEqual(
      trace(afterParagraphFormula(), home),
    );
  });

  it("rebuilds the edits inside the formula from the operations alone", () => {
    const start = afterCellFormula();
    const edited = run(start, keys.slice(0, 4));
    let page = start.document.page;
    for (const op of edited.ops) page = applyOp(page, op, appSchema.data);
    const replica = {
      ...edited.state,
      document: { ...edited.state.document, page },
    };
    expect(proseOf(replica)).toBe("a $x{y}^{2}$ b");
    // Every op addresses the real table block, never the stand-in paragraph.
    const tableId = tableIn(start.document.page.blocks).id;
    expect(
      edited.ops.every((op) => "blockId" in op && op.blockId === tableId),
    ).toBe(true);
  });

  it("undoes a keystroke inside the formula", () => {
    const inside = run(afterCellFormula(), keys.slice(0, 1)).state;
    const typedY = insertText(inside, "y");
    expect(proseOf(typedY.state)).toBe("a $xy$ b");
    const inverses = invertOperations(
      typedY.ops,
      inside.document.page,
      (page, op) => applyOp(page, op, appSchema.data),
      inside.CRDTbinding,
      appSchema.data,
    );
    let page = typedY.state.document.page;
    for (const op of inverses) page = applyOp(page, op, appSchema.data);
    expect(
      proseOf({
        ...typedY.state,
        document: { ...typedY.state.document, page },
      }),
    ).toBe("a $x$ b");
  });

  it("pastes into the formula and copies from it, as a paragraph does", () => {
    const pasteIn = (state: EditorState) => {
      const inside = press(MOVE_CURSOR_LEFT)(state).state;
      const pasted = pasteFromClipboardEvent(inside, {} as ClipboardEvent, {
        text: "z",
        html: "",
        imageFile: null,
      });
      return pasted ? proseOf(pasted.state) : "<not pasted>";
    };
    expect(pasteIn(afterCellFormula())).toBe("a $xz$ b");
    expect(pasteIn(afterCellFormula())).toBe(pasteIn(afterParagraphFormula()));
  });

  it("keeps Tab inside the formula instead of moving to the next cell", () => {
    const inside = run(afterCellFormula(), keys.slice(0, 1)).state;
    const tabbed = inside.actionBus.dispatchState(MOVE_CONTENT_TAB, inside, {
      backward: false,
    }).state;
    expect(insideFormula(tabbed)).toBe(true);
    expect(tabbed.document.contentSelection?.focus.contentId).toBe(
      inside.document.contentSelection?.focus.contentId,
    );
  });

  it("moves down a row on Enter inside the formula, as Enter anywhere in the cell does", () => {
    // A paragraph's Enter in a formula leaves it and splits the block; a cell
    // cannot split, so Enter leaves the formula and moves down a row.
    const enter = (state: EditorState) => {
      const result = state.actionBus.dispatchState(SPLIT_BLOCK, state);
      const focus = result.state.document.contentSelection?.focus;
      return {
        markdown: serializeToMarkdown(
          result.state.document.page.blocks,
          undefined,
          {
            schema: appDataSchema,
          },
        ),
        inside: insideFormula(result.state),
        cell: focus?.kind === "text" ? focus.nodeId : undefined,
      };
    };
    const inside = run(afterCellFormula(), keys.slice(0, 1)).state;
    expect(insideFormula(inside)).toBe(true);
    const fromFormula = enter(inside);
    expect(fromFormula).toEqual(enter(afterCellFormula()));
    expect(fromFormula.inside).toBe(false);
    expect(fromFormula.cell).not.toBe(bodyCell(inside).cell.id);
    expect(fromFormula.markdown).toContain("| a $x$ b |");
  });

  it("leaves the table on Shift+Enter inside the formula, as it does from the cell", () => {
    const inside = run(afterCellFormula(), keys.slice(0, 1)).state;
    const exit = (state: EditorState) => {
      const result = state.actionBus.dispatchState(EXIT_BLOCK, state).state;
      return {
        markdown: serializeToMarkdown(result.document.page.blocks, undefined, {
          schema: appDataSchema,
        }),
        nested: result.document.contentSelection !== null,
        cursor: result.document.cursor?.position,
      };
    };
    expect(exit(inside)).toEqual(exit(afterCellFormula()));
    expect(exit(inside).nested).toBe(false);
  });

  it("does not hold the whole table on Backspace at a formula in the first cell", () => {
    const source = ["| $x$ a |", "| --- |", "| b |"].join("\n");
    const state = editorOver(source);
    const block = tableIn(state.document.page.blocks);
    const document = getTableDocument(block)!;
    const first = tableCellIds(document)[0];
    const atStart = updateContentSelection(
      state,
      tableCaretToContentSelection(document, block.id, {
        cellId: first,
        offset: 0,
      })!,
    );
    const entered = press(MOVE_CURSOR_RIGHT)(atStart).state;
    expect(insideFormula(entered)).toBe(true);
    const deleted = press(DELETE_BACKWARD)(entered).state;
    // Still editing in the table, not holding the block as a node selection.
    expect(deleted.document.contentSelection).not.toBeNull();
    expect(deleted.document.selection).toBeNull();
  });

  it("completes a typed `\\fra` from the command menu, as a paragraph does", () => {
    // What the menu's Enter (or click) dispatches for `\frac`.
    const complete = (state: EditorState) => {
      let inside = press(MOVE_CURSOR_LEFT)(state).state;
      for (const char of String.raw`\fra`)
        inside = insertText(inside, char).state;
      const result = inside.actionBus.dispatchState(
        INSERT_MATH_COMMAND,
        inside,
        {
          text: String.raw`\frac{}{}`,
          caretOffset: 6,
          trigger: "\\",
        },
      );
      return {
        claimed: result.claimed,
        prose: proseOf(result.state),
        inside: insideFormula(result.state),
      };
    };
    const cell = complete(afterCellFormula());
    expect(cell).toEqual(complete(afterParagraphFormula()));
    expect(cell).toEqual({
      claimed: true,
      prose: String.raw`a $x\frac{}{}$ b`,
      inside: true,
    });
  });

  it("hides the page's formula hover from the cell's paragraph code and keeps it after", () => {
    // Hover names page blocks by index; on the stand-in, index 0 is the cell.
    const hover = { blockIndex: 0, startIndex: CHIP, endIndex: CHIP + 1 };
    const base = afterCellFormula();
    const state = {
      ...base,
      ui: { ...base.ui, inlineMathHover: hover, hoveredMathBlockIndex: 0 },
    };
    const { block, document, cell } = bodyCell(state);
    let seen: unknown = "not run";
    const result = runFieldAsParagraph(
      state,
      cellField({ block, document }, cell.id),
      { anchor: CHIP + 1, focus: CHIP + 1 },
      (paragraph) => {
        seen = [
          paragraph.ui.inlineMathHover,
          paragraph.ui.hoveredMathBlockIndex,
        ];
        return { state: paragraph, ops: [] };
      },
    );
    expect(seen).toEqual([null, null]);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.state.ui.inlineMathHover).toEqual(hover);
    expect(result.state.ui.hoveredMathBlockIndex).toBe(0);
  });

  it("refuses a caret inside an attachment the cell does not point at", () => {
    const state = editorOver(GRID);
    const block = tableIn(state.document.page.blocks);
    const document = getTableDocument(block)!;
    const [, , , withY] = tableCellIds(document);
    // Enter the formula in the `a $x$` cell, then lend that caret to `$y$`'s.
    const inX = press(MOVE_CURSOR_LEFT)(selectCells(state, [2, 3])).state;
    expect(insideFormula(inX)).toBe(true);
    const result = runFieldAsParagraph(
      inX,
      cellField({ block, document }, withY),
      { anchor: 0, focus: 0, content: inX.document.contentSelection! },
      (paragraph) => insertText(paragraph, "q"),
    );
    expect(result).toEqual({ kind: "refused", reason: "missing" });
  });
});

describe("two peers editing inside a cell's formula", () => {
  it("one types in the formula while the other types in the same cell", () => {
    const merged = concurrently(
      GRID,
      (s) => {
        const inside = press(MOVE_CURSOR_LEFT)(selectCells(s, [2, 3])).state;
        return insertText(inside, "w");
      },
      (s) => insertText(selectCells(s, [2, 0]), "Z"),
    );
    expect(cellsView(merged)[2]).toBe("Za [xw]");
    expectOwnedFormulas(merged);
  });
});

// ─── Nothing is lost ────────────────────────────────────────────────────────

type Step = { state: EditorState; ops: Operation[] };

/** Undo `step` (taken from `before`) the way history does: inverse ops. */
function undoStep(before: EditorState, step: Step): Step {
  const ops = invertOperations(
    step.ops,
    before.document.page,
    (page, op) => applyOp(page, op, appSchema.data),
    before.CRDTbinding,
    appSchema.data,
  );
  let page = step.state.document.page;
  for (const op of ops) page = applyOp(page, op, appSchema.data);
  return {
    state: { ...step.state, document: { ...step.state.document, page } },
    ops,
  };
}

function markdownOf(state: EditorState): string {
  return serializeToMarkdown(state.document.page.blocks, undefined, {
    schema: appDataSchema,
  });
}

/** Rebuild the page from `ops` alone, on top of `start`. */
function replayed(start: EditorState, ...steps: Step[]): string {
  let page = start.document.page;
  for (const step of steps)
    for (const op of step.ops) page = applyOp(page, op, appSchema.data);
  return markdownOf({ ...start, document: { ...start.document, page } });
}

describe("formulas in cells survive undo, deletes, export and reload", () => {
  it("undo of clearing a range across formula cells brings every formula back", () => {
    const start = editorOver(GRID);
    const range = selectCells(start, [2, 0], [3, 1]);
    const cleared = range.actionBus.dispatchState(DELETE_BACKWARD, range);
    expect(cellsView(cleared.state).slice(2, 4)).toEqual(["", ""]);
    const undone = undoStep(range, cleared);
    expect(markdownOf(undone.state)).toBe(markdownOf(start));
    expect(replayed(start, cleared, undone)).toBe(markdownOf(start));
  });

  it("undo of typing over a range across formula cells brings every formula back", () => {
    const start = editorOver(GRID);
    const range = selectCells(start, [2, 0], [3, 1]);
    const typedOver = insertText(range, "Q");
    expect(cellsView(typedOver.state).slice(2, 4)).toEqual(["Q", ""]);
    const undone = undoStep(range, typedOver);
    expect(markdownOf(undone.state)).toBe(markdownOf(start));
    expect(replayed(start, typedOver, undone)).toBe(markdownOf(start));
  });

  it("undo of typing over a range inside one cell that covers its formula", () => {
    const start = editorOver(GRID);
    const range = selectCells(start, [2, 0], [2, 3]);
    const typedOver = insertText(range, "Q");
    expect(cellsView(typedOver.state)[2]).toBe("Q");
    const undone = undoStep(range, typedOver);
    expect(markdownOf(undone.state)).toBe(markdownOf(start));
    expect(replayed(start, typedOver, undone)).toBe(markdownOf(start));
  });

  it("undo of deleting a row with formulas brings them back", () => {
    const start = editorOver(GRID);
    const at = selectCells(start, [2, 1]);
    const deleted = at.actionBus.dispatchState(TABLE_DELETE_ROW, at, {});
    expect(markdownOf(deleted.state)).not.toContain("$x$");
    const undone = undoStep(at, deleted);
    expect(markdownOf(undone.state)).toBe(markdownOf(start));
    expect(replayed(start, deleted, undone)).toBe(markdownOf(start));
  });

  it("undo of deleting the whole table brings its formulas back", () => {
    const start = editorOver(GRID);
    const at = selectCells(start, [0, 0]);
    const held = selectTableBlock(at, activeTableContext(at)!).state;
    const deleted = held.actionBus.dispatchState(DELETE_BACKWARD, held);
    expect(markdownOf(deleted.state)).not.toContain("$x$");
    const undone = undoStep(held, deleted);
    expect(markdownOf(undone.state)).toBe(markdownOf(start));
  });

  it("exports formulas as LaTeX in Markdown, plain text and HTML", () => {
    const start = editorOver(GRID);
    expect(markdownOf(start)).toContain("| a $x$ | $y$ |");
    const text = serializeToText(start.document.page.blocks, {
      schema: appDataSchema,
    });
    expect(text).toContain("x");
    expect(text).toContain("y");
    const held = selectTableBlock(
      selectCells(start, [0, 0]),
      activeTableContext(selectCells(start, [0, 0]))!,
    ).state;
    const payload = buildClipboardPayload(held)!;
    expect(payload.plainText).toContain("$x$");
    expect(payload.html).toMatch(/x/);
    expect(payload.html).not.toMatch(/￼/);
    // A copied table pastes back with its formulas.
    const target = moveCursorToPosition(editorOver("after"), 0, 5);
    const pasted = pasteFromClipboardEvent(target, {} as ClipboardEvent, {
      text: payload.plainText,
      html: payload.html,
      imageFile: null,
    })!;
    expect(markdownOf(pasted.state)).toContain("$x$");
    expect(markdownOf(pasted.state)).toContain("$y$");
  });

  it("reloads a page edited every way from its operations alone", () => {
    const start = editorOver(GRID);
    const steps: Step[] = [];
    let s = start;
    const step = (r: Step) => {
      steps.push(r);
      s = r.state;
    };
    step(typeIn(selectCells(s, [4, 3]), "$z$"));
    step(insertText(selectCells(s, [2, 0]), "k"));
    step(copyThenPaste(selectCells(s, [3, 0], [3, 1]), selectCells(s, [5, 3])));
    const live = markdownOf(s);
    expect(live).toContain("$z$");
    expect(replayed(start, ...steps)).toBe(live);
    // And back through Markdown.
    expect(markdownOf(editorOver(live))).toBe(live);
  });

  it("two peers: one deletes a formula's cell row while the other edits inside the formula", () => {
    const merged = concurrently(
      GRID,
      (s) => {
        const at = selectCells(s, [2, 1]);
        return at.actionBus.dispatchState(TABLE_DELETE_ROW, at, {});
      },
      (s) => {
        const inside = press(MOVE_CURSOR_LEFT)(selectCells(s, [2, 3])).state;
        return insertText(inside, "w");
      },
    );
    // The row is gone on both sides alike (convergence asserted by `concurrently`).
    expect(markdownOf(merged)).not.toContain("$x");
  });

  it("two peers: one clears a formula cell while the other types inside the formula", () => {
    const merged = concurrently(
      GRID,
      (s) => {
        const range = selectCells(s, [2, 0], [2, 3]);
        return range.actionBus.dispatchState(DELETE_BACKWARD, range);
      },
      (s) => {
        const inside = press(MOVE_CURSOR_LEFT)(selectCells(s, [2, 3])).state;
        return insertText(inside, "w");
      },
    );
    expectOwnedFormulas(merged);
    // Whatever survives must still render: no mark without its formula.
    expect(cellsView(merged).join("|")).not.toContain("missing");
  });
});
