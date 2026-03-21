/**
 * P2P Replication Protocol
 *
 * Implements Platform.sync using the NetworkDriver (WebRTC DataChannels).
 * Each document room maps to a NetworkTopic. When peers connect on a topic,
 * they exchange CRDT operations, sync requests/responses, and awareness
 * directly over the peer-to-peer data channel.
 *
 * Message protocol (JSON over DataChannel):
 *
 *   { type: "operations",     roomId, operations[] }
 *   { type: "sync-request",   roomId, versionVector, snapshotClock? }
 *   { type: "sync-response",  roomId, operations[], versionVector }
 *   { type: "awareness",      roomId, peerId, state }
 *   { type: "room-join",      roomId, peerId, user? }
 *   { type: "room-peers",     roomId, peers[] }
 */

import type { NetworkDriver, NetworkPeer, NetworkTopic } from "./driver";
import type {
  ConnectionState,
  SyncEvents,
  PageEvents,
  RoomUser,
} from "./types";
import type { AwarenessState } from "@/editor/sync/awareness";
import type { Operation } from "@/editor/sync/types";

// =============================================================================
// Message Types (over DataChannel)
// =============================================================================

interface OperationsMsg {
  type: "operations";
  roomId: string;
  operations: Operation[];
}

interface SyncRequestMsg {
  type: "sync-request";
  roomId: string;
  versionVector: Record<string, number>;
  snapshotClock?: { counter: number; peerId: string } | null;
  requesterId: string;
}

interface SyncResponseMsg {
  type: "sync-response";
  roomId: string;
  operations: Operation[];
  versionVector: Record<string, number>;
}

interface AwarenessMsg {
  type: "awareness";
  roomId: string;
  peerId: string;
  state: AwarenessState;
}

interface RoomJoinMsg {
  type: "room-join";
  roomId: string;
  peerId: string;
  user?: RoomUser;
}

interface RoomLeaveMsg {
  type: "room-leave";
  roomId: string;
  peerId: string;
}

interface RoomPeersMsg {
  type: "room-peers";
  roomId: string;
  peers: { peerId: string; user?: RoomUser }[];
  awarenessStates?: Record<string, AwarenessState>;
}

type SyncMessage =
  | OperationsMsg
  | SyncRequestMsg
  | SyncResponseMsg
  | AwarenessMsg
  | RoomJoinMsg
  | RoomLeaveMsg
  | RoomPeersMsg;

// =============================================================================
// Encoder / Decoder — JSON over Uint8Array
// =============================================================================

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(msg: SyncMessage): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

function decode(data: Uint8Array): SyncMessage | null {
  try {
    return JSON.parse(decoder.decode(data));
  } catch {
    return null;
  }
}

// =============================================================================
// Room State
// =============================================================================

interface RoomState {
  roomId: string;
  localPeerId: string;
  localUser?: RoomUser;
  callbacks: Partial<SyncEvents>;
  /** Peers currently in this room (by publicKey) */
  peerUsers: Map<string, RoomUser | undefined>;
  /** Awareness states we've collected */
  awarenessStates: Map<string, AwarenessState>;
}

// =============================================================================
// P2P Sync Implementation
// =============================================================================

export class P2PSync {
  private network: NetworkDriver;
  private topic: NetworkTopic | null = null;
  private topicKey: Uint8Array | null = null;
  private rooms = new Map<string, RoomState>();
  private connectionState: ConnectionState = "disconnected";
  private connectionListeners = new Set<(state: ConnectionState) => void>();
  private pageEventListeners = new Set<Partial<PageEvents>>();
  private peerCleanups = new Map<string, () => void>();

  constructor(network: NetworkDriver) {
    this.network = network;
  }

  // ---------------------------------------------------------------------------
  // Join / Leave
  // ---------------------------------------------------------------------------

  async joinRoom(
    roomId: string,
    peerId: string,
    user?: RoomUser,
    callbacks?: Partial<SyncEvents>,
  ): Promise<void> {
    // Store room state
    const room: RoomState = {
      roomId,
      localPeerId: peerId,
      localUser: user,
      callbacks: callbacks ?? {},
      peerUsers: new Map(),
      awarenessStates: new Map(),
    };
    this.rooms.set(roomId, room);

    // Join the network topic for this room (all rooms share one topic for now,
    // derived from room ID). Each room gets its own topic so peers only
    // discover others editing the same document.
    await this.ensureTopic(roomId);

    this.setConnectionState("connected");

    // Announce ourselves to all connected peers
    this.broadcastToAll({
      type: "room-join",
      roomId,
      peerId,
      user,
    });
  }

