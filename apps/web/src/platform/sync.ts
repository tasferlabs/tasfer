/**
 * Replicator — Pull-based P2P Replication
 *
 * Replaces the old topic/swarm-based P2PSync with a per-peer connection model.
 * Each peer pair communicates over a single WebRTC DataChannel, carrying all
 * shared spaces.
 *
 * Who we peer with — space membership, and nothing else:
 *
 *   - We dial exactly the members of the active spaces we belong to
 *     ({@link Replicator.admittedPeers}). A key that shares no active space
 *     with us is never dialed, however it reached our peer table.
 *   - Membership propagates *within* a space: a `member_add` in a space we
 *     belong to is how we learn about a co-member we were never introduced
 *     to, and we then connect to them directly rather than routing through
 *     whoever added them. Indirect acquaintance, direct connection.
 *   - We never adopt a peer's peers. Nothing on the wire carries a roster,
 *     and a space we do not already belong to cannot be pushed onto us — new
 *     spaces arrive only through an invite (see `handleSyncData`). So a peer's
 *     contacts in spaces we are not in stay invisible to us.
 *   - Our own other devices are the one exception, in both clauses: they are
 *     always dialed, and a space one of them pushes at us is adopted. They
 *     hold our root, so their spaces are already ours — this is what makes a
 *     space created after linking reach the devices linked before it existed.
 *     They also exchange `own-state`, the person-private decisions that no op
 *     can carry because co-members must not see them (see {@link OwnStateMsg}).
 *
 * Protocol:
 *   1. Connect to each admitted peer via deterministic topic
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
 *   Own-device state (only ever exchanged with our own devices):
 *     { type: "own-state",  spaces[] }
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
 *   Asset (pull; requested on-demand at render and eagerly by AssetPrefetcher):
 *     { type: "asset-req",  hash }
 *     { type: "asset-data", hash, ext, data }
 *
 *   Pairing (one-time topic):
 *     { type: "pair-hello", publicKey, name, proof, spaceId, spaceName }
 *     { type: "pair-ack",   publicKey, name, proof }
 *
 *   Device linking (one-time topic, distinct HKDF label):
 *     { type: "device-link", rootPublicKey, rootPrivateKey, cert, issuedAt,
 *                            deviceCerts[], spaces[], profile }
 *
 * Two kinds of pairing share this machinery and must not be confused. A space
 * invite adds another PERSON to one space. A device link adds another of the
 * local user's OWN devices to all of them, handing over the root identity that
 * makes them recognisable as one person (see ./device-cert). They rendezvous on
 * different topics, so a session only ever meets peers running the same mode.
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
import type { Operation } from "@tasfer/editor";
import type { CursorPresence } from "@tasfer/provider-core/cursors";
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
 *  - The `Operation` union is append-only. Never reshape an existing op type.
 *    A protocol mismatch blocks replication in both directions: an older peer
 *    may drop a new op, while its old merge semantics may emit operations that
 *    are unsafe for a newer authoritative projection.
 *  - Received unknown ops/blocks/marks are preserved in the log, never rejected
 *    (see reducer.applyOp's default case and UnknownNode).
 *
 * Bump on any protocol-level change; a higher remote value means "the peer may
 * speak things we don't yet understand".
 */
export const PROTOCOL_VERSION = 4;

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
  /**
   * Every locally-known peer record. A record is not a licence to connect —
   * membership is (see {@link Replicator.admittedPeers}). `trusted: false`
   * marks a peer the local user revoked, which suppresses them even while
   * they remain a space member.
   */
  getPeerRecords(): Promise<Peer[]>;
  /** Get IDs of the active spaces this device belongs to */
  getSpaceIds(): Promise<string[]>;
  /**
   * Public keys of this person's OTHER devices — the ones certified under our
   * own root. They are not peers in the ordinary sense: they are us, so they
   * are always admitted and may hand us a space we have never seen.
   */
  getOwnDeviceKeys(): Promise<string[]>;
  /** Whether a known space is currently eligible for replication. */
  getSpaceState(spaceId: string): Promise<"active" | "archived" | "unknown">;
  /** This device's view of the person-private space state (see {@link OwnStateMsg}). */
  getOwnSpaceStates(): Promise<OwnSpaceState[]>;
  /** Merge a sibling device's {@link OwnSpaceState} entries, last decision wins. */
  applyOwnSpaceStates(states: OwnSpaceState[]): Promise<void>;
  /** This device's person-private preferences (see {@link OwnPref}). */
  getOwnPrefs(): Promise<OwnPref[]>;
  /** Merge a sibling device's {@link OwnPref} entries, last decision wins. */
  applyOwnPrefs(prefs: OwnPref[]): Promise<void>;
  /** Resolve a page to its space and that space's current archive state. */
  getPageSpaceState(
    pageId: string,
  ): Promise<{ spaceId: string; state: "active" | "archived" } | null>;
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
  /** Get or derive the shared encryption key for a peer. Returns null for an unknown peer. */
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
/**
 * One space's person-private state, as one device decided it.
 *
 * Archiving a space is a decision about the person's own sidebar, not about the
 * space's content: the other members keep theirs. So it cannot travel as a
 * space op — every op in a space log reaches every member — yet it still has to
 * reach the person's other devices, or filing a space away on the laptop leaves
 * it sitting in the phone's sidebar.
 *
 * `stamp` is wall-clock ms, not an HLC counter. There is no shared log to draw
 * a counter from (that is the whole problem), and every stamp here is written
 * by one person's own devices, where "the decision I made most recently wins"
 * is both what they expect and what a counter would only approximate. `by` is
 * the deciding device's key, breaking a same-millisecond tie the same way on
 * every replica.
 */
export interface OwnSpaceState {
  spaceId: string;
  /** ISO timestamp the space was archived, or null while it is active. */
  archivedAt: string | null;
  /** Unix ms of the archive/unarchive decision; 0 if never decided. */
  stamp: number;
  /** Device key that made the decision, or null if never decided. */
  by: string | null;
}
/**
 * One person-private preference, as one device decided it.
 *
 * The same problem as {@link OwnSpaceState}, without the space: how the sidebar
 * is arranged, which walkthroughs have been read, and what the person calls
 * each of their devices are decisions about the person, so no space's op log
 * can carry them — yet they still have to reach the person's other devices, or
 * arranging the sidebar on the laptop leaves the phone showing the old order,
 * and the label put on the phone is readable only on the phone.
 *
 * One register per key, ordered by (`stamp`, `by`) exactly as the archive one
 * is. A key is a whole register: two devices reordering spaces at once resolve
 * to one of the two arrangements, not to a merge of both — which is what a
 * person expects from "the arrangement I made last".
 */
