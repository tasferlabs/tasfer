/**
 * Structured-content adapter for the optional table feature.
 *
 * A table's whole content — its columns, its rows, and the rich text in every
 * cell — lives in ONE structured attachment on the block, addressed by the
 * block id. The block itself stores nothing. This module is the only place that
 * knows the shape of that attachment.
 *
 * The shape, and why:
 *
 *     root  (type "table", authority "block")
 *       ├── slot "columns" → column nodes    { align? }
 *       └── slot "rows"    → row nodes
 *              └── slot "cells" → cell nodes { columnId }, textFields { text }
 *
 * **Columns are nodes with identities, and a cell names its column.** This is
 * the load-bearing decision. The obvious alternative — a row is just a list of
 * cells, column N is the Nth cell — cannot converge: two peers that each insert
 * a column concurrently produce rows of different lengths with no way to say
 * which cell belongs to which column, and the grid is ragged forever. With
 * column identities the same edit is unambiguous: each peer's column is a
 * distinct node, every cell keeps naming its own column, and a row that has no
 * cell for some column simply renders that cell empty.
 *
 * That "missing cell" state is normal, not a defect: it is exactly what a peer
 * sees for a row another peer added while it was adding a column. Readers here
 * therefore never assume a rectangular grid — {@link readTable} resolves cells
 * by column identity and reports the holes as `undefined`.
 */

import {
  createDeterministicIdentityAllocator,
  type IdentityAllocator,
} from "@shared/identity";
import type { CharRun, MarkRange } from "@tasfer/editor/serlization/loadPage";
import { charsToRuns } from "@tasfer/editor/sync/char-runs";
import { generateNKeysBetween } from "@tasfer/editor/sync/fractional-index";
import {
  buildStructuredChildIndex,
  cloneStructuredDocumentWithFreshIdentities,
  createStructuredDocument,
  getStructuredChildren,
  getStructuredText,
  structuredContentId,
  type StructuredDocument,
  type StructuredMutation,
  type StructuredNode,
  type StructuredValue,
  validateStructuredDocument,
} from "@tasfer/editor/sync/structured-content";

/** Adapter discriminator stored in `StructuredDocument.kind`. */
export const TABLE_STRUCTURED_KIND = "table";

/** Node types inside a table document. */
export const TABLE_NODE = "table";
export const COLUMN_NODE = "column";
export const ROW_NODE = "row";
export const CELL_NODE = "cell";

/** Child slots. */
export const COLUMNS_SLOT = "columns";
export const ROWS_SLOT = "rows";
export const CELLS_SLOT = "cells";

/** The character-CRDT field a cell's text lives in. */
export const CELL_TEXT_FIELD = "text";

/** Horizontal alignment of a column. `null` is the reader's default. */
export type TableAlign = "left" | "center" | "right";

/** The stable attachment address for a table block. */
export function tableContentIdForBlock(blockId: string): string {
  return structuredContentId(blockId, TABLE_STRUCTURED_KIND);
}

/** The authoritative table attached to a block, if it carries one. */
export function getTableDocument(block: {
  readonly id: string;
  readonly structuredContent?: Readonly<Record<string, StructuredDocument>>;
}): StructuredDocument | undefined {
  const document = block.structuredContent?.[tableContentIdForBlock(block.id)];
  return document?.kind === TABLE_STRUCTURED_KIND ? document : undefined;
}

/** A column's alignment, or `null` when it never set one. */
export function columnAlign(column: StructuredNode): TableAlign | null {
  const align = column.attrs.align;
  return align === "left" || align === "center" || align === "right"
    ? align
    : null;
}

/**
 * A column's explicit width, as a fraction of the grid, or `null` when it is
 * sized from its content.
 *
 * A fraction and not a pixel count: the grid is re-fitted to whatever width the
 * page has, and the same document is opened on a phone and on a desktop — a
 * stored pixel width would be wrong on one of them. Out-of-range values are
 * read as "no width" rather than clamped, so a document written by a future
 * version that means something else by them degrades to automatic sizing.
 */
export function columnWidth(column: StructuredNode): number | null {
  const width = column.attrs.width;
  return typeof width === "number" &&
    Number.isFinite(width) &&
    width > 0 &&
    width < 1
    ? width
    : null;
}

/** The column a cell belongs to, or `""` for a malformed cell. */
export function cellColumnId(cell: StructuredNode): string {
  const columnId = cell.attrs.columnId;
  return typeof columnId === "string" ? columnId : "";
}

/** The visible text of one cell. */
export function cellText(
  document: StructuredDocument,
  cell: StructuredNode,
): string {
  return getStructuredText(document, cell.id, CELL_TEXT_FIELD);
}

