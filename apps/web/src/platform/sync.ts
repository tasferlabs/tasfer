/**
 * Replicator — Pull-based P2P Replication
 *
 * Replaces the old topic/swarm-based P2PSync with a per-peer connection model.
 * Each peer pair communicates over a single WebRTC DataChannel, carrying all
 * shared spaces.
 *
 * Protocol:
 *   1. Connect to each trusted peer via deterministic topic
 *      (SHA-256 of sorted public keys — only the two peers can compute it)
 *   2. Exchange hellos (public key + space list)
 *   3. For each shared space, bidirectional pull (send VV, receive missing ops)
 *   4. Real-time push: new ops sent immediately after catch-up
 *   5. Rooms provide awareness routing (cursor/selection for open pages)
 *
 * Message protocol (JSON over DataChannel):
 *
 *   Handshake:
 *     { type: "hello",      publicKey, spaces[] }
 *
 *   Replication (pull-based catch-up):
 *     { type: "sync-pull",  spaceId, spaceVV, pageVVs }
 *     { type: "sync-data",  spaceId, spaceOps[], pageOps }
 *
 *   Real-time push (after catch-up):
 *     { type: "space-ops",  spaceId, ops[] }
 *     { type: "page-ops",   spaceId, pageId, ops[] }
 *
 *   Room awareness (per-page presence):
 *     { type: "room-join",  pageId, peerId, user? }
 *     { type: "room-leave", pageId, peerId }
 *     { type: "room-peers", pageId, peers[], awarenessStates? }
 *     { type: "awareness",  pageId, peerId, state }
 *
 *   Per-page sync (fallback for late-opening editors):
 *     { type: "sync-req",   pageId, versionVector, requesterId }
 *     { type: "sync-res",   pageId, ops[], versionVector }
 *
 *   Asset (lazy pull):
 *     { type: "asset-req",  hash }
 *     { type: "asset-data", hash, ext, data }
 *
 *   Pairing (one-time topic):
 *     { type: "pair-hello", publicKey, name, proof, spaceId, spaceName }
 *     { type: "pair-ack",   publicKey, name, proof }
 */

import type { NetworkDriver, NetworkTopic, NetworkPeer, CryptoDriver } from "./driver";
import { logNet } from "./devlog";
import type {
  ConnectionState,
  SyncEvents,
  PageEvents,
  RoomUser,
  SpaceOperation,
  SpaceInvite,
  PairCallbacks,
  Identity,
  Peer,
} from "./types";
import type { AwarenessState } from "@/editor/sync/awareness";
import type { Operation } from "@/editor/sync/types";

// =============================================================================
// ReplicatorHost — what the Replicator needs from the Engine
// =============================================================================

export interface ReplicatorHost {
  /** Get the local device identity */
  getIdentity(): Promise<Identity>;
  /** Get the private key for signing (pairing proofs) */
  getPrivateKey(): Promise<string>;
  /** Get the crypto driver for sign/verify */
  getCrypto(): CryptoDriver;
  /** Get all trusted peers */
  getTrustedPeers(): Promise<Peer[]>;
  /** Get IDs of all spaces this device belongs to */
  getSpaceIds(): Promise<string[]>;
  /** Get members of a space (for access control) */
  getSpaceMembers(spaceId: string): Promise<{ publicKey: string }[]>;
  /** Get the version vector for a space's CRDT ops */
  getSpaceVV(spaceId: string): Promise<Record<string, number>>;
  /** Get version vectors for all pages in a space */
  getPageVVs(spaceId: string): Promise<Record<string, Record<string, number>>>;
  /** Build a sync response: return ops the requesting peer is missing */
  buildSyncResponse(
    spaceId: string,
    spaceVV: Record<string, number>,
    pageVVs: Record<string, Record<string, number>>,
  ): Promise<{ spaceOps: SpaceOperation[]; pageOps: Record<string, Operation[]> }>;
  /** Store + apply remote space ops */
  applyRemoteSpaceOps(spaceId: string, ops: SpaceOperation[]): Promise<void>;
  /** Store remote page ops */
  applyRemotePageOps(pageId: string, ops: Operation[]): Promise<void>;
  /** Read a local asset's raw data + extension. Returns null if not found. */
  getAssetData(hash: string): Promise<{ ext: string; data: Uint8Array } | null>;
  /** Store an asset received from a peer */
  storeAssetData(hash: string, ext: string, data: Uint8Array): Promise<void>;
}