export interface OwnPref {
  /** Namespaced key, e.g. `sidebar.spaceOrder`. */
  key: string;
  /** JSON-encoded value. Opaque here: only the app layer reads the shape. */
  value: string;
  /** Unix ms of the decision. */
  stamp: number;
  /** Device key that made it, or null if unknown. */
  by: string | null;
}
/**
 * Person-private state, pushed on every decision and exchanged in full when two
 * of our devices meet. Accepted from our own devices only — another person
 * sending this is claiming to be a replica of us.
 *
 * The full exchange on `hello` is what makes it converge without an op log: a
 * device that was offline for the decision learns it on reconnect, and learns
 * it from any sibling that holds it, not only from the one that decided.
 */
interface OwnStateMsg {
  type: "own-state";
  spaces: OwnSpaceState[];
  /**
   * Absent from a build that predates person-private preferences, which is why
   * adding them is not a {@link PROTOCOL_VERSION} bump: the field carries no
   * merge semantics an older peer could get wrong, and denying that peer every
   * op over a sidebar arrangement would be the worse trade. It simply keeps the
   * old order until it updates.
   */
  prefs?: OwnPref[];
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
/** Asset request: "I need this content-addressed asset — can you send it?" Sent when an image block renders without local data for its hash, and eagerly by the AssetPrefetcher for every referenced hash missing from the local store. */
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

/**
 * Enrolment payload, sent by an already-linked device to a new one after the
 * pairing proof succeeds. This is the device-link flow's whole point: it hands
 * over the person's root identity and the space list, which is what lets the
 * newcomer be recognised as the same human rather than a second collaborator.
 *
 * It carries the ROOT PRIVATE KEY. That is deliberate — every linked device can
 * enrol the next one, so losing a single device never strands the account — but
 * it makes the invite secret equivalent to full account access for its lifetime.
 * The payload is sent only after both sides prove they hold that secret, and
 * only over the pairing topic, which is encrypted with a key derived from it.
 *
 * The space list travels here because a space cannot be pushed onto a peer over
 * normal replication (see `handleSyncData`): the newcomer must already own the
 * rows before it connects, exactly as `Engine.acceptInvite` writes them for a
 * single space. The profile and the per-space archive flags travel for a
 * different reason — no op describes either, so they would arrive only on the
 * newcomer's first handshake, and it would spend the moments before that
 * nameless with a sidebar full of spaces the person had filed away.
 */
interface DeviceLinkMsg {
  type: "device-link";
  /** Root ("person") keypair, copied so any linked device can enrol the next. */
  rootPublicKey: string;
  rootPrivateKey: string;
  /** Certificate the sender just issued for the recipient's device key. */
  cert: string;
  issuedAt: number;
  /** Certificates for the sender's own devices, so the newcomer can verify membership without waiting for replication. */
  deviceCerts: { deviceKey: string; cert: string; issuedAt: number }[];
  /**
   * Every space the sender belongs to, personal ones included, each with the
   * sender's archive state. No op carries that flag — see {@link OwnStateMsg} —
   * so without it a space filed away on one device would come back active on
   * every device linked afterwards.
   *
   * The decision's stamp travels with it so the newcomer joins the LWW register
   * already in step, instead of holding an undated copy that the next decision
   * anywhere would have to outrank by luck.
   */
  spaces: {
    id: string;
    name: string;
    personal: boolean;
    archivedAt?: string | null;
    archiveStamp?: number;
    archiveBy?: string | null;
  }[];
  /**
   * The person's display name and avatar, from the sender's `identity` row.
   * That row is device-local and replication never carries it, so a newcomer
   * without this would keep its own blank profile and show up as a nameless
   * stranger beside its siblings in every shared space.
   *
   * Absent from a payload written by an older build; the newcomer then keeps
   * whatever profile it already has.
   */
  profile?: { name: string; avatar: string | null };
  /**
   * The person's private preferences (see {@link OwnPref}), for the same reason
   * the archive flags travel: nothing else in this bootstrap describes them, so
   * without them the new device would spend its first moments with the sidebar
   * arranged the way no device of this person's arranges it, would re-run
   * walkthroughs the person has already read, and would show the siblings it
   * just joined as a row of unnamed devices.
   *
   * Stamps travel too, so the newcomer joins each register already in step.
   */
  prefs?: OwnPref[];
}

/** The enrolment data an already-linked device hands a newcomer. */
export type DeviceLinkPayload = Omit<DeviceLinkMsg, "type">;

type Message =
  | HelloMsg
  | SyncPullMsg
  | SyncDataMsg
  | SpaceOpsMsg
  | PageOpsMsg
  | OwnStateMsg
  | RoomJoinMsg
  | RoomLeaveMsg
  | RoomPeersMsg
  | AwarenessMsg
  | SyncReqMsg
  | SyncResMsg
  | AssetReqMsg
  | PairHelloMsg
  | PairAckMsg
  | DeviceLinkMsg;

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
   * True only after `hello` negotiated an exact protocol + wire match. Undefined
   * before the handshake and false on either mismatch; in both cases every
   * non-hello send/receive is blocked.
   */
  versionCompatible?: boolean;
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

/** Holds all state for an in-progress device-pairing flow. Initiator sessions listen until the invite expires or is revoked (surviving dialog close); an acceptor session is torn down once both sides have exchanged proofs and stored each other as trusted peers. */
interface PairingSession {
  topicHex: string;
  topic: NetworkTopic;
  invite: SpaceInvite;
  role: "initiator" | "acceptor";
  /**
   * "space" adds another person to one space; "device" adds another of the
   * local user's own devices to all of them. The two use different signaling
   * topics, so a session only ever meets peers running the same mode.
   */
  mode: "space" | "device";
  /** Device mode, initiator: build the enrolment payload for a verified newcomer. */
  issueDeviceLink?: (peerPublicKey: string) => Promise<DeviceLinkPayload | null>;
  /** Device mode, acceptor: adopt the enrolment payload before connecting. */
  applyDeviceLink?: (payload: DeviceLinkPayload) => Promise<void>;
  /** Space name — initiator provides from DB, acceptor receives via pair-hello */
  spaceName: string;
  localPublicKey: string;
  localName: string;
  privateKey: string;
  callbacks: PairCallbacks;
  completed: boolean;
  /** Multi-peer (initiator): don't destroy topic after first peer */
  multi: boolean;
  /** Track peers that already completed pairing (by public key) */
  completedPeers: Set<string>;
  /** Tears the session down when the invite expires */
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

// =============================================================================
// Encoder / Decoder — JSON over Uint8Array
// Wire-level optimisations (op shortcodes, charId runs, pageId stripping) are
// applied inside encode/decode via helpers imported from ./wire-codec.
// =============================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Max time pause() waits for peer send buffers to drain before tearing down.
 * Bounds the iOS background-task flush window — must stay well under the OS's
 * background execution grace (~seconds).
 */
const FLUSH_TIMEOUT_MS = 2500;

/**
 * How long a `sync-pull` may stay unanswered before it stops counting as
 * catch-up in flight. A peer that goes quiet mid-exchange leaves its pull
 * outstanding forever otherwise, and the host would show that space as
 * syncing for as long as the connection lasts.
 */
const SYNC_PULL_TIMEOUT_MS = 15_000;

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