/** One row, with its cells already resolved against the column order. */
export interface TableRowView {
  readonly node: StructuredNode;
  /**
   * One entry per column, in column order. `undefined` is a cell this row does
   * not have — a hole left by a concurrent add-column/add-row, rendered empty.
   */
  readonly cells: readonly (StructuredNode | undefined)[];
}

/** A whole table resolved for reading: columns, rows, and cells by column. */
export interface TableView {
  readonly root: StructuredNode | undefined;
  readonly columns: readonly StructuredNode[];
  readonly rows: readonly TableRowView[];
}

/**
 * Resolve a table document for reading.
 *
 * Builds ONE child index for the whole document rather than asking per row: a
 * layout pass walks every row and every cell, and the unindexed lookup scans
 * all nodes each time, so a large table would otherwise be quadratic per frame.
 *
 * Should a row somehow hold two cells for one column (only reachable from a
 * malformed remote document — the editing commands cannot produce it), the
 * first in sibling order wins, deterministically on every peer.
 */
export function readTable(document: StructuredDocument): TableView {
  const root = document.nodes[document.rootId];
  if (!root || root.type !== TABLE_NODE) {
    return { root: undefined, columns: [], rows: [] };
  }

  const index = buildStructuredChildIndex(document);
  const columns = getStructuredChildren(
    document,
    document.rootId,
    COLUMNS_SLOT,
    { index },
  ).filter((node) => node.type === COLUMN_NODE);
  const columnOrder = new Map(columns.map((column, at) => [column.id, at]));

  const rows = getStructuredChildren(document, document.rootId, ROWS_SLOT, {
    index,
  })
    .filter((node) => node.type === ROW_NODE)
    .map((node): TableRowView => {
      const cells: (StructuredNode | undefined)[] = columns.map(
        () => undefined,
      );
      for (const cell of getStructuredChildren(document, node.id, CELLS_SLOT, {
        index,
      })) {
        if (cell.type !== CELL_NODE) continue;
        const at = columnOrder.get(cellColumnId(cell));
        if (at === undefined || cells[at] !== undefined) continue;
        cells[at] = cell;
      }
      return { node, cells };
    });

  return { root, columns, rows };
}

/** The plain content a table is built from — one cell's text and its marks. */
export interface TableCellSeed {
  readonly charRuns: readonly CharRun[];
  readonly marks?: readonly MarkRange[];
}

/**
 * A whole table's content, before it has identities. This is what a Markdown
 * parse produces and what {@link buildTableDocument} turns into CRDT state.
 * `rows[0]` is the header row.
 */
export interface TableSeed {
  readonly aligns: readonly (TableAlign | null)[];
  readonly rows: readonly (readonly TableCellSeed[])[];
}

export interface BuildTableOptions {
  readonly contentId: string;
  /**
   * Identity source. Live callers pass their CRDT binding; a parse passes
   * nothing and gets a deterministic allocator scoped to the content id, whose
   * identities the import path re-addresses when the block becomes ops.
   */
  readonly identityAllocator?: IdentityAllocator;
}

/**
 * Build the structured document for a table.
 *
 * Attachments are created eagerly by exactly one peer (the one typing or
 * importing), so no cross-peer identity convergence is required here — the
 * same contract display math is built under.
 */
export function buildTableDocument(
  seed: TableSeed,
  options: BuildTableOptions,
): StructuredDocument {
  const identities =
    options.identityAllocator ??
    createDeterministicIdentityAllocator(
      `table-import/${encodeURIComponent(options.contentId)}`,
    );

  const nodes: Record<string, StructuredNode> = {};
  const add = (node: StructuredNode): void => {
    nodes[node.id] = node;
  };

  add({
    id: options.contentId,
    type: TABLE_NODE,
    placement: { parentId: null, slot: "", orderKey: "" },
    attrs: {},
    textFields: {},
  });

  const columnCount = Math.max(
    seed.aligns.length,
    ...seed.rows.map((row) => row.length),
    0,
  );
  const columnKeys = generateNKeysBetween(null, null, columnCount);
  const columnIds: string[] = [];
  for (let at = 0; at < columnCount; at++) {
    const id = identities.nextId();
    columnIds.push(id);
    const align = seed.aligns[at] ?? null;
    add({
      id,
      type: COLUMN_NODE,
      placement: {
        parentId: options.contentId,
        slot: COLUMNS_SLOT,
        orderKey: columnKeys[at],
      },
      attrs: align ? { align } : {},
      textFields: {},
    });
  }

  const rowKeys = generateNKeysBetween(null, null, seed.rows.length);
  seed.rows.forEach((row, rowAt) => {
    const rowId = identities.nextId();
    add({
      id: rowId,
      type: ROW_NODE,
      placement: {
        parentId: options.contentId,
        slot: ROWS_SLOT,
        orderKey: rowKeys[rowAt],
      },
      attrs: {},
      textFields: {},
    });

    const cellKeys = generateNKeysBetween(null, null, columnCount);
    for (let at = 0; at < columnCount; at++) {
      const cell = row[at];
      const cellId = identities.nextId();
      add({
        id: cellId,
        type: CELL_NODE,
        placement: {
          parentId: rowId,
          slot: CELLS_SLOT,
          orderKey: cellKeys[at],
        },
        attrs: { columnId: columnIds[at] },
        textFields: { [CELL_TEXT_FIELD]: cell ? [...cell.charRuns] : [] },
        ...(cell?.marks && cell.marks.length > 0
          ? { markFields: { [CELL_TEXT_FIELD]: [...cell.marks] } }
          : {}),
      });
    }
  });

  const document: StructuredDocument = {
    ...createStructuredDocument(TABLE_STRUCTURED_KIND, options.contentId),
    authority: "block",
    nodes,
  };
  const validated = validateStructuredDocument(document);
  if (!validated) throw new Error("Built an invalid table document");
  return validated;
}

