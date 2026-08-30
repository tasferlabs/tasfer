/**
 * The whole data path, end to end: Markdown in, CRDT state, Markdown back out.
 *
 * A table is the first block type whose entire content lives in a structured
 * attachment *and* round-trips through Markdown, so these assert the property
 * that matters most for a document format — what the user wrote is what comes
 * back — plus the degrade path for a host that never installed the feature.
 */

import { tableDataExtension } from "./data";
import {
  cellText,
  getTableDocument,
  readTable,
  tableContentIdForBlock,
  tableDocumentInit,
} from "./structured";
import { getBaseDataSchema } from "@tasfer/editor/baseDataSchema";
import { serializeToHTMLFragment } from "@tasfer/editor/serlization/htmlSerializer";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import { createCRDTbinding, createSyncEngine } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

function schema() {
  return getBaseDataSchema().extend(tableDataExtension());
}

const TABLE = ["| Fruit | Price |", "| --- | ---: |", "| Apples | 1.20 |"].join(
  "\n",
);

/** Parse `source`, then serialize the result back to Markdown. */
function roundTrip(source: string): string {
  const active = schema();
  const page = loadPage(source, active);
  return serializeToMarkdown(page.blocks, undefined, { schema: active });
}

describe("markdown round trip", () => {
  it("returns a table unchanged", () => {
    expect(roundTrip(TABLE)).toBe(TABLE);
  });

  it("parses a table into one block whose content is its attachment", () => {
    const page = loadPage(TABLE, schema());

    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0].type).toBe("table");
    const document = getTableDocument(page.blocks[0])!;
    expect(document.authority).toBe("block");

    const view = readTable(document);
    expect(view.columns).toHaveLength(2);
    expect(
      view.rows.map((row) =>
        row.cells.map((cell) => (cell ? cellText(document, cell) : undefined)),
      ),
    ).toEqual([
      ["Fruit", "Price"],
      ["Apples", "1.20"],
    ]);
  });

  it("keeps a column's alignment", () => {
    const page = loadPage(TABLE, schema());
    const view = readTable(getTableDocument(page.blocks[0])!);

    expect(view.columns.map((column) => column.attrs.align)).toEqual([
      undefined,
      "right",
    ]);
  });

  it("keeps inline marks inside a cell", () => {
    const source = ["| a |", "| --- |", "| **bold** and `code` |"].join("\n");
    const page = loadPage(source, schema());
    const document = getTableDocument(page.blocks[0])!;
    const cell = readTable(document).rows[1].cells[0]!;

    // Stored as text plus marks, not as literal asterisks.
    expect(cellText(document, cell)).toBe("bold and code");
    expect(cell.markFields?.text).toHaveLength(2);
    expect(roundTrip(source)).toBe(source);
  });

  it("keeps a link in a cell", () => {
    const source = ["| a |", "| --- |", "| [docs](https://x.test) |"].join(
      "\n",
    );

    expect(roundTrip(source)).toBe(source);
  });

  it("treats block syntax inside a cell as literal text, as GFM does", () => {
    const source = ["| a |", "| --- |", "| # not a heading |"].join("\n");
    const page = loadPage(source, schema());
    const document = getTableDocument(page.blocks[0])!;

    expect(cellText(document, readTable(document).rows[1].cells[0]!)).toBe(
      "# not a heading",
    );
    expect(roundTrip(source)).toBe(source);
  });

  it("keeps an escaped pipe escaped", () => {
    const source = ["| a |", "| --- |", "| one \\| two |"].join("\n");
    const page = loadPage(source, schema());
    const document = getTableDocument(page.blocks[0])!;

    expect(cellText(document, readTable(document).rows[1].cells[0]!)).toBe(
      "one | two",
    );
    expect(roundTrip(source)).toBe(source);
  });

  it("keeps the prose around a table", () => {
    const source = ["Before.", "", TABLE, "", "After."].join("\n");

    expect(roundTrip(source)).toBe(source);
  });

  it("renders a table to HTML with its alignment", () => {
    const active = schema();
    const page = loadPage(TABLE, active);
    const html = serializeToHTMLFragment(page.blocks, { schema: active });

    expect(html).toContain("<table>");
    expect(html).toContain("<th>Fruit</th>");
    expect(html).toContain('<th style="text-align:right">Price</th>');
    expect(html).toContain('<td style="text-align:right">1.20</td>');
  });
});

describe("without the feature installed", () => {
  it("preserves the source text rather than destroying it", () => {
    const base = getBaseDataSchema();
    const page = loadPage(TABLE, base);

    // No table block — but every line survives as prose, so a host that never
    // installed the feature cannot silently eat a table.
    expect(page.blocks.map((block) => block.type as string)).not.toContain(
      "table",
    );
    expect(serializeToMarkdown(page.blocks, undefined, { schema: base })).toBe(
      TABLE,
    );
  });
});

describe("as CRDT operations", () => {
  it("replays a table through a data-only worker schema", () => {
    const active = schema();
    const binding = createCRDTbinding("table-worker", "author");
    const author = createSyncEngine(binding, active);
    const block = author.createBlockInsert("a0", "table");
    author.emit([block]);

    const contentId = tableContentIdForBlock(block.blockId);
    author.emit([
      author.createContentEdit(
        block.blockId,
        contentId,
        tableDocumentInit(
          {
            aligns: [null],
            rows: [[{ charRuns: [] }], [{ charRuns: [] }]],
          },
          { contentId, identityAllocator: binding },
        ),
      ),
    ]);

    const worker = createSyncEngine(
      createCRDTbinding("table-worker", "worker"),
      active,
    );
    worker.loadOperations(author.getOperations());

    const document = getTableDocument(worker.getState().blocks[0])!;
    const view = readTable(document);
    expect(view.columns).toHaveLength(1);
    expect(view.rows).toHaveLength(2);
  });
});
