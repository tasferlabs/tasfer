/**
 * Pasting into a table: a copied grid spreads across cells, the way it does in
 * a spreadsheet.
 *
 * Core offers every paste that lands in a nested selection to the kind that
 * owns it (`StructuredKindSpec.paste`). What the clipboard holds decides what
 * happens:
 *
 *   - **A grid** — cells copied from a table here (whose rich flavor carries a
 *     GFM table), or rows and columns from a spreadsheet (tab-separated text).
 *     Its top-left cell lands on the top-left cell of the selection, or on the
 *     caret's cell, and every cell it covers is REPLACED: pasting a column over
 *     a column overwrites it, it does not insert a new one. When the grid runs
 *     past the table's last row or column, the table grows to fit — dropping
 *     what does not fit would silently lose part of the paste. The pasted block
 *     is left selected, so it can be pasted again, cut or formatted.
 *   - **One cell's worth** — text with no tab or line break, or a partial cell
 *     copied here. It goes in at the caret like typing, replacing any selected
 *     range, and keeps its own formatting when it came from Tasfer.
 *
 * Formatting only survives a copy made in Tasfer: that is the only clipboard
 * whose Markdown core hands over, and plain text from elsewhere is taken as
 * literal characters — a spreadsheet cell reading `*.ts` must not paste italic.
 */

import { insertColumn, insertRow } from "./commands";
import {
  activeTableContext,
  commitTableEdits,
  type TableContext,
} from "./context";
import {
  charIdBefore,
  clearRange,
  firstSelectedMarks,
  insertedMarkEdits,
} from "./input";
import { cellSeedFromMarkdown, matchGfmTable } from "./markdown";
import {
  cellPosition,
  cellRect,
  cellRuns,
  type TableCaret,
  tableRangeToContentSelection,
} from "./selection";
import {
  CELL_NODE,
  CELL_TEXT_FIELD,
  cellRunsFromText,
  CELLS_SLOT,
  getTableDocument,
  readTable,
  type TableCellSeed,
} from "./structured";
import type { StateResult } from "@tasfer/editor/action-bus";
import type { ContentSelectionPasteCtx } from "@tasfer/editor/feature-facets";
import { inheritedMarksInText } from "@tasfer/editor/mark-edge";
import { clearSelection } from "@tasfer/editor/selection";
import type {
  CharRun,
  Mark,
  MarkSpan,
} from "@tasfer/editor/serlization/loadPage";
import type { EditorState } from "@tasfer/editor/state-types";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import {
  getCharIdsInRangeFromRuns,
  getVisibleTextFromRuns,
} from "@tasfer/editor/sync/char-runs";
import { generateKeyBetween } from "@tasfer/editor/sync/fractional-index";
import { areMarksEqual } from "@tasfer/editor/sync/mark-spans";
import {
  applyStructuredEdits,
  getStructuredMarks,
  type StructuredDocument,
  type StructuredEdit,
} from "@tasfer/editor/sync/structured-content";

/** What a clipboard means to a table. */
export type TableClipboard =
  /** Rows of cells; `rich` sources are inline Markdown, plain ones literal. */
  | {
      readonly kind: "grid";
      readonly rows: readonly (readonly string[])[];
      readonly rich: boolean;
    }
  /** Text for the caret's cell alone. */
  | {
      readonly kind: "inline";
      readonly source: string;
      readonly rich: boolean;
    };

/**
 * Split spreadsheet text into rows of cells.
 *
 * Tabs separate cells and line breaks separate rows — what Excel, Numbers and
 * Google Sheets put on the clipboard, and what a table here copies as. A cell
 * that holds a tab, a line break or a quote is written in double quotes with
 * inner quotes doubled; only a quote at the very start of a cell opens one, so
 * ordinary text with a `"` in it stays literal. A line break inside a quoted
 * cell becomes a space, because a cell holds one line. The one trailing line
 * break spreadsheets append is not an empty last row.
 */
