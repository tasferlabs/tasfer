/**
 * useP2PRoom — Room subscription hook for P2P CRDT sync.
 *
 * Connects to the platform's Replicator via per-peer WebRTC DataChannels.
 * Rooms provide awareness routing (cursor/selection) for open pages.
 * Ops flow through the Replicator's space-level replication.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { getPlatform } from "@/platform";
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

// The device peer id derives from the persistent device keypair, but
// `platform.identity.get()` is async — so on first render `peerId` is unknown.
// That id is the origin half of every CRDT op id (`peerId:counter`); a doc
// created before it resolves binds to an empty origin, which COLLIDES across
// peers and silently drops ops (peers diverge). Cache the resolved id so later
// visits read it synchronously and the doc never has to be created with "".
// (First-ever visit still resolves async; the editor binding's own guard
// generates a unique id for that one session, so no collision either way.)
const PEER_ID_CACHE_KEY = "cypher.devicePeerId";

function readCachedPeerId(): string {
  try {
    return localStorage.getItem(PEER_ID_CACHE_KEY) ?? "";
  } catch {
    return "";
  }
}

function cachePeerId(peerId: string): void {
  try {
    localStorage.setItem(PEER_ID_CACHE_KEY, peerId);
  } catch {
    // Private mode / storage disabled — the async resolve still sets state.
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
  const [peerId, setPeerId] = useState(readCachedPeerId);
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

      const myPeerId = identity.publicKey.slice(0, 32);
      cachePeerId(myPeerId);
      setPeerId(myPeerId);
      setLocalUser({
        peerId: myPeerId,
        name: identity.name,
        avatar: identity.avatar,
        color: getColorForPeer(identity.name || myPeerId),
        deviceType: identity.deviceType,
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
          deviceType: identity.deviceType,
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
  }, [roomId, spaceId]);

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
