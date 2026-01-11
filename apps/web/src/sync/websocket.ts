/**
 * WebSocket Sync Module
 *
 * Handles real-time CRDT operation exchange via WebSocket server.
 * Replaces WebRTC peer-to-peer with centralized server communication.
 */

import { SyncEngine, serializeVV } from "./index";
import type { Operation } from "./types";

// =============================================================================
// Types
// =============================================================================

/** Message types for server communication */
export type ServerMessage =
  | { type: "join"; roomId: string; peerId: string }
  | { type: "leave"; roomId: string; peerId: string }
  | { type: "sync-request"; versionVector: Record<string, number> }
  | { type: "sync-response"; operations: Operation[]; versionVector: Record<string, number> }
  | { type: "operations"; operations: Operation[] }
  | { type: "peer-joined"; peerId: string }
  | { type: "peer-left"; peerId: string }
  | { type: "room-peers"; peers: string[] }
  | { type: "error"; message: string };

/** WebSocket sync configuration */
export interface WebSocketSyncConfig {
  /** WebSocket server URL */
  serverUrl: string;
  /** Called when sync state changes */
  onStateChange?: (state: SyncState) => void;
  /** Called when a remote operation is received */
  onRemoteOperation?: (ops: Operation[]) => void;
  /** Called when you're the first/only peer in the room (load initial content) */
  onFirstPeer?: () => void;
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

  constructor(engine: SyncEngine, config: WebSocketSyncConfig) {
    this.engine = engine;
    this.config = config;
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
        this.updateState();
        break;

      case "peer-joined":
        console.log(`[WebSocket] Peer joined: ${message.peerId}`);
        this.peerCount++;
        this.updateState();
        break;

      case "peer-left":
        console.log(`[WebSocket] Peer left: ${message.peerId}`);
        this.peerCount = Math.max(0, this.peerCount - 1);
        this.updateState();
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