  async leaveRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;

    // Tell peers we're leaving this room
    this.broadcastToAll({
      type: "room-leave",
      roomId,
      peerId: room.localPeerId,
    });

    this.rooms.delete(roomId);

    // If no more rooms, tear down the topic
    if (this.rooms.size === 0 && this.topic) {
      await this.topic.destroy();
      this.topic = null;
      this.topicKey = null;
      this.peerCleanups.clear();
      this.setConnectionState("disconnected");
    }
  }

  // ---------------------------------------------------------------------------
  // Send Operations
  // ---------------------------------------------------------------------------

  sendOperations(roomId: string, operations: Operation[]): void {
    this.broadcastToAll({
      type: "operations",
      roomId,
      operations,
    });
  }

  // ---------------------------------------------------------------------------
  // Sync Request / Response
  // ---------------------------------------------------------------------------

  sendSyncRequest(
    roomId: string,
    versionVector: Record<string, number>,
    snapshotClock?: { counter: number; peerId: string } | null,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    this.broadcastToAll({
      type: "sync-request",
      roomId,
      versionVector,
      snapshotClock,
      requesterId: room.localPeerId,
    });
  }

  sendSyncResponse(
    roomId: string,
    operations: Operation[],
    versionVector: Record<string, number>,
    targetPeerId?: string,
  ): void {
    const msg: SyncResponseMsg = {
      type: "sync-response",
      roomId,
      operations,
      versionVector,
    };

    if (targetPeerId) {
      this.sendToPeer(targetPeerId, msg);
    } else {
      this.broadcastToAll(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Awareness
  // ---------------------------------------------------------------------------

  sendAwareness(roomId: string, state: AwarenessState): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    this.broadcastToAll({
      type: "awareness",
      roomId,
      peerId: room.localPeerId,
      state,
    });
  }

  // ---------------------------------------------------------------------------
  // Page Events
  // ---------------------------------------------------------------------------

  onPageEvents(callbacks: Partial<PageEvents>): () => void {
    this.pageEventListeners.add(callbacks);
    return () => { this.pageEventListeners.delete(callbacks); };
  }

  // ---------------------------------------------------------------------------
  // Connection State
  // ---------------------------------------------------------------------------

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionChange(cb: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(cb);
    return () => { this.connectionListeners.delete(cb); };
  }

  private setConnectionState(state: ConnectionState) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const cb of this.connectionListeners) cb(state);
  }

  // ---------------------------------------------------------------------------
  // Topic Management
  // ---------------------------------------------------------------------------

  private async ensureTopic(roomId: string): Promise<void> {
    const key = hexToBytes(roomId);

    // If we already have a topic for a different room, we need a new topic
    // For now, each room gets its own topic
    if (this.topic && this.topicKey && bytesEqual(this.topicKey, key)) {
      return;
    }

    // Destroy old topic if switching
    if (this.topic) {
      await this.topic.destroy();
      this.peerCleanups.clear();
    }

    this.topicKey = key;
    this.topic = await this.network.join(key);

    // Wire up peer join/leave
    this.topic.onPeerJoin((peer) => this.handlePeerJoin(peer));
    this.topic.onPeerLeave((publicKey) => this.handlePeerLeave(publicKey));

    // Handle already-connected peers (race condition: peers joined before our listener)
    for (const peer of this.topic.getPeers()) {
      this.handlePeerJoin(peer);
    }
  }

  // ---------------------------------------------------------------------------
  // Peer Handling
  // ---------------------------------------------------------------------------

  private handlePeerJoin(peer: NetworkPeer) {
    const peerKey = peer.remotePublicKey;

    // Listen for messages from this peer
    const unsub = peer.onMessage((data) => {
      const msg = decode(data);
      if (msg) this.handleMessage(peerKey, msg);
    });

    const unsubClose = peer.onClose(() => {
      this.handlePeerLeave(peerKey);
    });

    this.peerCleanups.set(peerKey, () => {
      unsub();
      unsubClose();
    });

    // Announce all our rooms to the new peer
    for (const room of this.rooms.values()) {
      peer.send(encode({
        type: "room-join",
        roomId: room.roomId,
        peerId: room.localPeerId,
        user: room.localUser,
      }));

      // Send them our current room peer list
      const peers: { peerId: string; user?: RoomUser }[] = [
        { peerId: room.localPeerId, user: room.localUser },
      ];
      for (const [pid, user] of room.peerUsers) {
        peers.push({ peerId: pid, user });
      }
      peer.send(encode({
        type: "room-peers",
        roomId: room.roomId,
        peers,
        awarenessStates: Object.fromEntries(room.awarenessStates),
      }));
    }
  }

  private handlePeerLeave(peerKey: string) {
    // Clean up listeners
    const cleanup = this.peerCleanups.get(peerKey);
    if (cleanup) {
      cleanup();
      this.peerCleanups.delete(peerKey);
    }

    // Remove from all rooms and notify callbacks
    for (const room of this.rooms.values()) {
      if (room.peerUsers.has(peerKey)) {
        room.peerUsers.delete(peerKey);
        room.awarenessStates.delete(peerKey);
        room.callbacks.onPeerLeft?.(peerKey);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Message Handling
  // ---------------------------------------------------------------------------

  private handleMessage(fromPeerKey: string, msg: SyncMessage) {
    switch (msg.type) {
      case "room-join":
        this.handleRoomJoin(fromPeerKey, msg);
        break;
      case "room-leave":
        this.handleRoomLeave(msg);
        break;
      case "room-peers":
        this.handleRoomPeers(msg);
        break;
      case "operations":
        this.handleOperations(msg);
        break;
      case "sync-request":
        this.handleSyncRequest(msg);
        break;
      case "sync-response":
        this.handleSyncResponse(msg);
        break;
      case "awareness":
        this.handleAwareness(msg);
        break;
    }
  }

  private handleRoomJoin(_fromPeerKey: string, msg: RoomJoinMsg) {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;

    // Track peer in room
    room.peerUsers.set(msg.peerId, msg.user);
    room.callbacks.onPeerJoined?.(msg.peerId, msg.user);
  }

  private handleRoomLeave(msg: RoomLeaveMsg) {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;

    room.peerUsers.delete(msg.peerId);
    room.awarenessStates.delete(msg.peerId);
    room.callbacks.onPeerLeft?.(msg.peerId);
  }

  private handleRoomPeers(msg: RoomPeersMsg) {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;

    const peerIds: string[] = [];
    for (const p of msg.peers) {
      if (p.peerId !== room.localPeerId) {
        room.peerUsers.set(p.peerId, p.user);
        peerIds.push(p.peerId);
      }
    }

    room.callbacks.onRoomPeers?.(peerIds, msg.awarenessStates);
  }

  private handleOperations(msg: OperationsMsg) {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;

    room.callbacks.onOperations?.(msg.operations);
  }

  private handleSyncRequest(msg: SyncRequestMsg) {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;

    room.callbacks.onSyncRequest?.(
      msg.versionVector,
      msg.snapshotClock,
      msg.requesterId,
    );
  }

  private handleSyncResponse(msg: SyncResponseMsg) {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;

    room.callbacks.onSyncResponse?.(msg.operations, msg.versionVector);
  }

  private handleAwareness(msg: AwarenessMsg) {
    const room = this.rooms.get(msg.roomId);
    if (!room) return;

    room.awarenessStates.set(msg.peerId, msg.state);
    room.callbacks.onAwareness?.(msg.peerId, msg.state);
  }

  // ---------------------------------------------------------------------------
  // Transport Helpers
  // ---------------------------------------------------------------------------

  private broadcastToAll(msg: SyncMessage) {
    if (!this.topic) return;
    const data = encode(msg);
    for (const peer of this.topic.getPeers()) {
      peer.send(data);
    }
  }

  private sendToPeer(peerId: string, msg: SyncMessage) {
    if (!this.topic) return;
    const data = encode(msg);
    // peerId from the sync layer maps to remotePublicKey in the network layer
    for (const peer of this.topic.getPeers()) {
      if (peer.remotePublicKey === peerId) {
        peer.send(data);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  async destroy(): Promise<void> {
    for (const roomId of this.rooms.keys()) {
      await this.leaveRoom(roomId);
    }
    this.connectionListeners.clear();
    this.pageEventListeners.clear();
  }
}

// =============================================================================
// Utilities
// =============================================================================

function hexToBytes(hex: string): Uint8Array {
  // If it's a UUID or other non-hex string, hash it to get consistent bytes
  // For UUIDs, strip dashes and convert
  const clean = hex.replace(/-/g, "");
  if (/^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0) {
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
    }
    return bytes;
  }
  // Fallback: encode as UTF-8
  return new TextEncoder().encode(hex);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
