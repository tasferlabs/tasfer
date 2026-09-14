/**
 * The clipboard projection of a selection inside a table.
 *
 * Copy asks the owning structured kind what a nested range says
 * (`serializeContentSelection`); a kind that answers nothing puts nothing on the
 * clipboard, because the flat selection a table has none of is the only other
 * source. So this is what makes Ctrl/Cmd+C work on a selection in a table.
 *
 * Two shapes, matching what the band paints and what a delete takes:
 *
 *   - inside one cell — the selected characters, exactly as prose copies;
 *   - across cells — the rectangle of covered cells, whole.
 *
 * Each shape is given to the clipboard twice over. The plain text is what a
 * spreadsheet reads: cells tab-separated within a row and newline-separated
 * between rows, so a copied block of cells pastes into one as columns. The
 * rich flavors come from `blocks` — the range rebuilt as a standalone table (or,
 * inside one cell, a paragraph) — which core serializes through the same codecs
 * a copied block goes through. That is what keeps bold, links and inline code:
 * pasted back into a table (`./paste`) the cells return formatted, and pasted
 * into prose they become a table of their own.
 *
 * Like math's, this adapter is installed by the interactive bundle only: the
 * clipboard is a main-thread concern, and the canvas-free `@tasfer/table/data`
 * entry stays free of the selection module.
 */

import { tableContentPaste } from "./paste";
import {
  cellRect,
  cellRuns,
  cellsInRect,
  tableCaretFromContentPoint,
} from "./selection";
import {
  buildTableDocument,
  CELL_TEXT_FIELD,
  cellText,
  columnAlign,
  readTable,
  TABLE_STRUCTURED_KIND,
  type TableCellSeed,
  tableContentIdForBlock,
} from "./structured";
import { createDeterministicIdentityAllocator } from "@shared/identity";
import type {
  ContentSelectionCtx,
  ContentSelectionSlice,
} from "@tasfer/editor/feature-facets";
import type {
  Block,
  Char,
  MarkSpan,
} from "@tasfer/editor/serlization/loadPage";
import {
  charsToRuns,
  getVisibleTextFromRuns,
} from "@tasfer/editor/sync/char-runs";
import { getFormatsAtCharPosition } from "@tasfer/editor/sync/crdt-utils";
import { markKey } from "@tasfer/editor/sync/mark-spans";
import type { StructuredKindSpec } from "@tasfer/editor/sync/schema";
import {
  getStructuredMarks,
  type StructuredDocument,
  type StructuredNode,
} from "@tasfer/editor/sync/structured-content";

/**
 * The id the rebuilt slice block carries. It never reaches a document: a paste
 * into prose re-addresses every block it inserts, and a paste into a table reads
 * the Markdown, not the block.
 */
const SLICE_BLOCK_ID = "table-clipboard";

/** What a selected range inside a table puts on the clipboard. */
export function serializeTableContentSelection({
  document,
  selection,
}: ContentSelectionCtx): ContentSelectionSlice | undefined {
  const anchor = tableCaretFromContentPoint(document, selection.anchor);
  const focus = tableCaretFromContentPoint(document, selection.focus);
  if (!anchor || !focus) return undefined;

  if (anchor.cellId === focus.cellId) {
    const from = Math.min(anchor.offset, focus.offset);
    const to = Math.max(anchor.offset, focus.offset);
    if (from === to) return undefined;
    const text = getVisibleTextFromRuns(cellRuns(document, anchor.cellId));
    return {
      plainText: text.slice(from, to),
      blocks: [cellSliceParagraph(document, anchor.cellId, from, to)],
    };
  }

  const rect = cellRect(document, anchor.cellId, focus.cellId);
  if (!rect) return undefined;
  const view = readTable(document);
  const rows = view.rows.slice(rect.top, rect.bottom + 1);
  if (rows.length === 0 || cellsInRect(document, rect).length === 0) {
    return undefined;
  }

  // The rectangle's own shape, holes included: a hole copies as an empty cell
  // so every pasted cell still lands in its column.
  const cellsOf = (row: (typeof rows)[number]) =>
    row.cells.slice(rect.left, rect.right + 1);
  const plainText = rows
    .map((row) =>
      cellsOf(row)
        .map((cell) => (cell ? cellText(document, cell) : ""))
        .join("\t"),
    )
    .join("\n");

  const contentId = tableContentIdForBlock(SLICE_BLOCK_ID);
  const slice = buildTableDocument(
    {
      aligns: view.columns.slice(rect.left, rect.right + 1).map(columnAlign),
      rows: rows.map((row) => cellsOf(row).map(cellSeed)),
    },
    {
      contentId,
      identityAllocator:
        createDeterministicIdentityAllocator("table-clipboard"),
    },
  );
  const block = {
    id: SLICE_BLOCK_ID,
    type: "table",
    structuredContent: { [contentId]: slice },
  } as unknown as Block;
  return { plainText, blocks: [block] };
}

/**
 * One cell's content, verbatim. Its runs and marks keep their identities: the
 * slice is a detached document read only by the serializers, which resolve a
 * mark against the runs it came with — tombstones included.
 */
function cellSeed(cell: StructuredNode | undefined): TableCellSeed {
  if (!cell) return { charRuns: [] };
  return {
    charRuns: [...(cell.textFields[CELL_TEXT_FIELD] ?? [])],
    marks: [...(cell.markFields?.[CELL_TEXT_FIELD] ?? [])],
  };
}

/**
 * The characters `[from, to)` of one cell as a paragraph, each carrying the
 * marks it has in the cell — what a partial cell copies as, so the formatting
 * survives into prose and back into a cell.
 */
function cellSliceParagraph(
  document: StructuredDocument,
  cellId: string,
  from: number,
  to: number,
): Block {
  const runs = cellRuns(document, cellId) ?? [];
  const spans = getStructuredMarks(
    document,
    cellId,
    CELL_TEXT_FIELD,
  ) as MarkSpan[];
  const text = getVisibleTextFromRuns(runs);
  const identities = createDeterministicIdentityAllocator("table-clipboard");
  const clock = { counter: 0, peerId: "table-clipboard" };

  const chars: Char[] = [];
  const formats: MarkSpan[] = [];
  // Marks still running at the previous character, by identity, so a mark over
  // consecutive characters becomes one span rather than one per character.
  let open = new Map<string, MarkSpan>();
  for (let at = from; at < to; at++) {
    const id = identities.nextId();
    chars.push({ id, char: text[at] });
    const next = new Map<string, MarkSpan>();
    for (const mark of getFormatsAtCharPosition(runs, spans, at + 1)) {
      const key = markKey(mark);
      if (next.has(key)) continue;
      const running = open.get(key);
      if (running) {
        running.endCharId = id;
        next.set(key, running);
      } else {
        const span: MarkSpan = {
          startCharId: id,
          endCharId: id,
          format: mark,
          clock,
        };
        formats.push(span);
        next.set(key, span);
      }
    }
    open = next;
  }

  return {
    id: SLICE_BLOCK_ID,
    type: "paragraph",
    charRuns: charsToRuns(chars),
    formats,
  } as Block;
}

/** The table kind's clipboard adapters, for hand-assembled interactive schemas. */
export const tableContentSelectionKind = {
  kind: TABLE_STRUCTURED_KIND,
  contentSelection: serializeTableContentSelection,
  paste: tableContentPaste,
} as const satisfies StructuredKindSpec;
