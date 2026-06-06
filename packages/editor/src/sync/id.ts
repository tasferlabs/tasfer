/**
 * ID Generation Utilities
 *
 * Provides unique ID generation for:
 * - Peer IDs (unique per device/session)
 * - Operation IDs (unique per operation)
 * - Block IDs (unique per block)
 * - Character IDs (unique per character)
 *
 * ID format: `${peerId}:${counter}` ensures global uniqueness
 * when peerId is unique.
 */

import type { Block } from "@/serlization/loadPage";
import { nanoid } from "nanoid";

/**
 * Generate a unique peer ID (6 URL-safe chars, 36 bits of entropy).
 */
export function generatePeerId(): string {
  return nanoid(6);
}

/**
 * Create an ID generator bound to a peer ID.
 * Returns a function that generates unique IDs in the format `${peerId}:${counter}`.
 *
 * @param peerId - The peer's unique identifier
 * @param startCounter - Optional starting counter (default: 0)
 * @returns A function that generates unique IDs
 *
 * @example
 * const genId = createIdGenerator("abc123");
 * genId(); // "abc123:0"
 * genId(); // "abc123:1"
 */
export type IdGenerator = (() => string) & {
  /**
   * Bump the counter so that the NEXT id returned has counter > `toAtLeast`.
   * No-op if the internal counter is already past `toAtLeast`.
   *
   * Used to keep the RGA sibling-tie-break invariant across sessions: the
   * sibling sort compares ids by counter-first (see `compareIds`), so new
   * ids must out-counter every id we've ever seen — otherwise a fresh
   * session (counter starting at 0) emits low-counter ids that the sort
   * places AFTER pre-existing siblings (counter from the original session),
   * pushing newly-split blocks / newly-typed chars to the end of the page.
   */
  advance: (toAtLeast: number) => void;
};

export function createIdGenerator(
  peerId: string,
  startCounter: number = 0,
): IdGenerator {
  let counter = startCounter;

  const gen = (() => {
    const id = `${peerId}:${counter}`;
    counter++;
    return id;
  }) as IdGenerator;

  gen.advance = (toAtLeast: number) => {
    if (toAtLeast >= counter) counter = toAtLeast + 1;
  };

  return gen;
}

/**
 * Extract the peer ID from a compound ID.
 *
 * @example
 * extractPeerId("abc123:42"); // "abc123"
 */
export function extractPeerId(id: string): string {
  const colonIndex = id.indexOf(":");
  if (colonIndex === -1) {
    return id;
  }
  return id.slice(0, colonIndex);
}

/**
 * Extract the counter from a compound ID.
 *
 * @example
 * extractCounter("abc123:42"); // 42
 */
export function extractCounter(id: string): number {
  const colonIndex = id.indexOf(":");
  if (colonIndex === -1) {
    return 0;
  }
  return parseInt(id.slice(colonIndex + 1), 10);
}

/**
 * Compare two IDs for ordering.
 * Orders by counter first (numerically), then by peerId (lexicographically).
 * This provides a deterministic total ordering.
 */
export function compareIds(a: string, b: string): number {
  const counterA = extractCounter(a);
  const counterB = extractCounter(b);

  if (counterA !== counterB) {
    return counterA - counterB;
  }

  const peerA = extractPeerId(a);
  const peerB = extractPeerId(b);

  return peerA.localeCompare(peerB);
}

/**
 * Generate a unique block ID.
 * Uses the ID generator to create block IDs with a "b" prefix for clarity.
 *
 * @param genId - ID generator function
 * @returns Block ID in format `b-${peerId}:${counter}`
 */
export function generateBlockId(genId: () => string): string {
  return `b-${genId()}`;
}

/**
 * Generate unique character IDs for a string.
 * Creates an array of CharData objects with unique IDs.
 *
 * @param genId - ID generator function
 * @param text - Text to generate character IDs for
 * @returns Array of CharData objects
 */
export function generateCharIds(
  genId: () => string,
  text: string,
): Array<{ id: string; char: string }> {
  return Array.from(text).map((char) => ({
    id: genId(),
    char,
  }));
}
/**
 * Compare two blocks for ordering.
 * Used to resolve concurrent inserts after the same block.
 * Orders by block ID for deterministic results.
 *
 * @returns negative if a < b, positive if a > b, 0 if equal
 */

export function compareBlocks(a: Block, b: Block): number {
  return compareIds(a.id, b.id);
}
