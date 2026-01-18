/**
 * WebSocketContext
 *
 * React context providing global WebSocket connection management.
 * Handles connection state, room subscriptions, and page events.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  GlobalWebSocket,
  getGlobalWebSocket,
} from "@/websocket/GlobalWebSocket";
import type {
  ConnectionState,
  ConnectionInfo,
  RoomCallbacks,
  PageEventCallbacks,
  RoomUser,
  Operation,
} from "@/websocket/types";
import type { AwarenessState } from "@/editor/sync/awareness";

// =============================================================================
// Context Types
// =============================================================================

interface WebSocketContextValue {
  /** Current connection state */
  connectionState: ConnectionState;
  /** Full connection info including error and reconnect attempt */
  connectionInfo: ConnectionInfo;
  /** Local peer ID */
  peerId: string;
  /** Local user info */
  localUser: RoomUser;
  /** Connect to the WebSocket server */
  connect: () => Promise<void>;
  /** Disconnect from the WebSocket server */
  disconnect: () => void;
  /** Force reconnect (e.g., after coming back online) */
  reconnect: () => Promise<void>;
  /** Join a document room for CRDT sync */
  joinRoom: (
    roomId: string,
    callbacks: RoomCallbacks,
    user?: RoomUser
  ) => () => void;
  /** Leave a document room */
  leaveRoom: (roomId: string) => void;
  /** Check if subscribed to a room */
  isInRoom: (roomId: string) => boolean;
  /** Broadcast operations to a room */
  broadcastOperations: (roomId: string, operations: Operation[]) => void;
  /** Broadcast awareness state to a room */
  broadcastAwareness: (roomId: string, state: AwarenessState) => void;
  /** Send sync request to a room */
  sendSyncRequest: (
    roomId: string,
    versionVector: Record<string, number>,
    snapshotClock?: { counter: number; peerId: string } | null
  ) => void;
  /** Send sync response to a room */
  sendSyncResponse: (
    roomId: string,
    operations: Operation[],
    versionVector: Record<string, number>,
    targetPeerId?: string
  ) => void;
  /** Subscribe to page lifecycle events */
  onPageEvents: (callbacks: PageEventCallbacks) => () => void;
  /** Update local user name */
  setUserName: (name: string) => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

// =============================================================================
// Provider Props
// =============================================================================

interface WebSocketProviderProps {
  /** WebSocket server URL */
  serverUrl: string;
  /** Optional initial user name */
  userName?: string;
  /** Auto-connect on mount (default: true) */
  autoConnect?: boolean;
  /** Children */
  children: React.ReactNode;
}

// =============================================================================
// Provider Component
// =============================================================================

export function WebSocketProvider({
  serverUrl,
  userName,
  autoConnect = true,
  children,
}: WebSocketProviderProps) {
  const wsRef = useRef<GlobalWebSocket | null>(null);
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo>({
    state: "disconnected",
  });
  const [localUser, setLocalUser] = useState<RoomUser>({
    peerId: "",
    name: userName || "",
    color: "",
  });

  // Initialize WebSocket on mount
  useEffect(() => {
    const ws = getGlobalWebSocket(serverUrl);
    wsRef.current = ws;

    // Set user name if provided
    if (userName) {
      ws.setUserName(userName);
    }

    // Update local user state
    setLocalUser(ws.getLocalUser());

    // Subscribe to connection changes
    const unsubscribe = ws.onConnectionChange((info) => {
      setConnectionInfo(info);
    });

    // Auto-connect if enabled
    if (autoConnect) {
      ws.connect().catch(() => {
        // Connection errors are handled by the connection state
      });
    }

    // Handle browser online/offline events
    const handleOnline = () => {
      ws.reconnect();
    };

    window.addEventListener("online", handleOnline);

    return () => {
      unsubscribe();
      window.removeEventListener("online", handleOnline);
      // Don't disconnect on unmount - keep connection alive across route changes
    };
  }, [serverUrl, userName, autoConnect]);

  // ==========================================================================
  // Context Methods
  // ==========================================================================

  const connect = useCallback(async () => {
    if (!wsRef.current) return;
    await wsRef.current.connect();
  }, []);

  const disconnect = useCallback(() => {
    if (!wsRef.current) return;
    wsRef.current.disconnect();
  }, []);

  const reconnect = useCallback(async () => {
    if (!wsRef.current) return;
    await wsRef.current.reconnect();
  }, []);

  const joinRoom = useCallback(
    (roomId: string, callbacks: RoomCallbacks, user?: RoomUser) => {
      if (!wsRef.current) {
        return () => {};
      }
      return wsRef.current.joinRoom(roomId, callbacks, user);
    },
    []
  );

  const leaveRoom = useCallback((roomId: string) => {
    if (!wsRef.current) return;
    wsRef.current.leaveRoom(roomId);
  }, []);

  const isInRoom = useCallback((roomId: string) => {
    if (!wsRef.current) return false;
    return wsRef.current.isInRoom(roomId);
  }, []);

  const broadcastOperations = useCallback(
    (roomId: string, operations: Operation[]) => {
      if (!wsRef.current) return;
      wsRef.current.broadcastOperations(roomId, operations);
    },
    []
  );

  const broadcastAwareness = useCallback(
    (roomId: string, state: AwarenessState) => {
      if (!wsRef.current) return;
      wsRef.current.broadcastAwareness(roomId, state);
    },
    []
  );

  const sendSyncRequest = useCallback(
    (
      roomId: string,
      versionVector: Record<string, number>,
      snapshotClock?: { counter: number; peerId: string } | null
    ) => {
      if (!wsRef.current) return;
      wsRef.current.sendSyncRequest(roomId, versionVector, snapshotClock);
    },
    []
  );

  const sendSyncResponse = useCallback(
    (
      roomId: string,
      operations: Operation[],
      versionVector: Record<string, number>,
      targetPeerId?: string
    ) => {
      if (!wsRef.current) return;
      wsRef.current.sendSyncResponse(
        roomId,
        operations,
        versionVector,
        targetPeerId
      );
    },
    []
  );

  const onPageEvents = useCallback((callbacks: PageEventCallbacks) => {
    if (!wsRef.current) {
      return () => {};
    }
    return wsRef.current.onPageEvents(callbacks);
  }, []);

  const setUserName = useCallback((name: string) => {
    if (!wsRef.current) return;
    wsRef.current.setUserName(name);
    setLocalUser(wsRef.current.getLocalUser());
  }, []);

  // ==========================================================================
  // Context Value
  // ==========================================================================

  const value: WebSocketContextValue = {
    connectionState: connectionInfo.state,
    connectionInfo,
    peerId: localUser.peerId,
    localUser,
    connect,
    disconnect,
    reconnect,
    joinRoom,
    leaveRoom,
    isInRoom,
    broadcastOperations,
    broadcastAwareness,
    sendSyncRequest,
    sendSyncResponse,
    onPageEvents,
    setUserName,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Use the WebSocket context.
 * Must be used within a WebSocketProvider.
 */
export function useWebSocket(): WebSocketContextValue {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error("useWebSocket must be used within a WebSocketProvider");
  }
  return context;
}

/**
 * Use only the connection state (for components that don't need full context).
 */
export function useWebSocketConnection(): {
  connectionState: ConnectionState;
  connectionInfo: ConnectionInfo;
  reconnect: () => Promise<void>;
} {
  const { connectionState, connectionInfo, reconnect } = useWebSocket();
  return { connectionState, connectionInfo, reconnect };
}
