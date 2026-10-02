/**
 * DevLog — lightweight event bus for network message logging.
 * Only active while developer tools are enabled (Settings → Developer tools;
 * defaults on in staging). No-op otherwise.
 */

import { inSharedWorker, isDevToolsEnabled } from "@/lib/devToolsFlag";

export type NetDirection = "send" | "recv";

export interface NetLogEntry {
  id: number;
  direction: NetDirection;
  type: string;
  peer: string;
  summary: string;
  timestamp: number;
  size: number;
}

const MAX = 500;
let _id = 0;
let _entries: NetLogEntry[] = [];
let _listeners = new Set<() => void>();

function notify() {
  for (const fn of _listeners) fn();
}

/** Log a network message (send or receive). No-op unless developer tools are on. */
export function logNet(
  direction: NetDirection,
  peer: string,
  msg: { type: string },
  sizeBytes: number,
) {
  if (!isDevToolsEnabled()) return;

  const record: NetLogRecord = {
    direction,
    type: msg.type,
    peer: peer.slice(0, 8),
    summary: buildSummary(msg as Record<string, unknown>),
    timestamp: Date.now(),
    size: sizeBytes,
    ops: countOps(msg as Record<string, unknown>),
  };
  // No tab can read the worker's memory: hand the entry to the tabs instead.
  if (netLogChannel && inSharedWorker()) netLogChannel.postMessage(record);
  else ingest(record);
}

/** One logged message as it crosses from the engine's worker to a tab. */
interface NetLogRecord extends Omit<NetLogEntry, "id"> {
  /** CRDT ops the message carries. */
  ops: number;
}

function ingest(record: NetLogRecord) {
  const { ops, ...entry } = record;
  _entries.push({ id: ++_id, ...entry });
  if (_entries.length > MAX) _entries = _entries.slice(-MAX);
  recordPeerOps(entry.direction, entry.peer, ops, entry.timestamp);
  notify();
}

/**
 * In the browser the Replicator runs in the engine's SharedWorker (see
 * `adapters/node.sharedworker.ts`), so its `logNet` calls arrive here, in every
 * open tab. Each tab keeps its own copy while its developer tools are on.
 */
const netLogChannel: BroadcastChannel | null = (() => {
  if (typeof BroadcastChannel === "undefined") return null;
  if (typeof window === "undefined" && !inSharedWorker()) return null;
  try {
    return new BroadcastChannel("tasfer:devtools-netlog");
  } catch {
    return null;
  }
})();

if (netLogChannel && !inSharedWorker()) {
  netLogChannel.onmessage = (e: MessageEvent<NetLogRecord>) => {
    if (isDevToolsEnabled() && e.data?.type) ingest(e.data);
  };
}

export function getNetLogs(): NetLogEntry[] {
  return _entries;
}

export function clearNetLogs() {
  _entries = [];
  notify();
}

export function onNetLogsChange(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

// ─── Per-peer op counts ──────────────────────────────────────────────────────
//
// The entry list above keeps only the last MAX messages, which a busy sync
// burns through in seconds. These counters keep how many CRDT ops went to and
// came from each peer for the last OPS_KEEP_MS: per second for the last
// OPS_FINE_KEEP_MS (the live chart), per minute before that. They live in
// sessionStorage: one tab's own traffic, surviving a reload of that tab, and
// never overwritten by another tab's counts.

export interface PeerOpBucket {
  /** Start of the bucket (a second, or a minute once older), epoch ms. */
  t: number;
  send: number;
  recv: number;
}

/** Width of a fresh bucket. Older ones are merged into OPS_COARSE_MS. */
export const PEER_OPS_BUCKET_MS = 1_000;
const OPS_COARSE_MS = 60_000;
const OPS_FINE_KEEP_MS = 5 * 60_000;
const OPS_KEEP_MS = 24 * 60 * 60_000;
const OPS_STORAGE_KEY = "tasfer:devtools-peer-ops";
const OPS_SAVE_DELAY_MS = 2_000;

let _peerOps: Map<string, PeerOpBucket[]> | null = null;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

/** How many CRDT ops a sync message carries; 0 for everything else. */
function countOps(msg: Record<string, unknown>): number {
  switch (msg.type) {
    case "space-ops":
    case "page-ops":
    case "sync-res":
      return (msg.ops as unknown[] | undefined)?.length ?? 0;
    case "sync-data": {
      let n = (msg.spaceOps as unknown[] | undefined)?.length ?? 0;
      for (const ops of Object.values((msg.pageOps as Record<string, unknown[]>) ?? {}))
        n += ops?.length ?? 0;
      return n;
    }
    default:
      return 0;
  }
}

function peerOps(): Map<string, PeerOpBucket[]> {
  if (_peerOps) return _peerOps;
  _peerOps = new Map();
  try {
    const raw = sessionStorage.getItem(OPS_STORAGE_KEY);
    if (raw) {
      const cutoff = Date.now() - OPS_KEEP_MS;
      for (const [peer, buckets] of Object.entries(
        JSON.parse(raw) as Record<string, PeerOpBucket[]>,
      )) {
        const kept = buckets.filter((b) => b.t >= cutoff);
        if (kept.length > 0) _peerOps.set(peer, kept);
      }
    }
  } catch {
    // Storage blocked or a stale shape — start counting afresh.
  }
  return _peerOps;
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      sessionStorage.setItem(
        OPS_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(peerOps())),
      );
    } catch {
      /* storage full or blocked — the in-memory counts still serve */
    }
  }, OPS_SAVE_DELAY_MS);
}

