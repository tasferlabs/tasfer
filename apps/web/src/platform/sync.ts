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

import type {
  NetworkDriver,
  NetworkTopic,
  NetworkPeer,
  CryptoDriver,
} from "./driver";
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
  PeerVersionInfo,
} from "./types";
import type { Operation } from "@cypherkit/editor";
import type { CursorPresence } from "@cypherkit/provider-core/cursors";
import {
  BINARY_ASSET_TAG,
  hexToBytes,
  bytesToHex,
  compressOp,
  expandOp,
  WIRE_VERSION,
} from "./wire-codec";

// =============================================================================
// Protocol versioning
// =============================================================================

/**
 * Semantic version of the replication protocol — the set of message types, the
 * shape of the CRDT `Operation` union, and the merge/convergence semantics.
 *
 * This is local-first and peer-to-peer: there is no central server to migrate
 * and no flag day, so at any moment peers on different app versions sync with
 * each other (an offline device can deliver months-old ops to a freshly
 * updated peer, and vice-versa). Both versions are exchanged in the `hello`
 * handshake so each side can detect a mismatch up front instead of silently
 * mis-handling data.
 *
 * Compatibility rules (see also the "Releasing Updates And Compatibility"
 * note at /docs/internals/compatibility):
 *  - The `Operation` union is append-only. Never reshape an existing op type;
 *    add new op/block/mark types instead, and gate emitting them on the peer's
 *    negotiated `protocolVersion` so an older peer never receives ops it would
 *    drop (a dropped op breaks CRDT convergence permanently).
 *  - Received unknown ops/blocks/marks are preserved in the log, never rejected
 *    (see reducer.applyOp's default case and UnknownNode).
 *
 * Bump on any protocol-level change; a higher remote value means "the peer may
 * speak things we don't yet understand".
 */
export const PROTOCOL_VERSION = 1;

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
  ): Promise<{
    spaceOps: SpaceOperation[];
    pageOps: Record<string, Operation[]>;
  }>;
  /** Store + apply remote space ops */
  applyRemoteSpaceOps(spaceId: string, ops: SpaceOperation[]): Promise<void>;
  /** Store remote page ops */
  applyRemotePageOps(pageId: string, ops: Operation[]): Promise<void>;
  /** Read a local asset's raw data + extension. Returns null if not found. */
  getAssetData(hash: string): Promise<{ ext: string; data: Uint8Array } | null>;
  /** Store an asset received from a peer */
  storeAssetData(hash: string, ext: string, data: Uint8Array): Promise<void>;
  /** Build a per-page sync response: return ops the requester is missing + local VV */
  buildPageSyncResponse(
    pageId: string,
    remoteVV: Record<string, number>,
  ): Promise<{ ops: Operation[]; versionVector: Record<string, number> }>;
  /** Get the shared encryption key for a peer (hex string). Returns null if not set. */
  getPeerSharedKey(publicKey: string): Promise<string | null>;
  /** Update the last-seen timestamp for a peer to now */
  updatePeerLastSeen(publicKey: string): Promise<void>;
}

// =============================================================================
// Message Types
// =============================================================================

