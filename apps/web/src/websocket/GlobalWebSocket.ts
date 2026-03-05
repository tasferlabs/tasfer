/**
 * GlobalWebSocket
 *
 * Core connection manager for a single global WebSocket connection.
 * Handles reconnection, message queuing, room subscriptions, and page events.
 */

import type {
  ConnectionInfo,
  ConnectionState,
  ServerMessage,
  ClientMessage,
  RoomCallbacks,
  PageEventCallbacks,
  SpaceEventCallbacks,
  // ShareEventCallbacks,
  RoomUser,
  Operation,
} from "./types";
import { isPageEvent, isSpaceEvent /*, isShareEvent */ } from "./types";
import type { AwarenessState } from "@/editor/sync/awareness";
import { getColorForPeer } from "@/editor/sync/awareness";
import { generatePeerId } from "@/editor/sync/id";
import { CLIENT_VERSION } from "@/version";

// =============================================================================
// Types
// =============================================================================

interface RoomSubscription {
  roomId: string;
  callbacks: RoomCallbacks;
  user?: RoomUser;
}

type ConnectionListener = (info: ConnectionInfo) => void;

/** Callback for update available notifications */
export type UpdateAvailableCallback = (info: {
  serverVersion: number;
  clientVersion: number;
  forceUpdate: boolean;
}) => void;

// =============================================================================
// GlobalWebSocket Class
// =============================================================================

export class GlobalWebSocket {
  private serverUrl: string;
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = "disconnected";
  private connectionError?: string;

  // Reconnection
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private baseReconnectDelay = 1000; // 1 second
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Message queue for offline messages
  private messageQueue: ClientMessage[] = [];

  // Subscriptions
  private roomSubscriptions: Map<string, RoomSubscription> = new Map();
  private connectionListeners: Set<ConnectionListener> = new Set();
  private pageEventListeners: Set<PageEventCallbacks> = new Set();
  private spaceEventListeners: Set<SpaceEventCallbacks> = new Set();
  // private shareEventListeners: Set<ShareEventCallbacks> = new Set();
  private updateAvailableListeners: Set<UpdateAvailableCallback> = new Set();

  // Peer identity
  private _peerId: string;
  private localUser: RoomUser;

  constructor(serverUrl: string, userName?: string) {
    this.serverUrl = serverUrl;
    this._peerId = generatePeerId();
    this.localUser = {
      peerId: this._peerId,
      name: userName,
      color: getColorForPeer(userName || this._peerId),
    };
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get the local peer ID.
   */
  get peerId(): string {
    return this._peerId;
  }

  /**
   * Get the local user info.
   */
  getLocalUser(): RoomUser {
    return this.localUser;
  }

  /**
   * Update the local user name.
   */
  setUserName(name: string): void {
    this.localUser = {
      ...this.localUser,
      name,
      color: getColorForPeer(name || this.localUser.peerId),
    };
  }

  /**
   * Update the local user name and avatar.
   */
  setUserInfo(name: string, avatar: string | null): void {
    this.localUser = {
      ...this.localUser,
      name,
      avatar,
      color: getColorForPeer(name || this.localUser.peerId),
    };
  }

  /**
   * Get current connection state.
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Get full connection info.
   */
  getConnectionInfo(): ConnectionInfo {
    return {
      state: this.connectionState,
      error: this.connectionError,
      reconnectAttempt:
        this.reconnectAttempts > 0 ? this.reconnectAttempts : undefined,
    };
  }

  /**
   * Connect to the WebSocket server.
   */
  connect(): Promise<void> {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return Promise.resolve();
    }

    return this.createConnection();
  }

