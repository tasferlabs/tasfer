/**
 * Hybrid Logical Clock (HLC) Implementation
 *
 * Pure Lamport clock with peer ID for total ordering:
 * - Monotonically increasing counters
 * - Causality tracking (happens-before relationships)
 * - Total ordering of events across distributed peers
 *
 * No wall clock dependency - immune to system clock skew.
 * Comparison order: counter → peerId (lexicographic)
 */

import type { HLC } from "./types";

/**
 * Create a new HLC initialized to zero.
 */
export function createHLC(peerId: string): HLC {
  return {
    counter: 0,
    peerId,
  };
}

/**
 * Increment the clock for a local event.
 * Returns a new HLC that is guaranteed to be greater than the current one.
 */
export function tickHLC(current: HLC): HLC {
  return {
    counter: current.counter + 1,
    peerId: current.peerId,
  };
}

/**
 * Receive a remote clock and merge with local clock.
 * Returns a new HLC that is greater than both local and remote.
 * Used when receiving operations from other peers.
 */
export function receiveHLC(local: HLC, remote: HLC): HLC {
  return {
    counter: Math.max(local.counter, remote.counter) + 1,
    peerId: local.peerId,
  };
}

/**
 * Compare two HLCs for total ordering.
 * Returns:
 *   - negative if a < b
 *   - positive if a > b
 *   - 0 if a === b (should never happen with unique peer IDs)
 *
 * Comparison order: counter → peerId
 */
export function compareHLC(a: HLC, b: HLC): number {
  // Compare counter first
  if (a.counter !== b.counter) {
    return a.counter - b.counter;
  }

  // Compare peer ID (lexicographic)
  return a.peerId.localeCompare(b.peerId);
}

/**
 * Check if HLC a is strictly less than HLC b.
 */
export function isHLCLessThan(a: HLC, b: HLC): boolean {
  return compareHLC(a, b) < 0;
}

/**
 * Check if HLC a is less than or equal to HLC b.
 */
export function isHLCLessOrEqual(a: HLC, b: HLC): boolean {
  return compareHLC(a, b) <= 0;
}

/**
 * Check if two HLCs are equal.
 */
export function isHLCEqual(a: HLC, b: HLC): boolean {
  return a.counter === b.counter && a.peerId === b.peerId;
}

/**
 * Get the maximum of two HLCs.
 */
export function maxHLC(a: HLC, b: HLC): HLC {
  return compareHLC(a, b) >= 0 ? a : b;
}

/**
 * Serialize HLC to a string for storage or comparison.
 * Format: `${counter.toString(36)}-${peerId}`
 * Uses base36 for compact representation.
 */
export function serializeHLC(hlc: HLC): string {
  return `${hlc.counter.toString(36)}-${hlc.peerId}`;
}

/**
 * Deserialize HLC from string.
 */
export function deserializeHLC(str: string): HLC {
  const dashIndex = str.indexOf("-");
  const counterStr = str.slice(0, dashIndex);
  const peerId = str.slice(dashIndex + 1);
  return {
    counter: parseInt(counterStr, 36),
    peerId,
  };
}
