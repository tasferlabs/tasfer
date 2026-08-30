/**
 * GitHub-flavored Markdown round-trip for tables.
 *
 * A table spans several source lines, so it is recognized whole by one
 * block-scope syntax rule and carried as a single token with a JSON payload —
 * the same shape a fenced code block uses. The token's `raw` is the exact source
 * consumed, so a schema without the table feature installed reproduces the
 * user's text verbatim instead of destroying it.
 *
 * Cell content is *inline* markdown in GFM: `**bold**` is bold, but `# foo` is
 * literally "# foo", because a cell is not a block context. The engine's parser
 * is a block parser, so a cell is parsed and then only accepted when it came
 * back as a single paragraph; anything that parsed as a block construct is kept
 * as literal text, which is exactly what GFM renders for it.
 */

import {
  type TableAlign,
  type TableCellSeed,
  type TableSeed,
} from "./structured";
import type { IdentityAllocator } from "@shared/identity";
import type { SyntaxCtx, SyntaxRule } from "@tasfer/editor/feature-facets";
import type {
  Char,
  CharRun,
  MarkRange,
} from "@tasfer/editor/serlization/loadPage";
import parsePage from "@tasfer/editor/serlization/parser";
import tokenizePage from "@tasfer/editor/serlization/tokenizer";
import { charsToRuns, iterateAllChars } from "@tasfer/editor/sync/char-runs";

/** Token this feature's codec claims. Its content is a {@link GfmTable} JSON. */
export const TABLE_BLOCK = "table_block";

/** A table as it appears in Markdown source: alignments plus cell sources. */
export interface GfmTable {
  readonly aligns: readonly (TableAlign | null)[];
  /** Rows of inline-markdown cell sources; `rows[0]` is the header. */
  readonly rows: readonly (readonly string[])[];
}

const DELIMITER_CELL = /^:?-+:?$/;

/**
 * Split one table line into raw cell sources.
 *
 * A leading and a trailing pipe are optional in GFM and are not separators. A
 * pipe escaped as `\|` is content; any other backslash is left alone for the
 * inline parser, which owns the rest of Markdown's escapes.
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const cells: string[] = [];
  let current = "";
  for (let at = 0; at < trimmed.length; at++) {
    const char = trimmed[at];
    if (char === "\\" && trimmed[at + 1] === "|") {
      current += "|";
      at++;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);

  // Drop the empty leading/trailing entries a bounding pipe produces. Only one
  // at each end: `| a || b |` really does contain an empty cell.
  if (cells.length > 1 && cells[0].trim() === "" && trimmed.startsWith("|")) {
    cells.shift();
  }
  if (
    cells.length > 1 &&
    cells[cells.length - 1].trim() === "" &&
    trimmed.endsWith("|") &&
    !trimmed.endsWith("\\|")
  ) {
    cells.pop();
  }
  return cells.map((cell) => cell.trim());
}

/** @internal Cell splitting is subtle enough to deserve its own tests. */
export const splitRowForTest = splitRow;

/** The alignment a delimiter cell (`:--`, `:-:`, `--:`) declares. */
function alignOf(cell: string): TableAlign | null {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return null;
}

/** Whether a line can only be read as a delimiter row. */
function delimiterAligns(line: string): (TableAlign | null)[] | undefined {
  const cells = splitRow(line);
  if (cells.length === 0) return undefined;
  if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return undefined;
  return cells.map(alignOf);
}

/**
 * Recognize a GFM table at `offset`, or return `undefined`.
 *
 * The table ends at the first blank line or at the end of the source, which is
 * GFM's own rule: a plain paragraph line directly under a table is read as one
 * more row, not as a paragraph.
 */
export function matchGfmTable(
  source: string,
  offset: number,
): { table: GfmTable; length: number } | undefined {
  const rest = source.slice(offset);
  const lines = rest.split("\n");
  if (lines.length < 2) return undefined;
  if (!lines[0].includes("|")) return undefined;

  const aligns = delimiterAligns(lines[1]);
  if (!aligns) return undefined;

  const header = splitRow(lines[0]);
  // GFM requires the header and the delimiter row to agree on width; without
  // that this is an ordinary paragraph that happens to contain pipes.
  if (header.length !== aligns.length) return undefined;

  const rows: string[][] = [fit(header, aligns.length)];
  let consumed = lines[0].length + 1 + lines[1].length;
  for (let at = 2; at < lines.length; at++) {
    const line = lines[at];
    if (line.trim() === "") break;
    rows.push(fit(splitRow(line), aligns.length));
    consumed += 1 + line.length;
  }

  return { table: { aligns, rows }, length: consumed };
}