  /**
   * Disconnect from the WebSocket server.
   */
  disconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;

    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }

    this.setConnectionState("disconnected");
  }

  /**
   * Force reconnect (e.g., after coming back online).
   */
  async reconnect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.disconnect();
    this.reconnectAttempts = 0;
    // connect() will rejoin all subscribed rooms via createConnection()
    await this.connect();
  }

  /**
   * Subscribe to connection state changes.
   */
  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    // Immediately notify with current state
    listener(this.getConnectionInfo());
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  /**
   * Subscribe to page lifecycle events.
   */
  onPageEvents(callbacks: PageEventCallbacks): () => void {
    this.pageEventListeners.add(callbacks);
    return () => {
      this.pageEventListeners.delete(callbacks);
    };
  }

  /**
   * Subscribe to space/group lifecycle events.
   */
  onSpaceEvents(callbacks: SpaceEventCallbacks): () => void {
    this.spaceEventListeners.add(callbacks);
    return () => {
      this.spaceEventListeners.delete(callbacks);
    };
  }

  // /**
  //  * Subscribe to share lifecycle events.
  //  */
  // onShareEvents(callbacks: ShareEventCallbacks): () => void {
  //   this.shareEventListeners.add(callbacks);
  //   return () => {
  //     this.shareEventListeners.delete(callbacks);
  //   };
  // }

  /**
   * Subscribe to update available notifications.
   */
  onUpdateAvailable(callback: UpdateAvailableCallback): () => void {
    this.updateAvailableListeners.add(callback);
    return () => {
      this.updateAvailableListeners.delete(callback);
    };
  }

  /**
   * Join a document room for CRDT sync.
   * Returns a function to leave the room.
   */
  joinRoom(
    roomId: string,
    callbacks: RoomCallbacks,
    user?: RoomUser,
  ): () => void {
    const subscription: RoomSubscription = {
      roomId,
      callbacks,
      user: user || this.localUser,
    };
    this.roomSubscriptions.set(roomId, subscription);

    // Send join message if connected
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendJoinRoom(roomId, subscription.user);
    }

    return () => {
      this.leaveRoom(roomId);
    };
  }

  /**
   * Leave a document room.
   */
  leaveRoom(roomId: string): void {
    const subscription = this.roomSubscriptions.get(roomId);
    if (!subscription) return;

    // Send leave message if connected
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        type: "leave",
        roomId,
        peerId: this._peerId,
      });
    }

    this.roomSubscriptions.delete(roomId);
  }

  /**
   * Broadcast operations to a room.
   * If not connected, operations are not sent (they're persisted in IndexedDB
   * and will be broadcast on reconnect via onJoined callback).
   */
  broadcastOperations(roomId: string, operations: Operation[]): void {
    if (!this.roomSubscriptions.has(roomId)) {
      console.warn(
        `[GlobalWebSocket] Cannot broadcast to room ${roomId} - not subscribed`,
      );
      return;
    }

    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.send({
      type: "operations",
      operations,
    });
  }

  /**
   * Broadcast awareness state to a room.
   */
  broadcastAwareness(roomId: string, state: AwarenessState): void {
    if (!this.roomSubscriptions.has(roomId)) {
      console.warn(
        `[GlobalWebSocket] Cannot broadcast awareness to room ${roomId} - not subscribed`,
      );
      return;
    }

    this.send({
      type: "awareness",
      peerId: this._peerId,
      state,
    });
  }

  /**
   * Send a sync request to a room.
   */
  sendSyncRequest(
    roomId: string,
    versionVector: Record<string, number>,
    snapshotClock?: { counter: number; peerId: string } | null,
  ): void {
    if (!this.roomSubscriptions.has(roomId)) {
      console.warn(
        `[GlobalWebSocket] Cannot send sync request to room ${roomId} - not subscribed`,
      );
      return;
    }

    this.send({
      type: "sync-request",
      versionVector,
      snapshotClock,
    });
  }

  /**
   * Send a sync response to a specific peer.
   */
  sendSyncResponse(
    roomId: string,
    operations: Operation[],
    versionVector: Record<string, number>,
    targetPeerId?: string,
  ): void {
    if (!this.roomSubscriptions.has(roomId)) {
      console.warn(
        `[GlobalWebSocket] Cannot send sync response to room ${roomId} - not subscribed`,
      );
      return;
    }

    this.send({
      type: "sync-response",
      operations,
      versionVector,
      targetPeerId,
    });
  }

  /**
   * Get the number of rooms currently subscribed.
   */
  getRoomCount(): number {
    return this.roomSubscriptions.size;
  }

  /**
   * Check if subscribed to a specific room.
   */
  isInRoom(roomId: string): boolean {
    return this.roomSubscriptions.has(roomId);
  }

  // ==========================================================================
  // Private: Connection Management
  // ==========================================================================

  private createConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setConnectionState("connecting");

      try {
        this.ws = new WebSocket(this.serverUrl);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.setConnectionState("connected");

          // Send hello message with client version immediately
          this.send({ type: "hello", clientVersion: CLIENT_VERSION });

          this.flushMessageQueue();

          // Rejoin all subscribed rooms
          for (const [roomId, subscription] of this.roomSubscriptions) {
            this.sendJoinRoom(roomId, subscription.user);
          }

          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as ServerMessage;
            this.handleMessage(message);
          } catch (error) {
            console.error("[GlobalWebSocket] Invalid message:", error);
          }
        };

        this.ws.onerror = (error) => {
          console.error("[GlobalWebSocket] WebSocket error:", error);
          this.connectionError = "WebSocket connection failed";
          reject(new Error("WebSocket connection failed"));
        };

        this.ws.onclose = () => {
          this.handleClose();
        };
      } catch (error) {
        this.setConnectionState("error", "Failed to create WebSocket");
        reject(error);
      }
    });
  }

  private handleClose(): void {
    this.ws = null;

    // Attempt reconnect if we have subscriptions
    if (this.roomSubscriptions.size > 0 || this.pageEventListeners.size > 0 || this.spaceEventListeners.size > 0) {
      this.attemptReconnect();
    } else {
      this.setConnectionState("disconnected");
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[GlobalWebSocket] Max reconnect attempts reached");
      this.setConnectionState(
        "error",
        "Connection lost - max retries exceeded",
      );
      return;
    }

    this.reconnectAttempts++;
    this.setConnectionState("connecting");

    // Exponential backoff
    const delay =
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    this.reconnectTimer = setTimeout(() => {
      this.createConnection().catch((error) => {
        console.error("[GlobalWebSocket] Reconnect failed:", error);
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setConnectionState(state: ConnectionState, error?: string): void {
    this.connectionState = state;
    this.connectionError = error;

    const info = this.getConnectionInfo();
    for (const listener of this.connectionListeners) {
      try {
        listener(info);
      } catch (e) {
        console.error("[GlobalWebSocket] Connection listener error:", e);
      }
    }
  }

  // ==========================================================================
  // Private: Message Handling
  // ==========================================================================

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue message for when connection is restored
      this.messageQueue.push(message);
    }
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift()!;
      this.send(message);
    }
  }

  private sendJoinRoom(roomId: string, user?: RoomUser): void {
    this.send({
      type: "join",
      roomId,
      peerId: this._peerId,
      user: user || this.localUser,
      clientVersion: CLIENT_VERSION,
    });
  }

  private handleMessage(message: ServerMessage): void {
    // Handle page events (broadcast to all listeners)
    if (isPageEvent(message)) {
      this.handlePageEvent(message);
      return;
    }

    // Handle space events (broadcast to all listeners)
    if (isSpaceEvent(message)) {
      this.handleSpaceEvent(message);
      return;
    }

    // // Handle share events (broadcast to all listeners)
    // if (isShareEvent(message)) {
    //   this.handleShareEvent(message);
    //   return;
    // }

    // Handle room messages (route to specific room subscription)
    switch (message.type) {
      case "room-peers":
        // Find which room this is for (most recently joined room)
        // The server doesn't include roomId in room-peers, so we route to the last joined room
        for (const [, subscription] of this.roomSubscriptions) {
          subscription.callbacks.onRoomPeers?.(
            message.peers,
            message.awarenessStates,
          );
        }
        break;

      case "peer-joined":
        for (const subscription of this.roomSubscriptions.values()) {
          subscription.callbacks.onPeerJoined?.(message.peerId, message.user);
        }
        break;

      case "peer-left":
        for (const subscription of this.roomSubscriptions.values()) {
          subscription.callbacks.onPeerLeft?.(message.peerId);
        }
        break;

      case "operations":
        for (const subscription of this.roomSubscriptions.values()) {
          subscription.callbacks.onOperations?.(message.operations);
        }
        break;

      case "sync-request":
        for (const subscription of this.roomSubscriptions.values()) {
          subscription.callbacks.onSyncRequest?.(
            message.versionVector,
            message.snapshotClock,
            message.requesterId,
          );
        }
        break;

      case "sync-response":
        for (const subscription of this.roomSubscriptions.values()) {
          subscription.callbacks.onSyncResponse?.(
            message.operations,
            message.versionVector,
          );
        }
        break;

      case "awareness":
        for (const subscription of this.roomSubscriptions.values()) {
          subscription.callbacks.onAwareness?.(message.peerId, message.state);
        }
        break;

      case "error":
        console.error("[GlobalWebSocket] Server error:", message.message);
        for (const subscription of this.roomSubscriptions.values()) {
          subscription.callbacks.onError?.(message.message);
        }
        break;

      case "update-available":
        console.log(
          `[GlobalWebSocket] Update available: server v${message.serverVersion}, client v${message.clientVersion}${message.forceUpdate ? " (FORCE)" : ""}`,
        );
        for (const callback of this.updateAvailableListeners) {
          try {
            callback({
              serverVersion: message.serverVersion,
              clientVersion: message.clientVersion,
              forceUpdate: message.forceUpdate,
            });
          } catch (e) {
            console.error("[GlobalWebSocket] Update available callback error:", e);
          }
        }
        break;
    }
  }

  private handlePageEvent(event: ServerMessage): void {
    for (const callbacks of this.pageEventListeners) {
      try {
        switch (event.type) {
          case "page-created":
            callbacks.onPageCreated?.(event.page);
            break;
          case "page-deleted":
            callbacks.onPageDeleted?.(event.pageId);
            break;
          case "page-moved":
            callbacks.onPageMoved?.(
              event.pageId,
              event.oldParentId,
              event.newParentId,
            );
            break;
          case "page-reordered":
            callbacks.onPageReordered?.(
              event.pageId,
              event.parentId,
              event.order,
            );
            break;
          case "page-title-updated":
            callbacks.onPageTitleUpdated?.(event.pageId, event.title);
            break;
        }
      } catch (e) {
        console.error("[GlobalWebSocket] Page event listener error:", e);
      }
    }
  }

  private handleSpaceEvent(event: ServerMessage): void {
    for (const callbacks of this.spaceEventListeners) {
      try {
        switch (event.type) {
          case "space-created":
            callbacks.onSpaceCreated?.(event.space);
            break;
          case "space-updated":
            callbacks.onSpaceUpdated?.(event.spaceId, event.name, event.description);
            break;
          case "space-deleted":
            callbacks.onSpaceDeleted?.(event.spaceId);
            break;
          case "member-added":
            callbacks.onMemberAdded?.(event.spaceId, event.member);
            break;
          case "member-removed":
            callbacks.onMemberRemoved?.(event.spaceId, event.memberId, event.userId);
            break;
          case "member-left":
            callbacks.onMemberLeft?.(event.spaceId, event.userId);
            break;
        }
      } catch (e) {
        console.error("[GlobalWebSocket] Space event listener error:", e);
      }
    }
  }

  // private handleShareEvent(event: ServerMessage): void {
  //   for (const callbacks of this.shareEventListeners) {
  //     try {
  //       switch (event.type) {
  //         case "share-created":
  //           callbacks.onShareCreated?.(event);
  //           break;
  //         case "share-updated":
  //           callbacks.onShareUpdated?.(event);
  //           break;
  //         case "share-removed":
  //           callbacks.onShareRemoved?.(event);
  //           break;
  //       }
  //     } catch (e) {
  //       console.error("[GlobalWebSocket] Share event listener error:", e);
  //     }
  //   }
  // }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let globalInstance: GlobalWebSocket | null = null;

/**
 * Get or create the global WebSocket instance.
 */
export function getGlobalWebSocket(serverUrl: string): GlobalWebSocket {
  if (!globalInstance) {
    globalInstance = new GlobalWebSocket(serverUrl);
  }
  return globalInstance;
}

/**
 * Reset the global WebSocket instance (for testing).
 */
export function resetGlobalWebSocket(): void {
  if (globalInstance) {
    globalInstance.disconnect();
    globalInstance = null;
  }
}