/** The atomic initializer a `content_edit` operation carries for a new table. */
export function tableDocumentInit(
  seed: TableSeed,
  options: BuildTableOptions,
): StructuredMutation {
  return {
    kind: "document_init",
    document: buildTableDocument(seed, options),
  };
}

/** Allocate character runs for a literal cell string. */
export function cellRunsFromText(
  text: string,
  identities: IdentityAllocator,
): CharRun[] {
  const chars = [];
  // One identity per UTF-16 code unit, matching how the engine addresses text
  // everywhere else (`iterateAllChars` walks a run by code unit).
  for (let offset = 0; offset < text.length; offset++) {
    chars.push({ id: identities.nextId(), char: text[offset] });
  }
  return charsToRuns(chars);
}

/**
 * Validate both the generic wire shape and this feature's own tree schema, so a
 * malformed document from a peer on a different version is rejected whole
 * rather than rendered as a half-built grid.
 */
export function validateTableDocument(
  value: StructuredDocument,
): StructuredDocument | undefined {
  const validated = validateStructuredDocument(value);
  if (!validated || validated.kind !== TABLE_STRUCTURED_KIND) return undefined;

  const root = validated.nodes[validated.rootId];
  if (!root || root.type !== TABLE_NODE) return undefined;

  const columnIds = new Set<string>();
  for (const node of Object.values(validated.nodes)) {
    if (node.id === validated.rootId) continue;
    const { parentId, slot } = node.placement;
    switch (node.type) {
      case COLUMN_NODE:
        if (parentId !== validated.rootId || slot !== COLUMNS_SLOT) {
          return undefined;
        }
        columnIds.add(node.id);
        break;
      case ROW_NODE:
        if (parentId !== validated.rootId || slot !== ROWS_SLOT) {
          return undefined;
        }
        break;
      case CELL_NODE: {
        if (slot !== CELLS_SLOT) return undefined;
        const parent = parentId ? validated.nodes[parentId] : undefined;
        if (!parent || parent.type !== ROW_NODE) return undefined;
        if (typeof node.attrs.columnId !== "string") return undefined;
        break;
      }
      default:
        return undefined;
    }
  }

  // A cell may only name a column this document actually holds. Checked after
  // the walk so column order in `nodes` cannot matter.
  for (const node of Object.values(validated.nodes)) {
    if (node.type !== CELL_NODE) continue;
    if (!columnIds.has(cellColumnId(node))) return undefined;
  }

  return validated;
}

/**
 * Re-address a table when a snapshot or import mints a new block id.
 *
 * The generic clone rewrites placements, text and mark anchors, but copies
 * attrs verbatim — it cannot know that `columnId` is an identity. Rewriting it
 * here is what keeps every cell attached to its column in the copy; without it
 * the clone's cells would all name columns that no longer exist and the table
 * would read as entirely empty.
 */
export function cloneTableDocument(
  document: StructuredDocument,
  targetContentId: string,
  identities: IdentityAllocator,
): StructuredDocument {
  return cloneStructuredDocumentWithFreshIdentities(
    document,
    targetContentId,
    identities,
    {
      rewriteAttrs: (attrs, resolveId) => {
        const columnId = attrs.columnId;
        if (typeof columnId !== "string") return attrs;
        const target = resolveId(columnId);
        // A dangling reference stays as it is: dropping the attr would strip
        // the cell of its column entirely, and keeping it lets a later repair
        // still recognize what it pointed at.
        return target
          ? ({ ...attrs, columnId: target } as Record<string, StructuredValue>)
          : attrs;
      },
    },
  );
}
