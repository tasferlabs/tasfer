/**
 * Operation Log Management
 *
 * Manages the operation log for a page:
 * - Stores operations in HLC order
 * - Tracks version vectors for sync
 * - Maintains computed state
 * - Provides delta sync operations
 */

import type { OpLog, Operation, VersionVector } from "./types";
import { compareHLC } from "./hlc";
import { extractPeerId, extractCounter } from "./id";
import { applyOp, createEmptyPageState, rebuildState } from "./reducer";

/**
 * Create an empty operation log for a page.
 */
export function createOpLog(pageId: string): OpLog {
  return {
    pageId,
    operations: [],
    versionVector: new Map(),
    state: createEmptyPageState(pageId),
  };
}

/**
 * Update version vector with a new operation.
 * Tracks the highest counter seen from each peer.
 */
export function updateVersionVector(
  vv: VersionVector,
  op: Operation
): VersionVector {
  const peerId = extractPeerId(op.id);
  const counter = extractCounter(op.id);

  const newVV = new Map(vv);
  const current = newVV.get(peerId) ?? -1;

  if (counter > current) {
    newVV.set(peerId, counter);
  }

  return newVV;
}

/**
 * Check if an operation is already known (in version vector).
 */
export function isOpKnown(vv: VersionVector, op: Operation): boolean {
  const peerId = extractPeerId(op.id);
  const counter = extractCounter(op.id);
  const known = vv.get(peerId) ?? -1;

  return counter <= known;
}

/**
 * Append a local operation to the log.
 * Updates version vector and state.
 */
export function appendOp(log: OpLog, op: Operation): OpLog {
  // Check if operation already exists
  if (isOpKnown(log.versionVector, op)) {
    return log;
  }

  // Insert operation in HLC order
  const newOps = [...log.operations];
  let insertIndex = newOps.length;

  // Find correct position (binary search would be more efficient for large logs)
  for (let i = newOps.length - 1; i >= 0; i--) {
    if (compareHLC(newOps[i].clock, op.clock) <= 0) {
      insertIndex = i + 1;
      break;
    }
    insertIndex = i;
  }

  newOps.splice(insertIndex, 0, op);

  // Update version vector
  const newVV = updateVersionVector(log.versionVector, op);

  // Apply operation to state
  const newState = applyOp(log.state, op);

  return {
    ...log,
    operations: newOps,
    versionVector: newVV,
    state: newState,
  };
}

/**
 * Merge remote operations into the log.
 * Filters out already-known operations and rebuilds state if needed.
 *
 * @param log - Current operation log
 * @param ops - Remote operations to merge
 * @returns Updated operation log
 */
export function mergeOps(log: OpLog, ops: Operation[]): OpLog {
  // Filter out already-known operations
  const newOps = ops.filter((op) => !isOpKnown(log.versionVector, op));

  if (newOps.length === 0) {
    return log;
  }

  // Add all new operations
  const allOps = [...log.operations, ...newOps];

  // Sort by HLC
  allOps.sort((a, b) => compareHLC(a.clock, b.clock));

  // Update version vector
  let newVV = new Map(log.versionVector);
  for (const op of newOps) {
    newVV = updateVersionVector(newVV, op);
  }

  // Rebuild state from all operations
  // (This is simpler but less efficient than incremental apply)
  const newState = rebuildState(log.pageId, allOps);

  return {
    ...log,
    operations: allOps,
    versionVector: newVV,
    state: newState,
  };
}

/**
 * Get operations that a peer is missing based on their version vector.
 *
 * @param log - Current operation log
 * @param peerVV - Peer's version vector
 * @returns Operations the peer needs
 */
export function getOpsSince(log: OpLog, peerVV: VersionVector): Operation[] {
  return log.operations.filter((op) => {
    const peerId = extractPeerId(op.id);
    const counter = extractCounter(op.id);
    const peerKnows = peerVV.get(peerId) ?? -1;

    return counter > peerKnows;
  });
}

/**
 * Merge two version vectors, taking the max of each peer's counter.
 */
export function mergeVersionVectors(
  a: VersionVector,
  b: VersionVector
): VersionVector {
  const result = new Map(a);

  for (const [peer, counter] of b) {
    const current = result.get(peer) ?? -1;
    result.set(peer, Math.max(current, counter));
  }

  return result;
}

/**
 * Check if version vector A dominates B (A has seen everything B has seen).
 */
export function vvDominates(a: VersionVector, b: VersionVector): boolean {
  for (const [peer, counter] of b) {
    const aCounter = a.get(peer) ?? -1;
    if (aCounter < counter) {
      return false;
    }
  }
  return true;
}

/**
 * Check if two version vectors are equal.
 */
export function vvEquals(a: VersionVector, b: VersionVector): boolean {
  if (a.size !== b.size) return false;

  for (const [peer, counter] of a) {
    if (b.get(peer) !== counter) {
      return false;
    }
  }

  return true;
}

/**
 * Serialize version vector to JSON-compatible format.
 */
export function serializeVV(vv: VersionVector): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [peer, counter] of vv) {
    result[peer] = counter;
  }
  return result;
}

/**
 * Deserialize version vector from JSON format.
 */
export function deserializeVV(obj: Record<string, number>): VersionVector {
  return new Map(Object.entries(obj));
}

/**
 * Get operation count by peer.
 */
export function getOpCountByPeer(log: OpLog): Map<string, number> {
  const counts = new Map<string, number>();

  for (const op of log.operations) {
    const peerId = extractPeerId(op.id);
    counts.set(peerId, (counts.get(peerId) ?? 0) + 1);
  }

  return counts;
}

/**
 * Get the latest operation from the log.
 */
export function getLatestOp(log: OpLog): Operation | undefined {
  if (log.operations.length === 0) {
    return undefined;
  }
  return log.operations[log.operations.length - 1];
}
