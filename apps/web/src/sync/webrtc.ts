/**
 * WebRTC Sync Module
 *
 * Handles peer-to-peer connections for real-time CRDT operation exchange.
 * Uses WebRTC data channels for low-latency communication between peers.
 */

import type { Operation } from "./types";
import { SyncEngine, serializeVV, deserializeVV } from "./index";

// =============================================================================
// Types
// =============================================================================

/** Message types for signaling and data exchange */
export type SignalingMessage =
  | { type: "join"; roomId: string; peerId: string }
  | { type: "leave"; roomId: string; peerId: string }
  | { type: "offer"; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: "peer-joined"; peerId: string }
  | { type: "peer-left"; peerId: string }
  | { type: "room-peers"; peers: string[] };

/** Serialized version vector for JSON transfer */
type SerializedVV = Record<string, number>;

/** Data channel message types */
export type DataMessage =
  | { type: "sync-request"; versionVector: SerializedVV }
  | { type: "sync-response"; operations: Operation[] }
  | { type: "operations"; operations: Operation[] };

/** Connection state for a peer */
interface PeerConnection {
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  isConnected: boolean;
  /** Queue of messages waiting to be sent when buffer drains */
  sendQueue: string[];
}

/** WebRTC sync configuration */
export interface WebRTCSyncConfig {
  /** Signaling server WebSocket URL */
  signalingUrl: string;
  /** ICE servers for NAT traversal */
  iceServers?: RTCIceServer[];
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
// WebRTC Sync Manager
// =============================================================================

/**
 * WebRTCSync manages peer-to-peer connections for real-time collaboration.
 *
 * @example
 * const sync = new WebRTCSync(engine, {
 *   signalingUrl: "wss://signal.example.com",
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
export class WebRTCSync {
  private engine: SyncEngine;
  private config: WebRTCSyncConfig;
  private ws: WebSocket | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private roomId: string | null = null;
  private state: SyncState = { status: "disconnected" };
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(engine: SyncEngine, config: WebRTCSyncConfig) {
    this.engine = engine;
    this.config = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
      ...config,
    };
  }

  /**
   * Get the current sync state.
   */
  getState(): SyncState {
    return this.state;
  }