export function parseClipboardGrid(text: string): string[][] {
  const source = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let at = 0;
  for (;;) {
    const quoted = source[at] === '"' ? readQuotedCell(source, at) : undefined;
    let cell: string;
    if (quoted) {
      cell = quoted.text;
      at = quoted.end;
    } else {
      const start = at;
      while (at < source.length && source[at] !== "\t" && source[at] !== "\n") {
        at++;
      }
      cell = source.slice(start, at);
    }
    row.push(cell);
    if (at >= source.length) break;
    if (source[at] === "\n") {
      rows.push(row);
      row = [];
    }
    at++;
  }
  rows.push(row);
  return rows;
}

/**
 * A double-quoted cell starting at `start`: its text, and the index just past
 * the closing quote. `undefined` unless the quote closes right before a
 * separator or the end — anything else is a literal quote in an ordinary cell.
 */
function readQuotedCell(
  source: string,
  start: number,
): { readonly text: string; readonly end: number } | undefined {
  let text = "";
  for (let at = start + 1; at < source.length; at++) {
    if (source[at] !== '"') {
      text += source[at];
      continue;
    }
    if (source[at + 1] === '"') {
      text += '"';
      at++;
      continue;
    }
    const after = source[at + 1];
    if (after !== undefined && after !== "\t" && after !== "\n")
      return undefined;
    return { text: text.replace(/\n/g, " "), end: at + 1 };
  }
  return undefined;
}

/**
 * Read a paste's flavors as a table sees them. `undefined` when there is
 * nothing to paste at all.
 */
export function readTableClipboard(
  text: string,
  markdown: string | undefined,
): TableClipboard | undefined {
  if (markdown !== undefined) {
    const source = markdown.replace(/\n+$/, "");
    const table = matchGfmTable(source, 0);
    if (table && table.length === source.length) {
      const { rows } = table.table;
      return rows.length === 1 && rows[0].length === 1
        ? { kind: "inline", source: rows[0][0], rich: true }
        : { kind: "grid", rows, rich: true };
    }
    // One paragraph of inline Markdown is one cell's worth, formatted.
    if (source !== "" && !source.includes("\n")) {
      return { kind: "inline", source, rich: true };
    }
  }
  if (text === "") return undefined;
  if (!/[\t\n\r]/.test(text))
    return { kind: "inline", source: text, rich: false };
  const rows = parseClipboardGrid(text);
  return rows.length === 1 && rows[0].length === 1
    ? { kind: "inline", source: rows[0][0], rich: false }
    : { kind: "grid", rows, rich: false };
}

/** The structured-kind paste adapter the interactive table bundle installs. */
export function tableContentPaste(
  ctx: ContentSelectionPasteCtx,
): StateResult | undefined {
  const { state } = ctx;
  if (state.ui.composition) return undefined;
  const context = activeTableContext(state);
  if (!context || context.document.rootId !== ctx.document.rootId) {
    return undefined;
  }
  const clipboard = readTableClipboard(ctx.text, ctx.markdown);
  if (!clipboard) return undefined;
  return clipboard.kind === "grid"
    ? pasteGrid(state, context, clipboard.rows, clipboard.rich)
    : pasteInline(state, context, clipboard.source, clipboard.rich);
}

/** Cell content for one clipboard source, with identities from the document. */
function seedFor(
  state: EditorState,
  source: string,
  rich: boolean,
): TableCellSeed {
  if (!rich) return { charRuns: cellRunsFromText(source, state.CRDTbinding) };
  const seed = cellSeedFromMarkdown(source, state.CRDTbinding);
  // A cell never carries a structured mark (see `./marks`), so one arriving
  // from elsewhere is dropped rather than stranded without its attachment.
  return {
    charRuns: seed.charRuns,
    marks: seed.marks?.filter(
      (range) => !state.schema.structuredMark(range.format.type),
    ),
  };
}

/** The ids of a seed's characters, in order. */
function seedCharIds(runs: readonly CharRun[]): string[] {
  return runs.flatMap((run) =>
    Array.from(
      { length: run.text.length },
      (_unused, at) => `${run.peerId}:${run.startCounter + at}`,
    ),
  );
}