/** Initial handshake sent when a DataChannel opens. Identifies the sender by public key so both peers can look each other up in their trusted-peer list. */
interface HelloMsg {
  type: "hello";
  publicKey: string;
  /**
   * Sender's {@link PROTOCOL_VERSION}. Optional on the wire so a hello from a
   * peer predating version negotiation decodes fine and is treated as v1.
   */
  protocolVersion?: number;
  /** Sender's {@link WIRE_VERSION} (byte-level op encoding). Absent = 1. */
  wireVersion?: number;
}
/** Pull request: "here is what I already have — send me what I'm missing." Carries the sender's version vector for a space and all its pages so the recipient can compute the diff. */
interface SyncPullMsg {
  type: "sync-pull";
  spaceId: string;
  spaceVV: Record<string, number>;
  pageVVs: Record<string, Record<string, number>>;
}
/** Response to a sync-pull. Contains every space-level op and every page-level op the requesting peer had not yet seen, as determined by comparing version vectors. */
interface SyncDataMsg {
  type: "sync-data";
  spaceId: string;
  spaceOps: SpaceOperation[];
  pageOps: Record<string, Operation[]>;
}
/** Real-time push of one or more space-level CRDT ops (e.g. page_add, member_add) generated after catch-up is complete. */
interface SpaceOpsMsg {
  type: "space-ops";
  spaceId: string;
  ops: SpaceOperation[];
}
/** Real-time push of one or more page-level CRDT ops (text_insert, mark_set, etc.) generated after catch-up is complete. */
interface PageOpsMsg {
  type: "page-ops";
  spaceId: string;
  pageId: string;
  ops: Operation[];
}
/** Sent when a peer opens a page. Announces presence to every other peer already in the room so they can show the peer's cursor and avatar. */
interface RoomJoinMsg {
  type: "room-join";
  pageId: string;
  peerId: string;
  user?: RoomUser;
}
/** Sent when a peer closes a page or disconnects. Tells the room to remove that peer's cursor and presence indicator. */
interface RoomLeaveMsg {
  type: "room-leave";
  pageId: string;
  peerId: string;
}
/** Sent by a peer already in the room to a newcomer. Delivers the full list of currently present peers and their last-known awareness states so the newcomer can render everyone's cursors immediately. */
interface RoomPeersMsg {
  type: "room-peers";
  pageId: string;
  peers: { peerId: string; user?: RoomUser }[];
  awarenessStates?: Record<string, CursorPresence>;
}
/** Carries a single peer's ephemeral awareness state (cursor position, selection, scroll) to all other peers in the same room. Sent on every local cursor/selection change. */
interface AwarenessMsg {
  type: "awareness";
  pageId: string;
  peerId: string;
  state: CursorPresence;
}
/** Fallback per-page sync request for editors that open after the initial catch-up handshake. Includes the requester's current version vector so the responder can send only the missing ops. */
interface SyncReqMsg {
  type: "sync-req";
  pageId: string;
  versionVector: Record<string, number>;
  requesterId: string;
}
/** Response to a sync-req. Returns the ops the requester was missing plus the responder's current version vector for the page. */
interface SyncResMsg {
  type: "sync-res";
  pageId: string;
  ops: Operation[];
  versionVector: Record<string, number>;
}
/** Lazy asset request: "I need this content-addressed asset — can you send it?" Triggered when an image block is rendered but the local asset store has no data for that hash. */
interface AssetReqMsg {
  type: "asset-req";
  hash: string;
}
/** First message of the one-time pairing handshake. The sender introduces themselves with their public key, display name, a cryptographic proof (Ed25519 signature over the shared invite secret), and the space they want to share. */
interface PairHelloMsg {
  type: "pair-hello";
  publicKey: string;
  name: string;
  proof: string;
  spaceId: string;
  spaceName: string;
}
/** Acknowledgement in the pairing handshake. The acceptor echoes back their own public key, name, and signature proof, completing the mutual authentication and establishing trust. */
interface PairAckMsg {
  type: "pair-ack";
  publicKey: string;
  name: string;
  proof: string;
}

type Message =
  | HelloMsg
  | SyncPullMsg
  | SyncDataMsg
  | SpaceOpsMsg
  | PageOpsMsg
  | RoomJoinMsg
  | RoomLeaveMsg
  | RoomPeersMsg
  | AwarenessMsg
  | SyncReqMsg
  | SyncResMsg
  | AssetReqMsg
  | PairHelloMsg
  | PairAckMsg;

// =============================================================================
// Internal State
// =============================================================================

/** Tracks an active WebRTC DataChannel connection to a single trusted peer, including which spaces are shared with them and a cleanup callback to tear down listeners when the connection closes. */
interface PeerConnection {
  publicKey: string;
  netPeer: NetworkPeer;
  sharedSpaces: Set<string>;
  cleanup: () => void;
  /** Serial message queue so async handlers don't interleave. */
  msgQueue: Promise<void>;
  /** Protocol version the peer advertised in `hello` (undefined until received). */
  remoteProtocolVersion?: number;
  /** Wire-codec version the peer advertised in `hello` (undefined until received). */
  remoteWireVersion?: number;
  /**
   * Set when the peer's {@link WIRE_VERSION} differs from ours: its ops cannot
   * be reliably decoded, so we refuse all data exchange with it (no sync-pull,
   * no sends, inbound non-hello messages dropped). A *protocol*-only mismatch
   * does NOT set this — those peers still sync (forward-compat by design).
   */
  wireIncompatible?: boolean;
}

/** Represents a local peer's membership in a page's awareness room — who is present, their display info, and the latest cursor/selection state for each remote participant. */
interface RoomState {
  pageId: string;
  spaceId: string;
  localPeerId: string;
  localUser?: RoomUser;
  callbacks: Partial<SyncEvents>;
  remotePeers: Map<string, RoomUser | undefined>;
  awarenessStates: Map<string, CursorPresence>;
  /**
   * Remote peer id (the per-tab replica id carried on the wire) → the public
   * key of the connection it arrived on. Presence is keyed by replica id, not
   * by public key, so this is how a closed connection's stale entries get
   * found and removed — without it, a dropped/relaunched peer leaves a ghost
   * cursor behind.
   */
  peerOrigin: Map<string, string>;
}