  /**
   * Join a collaboration room.
   * Connects to the signaling server and establishes peer connections.
   */
  async joinRoom(roomId: string): Promise<void> {
    if (this.roomId) {
      await this.leaveRoom();
    }

    this.roomId = roomId;
    this.setState({ status: "connecting" });

    return new Promise((resolve, reject) => {
      this.connectSignaling()
        .then(() => {
          this.sendSignaling({
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
   * Closes all peer connections and disconnects from signaling.
   */
  async leaveRoom(): Promise<void> {
    if (this.roomId) {
      this.sendSignaling({
        type: "leave",
        roomId: this.roomId,
        peerId: this.engine.getPeerId(),
      });
    }

    // Close all peer connections
    for (const [peerId] of this.peers) {
      this.closePeerConnection(peerId);
    }
    this.peers.clear();

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.roomId = null;
    this.setState({ status: "disconnected" });
  }

  /**
   * Broadcast operations to all connected peers.
   */
  broadcast(operations: Operation[]): void {
    if (operations.length === 0) return;

    const message: DataMessage = {
      type: "operations",
      operations,
    };

    const data = JSON.stringify(message);

    for (const [peerId, peer] of this.peers) {
      if (peer.isConnected && peer.dataChannel) {
        this.queueSend(peerId, data);
      }
    }
  }

  /**
   * Request sync from a peer.
   * Sends our version vector and receives missing operations.
   */
  private requestSync(peerId: string): void {
    const vv = this.engine.getVersionVector();
    const message: DataMessage = {
      type: "sync-request",
      versionVector: serializeVV(vv),
    };

    this.queueSend(peerId, JSON.stringify(message));
  }

  /**
   * Handle a sync request from a peer.
   * Sends back any operations they're missing.
   */
  private handleSyncRequest(peerId: string, peerVV: SerializedVV): void {
    const missingOps = this.engine.getOpsSince(deserializeVV(peerVV));
    const message: DataMessage = {
      type: "sync-response",
      operations: missingOps,
    };

    this.queueSend(peerId, JSON.stringify(message));
  }

  // ==========================================================================
  // Signaling
  // ==========================================================================

  private async connectSignaling(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.signalingUrl);

        this.ws.onopen = () => {
          console.log("[WebRTC] Connected to signaling server");
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as SignalingMessage;
            this.handleSignalingMessage(message);
          } catch (error) {
            console.error("[WebRTC] Invalid signaling message:", error);
          }
        };

        this.ws.onerror = (error) => {
          console.error("[WebRTC] Signaling error:", error);
          reject(new Error("Signaling connection failed"));
        };

        this.ws.onclose = () => {
          console.log("[WebRTC] Signaling connection closed");
          this.handleSignalingClose();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleSignalingClose(): void {
    if (this.roomId && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.setState({ status: "connecting" });

      setTimeout(() => {
        console.log(`[WebRTC] Reconnecting... (attempt ${this.reconnectAttempts})`);
        this.connectSignaling()
          .then(() => {
            if (this.roomId) {
              this.sendSignaling({
                type: "join",
                roomId: this.roomId,
                peerId: this.engine.getPeerId(),
              });
            }
          })
          .catch((error) => {
            console.error("[WebRTC] Reconnection failed:", error);
            this.setState({ status: "error", error: "Failed to reconnect" });
          });
      }, this.reconnectDelay * this.reconnectAttempts);
    } else if (this.roomId) {
      this.setState({ status: "error", error: "Connection lost" });
    }
  }

  private sendSignaling(message: SignalingMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private async handleSignalingMessage(message: SignalingMessage): Promise<void> {
    switch (message.type) {
      case "room-peers":
        // Connect to existing peers in the room
        const otherPeers = message.peers.filter(p => p !== this.engine.getPeerId());

        if (otherPeers.length === 0) {
          // We're the first peer in the room - load initial content
          console.log("[WebRTC] First peer in room, loading initial content");
          this.config.onFirstPeer?.();
        } else {
          // There are other peers, we'll receive content via sync
          console.log(`[WebRTC] Joining room with ${otherPeers.length} existing peers`);
          for (const peerId of otherPeers) {
            await this.createPeerConnection(peerId, true);
          }
        }
        this.updateState();
        break;

      case "peer-joined":
        console.log(`[WebRTC] Peer joined: ${message.peerId}`);
        // New peer will initiate connection
        break;

      case "peer-left":
        console.log(`[WebRTC] Peer left: ${message.peerId}`);
        this.closePeerConnection(message.peerId);
        this.updateState();
        break;

      case "offer":
        await this.handleOffer(message.from, message.sdp);
        break;

      case "answer":
        await this.handleAnswer(message.from, message.sdp);
        break;

      case "ice-candidate":
        await this.handleIceCandidate(message.from, message.candidate);
        break;
    }
  }

  // ==========================================================================
  // Peer Connection Management
  // ==========================================================================

  private async createPeerConnection(peerId: string, initiator: boolean): Promise<void> {
    console.log(`[WebRTC] Creating connection to ${peerId} (initiator: ${initiator})`);

    const connection = new RTCPeerConnection({
      iceServers: this.config.iceServers,
    });

    const peerConn: PeerConnection = {
      connection,
      dataChannel: null,
      isConnected: false,
      sendQueue: [],
    };

    this.peers.set(peerId, peerConn);

    // Handle ICE candidates
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignaling({
          type: "ice-candidate",
          from: this.engine.getPeerId(),
          to: peerId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Handle connection state changes
    connection.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state (${peerId}): ${connection.connectionState}`);
      if (connection.connectionState === "connected") {
        peerConn.isConnected = true;
        this.updateState();
      } else if (connection.connectionState === "failed" || connection.connectionState === "disconnected") {
        peerConn.isConnected = false;
        this.updateState();
      }
    };

    // Handle incoming data channels (non-initiator receives this)
    connection.ondatachannel = (event) => {
      console.log(`[WebRTC] Received data channel from ${peerId}`);
      peerConn.dataChannel = event.channel;
      // Non-initiator doesn't request sync - initiator will request from us
      this.setupDataChannel(peerId, event.channel, false);
    };

    if (initiator) {
      // Create data channel and offer
      const dataChannel = connection.createDataChannel("sync", {
        ordered: true,
      });
      peerConn.dataChannel = dataChannel;
      // Initiator requests sync when channel opens
      this.setupDataChannel(peerId, dataChannel, true);

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      this.sendSignaling({
        type: "offer",
        from: this.engine.getPeerId(),
        to: peerId,
        sdp: offer,
      });
    }
  }

  private async handleOffer(peerId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    let peerConn = this.peers.get(peerId);
    if (!peerConn) {
      await this.createPeerConnection(peerId, false);
      peerConn = this.peers.get(peerId)!;
    }

    await peerConn.connection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peerConn.connection.createAnswer();
    await peerConn.connection.setLocalDescription(answer);

    this.sendSignaling({
      type: "answer",
      from: this.engine.getPeerId(),
      to: peerId,
      sdp: answer,
    });
  }

  private async handleAnswer(peerId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const peerConn = this.peers.get(peerId);
    if (peerConn) {
      await peerConn.connection.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  }

  private async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peerConn = this.peers.get(peerId);
    if (peerConn) {
      await peerConn.connection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private closePeerConnection(peerId: string): void {
    const peerConn = this.peers.get(peerId);
    if (peerConn) {
      peerConn.dataChannel?.close();
      peerConn.connection.close();
      this.peers.delete(peerId);
    }
  }

  // ==========================================================================
  // Data Channel
  // ==========================================================================

  /** Buffer threshold before queueing messages (64KB) */
  private static readonly BUFFER_LOW_THRESHOLD = 64 * 1024;

  /**
   * Queue data to send through a data channel.
   * If buffer is low, sends immediately. Otherwise queues for later.
   */
  private queueSend(peerId: string, data: string): void {
    const peer = this.peers.get(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== "open") {
      return;
    }

    // Add to queue
    peer.sendQueue.push(data);

    // Try to flush the queue
    this.flushSendQueue(peerId);
  }

  /**
   * Flush queued messages for a peer when buffer space is available.
   */
  private flushSendQueue(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer?.dataChannel || peer.dataChannel.readyState !== "open") {
      return;
    }

    const channel = peer.dataChannel;

    while (peer.sendQueue.length > 0) {
      // Wait if buffer is too full
      if (channel.bufferedAmount > WebRTCSync.BUFFER_LOW_THRESHOLD) {
        // Set up callback to resume when buffer drains
        channel.bufferedAmountLowThreshold = WebRTCSync.BUFFER_LOW_THRESHOLD / 2;
        channel.onbufferedamountlow = () => {
          channel.onbufferedamountlow = null;
          this.flushSendQueue(peerId);
        };
        return;
      }

      const data = peer.sendQueue.shift()!;
      try {
        channel.send(data);
      } catch (error) {
        // Channel closed, stop trying
        console.warn(`[WebRTC] Failed to send to ${peerId}:`, error);
        return;
      }
    }
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel, shouldRequestSync: boolean): void {
    channel.onopen = () => {
      console.log(`[WebRTC] Data channel open with ${peerId}`);
      if (shouldRequestSync) {
        this.requestSync(peerId);
      }
    };

    channel.onclose = () => {
      console.log(`[WebRTC] Data channel closed with ${peerId}`);
    };

    channel.onerror = (error) => {
      console.error(`[WebRTC] Data channel error with ${peerId}:`, error);
    };

    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as DataMessage;
        this.handleDataMessage(peerId, message);
      } catch (error) {
        console.error(`[WebRTC] Invalid data message from ${peerId}:`, error);
      }
    };
  }

  private handleDataMessage(peerId: string, message: DataMessage): void {
    switch (message.type) {
      case "sync-request":
        this.handleSyncRequest(peerId, message.versionVector);
        break;

      case "sync-response":
      case "operations":
        if (message.operations.length > 0) {
          console.log(`[WebRTC] Received ${message.operations.length} ops from ${peerId}`);
          this.engine.apply(message.operations);
          this.config.onRemoteOperation?.(message.operations);
        }
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
    const connectedCount = Array.from(this.peers.values()).filter(
      (p) => p.isConnected
    ).length;

    if (connectedCount > 0 || this.ws?.readyState === WebSocket.OPEN) {
      this.setState({ status: "connected", peerCount: connectedCount });
    } else if (this.roomId) {
      this.setState({ status: "connecting" });
    } else {
      this.setState({ status: "disconnected" });
    }
  }
}

/**
 * Create a WebRTC sync manager for a page.
 */
export function createWebRTCSync(
  engine: SyncEngine,
  config: WebRTCSyncConfig
): WebRTCSync {
  return new WebRTCSync(engine, config);
}
