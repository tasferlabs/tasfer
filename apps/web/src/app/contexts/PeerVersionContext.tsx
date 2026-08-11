import { getPlatform } from "@/platform";
import type { PeerVersionInfo } from "@/platform/types";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface PeerVersionContextValue {
  /** Incompatible peer currently connected, or null. */
  notice: PeerVersionInfo | null;
  /** Our app is the older side of the mismatch. */
  localOutdated: boolean;
  /** The sidebar warning is shrunk to its one-line row. */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}

const PeerVersionContext = createContext<PeerVersionContextValue | null>(null);

/** localStorage record of the mismatches the user collapsed. */
const COLLAPSED_KEY = "peerVersionNoticeCollapsed";

/** Identifies a mismatch: the same peer advertising the same versions is the same problem. */
function noticeKey(info: PeerVersionInfo): string {
  return `${info.publicKey}:${info.remoteProtocolVersion}.${info.remoteWireVersion}`;
}

function readCollapsed(): string[] {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed)
      ? parsed.filter((k) => typeof k === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Holds the incompatible-peer notice behind the sidebar warning.
 *
 * The notice lives as long as the problem does: the sync layer reports
 * mismatches only, never a later "compatible again", so it is cleared by the
 * peer disconnecting rather than by anything the user does. Collapsing shrinks
 * the warning to a one-line row instead of hiding it — the device stays
 * unsyncable either way.
 *
 * The collapse choice is remembered per browser (localStorage) and keyed by
 * peer plus advertised versions, so a different device — or the same one after
 * an update that still doesn't match — states itself once in full before it can
 * be quieted again.
 */
export function PeerVersionProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<PeerVersionInfo | null>(null);
  const [collapsedKeys, setCollapsedKeys] = useState<string[]>(readCollapsed);

  useEffect(() => {
    let unsubMismatch: (() => void) | undefined;
    let unsubPeers: (() => void) | undefined;
    try {
      const { sync } = getPlatform();
      unsubMismatch = sync.onPeerVersionMismatch((next) => {
        if (!next.syncCompatible) setNotice(next);
      });
      // A peer that hung up is no longer a device we're failing to sync with;
      // dropping the notice keeps the warning about what is connected now.
      unsubPeers = sync.onConnectedPeersChange((peers) => {
        setNotice((prev) =>
          prev && !peers.includes(prev.publicKey) ? null : prev,
        );
      });
    } catch {
      // Platform not initialized yet — nothing to subscribe to.
    }
    return () => {
      unsubMismatch?.();
      unsubPeers?.();
    };
  }, []);

  const key = notice ? noticeKey(notice) : null;

  const setCollapsed = useCallback(
    (collapsed: boolean) => {
      if (key === null) return;
      setCollapsedKeys((prev) => {
        const next = collapsed
          ? prev.includes(key)
            ? prev
            : [...prev, key]
          : prev.filter((k) => k !== key);
        if (next === prev) return prev;
        try {
          window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
        } catch {
          // Storage unavailable — the choice holds for this page load only.
        }
        return next;
      });
    },
    [key],
  );

  const value = useMemo<PeerVersionContextValue>(
    () => ({
      notice,
      // Our app is behind when either negotiated version is newer on the peer.
      localOutdated: notice
        ? notice.remoteProtocolVersion > notice.localProtocolVersion ||
          notice.remoteWireVersion > notice.localWireVersion
        : false,
      collapsed: key !== null && collapsedKeys.includes(key),
      setCollapsed,
    }),
    [notice, key, collapsedKeys, setCollapsed],
  );

  return (
    <PeerVersionContext.Provider value={value}>
      {children}
    </PeerVersionContext.Provider>
  );
}

export function usePeerVersion() {
  const ctx = useContext(PeerVersionContext);
  if (!ctx) {
    throw new Error("usePeerVersion must be used within a PeerVersionProvider");
  }
  return ctx;
}
