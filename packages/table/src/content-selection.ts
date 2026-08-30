/**
 * The clipboard projection of a selection inside a table.
 *
 * Copy asks the owning structured kind what a nested range says in plain text
 * (`serializeContentSelection`); a kind that answers nothing puts nothing on the
 * clipboard, because the flat selection a table has none of is the only other
 * source. So this is what makes Ctrl/Cmd+C work on text selected in a cell.
 *
 * Two shapes, matching what the band paints and what a delete takes:
 *
 *   - inside one cell — the selected characters, exactly as prose copies;
 *   - across cells — every covered cell whole, tab-separated within a row and
 *     newline-separated between rows. That is the grid convention every
 *     spreadsheet reads, so a copied block of cells pastes into one as columns.
 *
 * Plain text only. A cell's marks are rendered through the orchestrator's own
 * inline renderer (see `renderCells` in `./data`), which needs an output
 * context this facet is not given; a Markdown projection of half a grid would
 * also have to invent the rows and alignments the range does not cover.
 *
 * Like math's, this adapter is installed by the interactive bundle only: the
 * clipboard is a main-thread concern, and the canvas-free `@tasfer/table/data`
 * entry stays free of the selection module.
 */

import {
  cellRuns,
  tableCaretFromContentPoint,
  tableCellIds,
} from "./selection";
import { cellText, readTable, TABLE_STRUCTURED_KIND } from "./structured";
import type {
  ContentSelectionCtx,
  ContentSelectionSlice,
} from "@tasfer/editor/feature-facets";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import type { StructuredKindSpec } from "@tasfer/editor/sync/schema";

/** What a selected range inside a table puts on the clipboard. */
export function serializeTableContentSelection({
  document,
  selection,
}: ContentSelectionCtx): ContentSelectionSlice | undefined {
  const anchor = tableCaretFromContentPoint(document, selection.anchor);
  const focus = tableCaretFromContentPoint(document, selection.focus);
  if (!anchor || !focus) return undefined;

  if (anchor.cellId === focus.cellId) {
    const text = getVisibleTextFromRuns(cellRuns(document, anchor.cellId));
    const from = Math.min(anchor.offset, focus.offset);
    const to = Math.max(anchor.offset, focus.offset);
    return from === to ? undefined : { plainText: text.slice(from, to) };
  }

  const order = tableCellIds(document);
  const first = order.indexOf(anchor.cellId);
  const last = order.indexOf(focus.cellId);
  if (first < 0 || last < 0) return undefined;
  const covered = new Set(
    order.slice(Math.min(first, last), Math.max(first, last) + 1),
  );

  // Walked row by row rather than along the covered run, so the copied text
  // keeps the grid's shape: a range that ends mid-row copies the cells it
  // covers, on the rows they sit in.
  const rows: string[] = [];
  for (const row of readTable(document).rows) {
    const cells = row.cells.filter((cell) => !!cell && covered.has(cell.id));
    if (cells.length === 0) continue;
    rows.push(cells.map((cell) => cellText(document, cell!)).join("\t"));
  }
  return rows.length === 0 ? undefined : { plainText: rows.join("\n") };
}

/** The table kind's clipboard adapter, for hand-assembled interactive schemas. */
export const tableContentSelectionKind = {
  kind: TABLE_STRUCTURED_KIND,
  contentSelection: serializeTableContentSelection,
} as const satisfies StructuredKindSpec;
