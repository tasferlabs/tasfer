/**
 * Wire-level encoding helpers for the Replicator protocol.
 *
 * Three optimisations are applied transparently at encode/decode time so no
 * other code needs to change:
 *
 *  1. Op-type shortcodes — "text_insert"→"ti", "text_delete"→"td", etc.
 *     Saves 8-10 bytes per op; affects all messages that carry ops.
 *
 *  2. CharId run compression — consecutive IDs from the same peer are encoded
 *     as a [peerId, start, count] triple.  "abc1:100","abc1:101","abc1:102"
 *     → [["abc1",100,3]].  Only applied when the run encoding is shorter.
 *     Applies to text_delete and format_set charIds arrays.
 *
 *  3. Redundant pageId stripping — each Operation already carries its pageId
 *     (BaseOp.pageId), but that same value is also present as the message-
 *     level pageId (page-ops) or the pageOps record key (sync-data/sync-res).
 *     We drop it from each op on the wire and re-inject on decode.
 *
 * Binary asset frames use BINARY_ASSET_TAG — see handleAssetReq/handleBinaryAssetData
 * in sync.ts.
 */

// =============================================================================
// Binary asset framing
// =============================================================================

/**
 * Magic byte that prefixes binary asset-data frames sent over the DataChannel.
 * Any value that is NOT 0x7B ('{') works — JSON messages always start with '{'.
 *
 * Wire layout: [BINARY_ASSET_TAG][32 raw SHA-256 bytes][1 ext-len][ext bytes][raw asset data]
 */
export const BINARY_ASSET_TAG = 0xbd;

// =============================================================================
// Hex ↔ bytes utilities
// =============================================================================

/** Hex string → raw bytes. Strips dashes; falls back to UTF-8 for invalid input. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/-/g, "");
  if (/^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0) {
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
    }
    return bytes;
  }
  return new TextEncoder().encode(hex);
}

/** Raw bytes → lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

// =============================================================================
// Op-type shortcodes
// =============================================================================

/** Long op name → short wire code. */
export const OP_SHORT: Record<string, string> = {
  text_insert:  "ti",
  text_delete:  "td",
  format_set:   "fs",
  block_insert: "bi",
  block_delete: "bd",
  block_set:    "bs",
};

/** Short wire code → long op name. */
export const OP_LONG: Record<string, string> = Object.fromEntries(
  Object.entries(OP_SHORT).map(([k, v]) => [v, k]),
);

// =============================================================================
// CharId run compression
// =============================================================================

/** [peerId, startCounter, count] — compact representation of consecutive char IDs. */
export type CharRange = [string, number, number];

/**
 * Compress a flat charId array into runs.
 * ["abc1:100","abc1:101","abc1:102"] → [["abc1",100,3]]
 */
export function compressCharIds(ids: string[]): CharRange[] {
  const runs: CharRange[] = [];
  let curPeer = "";
  let runStart = 0;
  let runCount = 0;
  let prevCounter = -2;

  for (const id of ids) {
    const colon = id.indexOf(":");
    const peer = id.slice(0, colon);
    const counter = parseInt(id.slice(colon + 1), 10);

    if (peer === curPeer && counter === prevCounter + 1) {
      runCount++;
    } else {
      if (runCount > 0) runs.push([curPeer, runStart, runCount]);
      curPeer = peer;
      runStart = counter;
      runCount = 1;
    }
    prevCounter = counter;
  }
  if (runCount > 0) runs.push([curPeer, runStart, runCount]);
  return runs;
}

/** Expand runs back to a flat charId array. */
export function expandCharRanges(runs: CharRange[]): string[] {
  const ids: string[] = [];
  for (const [peer, start, count] of runs) {
    for (let i = 0; i < count; i++) ids.push(`${peer}:${start + i}`);
  }
  return ids;
}

// =============================================================================
// Op-level wire transformations
// =============================================================================

/**
 * Transform an operation for the wire:
 *  - Shorten the op type code
 *  - Strip pageId when it matches the message-level context (redundant)
 *  - Compress charIds to runs when it saves bytes
 */
export function compressOp(op: any, contextPageId?: string): any {
  const w: any = { ...op };

  if (w.op) w.op = OP_SHORT[w.op] ?? w.op;

  if (contextPageId && w.pageId === contextPageId) delete w.pageId;

  if (Array.isArray(w.charIds) && w.charIds.length > 1) {
    const runs = compressCharIds(w.charIds);
    // Each run is 3 elements; break-even at 3 ids/run
    if (runs.length * 3 < w.charIds.length) {
      w.cR = runs;
      delete w.charIds;
    }
  }

  return w;
}

/**
 * Restore an operation received from the wire:
 *  - Restore the full op type name
 *  - Re-inject pageId from message context if it was stripped
 *  - Expand charId runs back to flat array
 */
export function expandOp(raw: any, contextPageId?: string): any {
  const op: any = { ...raw };

  if (op.op) op.op = OP_LONG[op.op] ?? op.op;

  if (contextPageId && op.pageId === undefined) op.pageId = contextPageId;

  if (op.cR) {
    op.charIds = expandCharRanges(op.cR);
    delete op.cR;
  }

  return op;
}
