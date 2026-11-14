import { getBaseDataSchema } from "../baseDataSchema";
import type { CodeBlock } from "../nodes/code-block";
import type { ListBlock } from "../nodes/ListNode";
import type { QuoteBlock } from "../nodes/QuoteNode";
import type { TextBlock } from "../nodes/TextNode";
import type { VisualBlock } from "../rendering/nodes/AtomicNode";
import type { BlockRuntimeState } from "../rendering/nodes/Node";
import { generateNKeysBetween } from "../sync/fractional-index";
import { areMarksEqual, markKey } from "../sync/mark-spans";
import type { DataSchema } from "../sync/schema";
import type { HLC } from "../sync/sync";
import { normalizeBlocks } from "./normalize";
import parsePage from "./parser";
import tokenizePage from "./tokenizer";

/**
 * An inline mark on a run of characters. `type` is the mark's name. The
 * built-in ones are `strong`, `emphasis`, `strike`, `code` and `link`. It is a
 * plain string, so custom marks and marks from optional packages, like `math`,
 * fit too. Mark data, like a link's `url`, goes in `attrs`. Simple on/off marks
 * have no `attrs`.
 *
 * @group Document
 */
export interface Mark {
  type: string;
  /** Per-mark data, e.g. `{ url }` for a link. Absent for toggle marks. */
  attrs?: Record<string, unknown>;
}

// CRDT character with unique ID (legacy - kept for operation payloads)
export interface Char {
  id: string; // Unique ID: "peerId:counter"
  char: string; // Single character
  deleted?: boolean; // Tombstone flag for CRDT deletions
}

/**
 * CharRun represents consecutive characters from the same peer.
 * Each character's ID is computed as: `${peerId}:${startCounter + offset}`
 * where offset is the character's position within the run (0-indexed).
 */
export interface CharRun {
  peerId: string; // Peer that created these chars
  startCounter: number; // Counter of first char in run
  text: string; // Multiple chars as string (e.g., "Hello")
  deletedMask?: number[]; // Bitmask: bit i set = char at offset i is deleted
}

/**
 * A mark on a range of characters. The range is kept as the ids of its first
 * and last character, so it stays in place while others edit. Either end may be
 * a deleted character. The mark still covers the characters left between them.
 *
 * @group Document
 */
export interface MarkRange {
  startCharId: string;
  endCharId: string;
  format: Mark;
}

// Format span that references characters by ID
export interface MarkSpan extends MarkRange {
  clock: HLC; // For LWW conflict resolution
}

/**
 * Mark identity/equality lives in `sync/mark-spans` — a leaf module the mark
 * algebra can be imported from anywhere in the load order (this module pulls in
 * the parser and the base schema at runtime, so nothing early may import it).
 * Re-exported here because this is where callers have always found them.
 */
export { areMarksEqual, markKey };

