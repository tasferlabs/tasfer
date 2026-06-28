/**
 * useP2PRoom — Room subscription hook for P2P CRDT sync.
 *
 * Connects to the platform's Replicator via per-peer WebRTC DataChannels.
 * Rooms provide awareness routing (cursor/selection) for open pages.
 * Ops flow through the Replicator's space-level replication.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { detectDeviceType, getPlatform } from "@/platform";
import type { ConnectionState, SyncEvents } from "@/platform/types";
import type { Operation } from "@cypherkit/editor";
import {
  getColorForPeer,
  type CursorPresence,
  type CursorUser,
} from "@cypherkit/provider-core/cursors";

// =============================================================================
// Types
// =============================================================================

export type SyncState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; peerCount: number }
  | { status: "error"; error: string };

export interface RoomConfig {
  onOperations?: (operations: Operation[]) => void;
  onFirstPeer?: () => void;
  onJoined?: (hasOtherPeers: boolean) => void;
  /** Called when a new peer joins our room — use to re-broadcast awareness */
  onPeerJoined?: (peerId: string) => void;
  onSyncRequest?: (
    versionVector: Record<string, number>,
    requesterId?: string,
  ) => void;
  onSyncResponse?: (
    operations: Operation[],
    versionVector: Record<string, number>,
  ) => void;
  onAwarenessUpdate?: (peerId: string, state: CursorPresence | null) => void;
  onAwarenessStates?: (states: Record<string, CursorPresence>) => void;
}

export interface UseP2PRoomReturn {
  broadcast: (operations: Operation[]) => void;
  broadcastAwareness: (state: CursorPresence) => void;
  sendSyncRequest: (versionVector: Record<string, number>) => void;
  sendSyncResponse: (
    operations: Operation[],
    versionVector: Record<string, number>,
    targetPeerId?: string,
  ) => void;
  peerCount: number;
  syncState: SyncState;
  peerId: string;
  localUser: CursorUser;
}

// =============================================================================
// Hook
// =============================================================================

// Each browser tab is a distinct CRDT replica.
//
// `peerId` is the origin half of every CRDT op id (`peerId:counter`) and the
// version vector's per-origin key. It must be UNIQUE PER TAB: two tabs sharing
// one origin would mint colliding op ids (`abc:5` in both) and the merge would
// silently drop the second (first-write-wins in `isOpKnown`) — permanent
// divergence and lost edits. The device public key is shared by every tab, so
// it cannot serve as the replica id; we mint a per-tab id instead.
//
// The id lives in sessionStorage: unique per tab, stable across reloads of the
// same tab (so a reload doesn't spawn a fresh replica every time), and readable
// synchronously on first render so the doc is never created with an empty
// origin. Device identity (name/avatar/key) is still resolved from
// `platform.identity` separately — only the CRDT/presence origin is per-tab.
const REPLICA_ID_KEY = "cypher.replicaId";

function generateReplicaId(): string {
  // 32 hex chars, colon-free (op ids split on ":"), matching the previous width.
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}

function getTabReplicaId(): string {
  try {
    let id = sessionStorage.getItem(REPLICA_ID_KEY);
    if (!id) {
      id = generateReplicaId();
      sessionStorage.setItem(REPLICA_ID_KEY, id);
    }
    return id;
  } catch {
    // Private mode / storage disabled — a fresh id per call is still unique;
    // it's held in component state for the tab's lifetime.
    return generateReplicaId();
  }
}