// =============================================================================
// Message Types
// =============================================================================

interface HelloMsg { type: "hello"; publicKey: string; spaces: string[] }
interface SyncPullMsg { type: "sync-pull"; spaceId: string; spaceVV: Record<string, number>; pageVVs: Record<string, Record<string, number>> }
interface SyncDataMsg { type: "sync-data"; spaceId: string; spaceOps: SpaceOperation[]; pageOps: Record<string, Operation[]> }
interface SpaceOpsMsg { type: "space-ops"; spaceId: string; ops: SpaceOperation[] }
interface PageOpsMsg { type: "page-ops"; spaceId: string; pageId: string; ops: Operation[] }
interface RoomJoinMsg { type: "room-join"; pageId: string; peerId: string; user?: RoomUser }
interface RoomLeaveMsg { type: "room-leave"; pageId: string; peerId: string }
interface RoomPeersMsg { type: "room-peers"; pageId: string; peers: { peerId: string; user?: RoomUser }[]; awarenessStates?: Record<string, AwarenessState> }
interface AwarenessMsg { type: "awareness"; pageId: string; peerId: string; state: AwarenessState }
interface SyncReqMsg { type: "sync-req"; pageId: string; versionVector: Record<string, number>; requesterId: string }
interface SyncResMsg { type: "sync-res"; pageId: string; ops: Operation[]; versionVector: Record<string, number> }
interface AssetReqMsg { type: "asset-req"; hash: string }
interface AssetDataMsg { type: "asset-data"; hash: string; ext: string; data: string }
interface PairHelloMsg { type: "pair-hello"; publicKey: string; name: string; proof: string; spaceId: string; spaceName: string }
interface PairAckMsg { type: "pair-ack"; publicKey: string; name: string; proof: string }

type Message =
  | HelloMsg | SyncPullMsg | SyncDataMsg
  | SpaceOpsMsg | PageOpsMsg
  | RoomJoinMsg | RoomLeaveMsg | RoomPeersMsg
  | AwarenessMsg | SyncReqMsg | SyncResMsg
  | AssetReqMsg | AssetDataMsg
  | PairHelloMsg | PairAckMsg;

// =============================================================================
// Internal State
// =============================================================================

interface PeerConnection {
  publicKey: string;
  netPeer: NetworkPeer;
  sharedSpaces: Set<string>;
  cleanup: () => void;
}

interface RoomState {
  pageId: string;
  spaceId: string;
  localPeerId: string;
  localUser?: RoomUser;
  callbacks: Partial<SyncEvents>;
  remotePeers: Map<string, RoomUser | undefined>;
  awarenessStates: Map<string, AwarenessState>;
}

interface PairingSession {
  topicHex: string;
  topic: NetworkTopic;
  invite: SpaceInvite;
  role: "initiator" | "acceptor";
  localPublicKey: string;
  localName: string;
  privateKey: string;
  callbacks: PairCallbacks;
  completed: boolean;
  /** Multi-peer mode: don't destroy topic after first peer */
  multi: boolean;
  /** Track peers that already completed pairing (by public key) */
  completedPeers: Set<string>;
}

// =============================================================================
// Encoder / Decoder — JSON over Uint8Array
// =============================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

function encode(msg: Message): Uint8Array {
  return enc.encode(JSON.stringify(msg));
}

function decode(data: Uint8Array): Message | null {
  try { return JSON.parse(dec.decode(data)); }
  catch { return null; }
}

// =============================================================================
// Replicator
// =============================================================================

export class Replicator {
  private network: NetworkDriver;
  private host: ReplicatorHost;

  private localPublicKey = "";

  /** One topic per trusted peer, keyed by topic hex */
  private topics = new Map<string, { topic: NetworkTopic; remotePubKey: string }>();

  /** Connected peers, keyed by public key */
  private peers = new Map<string, PeerConnection>();

  /** Open document rooms, keyed by pageId */
  private rooms = new Map<string, RoomState>();

  /** Active pairing session */
  private pairingSession: PairingSession | null = null;

  /** Pending asset requests: hash → resolve callbacks waiting for the data */
  private pendingAssetRequests = new Map<string, Array<(found: boolean) => void>>();

