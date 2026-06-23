/**
 * Operation Log Management
 *
 * Manages the operation log for a page:
 * - Stores operations in HLC order
 * - Tracks version vectors for sync
 * - Maintains computed state
 * - Provides delta sync operations
 *
 * ## Per-origin ordering invariant
 *
 * The version vector here is a max-only counter per peer. Op IDs from a
 * single origin can have GAPS (block_insert reserves 2 IDs, insertText
 * reserves text.length + 1), so the VV cannot distinguish "seen 8" from
 * "seen 2 then 8 — never saw the 3..7 we don't own".
 *
 * Callers MUST deliver ops from a single origin in counter order. If a
 * downstream peer applies p000:8 before p000:2, the VV jumps to 8 and
 * isOpKnown silently drops p000:2 (2 <= 8 = true).
 *
 * The transport stack preserves this invariant:
 *   - WebRTC DataChannels are created with { ordered: true } (SCTP-ordered).
 *   - The chunk reassembler in webrtc.ts emits whole messages in arrival
 *     order; ordered SCTP means arrival order == send order per channel.
 *   - Each PageOps / SyncData message carries ops in per-origin counter
 *     order (real-time push uses the editor's local oplog which is
 *     monotonic per origin; catch-up uses `ORDER BY clock` from SQLite).
 *   - The Replicator serializes incoming message handlers per peer via
 *     `peer.msgQueue` so handleMessage calls from one connection don't
 *     interleave.
 *
 * If you change the transport, a different replication strategy, or batch
 * ops differently — re-evaluate this invariant. Option for the future:
 * gap-tracking VV (Map<peerId, { ceiling: number; seen: Set<number> }>)
 * which makes the protocol robust to any delivery order at the cost of
 * a richer wire format. Not implemented today because the transport
 * already provides ordering.
 */

import { baseDataSchema } from "../baseDataSchema";
import { IS_DEV } from "../env";
import type { Operation, OpLog, VersionVector } from "../state-types";
import { compareHLC } from "./hlc";
import { extractCounter, extractPeerId } from "./id";
import { applyOp, createEmptyPageState, rebuildState } from "./reducer";
import type { DataSchema } from "./schema";

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
  op: Operation,
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
export function appendOp(
  log: OpLog,
  op: Operation,
  schema: DataSchema = baseDataSchema,
): OpLog {
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
  const newState = applyOp(log.state, op, schema);

  return {
    ...log,
    operations: newOps,
    versionVector: newVV,
    state: newState,
  };
}

/**
 * Register operations that are already reflected in the log's materialized
 * state. This is the snapshot hydration path: it updates the operation log and
 * version vector without applying the operations to `state` again.
 *
 * The input must obey the same per-origin ordering invariant as `mergeOps`.
 */
export function registerAppliedOps(log: OpLog, ops: Operation[]): OpLog {
  if (ops.length === 0) return log;
  if (IS_DEV) assertPerOriginOrder(ops);

  const versionVector = new Map(log.versionVector);
  const fresh: Operation[] = [];

  for (const op of ops) {
    const peerId = extractPeerId(op.id);
    const counter = extractCounter(op.id);
    const known = versionVector.get(peerId) ?? -1;
    if (counter <= known) continue;

    fresh.push(op);
    versionVector.set(peerId, counter);
  }

  if (fresh.length === 0) return log;
  fresh.sort((a, b) => compareHLC(a.clock, b.clock));

  return {
    ...log,
    operations: mergeSortedOps(log.operations, fresh),
    versionVector,
  };
}

/**
 * Merge remote operations into the log.
 *
 * Fast path (every new op sorts strictly after every existing op): fold
 * applyOp incrementally over newOps. insertIntoRuns is locally RGA-correct
 * so concurrent same-anchor inserts converge in this path.
 *
 * Slow path (any new op interleaves with the existing log): replay the full
 * HLC-sorted log via rebuildState. This is the safety net for cases the
 * apply-time reducer cannot resolve locally — text_insert ops referencing
 * an afterCharId whose creating op hasn't been applied yet, mark_set
 * overlaps with non-LWW order dependence, and similar reorder hazards.
 *
 * @param log - Current operation log
 * @param ops - Remote operations to merge
 * @returns Updated operation log
 */
export function mergeOps(
  log: OpLog,
  ops: Operation[],
  schema: DataSchema = baseDataSchema,
): OpLog {
  if (IS_DEV) assertPerOriginOrder(ops);

  const newOps = ops.filter((op) => !isOpKnown(log.versionVector, op));

  if (newOps.length === 0) {
    return log;
  }

  newOps.sort((a, b) => compareHLC(a.clock, b.clock));

  let newVV = new Map(log.versionVector);
  for (const op of newOps) {
    newVV = updateVersionVector(newVV, op);
  }

  const lastExisting =
    log.operations.length > 0
      ? log.operations[log.operations.length - 1]
      : null;
  const canApplyIncrementally =
    !lastExisting || compareHLC(lastExisting.clock, newOps[0].clock) < 0;

  if (canApplyIncrementally) {
    let state = log.state;
    for (const op of newOps) {
      state = applyOp(state, op, schema);
    }

    const allOps = mergeSortedOps(log.operations, newOps);

    if (IS_DEV) {
      const rebuilt = rebuildState(log.pageId, allOps, schema);
      if (JSON.stringify(state) !== JSON.stringify(rebuilt)) {
        console.error(
          `[mergeOps] incremental state diverged from rebuilt state for page ${log.pageId}; new op ids: ${newOps.map((o) => o.id).join(", ")}`,
        );
      }
    }

    return { ...log, operations: allOps, versionVector: newVV, state };
  }

  const allOps = mergeSortedOps(log.operations, newOps);
  const state = rebuildState(log.pageId, allOps, schema);
  return { ...log, operations: allOps, versionVector: newVV, state };
}

/**
 * Dev-only invariant check: ops from a single origin in a batch must be in
 * counter-ascending order. If a batch contains p000:8 before p000:2, the
 * max-only VV will jump to 8 and silently drop p000:2 on arrival. The
 * transport (ordered WebRTC DataChannels + serialized handler queues) is
 * responsible for preserving this; this assertion catches regressions.
 */
function assertPerOriginOrder(ops: Operation[]): void {
  const lastByPeer = new Map<string, number>();
  for (const op of ops) {
    const peerId = extractPeerId(op.id);
    const counter = extractCounter(op.id);
    const prev = lastByPeer.get(peerId);
    if (prev !== undefined && counter < prev) {
      console.error(
        `[mergeOps] per-origin order violated: peer=${peerId} counter ${counter} arrived after ${prev}. The VV is max-only; any op from ${peerId} with counter in (prev, max-of-batch] will be silently dropped.`,
      );
    }
    if (prev === undefined || counter > prev) lastByPeer.set(peerId, counter);
  }
}

function mergeSortedOps(a: Operation[], b: Operation[]): Operation[] {
  const out: Operation[] = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) {
    if (compareHLC(a[i].clock, b[j].clock) <= 0) {
      out[k++] = a[i++];
    } else {
      out[k++] = b[j++];
    }
  }
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
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
  b: VersionVector,
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