  /** Active pairing sessions, keyed by invite secret */
  private pairingSessions = new Map<string, PairingSession>();

  /** Pending asset requests: hash → resolve callbacks waiting for the data */
  private pendingAssetRequests = new Map<
    string,
    Array<(found: boolean) => void>
  >();

  /** Per-room awareness throttle state (50 ms leading+trailing) */
  private awarenessThrottle = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout> | null;
      pending: CursorPresence | null;
    }
  >();

  /** True while suspended for app backgrounding (see pause()/resume()). */
  private paused = false;

  /**
   * Catch-up in flight: spaceId → the peers whose `sync-data` we are waiting
   * for, each with the pull's token and its expiry timer. A token is compared
   * on settle so a late reply cannot clear a pull sent after it.
   */
  private pendingPulls = new Map<
    string,
    Map<string, { token: number; timer: ReturnType<typeof setTimeout> }>
  >();
  private nextPullToken = 0;
  private syncingSpacesListeners = new Set<(spaceIds: string[]) => void>();

  /** Connection state */
  private connectionState: ConnectionState = "disconnected";
  private connectionListeners = new Set<(state: ConnectionState) => void>();
  private connectedPeersListeners = new Set<(peers: string[]) => void>();
  private pageEventListeners = new Set<Partial<PageEvents>>();
  private versionMismatchListeners = new Set<(info: PeerVersionInfo) => void>();
  private peerReadyListeners = new Set<(publicKey: string) => void>();

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