/** The marks each character of a seed carries, by position. */
function seedMarksByChar(
  seed: TableCellSeed,
  ids: readonly string[],
): Mark[][] {
  const byChar: Mark[][] = ids.map(() => []);
  const index = new Map(ids.map((id, at) => [id, at]));
  for (const range of seed.marks ?? []) {
    const start = index.get(range.startCharId);
    const end = index.get(range.endCharId);
    if (start === undefined || end === undefined) continue;
    for (let at = start; at <= end; at++) byChar[at].push(range.format);
  }
  return byChar;
}

/** Whether two characters' mark sets are the same set. */
function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return (
    a.length === b.length &&
    a.every((mark) => b.some((other) => areMarksEqual(other, mark)))
  );
}

/**
 * Paste one cell's worth at the caret: the same transaction typing makes —
 * replace the selection, insert, give the new characters their marks — but with
 * each run of the pasted text formatted as it was copied. Plain text from
 * elsewhere takes the marks typing there would, as it does in a paragraph.
 */
function pasteInline(
  state: EditorState,
  context: TableContext,
  source: string,
  rich: boolean,
): StateResult | undefined {
  const replacedMarks = firstSelectedMarks(state, context);
  const cleared = clearRange(context);
  const edits: StructuredEdit[] = cleared ? [...cleared.edits] : [];
  const caret = cleared?.caret ?? context.caret;
  const seed = seedFor(state, source, rich);
  const ids = seedCharIds(seed.charRuns);
  if (ids.length === 0) {
    return edits.length > 0
      ? commitTableEdits(state, context, edits, caret)
      : undefined;
  }

  const document =
    edits.length > 0
      ? applyStructuredEdits(context.document, edits)
      : context.document;
  const runs = cellRuns(document, caret.cellId);
  if (!runs) return undefined;
  edits.push({
    kind: "text_insert",
    nodeId: caret.cellId,
    field: CELL_TEXT_FIELD,
    afterCharId: charIdBefore(runs, caret.offset),
    charRuns: [...seed.charRuns],
  });
  const typed = applyStructuredEdits(context.document, edits);

  if (rich) {
    // One mark pass per run of equally-formatted characters, so each run gets
    // exactly its own marks and sheds any the surrounding text would lend it.
    const byChar = seedMarksByChar(seed, ids);
    let start = 0;
    for (let at = 1; at <= ids.length; at++) {
      if (at < ids.length && sameMarks(byChar[at], byChar[start])) continue;
      edits.push(
        ...insertedMarkEdits(
          state,
          typed,
          { cellId: caret.cellId, offset: caret.offset + start },
          ids.slice(start, at),
          byChar[start],
        ),
      );
      start = at;
    }
  } else {
    const wanted =
      state.ui.activeMarksMode.type === "explicit"
        ? state.ui.activeMarksMode.formats
        : (replacedMarks ??
          inheritedMarksInText(
            state,
            runs,
            getStructuredMarks(
              document,
              caret.cellId,
              CELL_TEXT_FIELD,
            ) as MarkSpan[],
            caret.offset,
          ));
    edits.push(...insertedMarkEdits(state, typed, caret, ids, wanted));
  }

  return commitTableEdits(state, context, edits, {
    cellId: caret.cellId,
    offset: caret.offset + ids.length,
  });
}

/**
 * Grow `document` until it has at least `rows` rows and `columns` columns,
 * adding them after the last ones. Returns the edits and the grown document.
 */
function growTable(
  state: EditorState,
  document: StructuredDocument,
  rows: number,
  columns: number,
): { edits: StructuredEdit[]; document: StructuredDocument } | undefined {
  const edits: StructuredEdit[] = [];
  let grown = document;
  for (;;) {
    const view = readTable(grown);
    const command =
      view.columns.length < columns
        ? insertColumn(
            grown,
            state.CRDTbinding,
            view.columns.length - 1,
            "after",
          )
        : view.rows.length < rows
          ? insertRow(grown, state.CRDTbinding, view.rows.length - 1, "after")
          : null;
    if (command === null) return { edits, document: grown };
    if (!command) return undefined;
    edits.push(...command.edits);
    grown = applyStructuredEdits(grown, command.edits);
  }
}

/**
 * Paste a grid: overwrite the cells it covers from the selection's top-left
 * corner, growing the table where it runs out, and leave the pasted block
 * selected.
 */