/** Holds all state for an in-progress device-pairing flow. A pairing session is created when the user generates or scans an invite code and is torn down once both sides have exchanged proofs and stored each other as trusted peers. */
interface PairingSession {
  topicHex: string;
  topic: NetworkTopic;
  invite: SpaceInvite;
  role: "initiator" | "acceptor";
  /** Space name — initiator provides from DB, acceptor receives via pair-hello */
  spaceName: string;
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
// Wire-level optimisations (op shortcodes, charId runs, pageId stripping) are
// applied inside encode/decode via helpers imported from ./wire-codec.
// =============================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

function encode(msg: Message): Uint8Array {
  let wire: any = msg;

  if (msg.type === "page-ops") {
    wire = { ...msg, ops: msg.ops.map((op) => compressOp(op, msg.pageId)) };
  } else if (msg.type === "sync-data") {
    const pageOps: Record<string, any[]> = {};
    for (const [pid, ops] of Object.entries(msg.pageOps)) {
      pageOps[pid] = ops.map((op) => compressOp(op, pid));
    }
    wire = { ...msg, pageOps };
  } else if (msg.type === "sync-res") {
    wire = { ...msg, ops: msg.ops.map((op) => compressOp(op, msg.pageId)) };
  }

  return enc.encode(JSON.stringify(wire));
}

function decode(data: Uint8Array): Message | null {
  try {
    const raw = JSON.parse(dec.decode(data));
    if (!raw || typeof raw.type !== "string") return null;

    if (raw.type === "page-ops" && Array.isArray(raw.ops)) {
      raw.ops = raw.ops.map((op: any) => expandOp(op, raw.pageId));
    } else if (raw.type === "sync-data" && raw.pageOps) {
      for (const pid of Object.keys(raw.pageOps)) {
        raw.pageOps[pid] = raw.pageOps[pid].map((op: any) => expandOp(op, pid));
      }
    } else if (raw.type === "sync-res" && Array.isArray(raw.ops)) {
      raw.ops = raw.ops.map((op: any) => expandOp(op, raw.pageId));
    }

    return raw as Message;
  } catch {
    return null;
  }
}

// =============================================================================
// Replicator
// =============================================================================

export class Replicator {
  private network: NetworkDriver;
  private host: ReplicatorHost;

  private localPublicKey = "";

  /** One topic per trusted peer, keyed by topic hex */
  private topics = new Map<
    string,
    { topic: NetworkTopic; remotePubKey: string }
  >();

  /** Connected peers, keyed by public key */
  private peers = new Map<string, PeerConnection>();

  /** Open document rooms, keyed by pageId */
  private rooms = new Map<string, RoomState>();

  /** Active pairing session */
  private pairingSession: PairingSession | null = null;

  /** Pending asset requests: hash → resolve callbacks waiting for the data */
  private pendingAssetRequests = new Map<
    string,
    Array<(found: boolean) => void>
  >();

  /** Per-room awareness throttle state (50 ms leading+trailing) */
  private awarenessThrottle = new Map<
    string,
    { timer: ReturnType<typeof setTimeout> | null; pending: CursorPresence | null }
  >();

  /** Connection state */
  private connectionState: ConnectionState = "disconnected";
  private connectionListeners = new Set<(state: ConnectionState) => void>();
  private connectedPeersListeners = new Set<(peers: string[]) => void>();
  private pageEventListeners = new Set<Partial<PageEvents>>();
  private versionMismatchListeners = new Set<(info: PeerVersionInfo) => void>();

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
    console.log(`[Sync] start localPeer=${this.localPublicKey.slice(0, 8)}`);

    // Set our public key as the signaling ID
    this.network.setLocalId(this.localPublicKey);