// Helper function to compare two arrays of Mark objects
export function areMarkArraysEqual(
  a: Mark[] | undefined,
  b: Mark[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;

  // Sort both arrays by type for consistent comparison
  const sortedA = [...a].sort((x, y) => x.type.localeCompare(y.type));
  const sortedB = [...b].sort((x, y) => x.type.localeCompare(y.type));

  for (let i = 0; i < sortedA.length; i++) {
    if (!areMarksEqual(sortedA[i], sortedB[i])) {
      return false;
    }
  }

  return true;
}

/**
 * One block of a document as the editor stores it: a paragraph or heading, a
 * list item, a code block, a quote, an image or a divider. The type lists only
 * these built-in blocks.
 *
 * Blocks from optional packages and custom types have the same shape, with
 * their own `type` name and their extra fields at the top level. In a custom
 * type's code, read them as a {@link CustomBlock}.
 *
 * @group Document
 */
// The union is closed on purpose: an open member with a non-literal `type`
// would break every `block.type === "…"` check in the engine. Custom blocks are
// cast to Block where the type is defined (defineNode); general engine code
// only touches shared fields.
export type Block =
  TextBlock | VisualBlock | ListBlock | CodeBlock | QuoteBlock;

/**
 * A custom block as its own code sees it (see {@link defineNode}). It has the
 * fields every block shares, optional text (`charRuns` and `formats`) for
 * custom blocks that hold text, and any other fields the node declares. In a
 * custom type's code, cast the incoming `Block` to `CustomBlock` to read them.
 *
 * @group Document
 */
export interface CustomBlock extends BlockRuntimeState {
  type: string;
  charRuns?: CharRun[];
  formats?: MarkSpan[];
  [key: string]: unknown;
}

/**
 * Treat a custom (CustomBlock-shaped) object as a `Block` at the extension
 * boundary. The runtime object is unchanged; this only crosses the type
 * boundary the closed `Block` union otherwise forbids.
 */
export function asBlock(block: CustomBlock): Block {
  return block as unknown as Block;
}

/**
 * Optional page details read from the front matter (the `---` section at the
 * top of a Markdown file): color, scheduled time, duration, all-day flag and
 * whether the page is a task.
 */
export interface PageMetadata {
  color?: string | null;
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
  task?: boolean;
}

/**
 * A whole document in its loaded form: an `id`, a `title`, its blocks in order,
 * and optional {@link PageMetadata}. This is what {@link parsePage} returns.
 *
 * @group Document
 */
export interface Page {
  id: string;
  title: String;
  blocks: Block[];
  metadata?: PageMetadata;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * Takes the front matter (the `---` section at the top) off a Markdown file.
 * Returns the rest of the text as `content` and the page details as `metadata`.
 * Only `task`, `scheduledAt`, `duration`, `allDay` and `color` are read. Other
 * keys are ignored. `metadata` is left out when there is no front matter or it
 * sets none of these.
 *
 * @group Serialization
 */
export function parseFrontmatter(content: string): {
  content: string;
  metadata?: PageMetadata;
} {
  // CRLF-tolerant: markdown authored on Windows still gets its frontmatter
  // parsed rather than falling through as body content.
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) return { content };

  const frontmatterBody = match[1] ?? "";
  const remaining = content.slice(match[0].length);

  const metadata: PageMetadata = {};
  for (const line of frontmatterBody.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (key === "task") metadata.task = value === "true";
    else if (key === "scheduledAt" && value) metadata.scheduledAt = value;
    else if (key === "duration" && value) metadata.duration = Number(value);
    else if (key === "allDay") metadata.allDay = value === "true";
    else if (key === "color" && value) metadata.color = value;
  }

  const hasValues =
    metadata.task ||
    metadata.scheduledAt ||
    metadata.duration != null ||
    metadata.allDay != null ||
    metadata.color;
  return { content: remaining, metadata: hasValues ? metadata : undefined };
}

export function loadPage(
  content: string,
  schema?: DataSchema,
  untypedBlockIds?: Set<string>,
): Page {
  // Schema-optional callers get the core block/mark set. Optional features
  // (math) are opted into by passing an explicit schema.
  schema ??= getBaseDataSchema();
  const { content: body, metadata } = parseFrontmatter(content);
  const tokens = tokenizePage(body, schema);
  const page = parsePage(tokens, schema, untypedBlockIds);
  if (metadata) page.metadata = metadata;
  // Coerce the parsed blocks to the schema's authoring allow-list — the import
  // analogue of paste normalization (a no-op for an unrestricted schema, so the
  // body editor is unaffected). parsePage already guarantees ≥1 block; if every
  // block is a disallowed void type and gets dropped, seed one empty fallback
  // block (reusing the first block's identity) so the page is never empty.
  if (schema) {
    const normalized = normalizeBlocks(page.blocks, schema);
    if (normalized.length > 0) {
      page.blocks = normalized;
    } else {
      const first = page.blocks[0];
      const seeded = first
        ? schema.createDefaultBlock(
            schema.fallbackBlockType(),
            first.id,
            first.orderKey ?? "",
          )
        : undefined;
      if (seeded) page.blocks = [seeded];
    }
    fillPageToContent(page, schema);
  }
  return page;
}

/**
 * Append the blocks a schema's `content` expression still requires. Import is
 * the one normalization path allowed to mint ids — `normalizeBlocks` is
 * contractually id-free so peers converge — so the shape rule's tail is filled
 * here, deterministically: ids continue the parser's `block-N` sequence and the
 * fractional-index keys are re-spread over the final list, exactly as
 * `parsePage` assigns them. A no-op for a schema with no expression.
 */
function fillPageToContent(page: Page, schema: DataSchema): void {
  const fill = schema.contentFill(page.blocks.map((block) => block.type));
  if (!fill || fill.length === 0) return;

  let counter = 0;
  for (const block of page.blocks) {
    const parsed = /^block-(\d+)$/.exec(block.id);
    if (parsed) counter = Math.max(counter, Number(parsed[1]) + 1);
  }
  const appended: Block[] = [];
  for (const type of fill) {
    const block = schema.createDefaultBlock(type, `block-${counter++}`, "");
    if (block) appended.push(block);
  }
  if (appended.length === 0) return;

  page.blocks = [...page.blocks, ...appended];
  const keys = generateNKeysBetween(null, null, page.blocks.length);
  for (let i = 0; i < page.blocks.length; i++) {
    page.blocks[i].orderKey = keys[i];
  }
}
/**
 * Type guard for the bullet/numbered/todo list family. Lives here, next to the
 * `Block`/`ListBlock` types it guards, rather than in `ListNode` — the view
 * extends `TextNode`, so co-locating the predicate there made every
 * lightweight consumer (state-utils, selection, serializers, …) pull in the
 * whole inheritance chain and created an init-time import cycle.
 */

export function isListBlock(block: Block): block is ListBlock {
  return (
    block.type === "bullet_list" ||
    block.type === "numbered_list" ||
    block.type === "todo_list"
  );
}
