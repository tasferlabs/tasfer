/**
 * WebSocket Sync Module
 *
 * Handles real-time CRDT operation exchange via WebSocket server.
 * Replaces WebRTC peer-to-peer with centralized server communication.
 */

import { SyncEngine, serializeVV, deserializeVV } from "./index";
import type { Operation } from "./types";
import type { AwarenessState, AwarenessUser } from "./awareness";
import { getColorForPeer, getTestNameForPeer } from "./awareness";

// =============================================================================
// Types
// =============================================================================

/** Message types for server communication */
export type ServerMessage =
  | { type: "join"; roomId: string; peerId: string; user?: AwarenessUser }
  | { type: "leave"; roomId: string; peerId: string }
  | { type: "sync-request"; versionVector: Record<string, number>; requesterId?: string }
  | { type: "sync-response"; operations: Operation[]; versionVector: Record<string, number>; targetPeerId?: string }
  | { type: "operations"; operations: Operation[] }
  | { type: "peer-joined"; peerId: string; user?: AwarenessUser }
  | { type: "peer-left"; peerId: string }
  | { type: "room-peers"; peers: string[]; awarenessStates?: Record<string, AwarenessState> }
  | { type: "awareness"; peerId: string; state: AwarenessState }
  | { type: "error"; message: string };

/** WebSocket sync configuration */
export interface WebSocketSyncConfig {
  /** WebSocket server URL */
  serverUrl: string;
  /** Local user name (optional, for awareness) */
  userName?: string;
  /** Called when sync state changes */
  onStateChange?: (state: SyncState) => void;
  /** Called when a remote operation is received */
  onRemoteOperation?: (ops: Operation[]) => void;
  /** Called when you're the first/only peer in the room (load initial content) */
  onFirstPeer?: () => void;
  /** Called when a remote peer's awareness state changes */
  onAwarenessUpdate?: (peerId: string, state: AwarenessState | null) => void;
  /** Called when initial awareness states are received on room join */
  onAwarenessStates?: (states: Record<string, AwarenessState>) => void;
}

/** Overall sync state */
export type SyncState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; peerCount: number }
  | { status: "error"; error: string };

// =============================================================================
// WebSocket Sync Manager
// =============================================================================

/**
 * WebSocketSync manages real-time collaboration via a central WebSocket server.
 *
 * @example
 * const sync = new WebSocketSync(engine, {
 *   serverUrl: "ws://localhost:8080",
 *   onStateChange: (state) => console.log("Sync state:", state),
 * });
 *
 * // Join a room for collaboration
 * sync.joinRoom("page-123");
 *
 * // Broadcast local operations to all peers
 * sync.broadcast(operations);
 *
 * // Leave the room
 * sync.leaveRoom();
 */
export class WebSocketSync {
  private engine: SyncEngine;
  private config: WebSocketSyncConfig;
  private ws: WebSocket | null = null;
  private roomId: string | null = null;
  private state: SyncState = { status: "disconnected" };
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private peerCount = 0;
  private messageQueue: ServerMessage[] = [];
  private localUser: AwarenessUser;

  constructor(engine: SyncEngine, config: WebSocketSyncConfig) {
    this.engine = engine;
    this.config = config;

    // Initialize local user for awareness
    const peerId = engine.getPeerId();
    this.localUser = {
      peerId,
      name: config.userName || getTestNameForPeer(peerId),
      color: getColorForPeer(peerId),
    };
  }

  /**
   * Get the local user info.
   */
  getLocalUser(): AwarenessUser {
    return this.localUser;
  }

  /**
   * Update the local user name.
   */
  setUserName(name: string): void {
    this.localUser = { ...this.localUser, name };
  }

  /**
   * Get the current sync state.
   */
  getState(): SyncState {
    return this.state;
  }