    await this.refreshSpaces();
  }

  /**
   * The peers we are allowed to dial: every member of every active space we
   * belong to, minus ourselves and minus locally revoked peers.
   *
   * This is the single admission rule for the whole replicator — membership
   * grants the connection, and a peer record only ever takes it away. Nothing
   * else may widen the set: not a peer's roster, not a space pushed at us by
   * someone already connected. `getSpaceIds` already restricts to active
   * spaces we are a member of, so a space we merely hold ops for (archived, or
   * one we left) admits no one.
   */
  private async admittedPeers(): Promise<Set<string>> {
    const [peerRecords, spaceIds, ownDevices] = await Promise.all([
      this.host.getPeerRecords(),
      this.host.getSpaceIds(),
      this.host.getOwnDeviceKeys(),
    ]);
    const revoked = new Set(
      peerRecords
        .filter((peer) => !peer.trusted)
        .map((peer) => peer.publicKey),
    );

    const memberLists = await Promise.all(
      spaceIds.map((spaceId) => this.host.getSpaceMembers(spaceId)),
    );
    const admitted = new Set<string>();
    // Our own devices need no space in common: they are this person's other
    // replicas, and a space that exists on only one of them is exactly the
    // case they have to connect for.
    for (const members of [
      ...memberLists,
      ownDevices.map((publicKey) => ({ publicKey })),
    ]) {
      for (const member of members) {
        if (member.publicKey === this.localPublicKey) continue;
        if (revoked.has(member.publicKey)) continue;
        admitted.add(member.publicKey);
      }
    }
    return admitted;
  }

  /** Whether a peer is another device of this person (certified under our root). */
  private async isOwnDevice(publicKey: string): Promise<boolean> {
    return (await this.host.getOwnDeviceKeys()).includes(publicKey);
  }

  /**
   * Reconcile peer connections and routing with the currently active spaces.
   * Archiving the last space shared with a peer closes its transport; restoring
   * a space reconnects and lets the normal handshake catch up missing ops.
   */
  async refreshSpaces(): Promise<void> {
    const activePeers = await this.admittedPeers();

    const connectedOrListeningPeers = new Set([
      ...this.peers.keys(),
      ...[...this.topics.values()].map((entry) => entry.remotePubKey),
    ]);
    for (const publicKey of connectedOrListeningPeers) {
      if (!activePeers.has(publicKey)) {
        await this.removePeer(publicKey);
      }
    }

    if (this.paused) return;

    for (const publicKey of activePeers) {
      try {
        await this.connectAdmittedPeer(publicKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[Sync] failed to connect to peer ${publicKey.slice(0, 8)}: ${msg}`,
        );
      }
    }
  }

  /**
   * Connect to a newly-paired or newly-learned peer, or re-negotiate shared
   * spaces if already connected.
   *
   * Callers reach this from outside the reconciler — a completed pairing, or a
   * `member_add` replicated from another peer — so the admission rule is
   * enforced here rather than trusted to the caller. A key that shares no
   * active space with us is refused no matter who named it.
   */
  async addPeer(publicKey: string): Promise<void> {
    if (!(await this.admittedPeers()).has(publicKey)) {
      console.warn(
        `[Sync] refusing to connect to ${publicKey.slice(0, 8)}: shares no active space with us`,
      );
      return;
    }
    await this.connectAdmittedPeer(publicKey);
  }

  /** {@link addPeer} past the admission check — for callers that just made it. */
  private async connectAdmittedPeer(publicKey: string): Promise<void> {
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
          if (
            response.spaceOps.length > 0 ||
            Object.keys(response.pageOps).length > 0
          ) {
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
      this.settlePeerPulls(publicKey);
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

  /**
   * Suspend sync for app backgrounding. Best-effort flushes in-flight sends,
   * then closes every peer connection and suspends the signaling sockets —
   * WITHOUT discarding trusted-peer topics, open rooms, or listeners, so
   * resume() can rebuild the connection quickly. Idempotent.
   *
   * NOTE: on native the Engine's CRDT ops are already durable in SQLite, so
   * "flush" here means completing the network exchange, not saving to disk.
   */
  async pause(): Promise<void> {
    if (this.paused) return;
    this.paused = true;
    console.log("[Sync] pause");

    // Give peer send buffers a bounded window to drain before teardown.
    await this.network.flush?.(FLUSH_TIMEOUT_MS);

    // Close peer connections; keep topics, rooms, and listeners intact.
    for (const conn of this.peers.values()) {
      conn.cleanup();
      conn.netPeer.close();
    }
    this.peers.clear();
    this.emitConnectedPeers();
    this.settleAllPulls();

    // Suspend the signaling sockets and halt reconnect backoff. Topic objects
    // and registered topic keys are preserved for resume().
    await this.network.pause?.();

    this.setConnectionState("disconnected");
  }

  /**
   * Resume sync after foregrounding. Re-opens the suspended signaling sockets;
   * peers rediscover each other and re-run the hello handshake, which itself
   * re-announces our open rooms (see handleHello), so presence self-heals.
   * Also connects any trusted peer added while backgrounded. Idempotent.
   */
  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    console.log("[Sync] resume");

    // Re-open sockets suspended by pause(); existing topics reconnect and their
    // onPeerJoin listeners re-fire handlePeerJoin → sendHello (a fresh round).
    await this.network.resume?.();

    // Reconcile spaces changed while backgrounded and connect only peers that
    // share at least one active space.
    await this.refreshSpaces();

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

  private _broadcastAwareness(
    room: RoomState,
    roomId: string,
    state: CursorPresence,
  ): void {
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
   * Subscribe to which spaces are catching up with a peer right now — from the
   * `sync-pull` that opens the exchange until the matching `sync-data` has been
   * applied (or the pull expires, see {@link SYNC_PULL_TIMEOUT_MS}). Fires
   * immediately with the current set so a subscriber that arrives mid-exchange
   * still sees it, then on every change.
   *
   * This covers the catch-up a peer owes us, not live edits: ops pushed while
   * both sides are already up to date arrive on their own and finish as they
   * land, with nothing to wait for.
   */
  onSyncingSpacesChange(cb: (spaceIds: string[]) => void): () => void {
    this.syncingSpacesListeners.add(cb);
    cb(this.syncingSpaces());
    return () => {
      this.syncingSpacesListeners.delete(cb);
    };
  }

  private syncingSpaces(): string[] {
    return Array.from(this.pendingPulls.keys());
  }

  private emitSyncingSpaces() {
    const spaceIds = this.syncingSpaces();
    for (const cb of this.syncingSpacesListeners) cb(spaceIds);
  }

  /**
   * Send a pull for one space and record it as in flight. Every pull goes
   * through here so the "syncing" set cannot drift from what is on the wire.
   * Returns the token to settle it with.
   */
  private sendSyncPull(
    conn: PeerConnection,
    spaceId: string,
    spaceVV: Record<string, number>,
    pageVVs: Record<string, Record<string, number>>,
  ): number {
    this.sendDirect(conn, { type: "sync-pull", spaceId, spaceVV, pageVVs });

    const byPeer = this.pendingPulls.get(spaceId) ?? new Map();
    const previous = byPeer.get(conn.publicKey);
    if (previous) clearTimeout(previous.timer);
    const token = ++this.nextPullToken;
    byPeer.set(conn.publicKey, {
      token,
      timer: setTimeout(
        () => this.settlePull(spaceId, conn.publicKey, token),
        SYNC_PULL_TIMEOUT_MS,
      ),
    });
    const isNew = !this.pendingPulls.has(spaceId);
    this.pendingPulls.set(spaceId, byPeer);
    if (isNew) this.emitSyncingSpaces();
    return token;
  }

  /**
   * Mark one peer's pull for a space as finished. A token that no longer
   * matches belongs to a superseded pull, so it settles nothing.
   */
  private settlePull(spaceId: string, publicKey: string, token?: number) {
    const byPeer = this.pendingPulls.get(spaceId);
    const pending = byPeer?.get(publicKey);
    if (!byPeer || !pending) return;
    if (token !== undefined && pending.token !== token) return;
    clearTimeout(pending.timer);
    byPeer.delete(publicKey);
    if (byPeer.size > 0) return;
    this.pendingPulls.delete(spaceId);
    this.emitSyncingSpaces();
  }

  /** Settle every pull outstanding with a peer — it can no longer answer. */
  private settlePeerPulls(publicKey: string) {
    for (const spaceId of this.syncingSpaces()) {
      this.settlePull(spaceId, publicKey);
    }
  }

  /** Settle every outstanding pull — every peer is gone (pause, destroy). */
  private settleAllPulls() {
    if (this.pendingPulls.size === 0) return;
    for (const byPeer of this.pendingPulls.values()) {
      for (const pending of byPeer.values()) clearTimeout(pending.timer);
    }
    this.pendingPulls.clear();
    this.emitSyncingSpaces();
  }

  /**
   * Subscribe to protocol/wire-version mismatches detected during a peer's
   * `hello` handshake. Fires once per hello whenever the peer's advertised
   * {@link PROTOCOL_VERSION} or {@link WIRE_VERSION} differs from ours, so the
   * host can surface "an update is available" / "this peer is outdated".
   *
   * Every mismatch is blocking: the replicator exchanges no ops/awareness in
   * either direction until a later `hello` advertises exact protocol and wire
   * versions. `wireCompatible` still reports whether the byte codec itself
   * matched; `syncCompatible` reports the complete negotiation result.
   */
  onPeerVersionMismatch(cb: (info: PeerVersionInfo) => void): () => void {
    this.versionMismatchListeners.add(cb);
    return () => {
      this.versionMismatchListeners.delete(cb);
    };
  }

  /**
   * Subscribe to a peer completing the `hello` handshake with compatible
   * versions — the earliest moment requests to that peer can succeed. Fires
   * on every accepted hello, including reconnects after pause/resume.
   */
  onPeerReady(cb: (publicKey: string) => void): () => void {
    this.peerReadyListeners.add(cb);
    return () => {
      this.peerReadyListeners.delete(cb);
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

  /**
   * Announce a person-private decision to this person's other devices.
   *
   * Not routed by shared space, unlike the op pushes: an archive is exactly the
   * message that stops the space from being shared, and the sibling it is meant
   * for may not be a member of the space at all yet. A preference is not about a
   * space at all.
   */
  async pushOwnState(update: {
    spaces?: OwnSpaceState[];
    prefs?: OwnPref[];
  }): Promise<void> {
    const spaces = update.spaces ?? [];
    const prefs = update.prefs ?? [];
    if (spaces.length === 0 && prefs.length === 0) return;
    const ownDevices = new Set(await this.host.getOwnDeviceKeys());
    for (const conn of this.peers.values()) {
      if (!ownDevices.has(conn.publicKey)) continue;
      this.sendDirect(conn, { type: "own-state", spaces, prefs });
    }
  }

  // ---------------------------------------------------------------------------
  // Pairing (one-time topic for peer discovery + mutual auth)
  // ---------------------------------------------------------------------------

  async startPairing(opts: {
    invite: SpaceInvite;
    role: "initiator" | "acceptor";
    mode?: "space" | "device";
    spaceName?: string;
    localPublicKey: string;
    localName: string;
    privateKey: string;
    callbacks: PairCallbacks;
    issueDeviceLink?: (
      peerPublicKey: string,
    ) => Promise<DeviceLinkPayload | null>;
    applyDeviceLink?: (payload: DeviceLinkPayload) => Promise<void>;
  }): Promise<void> {
    // Starting again for the same invite (e.g. an acceptor retry) replaces its session
    await this.cancelPairing(opts.invite.secret);

    if (Date.now() >= opts.invite.expiresAt) {
      opts.callbacks.onError?.("expired");
      return;
    }

    const mode = opts.mode ?? "space";
    const topicHex =
      mode === "device"
        ? await deriveDeviceLinkTopic(opts.invite.secret)
        : await deriveInviteTopic(opts.invite.secret);

    // Derive and register encryption key for the pairing topic
    const pairingKey = await derivePairingKey(opts.invite.secret, topicHex);
    this.network.registerTopicKey(topicHex, pairingKey);

    // A topic whose first signaling connect fails is still handed back, and
    // retries in the background — so pairing started offline picks up by
    // itself once the network returns. Only a topic that could not be created
    // at all is fatal here.
    let topic: NetworkTopic;
    try {
      topic = await this.network.join(hexToBytes(topicHex));
    } catch (e) {
      console.error("[Sync] could not join pairing topic:", e);
      this.network.unregisterTopicKey(topicHex);
      opts.callbacks.onError?.("network");
      return;
    }

    const session: PairingSession = {
      topicHex,
      topic,
      invite: opts.invite,
      role: opts.role,
      mode,
      issueDeviceLink: opts.issueDeviceLink,
      applyDeviceLink: opts.applyDeviceLink,
      spaceName: opts.spaceName ?? "",
      localPublicKey: opts.localPublicKey,
      localName: opts.localName,
      privateKey: opts.privateKey,
      callbacks: opts.callbacks,
      completed: false,
      multi: opts.role === "initiator",
      completedPeers: new Set(),
      expiryTimer: null,
    };
    this.pairingSessions.set(opts.invite.secret, session);
    this.armPairingExpiry(session);

    const handlePeer = (peer: NetworkPeer) => {
      if (session.completed) return;
      session.callbacks.onConnected?.();

      // A drop before the exchange finishes is not the end of the attempt: the
      // transport reconnects on its own and this handler runs again, sending a
      // fresh hello. Say so, so the screen can stop claiming to be connected.
      peer.onClose(() => {
        if (session.completed) return;
        session.callbacks.onReconnecting?.();
      });

      peer.onMessage(async (data) => {
        const msg = decode(data);
        if (!msg || session.completed) return;
        if (msg.type === "pair-hello" || msg.type === "pair-ack") {
          await this.handlePairingMessage(peer, msg, session);
        } else if (msg.type === "device-link") {
          await this.handleDeviceLink(msg, session);
        }
      });

      this.sendPairHello(peer, session);
    };

    topic.onPeerJoin(handlePeer);
    for (const peer of topic.getPeers()) handlePeer(peer);
  }

  /** Whether a pairing session is currently open for this invite secret. */
  isPairingActive(secret: string): boolean {
    return this.pairingSessions.has(secret);
  }

  /** Cancel the pairing session for one invite secret, or all of them. */
  async cancelPairing(secret?: string): Promise<void> {
    const sessions =
      secret !== undefined
        ? [this.pairingSessions.get(secret)]
        : [...this.pairingSessions.values()];
    for (const session of sessions) {
      if (session) await this.teardownPairingSession(session);
    }
  }

  private async teardownPairingSession(session: PairingSession): Promise<void> {
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
    this.pairingSessions.delete(session.invite.secret);
    this.network.unregisterTopicKey(session.topicHex);
    await session.topic.destroy();
  }

  /** setTimeout is capped at 2^31-1 ms, so re-arm until expiry is reachable. */
  private armPairingExpiry(session: PairingSession): void {
    const delay = session.invite.expiresAt - Date.now();
    if (delay <= 0) {
      // Tearing down silently leaves a waiting screen waiting for good — the
      // acceptor still owed its enrolment payload most of all.
      if (!session.completed) session.callbacks.onError?.("expired");
      void this.teardownPairingSession(session);
      return;
    }
    session.expiryTimer = setTimeout(
      () => this.armPairingExpiry(session),
      Math.min(delay, 0x7fffffff),
    );
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

    // Register the E2E encryption key for this topic before joining. Without a
    // shared key we cannot encrypt signaling, and join() refuses to send it in
    // cleartext. Direct pairings use their stored invite-derived key; other
    // members derive one from the two replica identities.
    const sharedKeyHex = await this.host.getPeerSharedKey(remotePubKey);
    if (!sharedKeyHex) {
      console.warn(
        `[Sync] no shared key for peer=${remotePubKey.slice(0, 8)} — not connecting`,
      );
      return;
    }
    this.network.registerTopicKey(topicHex, hexToBytes(sharedKeyHex));

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
        if (this.peers.get(remotePubKey)?.versionCompatible !== true) return;
        void this.handleBinaryAssetData(data).catch((e) => {
          console.error("[Sync] asset frame rejected:", e);
        });
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
    this.settlePeerPulls(publicKey);
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
    // `hello` is the gate, not just a notification. Before negotiation, or on
    // either version mismatch, drop everything else. A later matching hello can
    // reopen the connection without tearing down the transport.
    if (
      msg.type !== "hello" &&
      this.peers.get(fromPubKey)?.versionCompatible !== true
    ) {
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

      // Own-device state
      case "own-state":
        await this.handleOwnState(fromPubKey, msg);
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
        await this.handleSyncReq(fromPubKey, msg);
        break;
      case "sync-res":
        await this.handleSyncRes(fromPubKey, msg);
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

    const protocolCompatible = remoteProtocolVersion === PROTOCOL_VERSION;
    const wireCompatible = remoteWireVersion === WIRE_VERSION;
    const syncCompatible = protocolCompatible && wireCompatible;
    conn.versionCompatible = syncCompatible;
    if (syncCompatible) return;

    const direction =
      remoteProtocolVersion > PROTOCOL_VERSION ||
      remoteWireVersion > WIRE_VERSION
        ? "peer is newer — an update may be available"
        : "peer is older";
    console.warn(
      `[Sync] version mismatch with ${conn.publicKey.slice(0, 8)}: ` +
        `protocol ${remoteProtocolVersion} (local ${PROTOCOL_VERSION}), ` +
        `wire ${remoteWireVersion} (local ${WIRE_VERSION}) — ${direction}` +
        "; sync refused until both versions match",
    );

    const info: PeerVersionInfo = {
      publicKey: conn.publicKey,
      remoteProtocolVersion,
      remoteWireVersion,
      localProtocolVersion: PROTOCOL_VERSION,
      localWireVersion: WIRE_VERSION,
      protocolCompatible,
      wireCompatible,
      syncCompatible,
    };
    for (const cb of this.versionMismatchListeners) cb(info);
  }

  private async handleHello(fromPubKey: string, msg: HelloMsg) {
    console.log(`[Sync] hello from ${fromPubKey.slice(0, 8)}`);
    const conn = this.peers.get(fromPubKey);
    if (!conn) return;

    this.checkPeerVersion(conn, msg);
    if (conn.versionCompatible !== true) {
      console.warn(
        `[Sync] refusing to sync with ${fromPubKey.slice(0, 8)}: incompatible protocol or wire version`,
      );
      // Still record the contact, but exchange no ops/awareness with it.
      await this.host.updatePeerLastSeen(fromPubKey);
      return;
    }

    await this.host.updatePeerLastSeen(fromPubKey);
    await this.recomputeSharedSpaces(conn);

    // Our own device: trade the person-private state in full before anything
    // else. This is the only catch-up it gets — no version vector covers it —
    // and doing it first means a space this device filed away is already
    // filed on both sides by the time the pulls below run.
    if (await this.isOwnDevice(fromPubKey)) {
      const [states, prefs] = await Promise.all([
        this.host.getOwnSpaceStates(),
        this.host.getOwnPrefs(),
      ]);
      if (states.length > 0 || prefs.length > 0) {
        this.sendDirect(conn, { type: "own-state", spaces: states, prefs });
      }
    }

    const shared = conn.sharedSpaces;

    // For each shared space, send a sync-pull with our version vectors.
    // The remote will respond with only the ops we're missing.
    // Note: bootstrapping pushes (for spaces the remote doesn't know about)
    // are handled in addPeer() when new shared spaces are detected.
    for (const spaceId of shared) {
      const spaceVV = await this.host.getSpaceVV(spaceId);
      const pageVVs = await this.host.getPageVVs(spaceId);

      this.sendSyncPull(conn, spaceId, spaceVV, pageVVs);
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

    // Handshake complete — the peer can now serve sync and asset requests.
    for (const cb of this.peerReadyListeners) cb(fromPubKey);
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
    if (!conn) return;
    if (!(await this.ensureSharedSpace(conn, msg.spaceId))) {
      // Nothing to answer with — but if our own device is asking about a space
      // we have never seen, it has one we are missing. Ask for it instead of
      // going quiet; the reply bootstraps it (see {@link handleSyncData}).
      if (await this.requestUnknownOwnSpace(conn, msg.spaceId)) return;
      console.warn(
        `[Sync] dropped sync-pull for ${msg.spaceId.slice(0, 8)} from ${fromPubKey.slice(0, 8)} (not in sharedSpaces)`,
      );
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

  /**
   * A reply closes the pull that asked for it, whatever it turned out to hold —
   * including the paths that drop it, since a dropped reply is still the last
   * word we will get on that pull. The token captured up front keeps a reply
   * from settling a pull sent while it was being applied (the newly-shared
   * space below sends one).
   */
  private async handleSyncData(fromPubKey: string, msg: SyncDataMsg) {
    const token = this.pendingPulls.get(msg.spaceId)?.get(fromPubKey)?.token;
    try {
      await this.applySyncData(fromPubKey, msg);
    } finally {
      if (token !== undefined) this.settlePull(msg.spaceId, fromPubKey, token);
    }
  }

  private async applySyncData(fromPubKey: string, msg: SyncDataMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn) return;
    // A space we do not already belong to cannot arrive from another PERSON.
    // Letting them bootstrap an unknown space would hand us their `member_add`
    // roster too, and every name on it would become one of our peers — a space
    // we never joined, full of contacts we never met. Their spaces come from an
    // invite: the acceptor writes the space and its membership locally before
    // it ever connects (`Engine.acceptInvite`), so pairing does not need this.
    //
    // Our own device is not another person. Its roster is our roster and its
    // spaces are ours, so a space it pushes is adopted — the only way a space
    // created after linking can reach a device linked before it existed.
    const wasUnknown = !conn.sharedSpaces.has(msg.spaceId);
    let adopting = false;
    if (!(await this.ensureSharedSpace(conn, msg.spaceId))) {
      if (!(await this.isOwnDevice(fromPubKey))) {
        console.warn(
          `[Sync] dropped sync-data for ${msg.spaceId.slice(0, 8)} from ${fromPubKey.slice(0, 8)} (not in sharedSpaces)`,
        );
        return;
      }
      adopting = true;
    }

    // `sharedSpaces` is a cache that can outlive an archive, so re-check the
    // state: an archived space accepts no catch-up until it is restored. A
    // sibling may only create a space we have never seen — an archived one
    // stays archived, because ops are not how the archive flag moves between
    // our devices (`own-state` is), and a restore has to be a decision rather
    // than a side effect of a peer happening to push.
    const spaceState = await this.host.getSpaceState(msg.spaceId);
    const expected = adopting ? "unknown" : "active";
    if (spaceState !== expected) {
      console.warn(
        `[Sync] dropped sync-data for ${msg.spaceId.slice(0, 8)} from ${fromPubKey.slice(0, 8)} (${spaceState} space)`,
      );
      return;
    }

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

    // The space exists locally now, so let the transport see it before any
    // further message for it arrives. Connecting to whoever else is in it is
    // left to the engine, which reacts to the `member_add`s we just applied.
    if (adopting) await this.recomputeSharedSpaces(conn);

    // We only learned we share this space during this message — `hello` sent
    // no pull for it. Pull now so we catch up on whatever preceded this batch.
    if (wasUnknown) {
      console.log(
        `[Sync] newly shared space ${msg.spaceId.slice(0, 8)} with ${fromPubKey.slice(0, 8)}`,
      );
      const spaceVV = await this.host.getSpaceVV(msg.spaceId);
      const pageVVs = await this.host.getPageVVs(msg.spaceId);
      this.sendSyncPull(conn, msg.spaceId, spaceVV, pageVVs);
    }
  }

  // --- Real-time push ---

  /**
   * A live op or a pull naming a space we have never seen is only meaningful
   * from our own device: it holds a space we were never told about. Ask for it
   * in full rather than dropping the message — {@link handleSyncData} adopts
   * the reply. Returns whether the request was made.
   */
  private async requestUnknownOwnSpace(
    conn: PeerConnection,
    spaceId: string,
  ): Promise<boolean> {
    if (!(await this.isOwnDevice(conn.publicKey))) return false;
    if ((await this.host.getSpaceState(spaceId)) !== "unknown") return false;
    console.log(
      `[Sync] requesting unknown space ${spaceId.slice(0, 8)} from own device ${conn.publicKey.slice(0, 8)}`,
    );
    this.sendSyncPull(conn, spaceId, {}, {});
    return true;
  }

  private async handleSpaceOps(fromPubKey: string, msg: SpaceOpsMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn) return;
    if (!(await this.ensureSharedSpace(conn, msg.spaceId))) {
      if (await this.requestUnknownOwnSpace(conn, msg.spaceId)) return;
      console.warn(
        `[Sync] dropped space-ops for ${msg.spaceId.slice(0, 8)} from ${fromPubKey.slice(0, 8)} (not in sharedSpaces)`,
      );
      return;
    }

    await this.host.applyRemoteSpaceOps(msg.spaceId, msg.ops);
  }

  private async handlePageOps(fromPubKey: string, msg: PageOpsMsg) {
    const conn = this.peers.get(fromPubKey);
    if (!conn) return;
    if (!(await this.ensureSharedSpace(conn, msg.spaceId))) {
      if (await this.requestUnknownOwnSpace(conn, msg.spaceId)) return;
      console.warn(
        `[Sync] dropped page-ops for ${msg.spaceId.slice(0, 8)} from ${fromPubKey.slice(0, 8)} (not in sharedSpaces)`,
      );
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

  // --- Own-device state ---

  /**
   * Adopt a sibling's person-private state.
   *
   * Gated on the device certificate rather than on membership: this message says
   * "this is what you decided", which only a replica of us may say. A member of
   * the same space is still another person, and letting them speak here would
   * let them empty our sidebar.
   */
  private async handleOwnState(fromPubKey: string, msg: OwnStateMsg) {
    if (!this.peers.has(fromPubKey)) return;
    if (!(await this.isOwnDevice(fromPubKey))) {
      console.warn(
        `[Sync] dropped own-state from ${fromPubKey.slice(0, 8)} (not our device)`,
      );
      return;
    }
    // Either half may be empty — a preference change announces no space state,
    // and a sibling on an older build sends no preferences at all.
    if (msg.spaces?.length) await this.host.applyOwnSpaceStates(msg.spaces);
    if (msg.prefs?.length) await this.host.applyOwnPrefs(msg.prefs);
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

  private async canSyncPage(
    fromPubKey: string,
    pageId: string,
  ): Promise<boolean> {
    const conn = this.peers.get(fromPubKey);
    const pageSpace = await this.host.getPageSpaceState(pageId);
    return (
      conn !== undefined &&
      pageSpace?.state === "active" &&
      (await this.ensureSharedSpace(conn, pageSpace.spaceId))
    );
  }

  private async handleSyncReq(fromPubKey: string, msg: SyncReqMsg) {
    if (!(await this.canSyncPage(fromPubKey, msg.pageId))) return;

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

  private async handleSyncRes(fromPubKey: string, msg: SyncResMsg) {
    if (!(await this.canSyncPage(fromPubKey, msg.pageId))) return;

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
    const frame = new Uint8Array(
      1 + 32 + 1 + extBytes.length + asset.data.length,
    );
    let off = 0;
    frame[off++] = BINARY_ASSET_TAG;
    frame.set(hashBytes, off);
    off += 32;
    frame[off++] = extBytes.length;
    frame.set(extBytes, off);
    off += extBytes.length;
    frame.set(asset.data, off);

    conn.netPeer.send(frame);
  }

  /**
   * Handle a binary asset-data frame from a peer.
   *
   * Every byte here is remote input, and `ext` ends up in a filesystem path, so
   * the frame is validated before it reaches the host: it must be well-formed,
   * it must answer a request *we* made, and its bytes must actually hash to the
   * hash it claims. Asset data is only ever sent in reply to an `asset-req`
   * (see {@link handleAssetReq}), so an unsolicited frame is never legitimate.
   */
  private async handleBinaryAssetData(frame: Uint8Array) {
    // Layout: [BINARY_ASSET_TAG][32 hash bytes][1 ext-len][ext bytes][data]
    const HEADER_SIZE = 1 + 32 + 1;
    if (frame.length < HEADER_SIZE) return;

    let off = 1; // skip tag
    const hash = bytesToHex(frame.slice(off, off + 32));
    off += 32;
    const extLen = frame[off++];
    if (frame.length < HEADER_SIZE + extLen) return;
    const ext = dec.decode(frame.slice(off, off + extLen));
    off += extLen;
    const data = frame.slice(off);

    // Unsolicited: nobody asked for this hash. Dropping it denies a peer the
    // ability to plant a file we never requested.
    const callbacks = this.pendingAssetRequests.get(hash);
    if (!callbacks) return;

    // The hash names the content. Storing bytes that hash to something else
    // would let a peer bind arbitrary content to a hash other peers resolve.
    if ((await sha256Hex(data)) !== hash) {
      console.error(
        `[Sync] asset ${hash.slice(0, 8)} failed hash verification — discarded`,
      );
      return;
    }

    await this.host.storeAssetData(hash, ext, data);

    // Re-read: an await elapsed, and the 10s timeout may have settled these.
    if (!this.pendingAssetRequests.has(hash)) return;
    this.pendingAssetRequests.delete(hash);
    for (const cb of callbacks) cb(true);
  }

  // ---------------------------------------------------------------------------
  // Private: Pairing
  // ---------------------------------------------------------------------------

  private async sendPairHello(
    peer: NetworkPeer,
    session: PairingSession,
  ): Promise<void> {
    const cryptoDriver = this.host.getCrypto();
    const challenge = await derivePairingProofChallenge(session.invite.secret);
    const proof = await cryptoDriver.sign(session.privateKey, challenge);

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

  /**
   * Issue and send the enrolment payload to a newly verified device. Failing to
   * build one is not fatal to the pairing itself — the peer stays trusted — but
   * it does mean the device is not yet enrolled, so it is surfaced as an error
   * rather than swallowed.
   */
  private async sendDeviceLink(
    peer: NetworkPeer,
    peerPublicKey: string,
    session: PairingSession,
  ): Promise<void> {
    const payload = await session.issueDeviceLink?.(peerPublicKey);
    if (!payload) {
      session.callbacks.onError?.("certificate");
      return;
    }
    const msg: Message = { type: "device-link", ...payload };
    const data = encode(msg);
    // Deliberately not logged through logNet: the payload carries the root
    // private key, and devlog persists what it is given.
    console.log(
      `[Sync] sending device-link to ${peerPublicKey.slice(0, 8)} (${payload.spaces.length} spaces)`,
    );
    peer.send(data);
  }

  /**
   * Adopt an enrolment payload as the newly linked device. Writes the root
   * identity, certificates, and space rows, then reconciles the transport —
   * the newcomer could not connect for any of these spaces until it owned them
   * locally, since replication refuses to bootstrap an unknown space.
   */
  private async handleDeviceLink(
    msg: DeviceLinkMsg,
    session: PairingSession,
  ): Promise<void> {
    if (session.mode !== "device" || session.role !== "acceptor") {
      console.warn(
        "[Sync] ignoring device-link outside an accepting device-link session",
      );
      return;
    }
    if (!session.applyDeviceLink) return;

    const { type: _type, ...payload } = msg;
    try {
      await session.applyDeviceLink(payload);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`[Sync] failed to adopt device-link: ${detail}`);
      session.callbacks.onError?.("enrollment");
      return;
    }
    // Held open past the handshake for exactly this message — see
    // {@link handlePairingMessage}.
    if (!session.multi) {
      session.completed = true;
      await this.teardownPairingSession(session);
    }
    await this.refreshSpaces();
  }

  private async handlePairingMessage(
    peer: NetworkPeer,
    msg: PairHelloMsg | PairAckMsg,
    session: PairingSession,
  ): Promise<void> {
    if (session.completed) return;

    // Backstop for the expiry timer: never complete a pairing past expiry
    if (Date.now() >= session.invite.expiresAt) {
      await this.teardownPairingSession(session);
      return;
    }

    const alreadyPaired = session.completedPeers.has(msg.publicKey);

    const cryptoDriver = this.host.getCrypto();
    const challenge = await derivePairingProofChallenge(session.invite.secret);
    const valid = await cryptoDriver.verify(msg.publicKey, msg.proof, challenge);

    if (!valid) {
      session.callbacks.onError?.("invalid-proof");
      return;
    }

    // Already paired (multi-peer mode): the handshake does not repeat, but a
    // device that dropped before its enrolment payload landed says hello again
    // on reconnect, and it is the only thing it is still waiting for. Sent
    // after the proof check above, never on the peer's word alone.
    if (alreadyPaired) {
      if (session.mode === "device" && session.role === "initiator") {
        await this.sendDeviceLink(peer, msg.publicKey, session);
      }
      return;
    }

    session.callbacks.onPeerIdentity?.({
      publicKey: msg.publicKey,
      name: msg.name,
    });

    // If we received a hello, send ack back
    if (msg.type === "pair-hello") {
      const proof = await cryptoDriver.sign(session.privateKey, challenge);
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
    await session.callbacks.onComplete?.(
      {
        publicKey: msg.publicKey,
        name: msg.name,
        trusted: true,
        lastSeen: new Date().toISOString(),
      },
      session.spaceName || undefined,
    );

    // Device mode: the already-linked side now hands over the root identity and
    // the space list. Sent only here — after the peer proved it holds the invite
    // secret — because this payload is the account, not an introduction.
    if (session.mode === "device" && session.role === "initiator") {
      await this.sendDeviceLink(peer, msg.publicKey, session);
    }

    // Establish replication connection to the new peer
    await this.addPeer(msg.publicKey);

    // In single-peer mode (acceptor), clean up immediately — except while a
    // device-link acceptor is still owed its enrolment payload. The initiator
    // only sends `device-link` after this exchange, so completing here would
    // both silence the handler and destroy the topic under it, leaving a
    // trusted device with no root identity, no spaces, and nothing to sync.
    // {@link handleDeviceLink} closes the session once the payload lands; the
    // expiry timer closes it if the payload never does.
    const awaitingEnrolment =
      session.mode === "device" && session.role === "acceptor";
    if (!session.multi && !awaitingEnrolment) {
      session.completed = true;
      await this.teardownPairingSession(session);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Transport helpers
  // ---------------------------------------------------------------------------

  /** Send a message directly to a specific connected peer (with logging). */
  private sendDirect(conn: PeerConnection, msg: Message) {
    if (conn.versionCompatible !== true) return;
    const data = encode(msg);
    logNet("send", conn.publicKey, msg, data.byteLength);
    conn.netPeer.send(data);
  }

  private broadcastToSpacePeers(spaceId: string, msg: Message) {
    const data = encode(msg);
    for (const conn of this.peers.values()) {
      if (conn.versionCompatible !== true) continue;
      if (conn.sharedSpaces.has(spaceId)) {
        logNet("send", conn.publicKey, msg, data.byteLength);
        conn.netPeer.send(data);
      }
    }
  }

  private sendToPeer(peerId: string, msg: Message) {
    // peerId might be a truncated public key (first 32 chars) — match by prefix
    for (const conn of this.peers.values()) {
      if (conn.versionCompatible !== true) continue;
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
    this.settleAllPulls();

    for (const entry of this.topics.values()) {
      await entry.topic.destroy();
    }
    this.topics.clear();

    await this.cancelPairing();
    this.rooms.clear();
    this.connectionListeners.clear();
    this.connectedPeersListeners.clear();
    this.pageEventListeners.clear();
    this.peerReadyListeners.clear();
  }
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * SHA-256 of raw bytes, as lowercase hex. Matches how assets are named.
 * Slices to the view's own range — passing `.buffer` would hash the whole
 * backing store whenever the caller hands us a subarray.
 */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const bytes = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

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
 * Every use of the invite secret goes through here with its own label, so no
 * two derivations ever produce the same bytes. That separation is what keeps
 * the topic — the one derivation that is server-visible — from revealing or
 * equaling anything else derived from the secret.
 */
async function hkdfFromSecret(
  secretHex: string,
  label: string,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex).buffer as ArrayBuffer,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: enc.encode(label),
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** Signaling topic for an invite — derived, so the invite carries only the secret. */
async function deriveInviteTopic(secretHex: string): Promise<string> {
  return bytesToHex(await hkdfFromSecret(secretHex, "tasfer-topic"));
}

/**
 * Signaling topic for a device-link invite.
 *
 * The mode is carried by the rendezvous rather than by a field in the invite
 * code: the code is a fixed 56 bytes and `decodeInvite` rejects any other
 * length, so adding a flag byte would break pairing with every older client.
 * A distinct HKDF label means the two flows simply never meet — a peer offering
 * a space invite cannot be answered by a device-link acceptor, or the reverse.
 */
async function deriveDeviceLinkTopic(secretHex: string): Promise<string> {
  return bytesToHex(await hkdfFromSecret(secretHex, "tasfer-device-topic"));
}

/**
 * Challenge both peers sign to prove they hold the invite secret. Must stay
 * distinct from the topic: the topic is visible to the signaling server, and
 * a signature over a server-known value would prove nothing.
 */
function derivePairingProofChallenge(secretHex: string): Promise<Uint8Array> {
  return hkdfFromSecret(secretHex, "tasfer-proof");
}

/**
 * Derive an encryption key for a pairing topic.
 * Both peers know the invite secret — HKDF produces the same key.
 */
function derivePairingKey(
  secretHex: string,
  topicHex: string,
): Promise<Uint8Array> {
  return hkdfFromSecret(secretHex, "tasfer-pair:" + topicHex);
}
