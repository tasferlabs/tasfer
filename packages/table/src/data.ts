/**
 * Canvas-free data facet of the optional table feature.
 *
 * Import this entry in workers, persistence code, and Markdown tooling: it
 * registers the CRDT shape, the Markdown/HTML/text round-trip, the GFM
 * recognizer, and the structured-content adapters, without constructing the
 * canvas TableNode. Interactive hosts install the full bundle from
 * `@tasfer/table` instead, which adds the painter on top of exactly this.
 *
 * A host that installs neither still parses, syncs and re-serializes a document
 * containing tables — the block type and its round-trip are registered here,
 * the painter is what is optional.
 */

import {
  decodeTableToken,
  printGfmTable,
  TABLE_BLOCK,
  tableSeedFromToken,
  tableSyntaxRule,
} from "./markdown";
import {
  buildTableDocument,
  CELL_TEXT_FIELD,
  cellText,
  cloneTableDocument,
  columnAlign,
  getTableDocument,
  readTable,
  TABLE_STRUCTURED_KIND,
  type TableAlign,
  tableContentIdForBlock,
  type TableView,
} from "./structured";
import { createDeterministicIdentityAllocator } from "@shared/identity";
import type {
  BlockCodec,
  NodeCodec,
  OutputCtx,
} from "@tasfer/editor/serlization/codecs/types";
import type { Block } from "@tasfer/editor/serlization/loadPage";
import {
  NEWLINE,
  type VisibleToken,
} from "@tasfer/editor/serlization/tokenizer";
import { BLOCK_REGISTRY } from "@tasfer/editor/sync/block-registry";
import type {
  BlockSpecCore,
  StructuredKindSpec,
} from "@tasfer/editor/sync/schema";

// The adapter key a headless host needs to look the kind up on its own schema.
export { TABLE_STRUCTURED_KIND } from "./structured";

/** A table block carries no attributes of its own; everything is in the tree. */
export type TableBlockAttrs = Record<never, never>;

export type TableDataExtension = {
  readonly blocks: readonly [BlockSpecCore<"table", TableBlockAttrs>];
  readonly structuredKinds: readonly [StructuredKindSpec];
};

/** The table attached to a block, resolved for reading. */
function viewOf(block: Block): TableView | undefined {
  const document = getTableDocument(block);
  return document ? readTable(document) : undefined;
}

/**
 * Render every cell of a table in the active output format, as a grid of
 * strings. `ctx.inline` is the orchestrator's own inline renderer, so a cell's
 * bold/link/inline-math travels through exactly the path block text does.
 */
function renderCells(
  block: Block,
  ctx: OutputCtx,
): {
  aligns: readonly (TableAlign | null)[];
  rows: string[][];
} {
  const view = viewOf(block);
  if (!view) return { aligns: [], rows: [] };
  return {
    aligns: view.columns.map(columnAlign),
    rows: view.rows.map((row) =>
      row.cells.map((cell) => {
        if (!cell) return "";
        const runs = cell.textFields[CELL_TEXT_FIELD] ?? [];
        const marks = cell.markFields?.[CELL_TEXT_FIELD] ?? [];
        return ctx.inline([...runs], marks);
      }),
    ),
  };
}

/** `text-align` style for a column, or "" when it declares none. */
function alignStyle(align: TableAlign | null): string {
  return align ? ` style="text-align:${align}"` : "";
}

/** Markdown/HTML/text round-trip for a table block. Canvas-free. */
export const tableBlockNodeCodec: NodeCodec = {
  markdown: {
    tokens: [TABLE_BLOCK],
    input: (ctx) => {
      ctx.match(TABLE_BLOCK);
      const payload = (ctx.previous() as VisibleToken).content;
      ctx.match(NEWLINE);

      // A table's content lives only in its authority document; the block's
      // flat text stays empty. The deterministic allocator is parse-scoped —
      // the import path re-addresses identities when the block becomes CRDT
      // ops — and the SAME allocator feeds cell characters and tree nodes so
      // the two can never mint the same id.
      const id = ctx.nextBlockId();
      const contentId = tableContentIdForBlock(id);
      const identities = createDeterministicIdentityAllocator(
        `table-import/${encodeURIComponent(contentId)}`,
      );
      const seed = tableSeedFromToken(decodeTableToken(payload), identities);
      const document = buildTableDocument(seed, {
        contentId,
        identityAllocator: identities,
      });

      return {
        id,
        type: "table",
        structuredContent: { [contentId]: document },
      } as unknown as Block;
    },
    output: (block, ctx) => {
      const { aligns, rows } = renderCells(block, ctx);
      return printGfmTable(aligns, rows);
    },
  },
  html: {
    output: (block, ctx) => {
      const { aligns, rows } = renderCells(block, ctx);
      if (rows.length === 0) return "";
      const [header, ...body] = rows;
      const cellsOf = (cells: string[], tag: "th" | "td"): string =>
        cells
          .map(
            (cell, at) =>
              `<${tag}${alignStyle(aligns[at] ?? null)}>${cell}</${tag}>`,
          )
          .join("");
      const head = `<thead><tr>${cellsOf(header, "th")}</tr></thead>`;
      const rest =
        body.length > 0
          ? `<tbody>${body
              .map((row) => `<tr>${cellsOf(row, "td")}</tr>`)
              .join("")}</tbody>`
          : "";
      return `<table>${head}${rest}</table>`;
    },
  },
  text: {
    // The plain-text projection stays a GFM table so a copied table pastes back
    // as one, the same way a display equation copies as `$$…$$`.
    output: (block, ctx) => {
      const { aligns, rows } = renderCells(block, ctx);
      return printGfmTable(aligns, rows);
    },
  },
};

/** Full block codec consumed by DataSchema. */
export const tableBlockCodec: BlockCodec = {
  types: ["table"],
  ...tableBlockNodeCodec,
};

/** The `table` type's data registration — descriptor, round-trip, syntax. */
export const tableBlockSpec: BlockSpecCore<"table", TableBlockAttrs> = {
  type: "table",
  descriptor: BLOCK_REGISTRY.table,
  codec: tableBlockCodec,
  markdownSyntax: [tableSyntaxRule],
};

/**
 * Adapters for the `table` document kind. The clone adapter is not optional
 * here: a table stores column identities inside cell attrs, which the generic
 * copy cannot know to rewrite.
 */
export const tableStructuredKind: StructuredKindSpec = {
  kind: TABLE_STRUCTURED_KIND,
  clone: (ctx) => {
    const contentId = tableContentIdForBlock(ctx.targetBlockId);
    return {
      contentId,
      document: cloneTableDocument(ctx.document, contentId, ctx.identities),
    };
  },
  source: (document) => {
    const view = readTable(document);
    if (view.columns.length === 0) return undefined;
    return printGfmTable(
      view.columns.map(columnAlign),
      view.rows.map((row) =>
        row.cells.map((cell) => (cell ? cellText(document, cell) : "")),
      ),
    );
  },
};

/** Build a fresh, instance-safe table data bundle. */
export function tableDataExtension(): TableDataExtension {
  return {
    blocks: [tableBlockSpec],
    structuredKinds: [tableStructuredKind],
  };
}
