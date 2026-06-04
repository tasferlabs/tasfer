import type { HLC } from "../sync/sync";
import { IMAGE_DEFAULT_HEIGHT } from "../constants";
import { hasTextContent } from "../sync/block-registry";
import parsePage from "./parser";
import tokenizePage from "./tokenizer";

export interface BlockRuntimeState {
  id: string;
  cachedHeight?: number; // Cached rendered height
  cachedWidth?: number; // Width at which height was cached
  deleted?: boolean;
  afterId?: string | null;
}
export interface Heading extends BlockRuntimeState {
  type: "heading1" | "heading2" | "heading3";
  charRuns: CharRun[]; // Character runs (squashed CRDT storage)
  formats: FormatSpan[]; // Format spans reference char IDs
}
export interface Paragraph extends BlockRuntimeState {
  type: "paragraph";
  charRuns: CharRun[]; // Character runs (squashed CRDT storage)
  formats: FormatSpan[]; // Format spans reference char IDs
}

// List item blocks - support bullet, numbered, and todo lists with nesting
export interface BulletListItem extends BlockRuntimeState {
  type: "bullet_list";
  charRuns: CharRun[]; // Character runs (squashed CRDT storage)
  formats: FormatSpan[]; // Format spans reference char IDs
  indent: number; // 0-based indent level (0 = no indent)
}

export interface NumberedListItem extends BlockRuntimeState {
  type: "numbered_list";
  charRuns: CharRun[]; // Character runs (squashed CRDT storage)
  formats: FormatSpan[]; // Format spans reference char IDs
  indent: number; // 0-based indent level (0 = no indent)
}

export interface TodoListItem extends BlockRuntimeState {
  type: "todo_list";
  charRuns: CharRun[]; // Character runs (squashed CRDT storage)
  formats: FormatSpan[]; // Format spans reference char IDs
  checked: boolean;
  indent: number; // 0-based indent level (0 = no indent)
}

// Image block - full-width image that spans the entire canvas
// Note: cachedHeight/cachedWidth are transient runtime state, not persisted
export interface Image extends BlockRuntimeState {
  type: "image";
  url: string;
  alt?: string;
  // Image dimensions - if not specified, defaults to cover mode with full width and default height
  width?: number | "full"; // Width in pixels or 'full' for edge-to-edge
  height?: number; // Height in pixels (only used in cover mode)
  objectFit?: "cover" | "contain"; // How image should be fitted
}

// Line block - horizontal divider/separator
export interface Line extends BlockRuntimeState {
  type: "line";
}

// Math block - rendered LaTeX equation
export interface Math extends BlockRuntimeState {
  type: "math";
  latex: string;
  displayMode: boolean; // true = display/block mode, false = inline mode
}

// TODO: Normal inline image block (future implementation)
// export interface Image {
//   id: string;
//   type: "image";
//   url: string;
//   alt?: string;
//   cachedHeight?: number;
//   cachedWidth?: number;
// }

export interface TextFormat {
  type: "bold" | "italic" | "strikethrough" | "code" | "link" | "math";
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
export interface FormatSpan {
  startCharId: string;
  endCharId: string;
  format: TextFormat;
  clock: HLC; // For LWW conflict resolution
}

// Helper function to compare two TextFormat objects
export function areFormatsEqual(a: TextFormat, b: TextFormat): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "link" && b.type === "link") {
    return a.url === b.url;
  }
  return true;
}

// Helper function to compare two arrays of TextFormat objects
export function areFormatArraysEqual(
  a: TextFormat[] | undefined,
  b: TextFormat[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;

  // Sort both arrays by type for consistent comparison
  const sortedA = [...a].sort((x, y) => x.type.localeCompare(y.type));
  const sortedB = [...b].sort((x, y) => x.type.localeCompare(y.type));

  for (let i = 0; i < sortedA.length; i++) {
    if (!areFormatsEqual(sortedA[i], sortedB[i])) {
      return false;
    }
  }

  return true;
}

// Text blocks contain text content
export type TextBlock = Heading | Paragraph;

// List blocks contain list items with text content
export type ListBlock = BulletListItem | NumberedListItem | TodoListItem;

export type TextualBlock = TextBlock | ListBlock;

// Visual blocks contain visual content (images, lines, math, etc.)
export type VisualBlock = Image | Line | Math;

// Block is a union of all block types
export type Block = TextBlock | VisualBlock | ListBlock;

// Type guards
export function isTextualBlock(block: Block): block is TextualBlock {
  return hasTextContent(block.type);
}

export function isListBlock(block: Block): block is ListBlock {
  return (
    block.type === "bullet_list" ||
    block.type === "numbered_list" ||
    block.type === "todo_list"
  );
}

// Check if an image block is in default state (cover mode, full width, 300px height)
export function isImageDefault(block: Image): boolean {
  const width = block.width ?? "full";
  const height = block.height ?? IMAGE_DEFAULT_HEIGHT;
  const objectFit = block.objectFit ?? "cover";

  return width === "full" && height === 300 && objectFit === "cover";
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
export function parseFrontmatter(content: string): { content: string; metadata?: PageMetadata } {
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

  const hasValues = metadata.task || metadata.scheduledAt || metadata.duration != null || metadata.allDay != null || metadata.color;
  return { content: remaining, metadata: hasValues ? metadata : undefined };
}

export function loadPage(content: string): Page {
  const { content: body, metadata } = parseFrontmatter(content);
  const tokens = tokenizePage(body);
  const page = parsePage(tokens);
  if (metadata) page.metadata = metadata;
  return page;
}
