/**
 * Core CRDT Types for P2P Offline-Tolerant Live Updates
 *
 * This module defines the type system for a custom operation-log CRDT
 * optimized for block-based editors.
 */

import type {
  Block,
  Char,
  TextFormat,
} from "@/deserializer/loadPage";

// =============================================================================
// Hybrid Logical Clock (HLC)
// =============================================================================

/**
 * Hybrid Logical Clock for total ordering of operations.
 * Combines physical wall clock with logical counter for causality.
 */
export interface HLC {
  /** Physical wall clock time (Date.now()) */
  wall: number;
  /** Logical counter - increments when wall time equals previous */
  logical: number;
  /** Peer ID - tie-breaker for concurrent operations */
  peerId: string;
}

// =============================================================================
// Character-Level CRDT (RGA-style)
// =============================================================================

// =============================================================================
// Formatting
// =============================================================================

// =============================================================================
// Block Types
// =============================================================================

/** Supported block types matching the editor */
export type BlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullet_list"
  | "numbered_list"
  | "todo_list"
  | "image"
  | "line";

/**
 * Block properties that can be set via BlockSet operation.
 */
export interface BlockProps {
  /** List item indentation level */
  indent?: number;
  /** Todo item checked state */
  checked?: boolean;
  /** Image URL */
  url?: string;
  /** Image alt text */
  alt?: string;
  /** Image width */
  width?: number | "full";
  /** Image height */
  height?: number;
  /** Image object fit */
  objectFit?: "cover" | "contain";
}

// =============================================================================
// Page State
// =============================================================================

/**
 * Computed page state derived from operations.
 */
export interface PageState {
  /** Page ID */
  id: string;
  /** Page title */
  title: string;
  /** Ordered array of blocks (non-deleted, resolved from linked list) */
  blocks: Block[];
}

// =============================================================================
// Operations
// =============================================================================

/**
 * Base operation fields shared by all operation types.
 */
export interface BaseOp {
  /** Unique operation ID: `${peerId}:${counter}` */
  id: string;
  /** Hybrid logical clock timestamp */
  clock: HLC;
  /** Page this operation belongs to */
  pageId: string;
}

/**
 * Insert characters into a block's text content.
 */
export interface TextInsert extends BaseOp {
  op: "text_insert";
  /** Block to insert into */
  blockId: string;
  /** Insert after this character ID (null = beginning) */
  afterCharId: string | null;
  /** Characters to insert with their IDs */
  chars: Char[];
}

/**
 * Delete characters from a block (tombstone).
 */
export interface TextDelete extends BaseOp {
  op: "text_delete";
  /** Block to delete from */
  blockId: string;
  /** Character IDs to mark as deleted */
  charIds: string[];
}

/**
 * Set formatting on a range of characters.
 */
export interface FormatSet extends BaseOp {
  op: "format_set";
  /** Block containing the characters */
  blockId: string;
  /** Character IDs to format */
  charIds: string[];
  /** Format to apply */
  format: TextFormat;
  /** Format value (true/false for toggles, URL for links) */
  value: boolean | string;
}

/**
 * Insert a new block into the document.
 */
export interface BlockInsert extends BaseOp {
  op: "block_insert";
  /** Insert after this block ID (null = beginning) */
  afterBlockId: string | null;
  /** New block's unique ID */
  blockId: string;
  /** Block type */
  blockType: BlockType;
  /** Initial block properties */
  initialProps?: BlockProps;
}

/**
 * Delete a block (tombstone).
 */
export interface BlockDelete extends BaseOp {
  op: "block_delete";
  /** Block ID to mark as deleted */
  blockId: string;
}

/**
 * Set a block property (type, indent, checked, etc.).
 */
export interface BlockSet extends BaseOp {
  op: "block_set";
  /** Block to update */
  blockId: string;
  /** Property field name */
  field: string;
  /** New property value */
  value: unknown;
}

/**
 * Union of all operation types.
 */
export type Operation =
  | TextInsert
  | TextDelete
  | FormatSet
  | BlockInsert
  | BlockDelete
  | BlockSet;

// =============================================================================
// Sync Protocol
// =============================================================================

/**
 * Version vector tracking seen operations per peer.
 * Maps peer ID to highest operation counter seen from that peer.
 */
export type VersionVector = Map<string, number>;

/**
 * Operation log for a page.
 */
export interface OpLog {
  /** Page ID */
  pageId: string;
  /** All operations ordered by HLC */
  operations: Operation[];
  /** Version vector of seen operations */
  versionVector: VersionVector;
  /** Computed state from operations */
  state: PageState;
}

// =============================================================================
// Type Guards
// =============================================================================

export function isTextInsert(op: Operation): op is TextInsert {
  return op.op === "text_insert";
}

export function isTextDelete(op: Operation): op is TextDelete {
  return op.op === "text_delete";
}

export function isFormatSet(op: Operation): op is FormatSet {
  return op.op === "format_set";
}

export function isBlockInsert(op: Operation): op is BlockInsert {
  return op.op === "block_insert";
}

export function isBlockDelete(op: Operation): op is BlockDelete {
  return op.op === "block_delete";
}

export function isBlockSet(op: Operation): op is BlockSet {
  return op.op === "block_set";
}
