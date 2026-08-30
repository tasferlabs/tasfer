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
 * An inline mark applied to a run of characters. `type` is the mark's name —
 * built-ins are `strong`/`emphasis`/`strike`/`code`/`link`/`math`, but the
 * field is intentionally `string` (not a closed union) so a schema can register
 * custom marks. Per-mark data (e.g. a link's href) lives in `attrs`; plain
 * toggle marks carry none.
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
 * A mark anchored to a character range by CRDT id — the shape shared by every
 * store that keeps inline marks. Both endpoints may be tombstoned; resolution
 * is tolerant (see `mark-runs.ts`).
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

// Block is a union of the core block types. It is deliberately CLOSED: an
// open member with a non-literal `type` would de-discriminate the union and
// break every `block.type === "…"` narrow across the engine.
//
// Optional-feature and custom (schema-registered) block types are represented at runtime as
// Block-shaped objects whose `type` is a custom name and whose extra fields are
// top-level keys. They reach the closed `Block` type via a cast at the
// `defineNode` boundary (`asBlock`); the generic engine code only ever touches
// the shared `BlockRuntimeState` fields and dispatches the rest to the type's
// codec/descriptor/node, which narrow back to their own `CustomBlock` view.
export type Block =
  TextBlock | VisualBlock | ListBlock | CodeBlock | QuoteBlock;

/**
 * The author-facing view of a custom block (see `defineNode`). Carries the
 * shared runtime fields, optional text (`charRuns`/`formats` for text-bearing
 * custom nodes), and an index signature for the node's declared attrs. A
 * custom type's codec/descriptor/node casts the incoming `Block` to this shape.
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

export interface PageMetadata {
  color?: string | null;
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
  task?: boolean;
}

export interface Page {
  id: string;
  title: String;
  blocks: Block[];
  metadata?: PageMetadata;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * Strip YAML frontmatter from markdown and parse metadata.
 * Returns the content without frontmatter and any parsed metadata.
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