export function useP2PRoom(
  roomId: string | null,
  config: RoomConfig,
  spaceId?: string,
): UseP2PRoomReturn {
  const [peerCount, setPeerCount] = useState(0);
  const [syncState, setSyncState] = useState<SyncState>({
    status: "disconnected",
  });
  // Stable for the lifetime of this tab; never changes, so no setter.
  const [peerId] = useState(getTabReplicaId);
  const [localUser, setLocalUser] = useState<CursorUser>({
    peerId: "",
    color: "",
  });

  const configRef = useRef(config);
  configRef.current = config;

  // Join/leave room
  useEffect(() => {
    if (!roomId) {
      setSyncState({ status: "disconnected" });
      setPeerCount(0);
      return;
    }

    let platform: ReturnType<typeof getPlatform>;
    try {
      platform = getPlatform();
    } catch {
      setSyncState({ status: "error", error: "Platform not initialized" });
      return;
    }

    // Get identity for peerId
    let cancelled = false;
    const setupRoom = async () => {
      const identity = await platform.identity.get();
      if (cancelled) return;

      // Per-tab replica id (NOT the device key) — this is the CRDT op origin
      // and presence id, and must be distinct in each tab. Matches the `peerId`
      // the doc was created with on first render.
      const myPeerId = peerId;
      // Device form factor is inferred from the running client (not stored on the
      // identity) — it only exists to disambiguate same-named collaborators.
      const deviceType = detectDeviceType();
      setLocalUser({
        peerId: myPeerId,
        name: identity.name,
        avatar: identity.avatar,
        color: getColorForPeer(identity.name || myPeerId),
        deviceType,
        deviceId: identity.publicKey,
      });

      setSyncState({ status: "connecting" });

      const callbacks: Partial<SyncEvents> = {
        onOperations: (ops) => configRef.current.onOperations?.(ops),

        onSyncRequest: (vv, _clock, reqId) =>
          configRef.current.onSyncRequest?.(vv, reqId),

        onSyncResponse: (ops, vv) =>
          configRef.current.onSyncResponse?.(ops, vv),

        onPeerJoined: (joinedPeerId, user) => {
          setPeerCount((prev) => prev + 1);
          if (user) {
            configRef.current.onAwarenessUpdate?.(joinedPeerId, {
              user: {
                peerId: joinedPeerId,
                name: user.name,
                avatar: user.avatar,
                color: user.color || getColorForPeer(user.name || joinedPeerId),
                deviceType: user.deviceType,
                deviceId: user.deviceId,
              },
              caret: null,
              selection: null,
            });
          }
          // Notify MountedEditor so it can re-broadcast awareness to the new peer
          configRef.current.onPeerJoined?.(joinedPeerId);
        },

        onPeerLeft: (leftPeerId) => {
          setPeerCount((prev) => Math.max(0, prev - 1));
          configRef.current.onAwarenessUpdate?.(leftPeerId, null);
        },

        onRoomPeers: (peers, awarenessStates) => {
          const otherPeers = peers.filter((p) => p !== myPeerId);
          setPeerCount(otherPeers.length);
          setSyncState({ status: "connected", peerCount: otherPeers.length });

          if (otherPeers.length === 0) {
            configRef.current.onFirstPeer?.();
          }

          if (awarenessStates && Object.keys(awarenessStates).length > 0) {
            configRef.current.onAwarenessStates?.(awarenessStates);
          }

          configRef.current.onJoined?.(otherPeers.length > 0);
        },

        onAwareness: (awarenesspeerId, state) =>
          configRef.current.onAwarenessUpdate?.(awarenesspeerId, state),

        onError: (message) => setSyncState({ status: "error", error: message }),
      };

      await platform.sync.joinRoom(
        roomId,
        myPeerId,
        {
          name: identity.name,
          avatar: identity.avatar,
          deviceType,
          deviceId: identity.publicKey,
        },
        callbacks,
        spaceId,
      );

      if (cancelled) {
        await platform.sync.leaveRoom(roomId);
      }
    };

    setupRoom();

    return () => {
      cancelled = true;
      try {
        const p = getPlatform();
        p.sync.leaveRoom(roomId);
      } catch {
        // Platform may not be initialized
      }
      setPeerCount(0);
      setSyncState({ status: "disconnected" });
    };
  }, [roomId, spaceId, peerId]);

  // Update peer count in sync state
  useEffect(() => {
    if (syncState.status === "connected") {
      setSyncState({ status: "connected", peerCount });
    }
  }, [peerCount, syncState.status]);

  // Listen for connection state changes
  useEffect(() => {
    let platform: ReturnType<typeof getPlatform>;
    try {
      platform = getPlatform();
    } catch {
      return;
    }

    const unsub = platform.sync.onConnectionChange((state: ConnectionState) => {
      if (state === "disconnected") {
        setSyncState({ status: "disconnected" });
      } else if (state === "error") {
        setSyncState({ status: "error", error: "Connection failed" });
      }
    });

    return unsub;
  }, []);

  // Methods
  const broadcast = useCallback(
    (operations: Operation[]) => {
      if (!roomId || operations.length === 0) return;
      try {
        getPlatform().sync.sendOperations(roomId, operations);
      } catch {
        /* not initialized */
      }
    },
    [roomId],
  );

  const broadcastAwareness = useCallback(
    (state: CursorPresence) => {
      if (!roomId) return;
      try {
        getPlatform().sync.sendAwareness(roomId, state);
      } catch {
        /* not initialized */
      }
    },
    [roomId],
  );

  const sendSyncRequest = useCallback(
    (versionVector: Record<string, number>) => {
      if (!roomId) return;
      try {
        getPlatform().sync.sendSyncRequest(roomId, versionVector);
      } catch {
        /* not initialized */
      }
    },
    [roomId],
  );

  const sendSyncResponse = useCallback(
    (
      operations: Operation[],
      versionVector: Record<string, number>,
      targetPeerId?: string,
    ) => {
      if (!roomId) return;
      try {
        getPlatform().sync.sendSyncResponse(
          roomId,
          operations,
          versionVector,
          targetPeerId,
        );
      } catch {
        /* not initialized */
      }
    },
    [roomId],
  );

  return {
    broadcast,
    broadcastAwareness,
    sendSyncRequest,
    sendSyncResponse,
    peerCount,
    syncState,
    peerId,
    localUser,
  };
}