    const trustedPeers = await this.host.getTrustedPeers();
    console.log(
      `[Sync] trusted peers: ${
        trustedPeers
          .filter((p) => p.trusted)
          .map((p) => p.publicKey.slice(0, 8))
          .join(", ") || "(none)"
      }`,
    );
    for (const peer of trustedPeers) {
      if (peer.trusted) {
        try {
          await this.connectToPeer(peer.publicKey);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[Sync] failed to connect to peer ${peer.publicKey.slice(0, 8)}: ${msg}`);
        }
      }
    }
  }

  /** Connect to a newly-paired peer, or re-negotiate shared spaces if already connected. */
  async addPeer(publicKey: string): Promise<void> {
    const existing = this.peers.get(publicKey);
    if (existing) {
      // Already connected — recompute local sharedSpaces and push data only
      // for spaces that are newly shared (bootstrapping), not all of them.
      const prev = new Set(existing.sharedSpaces);
      await this.recomputeSharedSpaces(existing);

      // Push full data only for newly-shared spaces the remote may not know about
      for (const spaceId of existing.sharedSpaces) {
        if (!prev.has(spaceId)) {
          const response = await this.host.buildSyncResponse(spaceId, {}, {});
          if (response.spaceOps.length > 0 || Object.keys(response.pageOps).length > 0) {
            this.sendDirect(existing, {
              type: "sync-data",
              spaceId,
              spaceOps: response.spaceOps,
              pageOps: response.pageOps,
            });
          }
        }
      }

      // Re-send hello so the remote also recomputes its shared spaces
      this.sendHello(existing.netPeer);
      return;
    }
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
        this.network.unregisterTopicKey(hex);
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
      peerOrigin: new Map(),
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

    const th = this.awarenessThrottle.get(roomId);
    if (th?.timer !== null && th?.timer !== undefined) clearTimeout(th.timer);
    this.awarenessThrottle.delete(roomId);

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

  sendSyncRequest(roomId: string, versionVector: Record<string, number>): void {
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

  sendAwareness(roomId: string, state: CursorPresence): void {
    const room = this.rooms.get(roomId);
    if (!room || !room.spaceId) return;

    let th = this.awarenessThrottle.get(roomId);
    if (!th) {
      th = { timer: null, pending: null };
      this.awarenessThrottle.set(roomId, th);
    }

    if (th.timer === null) {
      // Leading edge: send immediately, then open a 50 ms window
      this._broadcastAwareness(room, roomId, state);
      th.timer = setTimeout(() => {
        th!.timer = null;
        if (th!.pending !== null) {
          const s = th!.pending;
          th!.pending = null;
          const r = this.rooms.get(roomId);
          if (r) this._broadcastAwareness(r, roomId, s);
        }
      }, 50);
    } else {
      // Within window: buffer latest state for the trailing send
      th.pending = state;
    }
  }

  private _broadcastAwareness(room: RoomState, roomId: string, state: CursorPresence): void {
    this.broadcastToSpacePeers(room.spaceId, {
      type: "awareness",
      pageId: roomId,
      peerId: room.localPeerId,
      state,
    });
  }

  onPageEvents(callbacks: Partial<PageEvents>): () => void {
    this.pageEventListeners.add(callbacks);
    return () => {
      this.pageEventListeners.delete(callbacks);
    };
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionChange(cb: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(cb);
    return () => {
      this.connectionListeners.delete(cb);
    };
  }

  getConnectedPeers(): string[] {
    return Array.from(this.peers.keys());
  }

  onConnectedPeersChange(cb: (peers: string[]) => void): () => void {
    this.connectedPeersListeners.add(cb);
    return () => {
      this.connectedPeersListeners.delete(cb);
    };
  }

  /**
   * Subscribe to protocol/wire-version mismatches detected during a peer's
   * `hello` handshake. Fires once per hello whenever the peer's advertised
   * {@link PROTOCOL_VERSION} or {@link WIRE_VERSION} differs from ours, so the
   * host can surface "an update is available" / "this peer is outdated".
   *
   * When `info.wireCompatible` is false the replicator additionally **refuses**
   * the peer — it exchanges no ops/awareness in either direction — since its
   * ops can't be reliably decoded. A protocol-only mismatch still syncs.
   */
  onPeerVersionMismatch(cb: (info: PeerVersionInfo) => void): () => void {
    this.versionMismatchListeners.add(cb);
    return () => {
      this.versionMismatchListeners.delete(cb);
    };
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
      return new Promise<boolean>((resolve) => {
        existing.push(resolve);
      });
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
    spaceName?: string;
    localPublicKey: string;
    localName: string;
    privateKey: string;
    callbacks: PairCallbacks;
  }): Promise<void> {
    if (this.pairingSession) await this.cancelPairing();

    const topicHex = opts.invite.topic;

    // Derive and register encryption key for the pairing topic
    const pairingKey = await derivePairingKey(opts.invite.secret, topicHex);
    this.network.registerTopicKey(topicHex, pairingKey);

    const topic = await this.network.join(hexToBytes(topicHex));

    this.pairingSession = {
      topicHex,
      topic,
      invite: opts.invite,
      role: opts.role,
      spaceName: opts.spaceName ?? "",
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
    this.network.unregisterTopicKey(this.pairingSession.topicHex);
    await this.pairingSession.topic.destroy();
    this.pairingSession = null;
  }

  // ---------------------------------------------------------------------------
  // Private: Peer connection management
  // ---------------------------------------------------------------------------

  private async connectToPeer(remotePubKey: string): Promise<void> {
    const topicHex = await computePeerTopic(this.localPublicKey, remotePubKey);

    if (this.topics.has(topicHex)) return;
    console.log(
      `[Sync] joining topic=${topicHex} for peer=${remotePubKey.slice(0, 8)}`,
    );

    // Register the E2E encryption key for this topic before joining
    const sharedKeyHex = await this.host.getPeerSharedKey(remotePubKey);
    if (sharedKeyHex) {
      this.network.registerTopicKey(topicHex, hexToBytes(sharedKeyHex));
    }

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
    console.log(`[Sync] peer joined: ${remotePubKey.slice(0, 8)}`);

    const unsub = netPeer.onMessage((data) => {
      // Binary asset-data frames start with BINARY_ASSET_TAG, not '{' (0x7B)
      if (data[0] === BINARY_ASSET_TAG) {
        this.handleBinaryAssetData(data);
        return;
      }
      const msg = decode(data);
      if (msg) {
        logNet("recv", remotePubKey, msg, data.byteLength);
        // Serialize message handling per-peer so async handlers (e.g. hello
        // computing sharedSpaces) complete before subsequent messages run.
        const peer = this.peers.get(remotePubKey);
        if (peer) {
          peer.msgQueue = peer.msgQueue.then(() =>
            this.handleMessage(remotePubKey, msg),
          );
        }
      }
    });

    const unsubClose = netPeer.onClose(() => {
      this.peers.delete(remotePubKey);
      this.emitConnectedPeers();
      this.removeConnectionPresence(remotePubKey);
      this.updateConnectionState();
    });

    const conn: PeerConnection = {
      publicKey: remotePubKey,
      netPeer,
      sharedSpaces: new Set(),
      cleanup: () => {
        unsub();
        unsubClose();
      },
      msgQueue: Promise.resolve(),
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
    this.removeConnectionPresence(publicKey);
    this.updateConnectionState();
  }

  /**
   * Drop every room-presence entry that originated from a now-closed
   * connection. Presence (`remotePeers`/`awarenessStates`) is keyed by the
   * remote's per-tab replica id, not by its public key, so we resolve each
   * entry's recorded origin connection rather than deriving a key from the
   * public key — the latter never matched, which is what left ghost cursors
   * for the same user after a drop or relaunch.
   */
  private removeConnectionPresence(publicKey: string) {
    for (const room of this.rooms.values()) {
      for (const [peerId, origin] of room.peerOrigin) {
        if (origin !== publicKey) continue;
        room.peerOrigin.delete(peerId);
        room.remotePeers.delete(peerId);
        room.awarenessStates.delete(peerId);
        room.callbacks.onPeerLeft?.(peerId);
      }
    }
  }

  private async sendHello(netPeer: NetworkPeer): Promise<void> {
    console.log(
      `[Sync] sending hello to ${netPeer.remotePublicKey.slice(0, 8)}`,
    );
    const msg: Message = {
      type: "hello",
      publicKey: this.localPublicKey,
      protocolVersion: PROTOCOL_VERSION,
      wireVersion: WIRE_VERSION,
    };
    const data = encode(msg);
    logNet("send", netPeer.remotePublicKey, msg, data.byteLength);
    netPeer.send(data);
  }

  // ---------------------------------------------------------------------------
  // Private: Message handling
  // ---------------------------------------------------------------------------

  private async handleMessage(fromPubKey: string, msg: Message) {
    // Refuse a wire-incompatible peer: its ops would mis-decode, so drop
    // everything except `hello` (which re-runs version negotiation and could
    // clear the flag if the peer later advertises a compatible version).
    if (msg.type !== "hello" && this.peers.get(fromPubKey)?.wireIncompatible) {
      return;
    }

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
        await this.handleSyncData(fromPubKey, msg);
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
        this.handleRoomPeers(fromPubKey, msg);
        break;
      case "awareness":
        this.handleAwareness(fromPubKey, msg);
        break;

      // Per-page sync (fallback)
      case "sync-req":
        await this.handleSyncReq(msg);
        break;
      case "sync-res":
        await this.handleSyncRes(msg);
        break;

      // Asset
      case "asset-req":
        await this.handleAssetReq(fromPubKey, msg);
        break;
    }
  }

  // --- Handshake ---

  /** Recompute which spaces are shared with a connected peer. */
  private async recomputeSharedSpaces(conn: PeerConnection): Promise<void> {
    const localSpaceIds = await this.host.getSpaceIds();
    const shared = new Set<string>();
    for (const sid of localSpaceIds) {
      const members = await this.host.getSpaceMembers(sid);
      if (members.some((m) => m.publicKey === conn.publicKey)) {
        shared.add(sid);
      }
    }
    conn.sharedSpaces = shared;
    console.log(
      `[Sync] shared spaces with ${conn.publicKey.slice(0, 8)}: ${shared.size} (${[...shared].map((s) => s.slice(0, 8)).join(", ")})`,
    );
  }

  /**
   * Record the versions a peer advertised in `hello` and, if either differs
   * from ours, log it and notify {@link onPeerVersionMismatch} subscribers.
   * A peer predating version negotiation omits both fields → treated as v1.
   */
  private checkPeerVersion(conn: PeerConnection, msg: HelloMsg): void {
    const remoteProtocolVersion = msg.protocolVersion ?? 1;
    const remoteWireVersion = msg.wireVersion ?? 1;
    conn.remoteProtocolVersion = remoteProtocolVersion;
    conn.remoteWireVersion = remoteWireVersion;

    const protocolMatch = remoteProtocolVersion === PROTOCOL_VERSION;
    const wireCompatible = remoteWireVersion === WIRE_VERSION;
    // Refuse data exchange only on wire incompatibility — a protocol-only
    // mismatch (same wire) still syncs, since unknown ops degrade gracefully.
    conn.wireIncompatible = !wireCompatible;
    if (protocolMatch && wireCompatible) return;

    const direction =
      remoteProtocolVersion > PROTOCOL_VERSION ||
      remoteWireVersion > WIRE_VERSION
        ? "peer is newer — an update may be available"
        : "peer is older";
    console.warn(
      `[Sync] version mismatch with ${conn.publicKey.slice(0, 8)}: ` +
        `protocol ${remoteProtocolVersion} (local ${PROTOCOL_VERSION}), ` +
        `wire ${remoteWireVersion} (local ${WIRE_VERSION}) — ${direction}` +
        (wireCompatible ? "" : "; ops may not decode correctly"),
    );

    const info: PeerVersionInfo = {
      publicKey: conn.publicKey,
      remoteProtocolVersion,
      remoteWireVersion,
      localProtocolVersion: PROTOCOL_VERSION,
      localWireVersion: WIRE_VERSION,
      wireCompatible,
    };
    for (const cb of this.versionMismatchListeners) cb(info);
  }

  private async handleHello(fromPubKey: string, msg: HelloMsg) {
    console.log(`[Sync] hello from ${fromPubKey.slice(0, 8)}`);
    const conn = this.peers.get(fromPubKey);
    if (!conn) return;

    this.checkPeerVersion(conn, msg);
    if (conn.wireIncompatible) {
      console.warn(
        `[Sync] refusing to sync with ${fromPubKey.slice(0, 8)}: incompatible wire version`,
      );
      // Still record the contact, but exchange no ops/awareness with it.
      await this.host.updatePeerLastSeen(fromPubKey);
      return;
    }

    await this.host.updatePeerLastSeen(fromPubKey);
    await this.recomputeSharedSpaces(conn);

    const shared = conn.sharedSpaces;

    // For each shared space, send a sync-pull with our version vectors.
    // The remote will respond with only the ops we're missing.
    // Note: bootstrapping pushes (for spaces the remote doesn't know about)
    // are handled in addPeer() when new shared spaces are detected.
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

  /**
   * Check if a space is shared with a peer. If not, recompute shared spaces
   * once as a fallback (handles race conditions where sync messages arrive
   * before hello completes, or spaces added after the initial handshake).
   */
  private async ensureSharedSpace(
    conn: PeerConnection,
    spaceId: string,
  ): Promise<boolean> {
    if (conn.sharedSpaces.has(spaceId)) return true;
    await this.recomputeSharedSpaces(conn);
    return conn.sharedSpaces.has(spaceId);
  }

  private async handleSyncPull(fromPubKey: string, msg: SyncPullMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn || !(await this.ensureSharedSpace(conn, msg.spaceId))) {
      console.warn(`[Sync] dropped sync-pull for ${msg.spaceId.slice(0, 8)} from ${fromPubKey.slice(0, 8)} (not in sharedSpaces)`);
      return;
    }

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

  private async handleSyncData(fromPubKey: string, msg: SyncDataMsg) {
    const conn = this.peers.get(fromPubKey);
    // Accept sync-data from any connected peer, even for unknown spaces.
    // The data may contain space_set + member_add ops that bootstrap a space
    // the remote peer created with us as a member.
    if (!conn) {
      console.warn(`[Sync] dropped sync-data for ${msg.spaceId.slice(0, 8)} from ${fromPubKey.slice(0, 8)} (no connection)`);
      return;
    }

    const wasUnknown = !conn.sharedSpaces.has(msg.spaceId);

    if (msg.spaceOps.length > 0) {
      await this.host.applyRemoteSpaceOps(msg.spaceId, msg.spaceOps);
    }

    for (const [pageId, ops] of Object.entries(msg.pageOps)) {
      if (ops.length > 0) {
        // Notify the editor immediately so the UI updates without waiting for DB
        const room = this.rooms.get(pageId);
        if (room) {
          room.callbacks.onOperations?.(ops);
        }

        // Persist to DB in the background
        this.host.applyRemotePageOps(pageId, ops);
      }
    }

    // If this sync-data bootstrapped a previously unknown space, recompute
    // shared spaces and send a sync-pull back so we get anything we missed.
    if (wasUnknown) {
      await this.recomputeSharedSpaces(conn);
      if (conn.sharedSpaces.has(msg.spaceId)) {
        console.log(`[Sync] bootstrapped space ${msg.spaceId.slice(0, 8)} from ${fromPubKey.slice(0, 8)}`);
        const spaceVV = await this.host.getSpaceVV(msg.spaceId);
        const pageVVs = await this.host.getPageVVs(msg.spaceId);
        this.sendDirect(conn, {
          type: "sync-pull",
          spaceId: msg.spaceId,
          spaceVV,
          pageVVs,
        });
      }
    }
  }

  // --- Real-time push ---

  private async handleSpaceOps(fromPubKey: string, msg: SpaceOpsMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn || !(await this.ensureSharedSpace(conn, msg.spaceId))) {
      console.warn(`[Sync] dropped space-ops for ${msg.spaceId.slice(0, 8)} from ${fromPubKey.slice(0, 8)} (not in sharedSpaces)`);
      return;
    }

    await this.host.applyRemoteSpaceOps(msg.spaceId, msg.ops);
  }

  private async handlePageOps(fromPubKey: string, msg: PageOpsMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn || !(await this.ensureSharedSpace(conn, msg.spaceId))) {
      console.warn(`[Sync] dropped page-ops for ${msg.spaceId.slice(0, 8)} from ${fromPubKey.slice(0, 8)} (not in sharedSpaces)`);
      return;
    }

    // Notify the editor immediately so the UI updates without waiting for DB
    const room = this.rooms.get(msg.pageId);
    if (room) {
      room.callbacks.onOperations?.(msg.ops);
    }

    // Persist to DB in the background
    this.host.applyRemotePageOps(msg.pageId, msg.ops);
  }

  // --- Room awareness ---

  private handleRoomJoin(fromPubKey: string, msg: RoomJoinMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn) return;

    const room = this.rooms.get(msg.pageId);
    if (room && !conn.sharedSpaces.has(room.spaceId)) return;

    if (room) {
      // We have the same page open — full room awareness exchange
      const isNew = !room.remotePeers.has(msg.peerId);
      room.remotePeers.set(msg.peerId, msg.user);
      room.peerOrigin.set(msg.peerId, fromPubKey);

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
    room.peerOrigin.delete(msg.peerId);
    room.remotePeers.delete(msg.peerId);
    room.awarenessStates.delete(msg.peerId);
    room.callbacks.onPeerLeft?.(msg.peerId);
  }

  private handleRoomPeers(fromPubKey: string, msg: RoomPeersMsg) {
    const room = this.rooms.get(msg.pageId);
    if (!room) return;
    const peerIds: string[] = [];
    for (const p of msg.peers) {
      if (p.peerId !== room.localPeerId) {
        room.remotePeers.set(p.peerId, p.user);
        // room-peers is a relay: these may be third parties the sender knows,
        // not the sender itself. Record a provisional origin so a relayed-only
        // peer is still cleanable, but don't clobber an origin already set by
        // that peer's own direct room-join/awareness (its real connection).
        if (!room.peerOrigin.has(p.peerId)) {
          room.peerOrigin.set(p.peerId, fromPubKey);
        }
        peerIds.push(p.peerId);
      }
    }
    room.callbacks.onRoomPeers?.(peerIds, msg.awarenessStates);
  }

  private handleAwareness(fromPubKey: string, msg: AwarenessMsg) {
    const room = this.rooms.get(msg.pageId);
    if (!room) return;
    room.peerOrigin.set(msg.peerId, fromPubKey);
    room.awarenessStates.set(msg.peerId, msg.state);
    room.callbacks.onAwareness?.(msg.peerId, msg.state);
  }

  // --- Per-page sync (fallback) ---

  private async handleSyncReq(msg: SyncReqMsg) {
    // Respond at the space-peer level from the DB — no need to have the page open
    const { ops, versionVector } = await this.host.buildPageSyncResponse(
      msg.pageId,
      msg.versionVector,
    );

    if (ops.length > 0 || msg.requesterId) {
      const res: SyncResMsg = {
        type: "sync-res",
        pageId: msg.pageId,
        ops,
        versionVector,
      };

      // Send back to the requester only
      this.sendToPeer(msg.requesterId, res);
    }
  }

  private async handleSyncRes(msg: SyncResMsg) {
    // Always persist ops — even if the page isn't open in the editor
    if (msg.ops.length > 0) {
      await this.host.applyRemotePageOps(msg.pageId, msg.ops);
    }

    // If the page is open in the editor, notify it so the UI updates live
    const room = this.rooms.get(msg.pageId);
    if (room) {
      room.callbacks.onSyncResponse?.(msg.ops, msg.versionVector);
    }
  }

  // --- Asset sync ---

  private async handleAssetReq(fromPubKey: string, msg: AssetReqMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn) return;

    const asset = await this.host.getAssetData(msg.hash);
    if (!asset) return; // We don't have it either

    // Send as a raw binary frame — eliminates the ~33% base64 overhead.
    // Layout: [BINARY_ASSET_TAG][32 raw hash bytes][1 ext-len byte][ext][data]
    const hashBytes = hexToBytes(msg.hash);
    const extBytes = enc.encode(asset.ext);
    const frame = new Uint8Array(1 + 32 + 1 + extBytes.length + asset.data.length);
    let off = 0;
    frame[off++] = BINARY_ASSET_TAG;
    frame.set(hashBytes, off); off += 32;
    frame[off++] = extBytes.length;
    frame.set(extBytes, off); off += extBytes.length;
    frame.set(asset.data, off);

    conn.netPeer.send(frame);
  }

  private async handleBinaryAssetData(frame: Uint8Array) {
    // Layout: [BINARY_ASSET_TAG][32 hash bytes][1 ext-len][ext bytes][data]
    let off = 1; // skip tag
    const hash = bytesToHex(frame.slice(off, off + 32)); off += 32;
    const extLen = frame[off++];
    const ext = dec.decode(frame.slice(off, off + extLen)); off += extLen;
    const data = frame.slice(off);

    await this.host.storeAssetData(hash, ext, data);

    const callbacks = this.pendingAssetRequests.get(hash);
    if (callbacks) {
      this.pendingAssetRequests.delete(hash);
      for (const cb of callbacks) cb(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Pairing
  // ---------------------------------------------------------------------------

  private async sendPairHello(
    peer: NetworkPeer,
    session: PairingSession,
  ): Promise<void> {
    const cryptoDriver = this.host.getCrypto();
    const secretBytes = enc.encode(session.invite.secret);
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", secretBytes),
    );
    const proof = await cryptoDriver.sign(session.privateKey, hash);

    const msg: Message = {
      type: "pair-hello",
      publicKey: session.localPublicKey,
      name: session.localName,
      proof,
      spaceId: session.invite.spaceId,
      spaceName: session.spaceName,
    };
    const data = encode(msg);
    logNet("send", peer.remotePublicKey, msg, data.byteLength);
    peer.send(data);
  }

  private async handlePairingMessage(
    peer: NetworkPeer,
    msg: PairHelloMsg | PairAckMsg,
  ): Promise<void> {
    const session = this.pairingSession;
    if (!session || session.completed) return;

    // Skip if we already paired with this peer (multi-peer mode)
    if (session.completedPeers.has(msg.publicKey)) return;

    const cryptoDriver = this.host.getCrypto();
    const secretBytes = enc.encode(session.invite.secret);
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", secretBytes),
    );
    const valid = await cryptoDriver.verify(msg.publicKey, msg.proof, hash);

    if (!valid) {
      session.callbacks.onError?.(
        "Invalid pairing proof — peer doesn't know the invite secret",
      );
      return;
    }

    session.callbacks.onPeerIdentity?.({
      publicKey: msg.publicKey,
      name: msg.name,
    });

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

    // Update session spaceName from pair-hello (acceptor receives it from initiator)
    if (msg.type === "pair-hello" && msg.spaceName) {
      session.spaceName = msg.spaceName;
    }

    // Fire completion callback (engine will trust peer, add members, etc.)
    await session.callbacks.onComplete?.({
      publicKey: msg.publicKey,
      name: msg.name,
      trusted: true,
      lastSeen: new Date().toISOString(),
    }, session.spaceName || undefined);

    // Establish replication connection to the new peer
    await this.addPeer(msg.publicKey);

    // In single-peer mode, clean up immediately
    if (!session.multi) {
      session.completed = true;
      this.network.unregisterTopicKey(session.topicHex);
      await session.topic.destroy();
      this.pairingSession = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Transport helpers
  // ---------------------------------------------------------------------------

  /** Send a message directly to a specific connected peer (with logging). */
  private sendDirect(conn: PeerConnection, msg: Message) {
    if (conn.wireIncompatible) return;
    const data = encode(msg);
    logNet("send", conn.publicKey, msg, data.byteLength);
    conn.netPeer.send(data);
  }

  private broadcastToSpacePeers(spaceId: string, msg: Message) {
    const data = encode(msg);
    for (const conn of this.peers.values()) {
      if (conn.wireIncompatible) continue;
      if (conn.sharedSpaces.has(spaceId)) {
        logNet("send", conn.publicKey, msg, data.byteLength);
        conn.netPeer.send(data);
      }
    }
  }

  private sendToPeer(peerId: string, msg: Message) {
    // peerId might be a truncated public key (first 32 chars) — match by prefix
    for (const conn of this.peers.values()) {
      if (conn.wireIncompatible) continue;
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
async function computePeerTopic(
  pubKeyA: string,
  pubKeyB: string,
): Promise<string> {
  const sorted =
    pubKeyA < pubKeyB ? `${pubKeyA}:${pubKeyB}` : `${pubKeyB}:${pubKeyA}`;
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(sorted));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive an encryption key for a pairing topic.
 * Both peers know the invite secret and topic — HKDF produces the same key.
 */
async function derivePairingKey(
  secretHex: string,
  topicHex: string,
): Promise<Uint8Array> {
  const secret = hexToBytes(secretHex);
  const info = enc.encode("cypher-pair:" + topicHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    secret.buffer as ArrayBuffer,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}
