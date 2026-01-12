/**
 * Hybrid Logical Clock (HLC) Implementation
 *
 * HLCs combine physical wall clock time with a logical counter to provide:
 * - Monotonically increasing timestamps
 * - Causality tracking (happens-before relationships)
 * - Total ordering of events across distributed peers
 *
 * Comparison order: wall → logical → peerId (lexicographic)
 */

import type { HLC } from "./types";

/**
 * Create a new HLC initialized to the current time.
 */
export function createHLC(peerId: string): HLC {
  return {
    wall: Date.now(),
    logical: 0,
    peerId,
  };
}

/**
 * Increment the clock for a local event.
 * Returns a new HLC that is guaranteed to be greater than the current one.
 */
export function tickHLC(current: HLC): HLC {
  const now = Date.now();

  if (now > current.wall) {
    // Wall clock moved forward, reset logical counter
    return {
      wall: now,
      logical: 0,
      peerId: current.peerId,
    };
  } else {
    // Wall clock is same or behind, increment logical counter
    return {
      wall: current.wall,
      logical: current.logical + 1,
      peerId: current.peerId,
    };
  }
}

/**
 * Receive a remote clock and merge with local clock.
 * Returns a new HLC that is greater than both local and remote.
 * Used when receiving operations from other peers.
 */
export function receiveHLC(local: HLC, remote: HLC): HLC {
  const now = Date.now();
  const maxWall = Math.max(now, local.wall, remote.wall);

  if (maxWall === now && now > local.wall && now > remote.wall) {
    // Current time is ahead of both clocks
    return {
      wall: now,
      logical: 0,
      peerId: local.peerId,
    };
  } else if (maxWall === local.wall && local.wall === remote.wall) {
    // All three are the same, increment from max logical
    return {
      wall: maxWall,
      logical: Math.max(local.logical, remote.logical) + 1,
      peerId: local.peerId,
    };
  } else if (maxWall === local.wall) {
    // Local wall is max
    return {
      wall: maxWall,
      logical: local.logical + 1,
      peerId: local.peerId,
    };
  } else if (maxWall === remote.wall) {
    // Remote wall is max
    return {
      wall: maxWall,
      logical: remote.logical + 1,
      peerId: local.peerId,
    };
  } else {
    // now is max but not strictly greater than both (equal to one)
    return {
      wall: maxWall,
      logical: 0,
      peerId: local.peerId,
    };
  }
}

/**
 * Compare two HLCs for total ordering.
 * Returns:
 *   - negative if a < b
 *   - positive if a > b
 *   - 0 if a === b (should never happen with unique peer IDs)
 *
 * Comparison order: wall → logical → peerId
 */
export function compareHLC(a: HLC, b: HLC): number {
  // Compare wall time first
  if (a.wall !== b.wall) {
    return a.wall - b.wall;
  }

  // Compare logical counter
  if (a.logical !== b.logical) {
    return a.logical - b.logical;
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
  return a.wall === b.wall && a.logical === b.logical && a.peerId === b.peerId;
}

/**
 * Get the maximum of two HLCs.
 */
export function maxHLC(a: HLC, b: HLC): HLC {
  return compareHLC(a, b) >= 0 ? a : b;
}

/**
 * Serialize HLC to a string for storage or comparison.
 * Format: `${wall.toString(36)}-${logical.toString(36)}-${peerId}`
 * Uses base36 for compact representation.
 */
export function serializeHLC(hlc: HLC): string {
  return `${hlc.wall.toString(36)}-${hlc.logical.toString(36)}-${hlc.peerId}`;
}

/**
 * Deserialize HLC from string.
 */
export function deserializeHLC(str: string): HLC {
  const [wallStr, logicalStr, peerId] = str.split("-");
  return {
    wall: parseInt(wallStr, 36),
    logical: parseInt(logicalStr, 36),
    peerId,
  };
}