/**
 * Drop buckets older than OPS_KEEP_MS and merge those older than
 * OPS_FINE_KEEP_MS into per-minute ones, so a busy day stays a few thousand
 * buckets. Fresh buckets are kept as they are.
 */
function compactBuckets(buckets: PeerOpBucket[], now: number): PeerOpBucket[] {
  const cutoff = now - OPS_KEEP_MS;
  const fineFrom = now - OPS_FINE_KEEP_MS;
  const out: PeerOpBucket[] = [];
  for (const b of buckets) {
    if (b.t < cutoff) continue;
    if (b.t >= fineFrom) {
      out.push(b);
      continue;
    }
    const t = b.t - (b.t % OPS_COARSE_MS);
    const prev = out[out.length - 1];
    if (prev && prev.t === t) {
      prev.send += b.send;
      prev.recv += b.recv;
    } else {
      out.push({ t, send: b.send, recv: b.recv });
    }
  }
  return out;
}

function recordPeerOps(direction: NetDirection, peer: string, n: number, now: number) {
  if (n === 0) return;
  const t = now - (now % PEER_OPS_BUCKET_MS);
  const map = peerOps();
  let buckets = map.get(peer) ?? [];
  let last = buckets[buckets.length - 1];
  if (!last || last.t !== t) {
    buckets = compactBuckets(buckets, now);
    last = { t, send: 0, recv: 0 };
    buckets.push(last);
  }
  map.set(peer, buckets);
  last[direction === "send" ? "send" : "recv"] += n;
  scheduleSave();
}

/** Op counts for a peer (short key), oldest first: per second for the last
 * few minutes, per minute before that. */
export function getPeerOpBuckets(peer: string): readonly PeerOpBucket[] {
  return peerOps().get(peer.slice(0, 8)) ?? [];
}

// ─── Summary builder ─────────────────────────────────────────────────────────

function buildSummary(msg: Record<string, unknown>): string {
  switch (msg.type) {
    case "hello":
      return `spaces: ${(msg.spaces as string[])?.length ?? 0}`;
    case "sync-pull":
      return `space ${sid(msg.spaceId)}`;
    case "sync-data": {
      const so = (msg.spaceOps as unknown[])?.length ?? 0;
      const po = Object.keys(msg.pageOps as object ?? {}).length;
      return `space ${sid(msg.spaceId)} — ${so} space ops, ${po} pages`;
    }
    case "space-ops":
      return `space ${sid(msg.spaceId)} — ${(msg.ops as unknown[])?.length ?? 0} ops`;
    case "page-ops":
      return `page ${sid(msg.pageId)} — ${(msg.ops as unknown[])?.length ?? 0} ops`;
    case "room-join":
    case "room-leave":
      return `page ${sid(msg.pageId)}`;
    case "room-peers":
      return `page ${sid(msg.pageId)} — ${(msg.peers as unknown[])?.length ?? 0} peers`;
    case "awareness":
      return `page ${sid(msg.pageId)}`;
    case "sync-req":
      return `page ${sid(msg.pageId)}`;
    case "sync-res":
      return `page ${sid(msg.pageId)} — ${(msg.ops as unknown[])?.length ?? 0} ops`;
    case "asset-req":
      return `hash ${sid(msg.hash)}`;
    case "asset-data":
      return `hash ${sid(msg.hash)}`;
    case "asset-miss":
      return `hash ${sid(msg.hash)} — not held`;
    case "pair-hello":
    case "pair-ack":
      return `${(msg.name as string) ?? ""}`;
    default:
      return "";
  }
}

function sid(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 8) : "?";
}
