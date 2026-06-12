import type { VisualBlock } from "../rendering/nodes/AtomicNode";
import type { ListBlock } from "../rendering/nodes/ListNode";
import type { BlockRuntimeState } from "../rendering/nodes/Node";
import type { TextBlock } from "../rendering/nodes/TextNode";
import type { DataSchema } from "../sync/schema";
import type { HLC } from "../sync/sync";
import parsePage from "./parser";
import tokenizePage from "./tokenizer";

export interface Mark {
  type: "strong" | "emphasis" | "strike" | "code" | "link" | "math";
  url?: string; // Only for link type
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

// Format span that references characters by ID
export interface MarkSpan {
  startCharId: string;
  endCharId: string;
  format: Mark;
  clock: HLC; // For LWW conflict resolution
}

// Helper function to compare two Mark objects
export function areMarksEqual(a: Mark, b: Mark): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "link" && b.type === "link") {
    return a.url === b.url;
  }
  return true;
}

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

// Block is a union of the built-in block types. It is deliberately CLOSED: an
// open member with a non-literal `type` would de-discriminate the union and
// break every `block.type === "…"` narrow across the engine.
//
// Custom (schema-registered) block types are represented at runtime as
// Block-shaped objects whose `type` is a custom name and whose extra fields are
// top-level keys. They reach the closed `Block` type via a cast at the
// `defineNode` boundary (`asBlock`); the generic engine code only ever touches
// the shared `BlockRuntimeState` fields and dispatches the rest to the type's
// codec/descriptor/node, which narrow back to their own `CustomBlock` view.
export type Block = TextBlock | VisualBlock | ListBlock;

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

/**
 * Strip YAML frontmatter from markdown and parse metadata.
 * Returns the content without frontmatter and any parsed metadata.
 */
export function parseFrontmatter(content: string): {
  content: string;
  metadata?: PageMetadata;
} {
  if (!content.startsWith("---\n")) return { content };

  const endIndex = content.indexOf("\n---\n", 4);
  if (endIndex === -1) return { content };

  const frontmatterBody = content.slice(4, endIndex);
  const remaining = content.slice(endIndex + 5);

  const metadata: PageMetadata = {};
  for (const line of frontmatterBody.split("\n")) {
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

export function loadPage(content: string, schema?: DataSchema): Page {
  const { content: body, metadata } = parseFrontmatter(content);
  const tokens = tokenizePage(body);
  const page = parsePage(tokens, schema);
  if (metadata) page.metadata = metadata;
  return page;
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