  /** Connection state */
  private connectionState: ConnectionState = "disconnected";
  private connectionListeners = new Set<(state: ConnectionState) => void>();
  private connectedPeersListeners = new Set<(peers: string[]) => void>();
  private pageEventListeners = new Set<Partial<PageEvents>>();

  constructor(network: NetworkDriver, host: ReplicatorHost) {
    this.network = network;
    this.host = host;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the replicator: connect to all trusted peers.
   * Call once after engine init + identity is available.
   */
  async start(): Promise<void> {
    const identity = await this.host.getIdentity();
    this.localPublicKey = identity.publicKey;

    // Set our public key as the signaling ID
    this.network.setLocalId(this.localPublicKey);

    const trustedPeers = await this.host.getTrustedPeers();
    for (const peer of trustedPeers) {
      if (peer.trusted) {
        await this.connectToPeer(peer.publicKey);
      }
    }
  }

  /** Connect to a newly-paired peer */
  async addPeer(publicKey: string): Promise<void> {
    if (this.peers.has(publicKey)) return;
    await this.connectToPeer(publicKey);
  }

  /** Disconnect from a peer */
  async removePeer(publicKey: string): Promise<void> {
    const conn = this.peers.get(publicKey);
    if (conn) {
      conn.cleanup();
      conn.netPeer.close();
      this.peers.delete(publicKey);
      this.emitConnectedPeers();
    }
    for (const [hex, entry] of this.topics) {
      if (entry.remotePubKey === publicKey) {
        await entry.topic.destroy();
        this.topics.delete(hex);
        break;
      }
    }
    this.updateConnectionState();
  }

  // ---------------------------------------------------------------------------
  // Platform.sync — Room (awareness + per-page editing)
  // ---------------------------------------------------------------------------

  async joinRoom(
    roomId: string,
    peerId: string,
    user?: RoomUser,
    callbacks?: Partial<SyncEvents>,
    spaceId?: string,
  ): Promise<void> {
    const room: RoomState = {
      pageId: roomId,
      spaceId: spaceId || "",
      localPeerId: peerId,
      localUser: user,
      callbacks: callbacks ?? {},
      remotePeers: new Map(),
      awarenessStates: new Map(),
    };
    this.rooms.set(roomId, room);

    // Announce to all peers who share this space
    if (spaceId) {
      this.broadcastToSpacePeers(spaceId, {
        type: "room-join",
        pageId: roomId,
        peerId,
        user,
      });

      // Immediately fire onRoomPeers so the hook knows about connected space peers.
      // In the old model this came from the topic; now we derive it from connections.
      const spacePeerIds: string[] = [];
      for (const conn of this.peers.values()) {
        if (conn.sharedSpaces.has(spaceId)) {
          spacePeerIds.push(conn.publicKey.slice(0, 32));
        }
      }
      // Fire asynchronously so the hook has finished setting up
      queueMicrotask(() => {
        callbacks?.onRoomPeers?.(spacePeerIds, undefined);
      });
    }

    this.setConnectionState("connected");
  }

  async leaveRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.spaceId) {
      this.broadcastToSpacePeers(room.spaceId, {
        type: "room-leave",
        pageId: roomId,
        peerId: room.localPeerId,
      });
    }

