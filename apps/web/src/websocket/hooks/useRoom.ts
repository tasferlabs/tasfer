/**
 * useRoom Hook
 *
 * Room subscription hook for CRDT sync in the editor.
 * Manages room join/leave lifecycle and provides methods for broadcasting.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { useWebSocket } from "@/app/contexts/WebSocketContext";
import type { RoomCallbacks, RoomUser, Operation } from "../types";
import type { AwarenessState } from "@/editor/sync/awareness";

// =============================================================================
// Types
// =============================================================================

export type SyncState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; peerCount: number }
  | { status: "error"; error: string };

export interface RoomConfig {
  /** Called when receiving operations from other peers */
  onOperations?: (operations: Operation[]) => void;
  /** Called when you're the first/only peer in the room (load initial content) */
  onFirstPeer?: () => void;
  /** Called when receiving sync request from a peer */
  onSyncRequest?: (
    versionVector: Record<string, number>,
    snapshotClock: { counter: number; peerId: string } | null | undefined,
    requesterId?: string
  ) => void;
  /** Called when receiving sync response */
  onSyncResponse?: (
    operations: Operation[],
    versionVector: Record<string, number>
  ) => void;
  /** Called when a peer's awareness state changes */
  onAwarenessUpdate?: (peerId: string, state: AwarenessState | null) => void;
  /** Called with initial awareness states on room join */
  onAwarenessStates?: (states: Record<string, AwarenessState>) => void;
  /** Snapshot clock for delta sync */
  snapshotClock?: { counter: number; peerId: string } | null;
}

export interface UseRoomReturn {
  /** Broadcast operations to the room */
  broadcast: (operations: Operation[]) => void;
  /** Broadcast awareness state to the room */
  broadcastAwareness: (state: AwarenessState) => void;
  /** Send sync request to room */
  sendSyncRequest: (
    versionVector: Record<string, number>,
    snapshotClock?: { counter: number; peerId: string } | null
  ) => void;
  /** Send sync response to specific peer */
  sendSyncResponse: (
    operations: Operation[],
    versionVector: Record<string, number>,
    targetPeerId?: string
  ) => void;
  /** Current number of peers in the room */
  peerCount: number;
  /** Current sync state */
  syncState: SyncState;
  /** Local peer ID */
  peerId: string;
  /** Local user info */
  localUser: RoomUser;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Subscribe to a document room for CRDT sync.
 *
 * @param roomId - Room ID to join (usually page ID). Pass null to not join any room.
 * @param config - Room configuration and callbacks
 *
 * @example
 * const { broadcast, broadcastAwareness, peerCount, syncState } = useRoom(
 *   pageId,
 *   {
 *     onOperations: (ops) => syncEngine.apply(ops),
 *     onFirstPeer: () => console.log("First peer in room"),
 *     onAwarenessUpdate: (peerId, state) => editor.setRemoteAwareness(peerId, state),
 *   }
 * );
 */
export function useRoom(
  roomId: string | null,
  config: RoomConfig
): UseRoomReturn {
  const {
    connectionState,
    joinRoom,
    broadcastOperations,
    broadcastAwareness: wsBroadcastAwareness,
    sendSyncRequest: wsSendSyncRequest,
    sendSyncResponse: wsSendSyncResponse,
    peerId,
    localUser,
  } = useWebSocket();

  const [peerCount, setPeerCount] = useState(0);
  const [syncState, setSyncState] = useState<SyncState>({ status: "disconnected" });

  // Keep config callbacks in refs to avoid re-subscribing on every render
  const configRef = useRef(config);
  configRef.current = config;

  // Track if this is our first join to determine first peer status
  const hasJoinedRef = useRef(false);

  // Join/leave room on roomId change
  useEffect(() => {
    if (!roomId) {
      setSyncState({ status: "disconnected" });
      setPeerCount(0);
      return;
    }

    // Update sync state based on connection state
    if (connectionState === "connecting") {
      setSyncState({ status: "connecting" });
    } else if (connectionState === "error") {
      setSyncState({ status: "error", error: "Connection failed" });
    } else if (connectionState === "disconnected") {
      setSyncState({ status: "disconnected" });
    }

    // Don't join until connected
    if (connectionState !== "connected") {
      return;
    }

    setSyncState({ status: "connecting" });
    hasJoinedRef.current = false;

    const callbacks: RoomCallbacks = {
      onOperations: (operations) => {
        configRef.current.onOperations?.(operations);
      },

      onSyncRequest: (versionVector, snapshotClock, requesterId) => {
        configRef.current.onSyncRequest?.(versionVector, snapshotClock, requesterId);
      },

      onSyncResponse: (operations, versionVector) => {
        configRef.current.onSyncResponse?.(operations, versionVector);
      },

      onPeerJoined: (joinedPeerId, user) => {
        setPeerCount((prev) => prev + 1);

        // Notify about new peer's initial awareness state
        if (user) {
          configRef.current.onAwarenessUpdate?.(joinedPeerId, {
            user,
            cursor: null,
            selection: null,
            lastUpdate: Date.now(),
          });
        }
      },

      onPeerLeft: (leftPeerId) => {
        setPeerCount((prev) => Math.max(0, prev - 1));

        // Notify that peer's awareness should be removed
        configRef.current.onAwarenessUpdate?.(leftPeerId, null);
      },

      onRoomPeers: (peers, awarenessStates) => {
        const otherPeers = peers.filter((p) => p !== peerId);

        setPeerCount(otherPeers.length);
        setSyncState({ status: "connected", peerCount: otherPeers.length });

        if (otherPeers.length === 0) {
          configRef.current.onFirstPeer?.();
        }

        // Notify about existing awareness states
        if (awarenessStates && Object.keys(awarenessStates).length > 0) {
          configRef.current.onAwarenessStates?.(awarenessStates);
        }

        hasJoinedRef.current = true;
      },

      onAwareness: (awarenesspeerId, state) => {
        configRef.current.onAwarenessUpdate?.(awarenesspeerId, state);
      },

      onError: (message) => {
        setSyncState({ status: "error", error: message });
      },
    };

    // Join the room
    const leave = joinRoom(roomId, callbacks);

    return () => {
      leave();
      setPeerCount(0);
      setSyncState({ status: "disconnected" });
    };
  }, [roomId, connectionState, joinRoom, peerId]);

  // Update peer count in sync state when it changes
  useEffect(() => {
    if (syncState.status === "connected") {
      setSyncState({ status: "connected", peerCount });
    }
  }, [peerCount, syncState.status]);

  // ==========================================================================
  // Methods
  // ==========================================================================

  const broadcast = useCallback(
    (operations: Operation[]) => {
      if (!roomId || operations.length === 0) return;
      broadcastOperations(roomId, operations);
    },
    [roomId, broadcastOperations]
  );

  const broadcastAwareness = useCallback(
    (state: AwarenessState) => {
      if (!roomId) return;
      wsBroadcastAwareness(roomId, state);
    },
    [roomId, wsBroadcastAwareness]
  );

  const sendSyncRequest = useCallback(
    (
      versionVector: Record<string, number>,
      snapshotClock?: { counter: number; peerId: string } | null
    ) => {
      if (!roomId) return;
      wsSendSyncRequest(roomId, versionVector, snapshotClock);
    },
    [roomId, wsSendSyncRequest]
  );

  const sendSyncResponse = useCallback(
    (
      operations: Operation[],
      versionVector: Record<string, number>,
      targetPeerId?: string
    ) => {
      if (!roomId) return;
      wsSendSyncResponse(roomId, operations, versionVector, targetPeerId);
    },
    [roomId, wsSendSyncResponse]
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
