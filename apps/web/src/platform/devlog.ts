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
  };
  // No tab can read the worker's memory: hand the entry to the tabs instead.
  if (netLogChannel && inSharedWorker()) netLogChannel.postMessage(record);
  else ingest(record);
}

/** One logged message as it crosses from the engine's worker to a tab. */
type NetLogRecord = Omit<NetLogEntry, "id">;

function ingest(record: NetLogRecord) {
  _entries.push({ id: ++_id, ...record });
  if (_entries.length > MAX) _entries = _entries.slice(-MAX);
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