    this.rooms.delete(roomId);
    this.updateConnectionState();
  }

  sendOperations(roomId: string, operations: Operation[]): void {
    const room = this.rooms.get(roomId);
    if (!room || !room.spaceId) return;

    this.broadcastToSpacePeers(room.spaceId, {
      type: "page-ops",
      spaceId: room.spaceId,
      pageId: roomId,
      ops: operations,
    });
  }

  sendSyncRequest(
    roomId: string,
    versionVector: Record<string, number>,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room || !room.spaceId) return;

    this.broadcastToSpacePeers(room.spaceId, {
      type: "sync-req",
      pageId: roomId,
      versionVector,
      requesterId: room.localPeerId,
    });
  }

  sendSyncResponse(
    roomId: string,
    operations: Operation[],
    versionVector: Record<string, number>,
    targetPeerId?: string,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room || !room.spaceId) return;

    const msg: SyncResMsg = {
      type: "sync-res",
      pageId: roomId,
      ops: operations,
      versionVector,
    };

    if (targetPeerId) {
      this.sendToPeer(targetPeerId, msg);
    } else {
      this.broadcastToSpacePeers(room.spaceId, msg);
    }
  }

  sendAwareness(roomId: string, state: AwarenessState): void {
    const room = this.rooms.get(roomId);
    if (!room || !room.spaceId) return;

    this.broadcastToSpacePeers(room.spaceId, {
      type: "awareness",
      pageId: roomId,
      peerId: room.localPeerId,
      state,
    });
  }

  onPageEvents(callbacks: Partial<PageEvents>): () => void {
    this.pageEventListeners.add(callbacks);
    return () => { this.pageEventListeners.delete(callbacks); };
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionChange(cb: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(cb);
    return () => { this.connectionListeners.delete(cb); };
  }

  getConnectedPeers(): string[] {
    return Array.from(this.peers.keys());
  }

  onConnectedPeersChange(cb: (peers: string[]) => void): () => void {
    this.connectedPeersListeners.add(cb);
    return () => { this.connectedPeersListeners.delete(cb); };
  }

  // ---------------------------------------------------------------------------
  // Asset sync (lazy pull from peers)
  // ---------------------------------------------------------------------------

  /**
   * Request an asset by hash from all connected peers.
   * Returns true if any peer responded with the data, false if none had it.
   */
  requestAsset(hash: string): Promise<boolean> {
    if (this.peers.size === 0) return Promise.resolve(false);

    // If there's already a pending request for this hash, piggyback on it
    const existing = this.pendingAssetRequests.get(hash);
    if (existing) {
      return new Promise<boolean>((resolve) => { existing.push(resolve); });
    }

    return new Promise<boolean>((resolve) => {
      const callbacks = [resolve];
      this.pendingAssetRequests.set(hash, callbacks);

      // Broadcast request to all peers
      const msg: AssetReqMsg = { type: "asset-req", hash };
      for (const conn of this.peers.values()) {
        this.sendDirect(conn, msg);
      }

      // Timeout after 10s — peer might be offline or not have it
      setTimeout(() => {
        if (this.pendingAssetRequests.has(hash)) {
          this.pendingAssetRequests.delete(hash);
          for (const cb of callbacks) cb(false);
        }
      }, 10_000);
    });
  }

  // ---------------------------------------------------------------------------
  // Push methods (called by Engine when local ops are generated)
  // ---------------------------------------------------------------------------

  pushSpaceOps(spaceId: string, ops: SpaceOperation[]): void {
    this.broadcastToSpacePeers(spaceId, {
      type: "space-ops",
      spaceId,
      ops,
    });
  }

  pushPageOps(spaceId: string, pageId: string, ops: Operation[]): void {
    this.broadcastToSpacePeers(spaceId, {
      type: "page-ops",
      spaceId,
      pageId,
      ops,
    });
  }

  // ---------------------------------------------------------------------------
  // Pairing (one-time topic for peer discovery + mutual auth)
  // ---------------------------------------------------------------------------

  async startPairing(opts: {
    invite: SpaceInvite;
    role: "initiator" | "acceptor";
    localPublicKey: string;
    localName: string;
    privateKey: string;
    callbacks: PairCallbacks;
  }): Promise<void> {
    if (this.pairingSession) await this.cancelPairing();

    const topicHex = opts.invite.topic;
    const topic = await this.network.join(hexToBytes(topicHex));

    this.pairingSession = {
      topicHex,
      topic,
      invite: opts.invite,
      role: opts.role,
      localPublicKey: opts.localPublicKey,
      localName: opts.localName,
      privateKey: opts.privateKey,
      callbacks: opts.callbacks,
      completed: false,
      multi: opts.callbacks.multi ?? false,
      completedPeers: new Set(),
    };

    const session = this.pairingSession;

    const handlePeer = (peer: NetworkPeer) => {
      if (session.completed) return;
      session.callbacks.onConnected?.();

      peer.onMessage(async (data) => {
        const msg = decode(data);
        if (!msg || session.completed) return;
        if (msg.type === "pair-hello" || msg.type === "pair-ack") {
          await this.handlePairingMessage(peer, msg);
        }
      });

      this.sendPairHello(peer, session);
    };

    topic.onPeerJoin(handlePeer);
    for (const peer of topic.getPeers()) handlePeer(peer);
  }

  async cancelPairing(): Promise<void> {
    if (!this.pairingSession) return;
    await this.pairingSession.topic.destroy();
    this.pairingSession = null;
  }

  // ---------------------------------------------------------------------------
  // Private: Peer connection management
  // ---------------------------------------------------------------------------

  private async connectToPeer(remotePubKey: string): Promise<void> {
    const topicHex = await computePeerTopic(this.localPublicKey, remotePubKey);

    if (this.topics.has(topicHex)) return;

    const topic = await this.network.join(hexToBytes(topicHex));
    this.topics.set(topicHex, { topic, remotePubKey });

    topic.onPeerJoin((netPeer) => this.handlePeerJoin(netPeer));
    topic.onPeerLeave((pk) => this.handlePeerLeave(pk));

    // Handle already-connected peers
    for (const peer of topic.getPeers()) {
      this.handlePeerJoin(peer);
    }
  }

  private handlePeerJoin(netPeer: NetworkPeer) {
    const remotePubKey = netPeer.remotePublicKey;

    // Already connected
    if (this.peers.has(remotePubKey)) return;

    const unsub = netPeer.onMessage((data) => {
      const msg = decode(data);
      if (msg) {
        logNet("recv", remotePubKey, msg, data.byteLength);
        this.handleMessage(remotePubKey, msg);
      }
    });

    const unsubClose = netPeer.onClose(() => {
      this.peers.delete(remotePubKey);
      this.emitConnectedPeers();
      for (const room of this.rooms.values()) {
        const peerId = remotePubKey.slice(0, 32);
        if (room.remotePeers.has(peerId)) {
          room.remotePeers.delete(peerId);
          room.awarenessStates.delete(peerId);
          room.callbacks.onPeerLeft?.(peerId);
        }
      }
      this.updateConnectionState();
    });

    const conn: PeerConnection = {
      publicKey: remotePubKey,
      netPeer,
      sharedSpaces: new Set(),
      cleanup: () => { unsub(); unsubClose(); },
    };
    this.peers.set(remotePubKey, conn);
    this.emitConnectedPeers();

    // Send hello with our space list
    this.sendHello(netPeer);
    this.updateConnectionState();
  }

  private handlePeerLeave(publicKey: string) {
    const conn = this.peers.get(publicKey);
    if (!conn) return;
    conn.cleanup();
    conn.netPeer.close();
    this.peers.delete(publicKey);
    this.emitConnectedPeers();

    for (const room of this.rooms.values()) {
      const peerId = publicKey.slice(0, 32);
      if (room.remotePeers.has(peerId)) {
        room.remotePeers.delete(peerId);
        room.awarenessStates.delete(peerId);
        room.callbacks.onPeerLeft?.(peerId);
      }
    }
    this.updateConnectionState();
  }

  private async sendHello(netPeer: NetworkPeer): Promise<void> {
    const spaceIds = await this.host.getSpaceIds();
    const msg: Message = {
      type: "hello",
      publicKey: this.localPublicKey,
      spaces: spaceIds,
    };
    const data = encode(msg);
    logNet("send", netPeer.remotePublicKey, msg, data.byteLength);
    netPeer.send(data);
  }

  // ---------------------------------------------------------------------------
  // Private: Message handling
  // ---------------------------------------------------------------------------

  private async handleMessage(fromPubKey: string, msg: Message) {
    switch (msg.type) {
      // Handshake
      case "hello":
        await this.handleHello(fromPubKey, msg);
        break;

      // Replication
      case "sync-pull":
        await this.handleSyncPull(fromPubKey, msg);
        break;
      case "sync-data":
        await this.handleSyncData(msg);
        break;

      // Real-time push
      case "space-ops":
        await this.handleSpaceOps(fromPubKey, msg);
        break;
      case "page-ops":
        await this.handlePageOps(fromPubKey, msg);
        break;

      // Room awareness
      case "room-join":
        this.handleRoomJoin(fromPubKey, msg);
        break;
      case "room-leave":
        this.handleRoomLeave(msg);
        break;
      case "room-peers":
        this.handleRoomPeers(msg);
        break;
      case "awareness":
        this.handleAwareness(msg);
        break;

      // Per-page sync (fallback)
      case "sync-req":
        this.handleSyncReq(msg);
        break;
      case "sync-res":
        this.handleSyncRes(msg);
        break;

      // Asset
      case "asset-req":
        await this.handleAssetReq(fromPubKey, msg);
        break;
      case "asset-data":
        await this.handleAssetData(msg);
        break;
    }
  }

  // --- Handshake ---

  private async handleHello(fromPubKey: string, msg: HelloMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn) return;

    // Compute shared spaces: intersection of both space lists,
    // filtered by membership (access control)
    const localSpaceIds = await this.host.getSpaceIds();
    const remoteSpaces = new Set(msg.spaces);

    const shared = new Set<string>();
    for (const sid of localSpaceIds) {
      if (!remoteSpaces.has(sid)) continue;
      // Verify the remote peer is actually a member
      const members = await this.host.getSpaceMembers(sid);
      if (members.some(m => m.publicKey === fromPubKey)) {
        shared.add(sid);
      }
    }

    conn.sharedSpaces = shared;

    // For each shared space, send a sync-pull with our version vectors
    for (const spaceId of shared) {
      const spaceVV = await this.host.getSpaceVV(spaceId);
      const pageVVs = await this.host.getPageVVs(spaceId);

      this.sendDirect(conn, {
        type: "sync-pull",
        spaceId,
        spaceVV,
        pageVVs,
      });
    }

    // Announce all open rooms in shared spaces to this peer
    // and notify them that a new space peer is now available.
    for (const room of this.rooms.values()) {
      if (shared.has(room.spaceId)) {
        this.sendDirect(conn, {
          type: "room-join",
          pageId: room.pageId,
          peerId: room.localPeerId,
          user: room.localUser,
        });

        // Re-fire onRoomPeers so the editor knows a space peer is now
        // reachable and can send a per-page sync request.
        const spacePeerIds: string[] = [];
        for (const c of this.peers.values()) {
          if (c.sharedSpaces.has(room.spaceId)) {
            spacePeerIds.push(c.publicKey.slice(0, 32));
          }
        }
        room.callbacks.onRoomPeers?.(spacePeerIds, undefined);
      }
    }
  }

  // --- Replication ---

  private async handleSyncPull(fromPubKey: string, msg: SyncPullMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn || !conn.sharedSpaces.has(msg.spaceId)) return;

    const response = await this.host.buildSyncResponse(
      msg.spaceId,
      msg.spaceVV,
      msg.pageVVs,
    );

    this.sendDirect(conn, {
      type: "sync-data",
      spaceId: msg.spaceId,
      spaceOps: response.spaceOps,
      pageOps: response.pageOps,
    });
  }

  private async handleSyncData(msg: SyncDataMsg) {
    if (msg.spaceOps.length > 0) {
      await this.host.applyRemoteSpaceOps(msg.spaceId, msg.spaceOps);
    }

    for (const [pageId, ops] of Object.entries(msg.pageOps)) {
      if (ops.length > 0) {
        await this.host.applyRemotePageOps(pageId, ops);

        // If the page is open in the editor, notify it
        const room = this.rooms.get(pageId);
        if (room) {
          room.callbacks.onOperations?.(ops);
        }
      }
    }
  }

  // --- Real-time push ---

  private async handleSpaceOps(fromPubKey: string, msg: SpaceOpsMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn || !conn.sharedSpaces.has(msg.spaceId)) return;

    await this.host.applyRemoteSpaceOps(msg.spaceId, msg.ops);
  }

  private async handlePageOps(fromPubKey: string, msg: PageOpsMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn || !conn.sharedSpaces.has(msg.spaceId)) return;

    await this.host.applyRemotePageOps(msg.pageId, msg.ops);

    // If the page is open, notify the editor
    const room = this.rooms.get(msg.pageId);
    if (room) {
      room.callbacks.onOperations?.(msg.ops);
    }
  }

  // --- Room awareness ---

  private handleRoomJoin(fromPubKey: string, msg: RoomJoinMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn) return;

    const room = this.rooms.get(msg.pageId);

    if (room) {
      // We have the same page open — full room awareness exchange
      const isNew = !room.remotePeers.has(msg.peerId);
      room.remotePeers.set(msg.peerId, msg.user);

      if (isNew) {
        room.callbacks.onPeerJoined?.(msg.peerId, msg.user);

        // Respond with current peer list
        const peers: { peerId: string; user?: RoomUser }[] = [
          { peerId: room.localPeerId, user: room.localUser },
        ];
        for (const [pid, user] of room.remotePeers) {
          peers.push({ peerId: pid, user });
        }

        this.sendDirect(conn, {
          type: "room-peers",
          pageId: msg.pageId,
          peers,
          awarenessStates: Object.fromEntries(room.awarenessStates),
        });
      }
    } else {
      // We don't have this page open, but the remote peer needs to know
      // we exist as a space peer. Send a minimal room-peers response.
      this.sendDirect(conn, {
        type: "room-peers",
        pageId: msg.pageId,
        peers: [],
      });
    }
  }

  private handleRoomLeave(msg: RoomLeaveMsg) {
    const room = this.rooms.get(msg.pageId);
    if (!room) return;
    room.remotePeers.delete(msg.peerId);
    room.awarenessStates.delete(msg.peerId);
    room.callbacks.onPeerLeft?.(msg.peerId);
  }

  private handleRoomPeers(msg: RoomPeersMsg) {
    const room = this.rooms.get(msg.pageId);
    if (!room) return;
    const peerIds: string[] = [];
    for (const p of msg.peers) {
      if (p.peerId !== room.localPeerId) {
        room.remotePeers.set(p.peerId, p.user);
        peerIds.push(p.peerId);
      }
    }
    room.callbacks.onRoomPeers?.(peerIds, msg.awarenessStates);
  }

  private handleAwareness(msg: AwarenessMsg) {
    const room = this.rooms.get(msg.pageId);
    if (!room) return;
    room.awarenessStates.set(msg.peerId, msg.state);
    room.callbacks.onAwareness?.(msg.peerId, msg.state);
  }

  // --- Per-page sync (fallback) ---

  private handleSyncReq(msg: SyncReqMsg) {
    const room = this.rooms.get(msg.pageId);
    if (!room) return;
    room.callbacks.onSyncRequest?.(msg.versionVector, undefined, msg.requesterId);
  }

  private async handleSyncRes(msg: SyncResMsg) {
    const room = this.rooms.get(msg.pageId);
    if (!room) return;

    // Persist the ops we received
    if (msg.ops.length > 0) {
      await this.host.applyRemotePageOps(msg.pageId, msg.ops);
    }

    room.callbacks.onSyncResponse?.(msg.ops, msg.versionVector);
  }

  // --- Asset sync ---

  private async handleAssetReq(fromPubKey: string, msg: AssetReqMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn) return;

    const asset = await this.host.getAssetData(msg.hash);
    if (!asset) return; // We don't have it either

    // Encode as base64 for JSON transport
    const base64 = uint8ToBase64(asset.data);
    this.sendDirect(conn, {
      type: "asset-data",
      hash: msg.hash,
      ext: asset.ext,
      data: base64,
    });
  }

  private async handleAssetData(msg: AssetDataMsg) {
    // Decode base64 → Uint8Array and store locally
    const bytes = base64ToUint8(msg.data);
    await this.host.storeAssetData(msg.hash, msg.ext, bytes);

    // Resolve any pending requests for this hash
    const callbacks = this.pendingAssetRequests.get(msg.hash);
    if (callbacks) {
      this.pendingAssetRequests.delete(msg.hash);
      for (const cb of callbacks) cb(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Pairing
  // ---------------------------------------------------------------------------

  private async sendPairHello(peer: NetworkPeer, session: PairingSession): Promise<void> {
    const cryptoDriver = this.host.getCrypto();
    const secretBytes = enc.encode(session.invite.secret);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", secretBytes));
    const proof = await cryptoDriver.sign(session.privateKey, hash);

    const msg: Message = {
      type: "pair-hello",
      publicKey: session.localPublicKey,
      name: session.localName,
      proof,
      spaceId: session.invite.spaceId,
      spaceName: session.invite.spaceName,
    };
    const data = encode(msg);
    logNet("send", peer.remotePublicKey, msg, data.byteLength);
    peer.send(data);
  }

  private async handlePairingMessage(peer: NetworkPeer, msg: PairHelloMsg | PairAckMsg): Promise<void> {
    const session = this.pairingSession;
    if (!session || session.completed) return;

    // Skip if we already paired with this peer (multi-peer mode)
    if (session.completedPeers.has(msg.publicKey)) return;

    const cryptoDriver = this.host.getCrypto();
    const secretBytes = enc.encode(session.invite.secret);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", secretBytes));
    const valid = await cryptoDriver.verify(msg.publicKey, msg.proof, hash);

    if (!valid) {
      session.callbacks.onError?.("Invalid pairing proof — peer doesn't know the invite secret");
      return;
    }

    session.callbacks.onPeerIdentity?.({ publicKey: msg.publicKey, name: msg.name });

    // If we received a hello, send ack back
    if (msg.type === "pair-hello") {
      const proof = await cryptoDriver.sign(session.privateKey, hash);
      const ackMsg: Message = {
        type: "pair-ack",
        publicKey: session.localPublicKey,
        name: session.localName,
        proof,
      };
      const ackData = encode(ackMsg);
      logNet("send", peer.remotePublicKey, ackMsg, ackData.byteLength);
      peer.send(ackData);
    }

    session.completedPeers.add(msg.publicKey);

    // Fire completion callback (engine will trust peer, add members, etc.)
    session.callbacks.onComplete?.({
      publicKey: msg.publicKey,
      name: msg.name,
      trusted: true,
      lastSeen: new Date().toISOString(),
    });

    // Establish replication connection to the new peer
    await this.addPeer(msg.publicKey);

    // In single-peer mode, clean up immediately
    if (!session.multi) {
      session.completed = true;
      await session.topic.destroy();
      this.pairingSession = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Transport helpers
  // ---------------------------------------------------------------------------

  /** Send a message directly to a specific connected peer (with logging). */
  private sendDirect(conn: PeerConnection, msg: Message) {
    const data = encode(msg);
    logNet("send", conn.publicKey, msg, data.byteLength);
    conn.netPeer.send(data);
  }

  private broadcastToSpacePeers(spaceId: string, msg: Message) {
    const data = encode(msg);
    for (const conn of this.peers.values()) {
      if (conn.sharedSpaces.has(spaceId)) {
        logNet("send", conn.publicKey, msg, data.byteLength);
        conn.netPeer.send(data);
      }
    }
  }

  private sendToPeer(peerId: string, msg: Message) {
    // peerId might be a truncated public key (first 32 chars) — match by prefix
    for (const conn of this.peers.values()) {
      if (conn.publicKey === peerId || conn.publicKey.startsWith(peerId)) {
        const data = encode(msg);
        logNet("send", conn.publicKey, msg, data.byteLength);
        conn.netPeer.send(data);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Connection state
  // ---------------------------------------------------------------------------

  private setConnectionState(state: ConnectionState) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const cb of this.connectionListeners) cb(state);
  }

  private updateConnectionState() {
    if (this.peers.size > 0) {
      this.setConnectionState("connected");
    } else if (this.topics.size > 0 || this.rooms.size > 0) {
      this.setConnectionState("connecting");
    } else {
      this.setConnectionState("disconnected");
    }
  }

  private emitConnectedPeers() {
    const peers = this.getConnectedPeers();
    for (const cb of this.connectedPeersListeners) cb(peers);
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  async destroy(): Promise<void> {
    for (const conn of this.peers.values()) {
      conn.cleanup();
      conn.netPeer.close();
    }
    this.peers.clear();
    this.emitConnectedPeers();

    for (const entry of this.topics.values()) {
      await entry.topic.destroy();
    }
    this.topics.clear();

    await this.cancelPairing();
    this.rooms.clear();
    this.connectionListeners.clear();
    this.connectedPeersListeners.clear();
    this.pageEventListeners.clear();
  }
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Compute a deterministic topic for a peer pair.
 * SHA-256(sorted(pubKeyA, pubKeyB)) — only these two peers can derive it.
 */
async function computePeerTopic(pubKeyA: string, pubKeyB: string): Promise<string> {
  const sorted = pubKeyA < pubKeyB ? `${pubKeyA}:${pubKeyB}` : `${pubKeyB}:${pubKeyA}`;
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(sorted));
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Uint8Array → base64 string (for JSON-safe transport over DataChannel) */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** base64 string → Uint8Array */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/-/g, "");
  if (/^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0) {
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
    }
    return bytes;
  }
  return new TextEncoder().encode(hex);
}