  /**
   * Join a collaboration room.
   * Connects to the WebSocket server and joins the specified room.
   */
  async joinRoom(roomId: string): Promise<void> {
    if (this.roomId) {
      await this.leaveRoom();
    }

    this.roomId = roomId;
    this.setState({ status: "connecting" });

    return new Promise((resolve, reject) => {
      this.connectWebSocket()
        .then(() => {
          this.send({
            type: "join",
            roomId,
            peerId: this.engine.getPeerId(),
            user: this.localUser,
          });
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Leave the current room.
   * Closes the WebSocket connection.
   */
  async leaveRoom(): Promise<void> {
    if (this.roomId) {
      this.send({
        type: "leave",
        roomId: this.roomId,
        peerId: this.engine.getPeerId(),
      });
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.roomId = null;
    this.peerCount = 0;
    this.setState({ status: "disconnected" });
  }

  /**
   * Broadcast operations to all connected peers via the server.
   */
  broadcast(operations: Operation[]): void {
    if (operations.length === 0) return;

    this.send({
      type: "operations",
      operations,
    });
  }

  /**
   * Broadcast local awareness state to all connected peers.
   * Call this when cursor/selection changes to notify other users.
   */
  broadcastAwareness(state: AwarenessState): void {
    this.send({
      type: "awareness",
      peerId: this.engine.getPeerId(),
      state,
    });
  }

  /**
   * Request sync from the server.
   * Sends our version vector and receives missing operations.
   */
  private requestSync(): void {
    const vv = this.engine.getVersionVector();
    this.send({
      type: "sync-request",
      versionVector: serializeVV(vv),
    });
  }

  /**
   * Handle incoming sync request from another peer.
   * Respond with operations they don't have.
   */
  private handleIncomingSyncRequest(
    requesterVV: Record<string, number>,
    requesterId?: string
  ): void {
    // Convert serialized version vector back to Map
    const vv = deserializeVV(requesterVV);

    // Get operations the requester doesn't have
    const missingOps = this.engine.getOpsSince(vv);

    console.log(`[WebSocket] Responding to sync request with ${missingOps.length} operations`);

    // Send sync response with our operations
    this.send({
      type: "sync-response",
      operations: missingOps,
      versionVector: serializeVV(this.engine.getVersionVector()),
      targetPeerId: requesterId,
    });
  }

  // ==========================================================================
  // WebSocket Connection
  // ==========================================================================

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.serverUrl);

        this.ws.onopen = () => {
          console.log("[WebSocket] Connected to server");
          this.reconnectAttempts = 0;
          this.flushMessageQueue();
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as ServerMessage;
            this.handleMessage(message);
          } catch (error) {
            console.error("[WebSocket] Invalid message:", error);
          }
        };

        this.ws.onerror = (error) => {
          console.error("[WebSocket] Error:", error);
          reject(new Error("WebSocket connection failed"));
        };

        this.ws.onclose = () => {
          console.log("[WebSocket] Connection closed");
          this.handleClose();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleClose(): void {
    if (this.roomId && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.setState({ status: "connecting" });

      setTimeout(() => {
        console.log(`[WebSocket] Reconnecting... (attempt ${this.reconnectAttempts})`);
        this.connectWebSocket()
          .then(() => {
            if (this.roomId) {
              this.send({
                type: "join",
                roomId: this.roomId,
                peerId: this.engine.getPeerId(),
                user: this.localUser,
              });
            }
          })
          .catch((error) => {
            console.error("[WebSocket] Reconnection failed:", error);
            this.setState({ status: "error", error: "Failed to reconnect" });
          });
      }, this.reconnectDelay * this.reconnectAttempts);
    } else if (this.roomId) {
      this.setState({ status: "error", error: "Connection lost" });
    }
  }

  private send(message: ServerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue messages if not connected yet
      this.messageQueue.push(message);
    }
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift()!;
      this.send(message);
    }
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "room-peers":
        // Received list of existing peers in the room
        const otherPeers = message.peers.filter(p => p !== this.engine.getPeerId());
        this.peerCount = otherPeers.length;

        if (otherPeers.length === 0) {
          // We're the first peer in the room - load initial content
          console.log("[WebSocket] First peer in room, loading initial content");
          this.config.onFirstPeer?.();
        } else {
          // There are other peers, request sync to get their operations
          console.log(`[WebSocket] Joining room with ${otherPeers.length} existing peers`);
          this.requestSync();
        }

        // Notify about existing awareness states
        if (message.awarenessStates && Object.keys(message.awarenessStates).length > 0) {
          console.log(`[WebSocket] Received ${Object.keys(message.awarenessStates).length} awareness states`);
          this.config.onAwarenessStates?.(message.awarenessStates);
        }

        this.updateState();
        break;

      case "peer-joined":
        console.log(`[WebSocket] Peer joined: ${message.peerId}`);
        this.peerCount++;

        // If the new peer has user info, notify about their initial awareness state
        if (message.user) {
          this.config.onAwarenessUpdate?.(message.peerId, {
            user: message.user,
            cursor: null,
            selection: null,
            lastUpdate: Date.now(),
          });
        }

        this.updateState();
        break;

      case "peer-left":
        console.log(`[WebSocket] Peer left: ${message.peerId}`);
        this.peerCount = Math.max(0, this.peerCount - 1);

        // Notify that this peer's awareness should be removed
        this.config.onAwarenessUpdate?.(message.peerId, null);

        this.updateState();
        break;

      case "awareness":
        // Received awareness update from a peer
        console.log(`[WebSocket] Received awareness from ${message.peerId}`);
        this.config.onAwarenessUpdate?.(message.peerId, message.state);
        break;

      case "sync-request":
        // Another peer is requesting our operations
        // Respond with operations they don't have based on their version vector
        console.log(`[WebSocket] Received sync request from ${message.requesterId}`);
        this.handleIncomingSyncRequest(message.versionVector, message.requesterId);
        break;

      case "sync-response":
        console.log(`[WebSocket] Received sync response with ${message.operations.length} operations`);
        if (message.operations.length > 0) {
          this.engine.apply(message.operations);
          this.config.onRemoteOperation?.(message.operations);
        }
        break;

      case "operations":
        console.log(`[WebSocket] Received ${message.operations.length} operations from peer`);
        if (message.operations.length > 0) {
          this.engine.apply(message.operations);
          this.config.onRemoteOperation?.(message.operations);
        }
        break;

      case "error":
        console.error("[WebSocket] Server error:", message.message);
        this.setState({ status: "error", error: message.message });
        break;
    }
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  private setState(state: SyncState): void {
    this.state = state;
    this.config.onStateChange?.(state);
  }

  private updateState(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.setState({ status: "connected", peerCount: this.peerCount });
    } else if (this.roomId) {
      this.setState({ status: "connecting" });
    } else {
      this.setState({ status: "disconnected" });
    }
  }
}

/**
 * Create a WebSocket sync manager for a page.
 */
export function createWebSocketSync(
  engine: SyncEngine,
  config: WebSocketSyncConfig
): WebSocketSync {
  return new WebSocketSync(engine, config);
}
