/**
 * DevLog — lightweight event bus for network message logging.
 * Only active while developer tools are enabled (Settings → Developer tools;
 * defaults on in staging). No-op otherwise.
 */

import { isDevToolsEnabled } from "@/lib/devTools";

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

/** Log a network message (send or receive). No-op if not staging. */
export function logNet(
  direction: NetDirection,
  peer: string,
  msg: { type: string },
  sizeBytes: number,
) {
  if (!isDevToolsEnabled()) return;

  const summary = buildSummary(msg as Record<string, unknown>);

  _entries.push({
    id: ++_id,
    direction,
    type: msg.type,
    peer: peer.slice(0, 8),
    summary,
    timestamp: Date.now(),
    size: sizeBytes,
  });

  if (_entries.length > MAX) _entries = _entries.slice(-MAX);
  notify();
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