/** Pad a short row with empty cells and drop any beyond the column count. */
function fit(cells: string[], width: number): string[] {
  const row = cells.slice(0, width);
  while (row.length < width) row.push("");
  return row;
}

/**
 * The block-scope recognizer this feature registers on its block spec. Only
 * consulted at the start of a line, and only when a schema is threaded through
 * the tokenizer.
 */
export const tableSyntaxRule: SyntaxRule = {
  id: "table/gfm",
  scope: "block",
  match: (ctx: SyntaxCtx) => {
    if (!ctx.startOfLine) return undefined;
    const matched = matchGfmTable(ctx.source, ctx.offset);
    if (!matched) return undefined;
    return {
      length: matched.length,
      tokens: [
        {
          type: TABLE_BLOCK,
          content: JSON.stringify(matched.table),
          raw: ctx.source.slice(ctx.offset, ctx.offset + matched.length),
        },
      ],
    };
  },
};

/** Decode a {@link TABLE_BLOCK} token's payload, tolerating a malformed one. */
export function decodeTableToken(content: string): GfmTable {
  try {
    const parsed = JSON.parse(content) as Partial<GfmTable>;
    const aligns = Array.isArray(parsed.aligns) ? parsed.aligns : [];
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    return {
      aligns: aligns.map((align) =>
        align === "left" || align === "center" || align === "right"
          ? align
          : null,
      ),
      rows: rows.map((row) =>
        (Array.isArray(row) ? row : []).map((cell) =>
          typeof cell === "string" ? cell : "",
        ),
      ),
    };
  } catch {
    return { aligns: [], rows: [] };
  }
}

/**
 * Turn one cell's inline Markdown into CRDT runs plus mark spans.
 *
 * The cell is parsed as its own miniature page and accepted only when it comes
 * back as one paragraph; a source that parsed into any other block type was
 * never inline Markdown to begin with, and GFM renders it literally, so that is
 * what we store. Identities are re-addressed onto `identities` because the
 * parser mints its own parse-scoped ones.
 */
export function cellSeedFromMarkdown(
  source: string,
  identities: IdentityAllocator,
): TableCellSeed {
  if (source === "") return { charRuns: [] };

  const page = parsePage(tokenizePage(source));
  const block = page.blocks.length === 1 ? page.blocks[0] : undefined;
  if (!block || block.type !== "paragraph" || !("charRuns" in block)) {
    return { charRuns: literalRuns(source, identities) };
  }

  const mapping = new Map<string, string>();
  const chars: Char[] = [];
  for (const { id, char, deleted } of iterateAllChars(block.charRuns)) {
    if (deleted) continue;
    const next = identities.nextId();
    mapping.set(id, next);
    chars.push({ id: next, char });
  }

  const marks: MarkRange[] = [];
  for (const span of block.formats ?? []) {
    const startCharId = mapping.get(span.startCharId);
    const endCharId = mapping.get(span.endCharId);
    if (!startCharId || !endCharId) continue;
    marks.push({ startCharId, endCharId, format: span.format });
  }

  return { charRuns: charsToRuns(chars), marks };
}

/** Runs for text that must survive exactly as written, marks and all. */
function literalRuns(text: string, identities: IdentityAllocator): CharRun[] {
  const chars: Char[] = [];
  for (let offset = 0; offset < text.length; offset++) {
    chars.push({ id: identities.nextId(), char: text[offset] });
  }
  return charsToRuns(chars);
}

/** Build the whole seed a parsed table token turns into. */
export function tableSeedFromToken(
  table: GfmTable,
  identities: IdentityAllocator,
): TableSeed {
  return {
    aligns: table.aligns,
    rows: table.rows.map((row) =>
      row.map((cell) => cellSeedFromMarkdown(cell, identities)),
    ),
  };
}

/** The delimiter cell that encodes one column's alignment. */
function delimiterFor(align: TableAlign | null): string {
  switch (align) {
    case "left":
      return ":---";
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}

/**
 * Escape one rendered cell for a table row: a pipe would end the cell, and a
 * newline would end the row.
 */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Print a table as GFM. `rows[0]` is emitted as the header, which GFM always
 * has; a table with no columns prints as nothing at all.
 */
export function printGfmTable(
  aligns: readonly (TableAlign | null)[],
  rows: readonly (readonly string[])[],
): string {
  const width = Math.max(aligns.length, ...rows.map((row) => row.length), 0);
  if (width === 0) return "";

  const line = (cells: readonly string[]): string =>
    `| ${fit([...cells], width)
      .map((cell) => escapeCell(cell))
      .join(" | ")} |`;

  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const delimiters = Array.from({ length: width }, (_, at) =>
    delimiterFor(aligns[at] ?? null),
  );

  return [
    line(header),
    `| ${delimiters.join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}