function pasteGrid(
  state: EditorState,
  context: TableContext,
  sources: readonly (readonly string[])[],
  rich: boolean,
): StateResult | undefined {
  const origin =
    context.anchor.cellId === context.caret.cellId
      ? cellPosition(context.document, context.caret.cellId)
      : (() => {
          const rect = cellRect(
            context.document,
            context.anchor.cellId,
            context.caret.cellId,
          );
          return rect && { row: rect.top, column: rect.left };
        })();
  if (!origin) return undefined;
  const height = sources.length;
  const width = Math.max(0, ...sources.map((row) => row.length));
  if (height === 0 || width === 0) return undefined;

  const grown = growTable(
    state,
    context.document,
    origin.row + height,
    origin.column + width,
  );
  if (!grown) return undefined;
  const edits = grown.edits;
  const view = readTable(grown.document);

  let first: TableCaret | undefined;
  let last: TableCaret | undefined;
  for (let r = 0; r < height; r++) {
    const row = view.rows[origin.row + r];
    if (!row) return undefined;
    // Order keys for any hole this row needs filled, after its last cell.
    let lastKey =
      row.cells.reduce<string | null>(
        (key, cell) =>
          cell && (key === null || cell.placement.orderKey > key)
            ? cell.placement.orderKey
            : key,
        null,
      ) ?? null;
    for (let c = 0; c < width; c++) {
      const column = view.columns[origin.column + c];
      if (!column) return undefined;
      let cellId = row.cells[origin.column + c]?.id;
      let runs: CharRun[] = [];
      if (cellId) {
        runs = cellRuns(grown.document, cellId) ?? [];
      } else {
        // A hole — a cell this row never got for a concurrently added column.
        // The paste has content for it, so it gets a cell of its own.
        let orderKey: string;
        try {
          orderKey = generateKeyBetween(lastKey, null);
        } catch {
          return undefined;
        }
        lastKey = orderKey;
        cellId = state.CRDTbinding.nextId();
        edits.push({
          kind: "node_insert",
          node: {
            id: cellId,
            type: CELL_NODE,
            placement: { parentId: row.node.id, slot: CELLS_SLOT, orderKey },
            attrs: { columnId: column.id },
            textFields: { [CELL_TEXT_FIELD]: [] },
          },
        });
      }

      const length = getVisibleTextFromRuns(runs).length;
      if (length > 0) {
        edits.push({
          kind: "text_delete",
          nodeId: cellId,
          field: CELL_TEXT_FIELD,
          charIds: getCharIdsInRangeFromRuns(runs, 0, length),
        });
      }
      const seed = seedFor(state, sources[r][c] ?? "", rich);
      const ids = seedCharIds(seed.charRuns);
      if (ids.length > 0) {
        // At the head of the field, ahead of the tombstones just made, so no
        // span anchored to the old text can reach over the new.
        edits.push({
          kind: "text_insert",
          nodeId: cellId,
          field: CELL_TEXT_FIELD,
          afterCharId: null,
          charRuns: [...seed.charRuns],
        });
        const index = new Map(ids.map((id, at) => [id, at]));
        for (const range of seed.marks ?? []) {
          const start = index.get(range.startCharId);
          const end = index.get(range.endCharId);
          if (start === undefined || end === undefined || end < start) continue;
          edits.push({
            kind: "mark_set",
            nodeId: cellId,
            field: CELL_TEXT_FIELD,
            charIds: ids.slice(start, end + 1),
            mark: range.format,
            value: true,
          });
        }
      }
      if (!first) first = { cellId, offset: 0 };
      last = { cellId, offset: ids.length };
    }
  }

  const committed = commitTableEdits(state, context, edits, undefined);
  const block = committed.state.document.page.blocks.find(
    (candidate) => candidate.id === context.block.id,
  );
  const document = block ? getTableDocument(block) : undefined;
  const selection =
    document &&
    first &&
    last &&
    tableRangeToContentSelection(document, context.block.id, first, last);
  if (!selection) return committed;
  return {
    state: updateContentSelection(clearSelection(committed.state), {
      ...selection,
      lastUpdate: Date.now(),
    }),
    ops: committed.ops,
  };
}
