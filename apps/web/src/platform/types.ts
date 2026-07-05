/**
 * Platform Interface Types
 *
 * Defines the contract between the UI/editor layer and the backend.
 * Each platform (web, electron, capacitor) implements this interface
 * with its own storage and networking strategy.
 */

import type { Block, HLC, Operation } from "@cypherkit/editor";
import type { CursorPresence } from "@cypherkit/provider-core/cursors";
import type { DbRow, DbRunResult } from "./driver";

// =============================================================================
// Data Types
// =============================================================================

/** Device type identifier */
export type DeviceType =
  | "laptop"
  | "desktop"
  | "phone"
  | "tablet"
  | "";

/** User identity — local device owner */
export interface Identity {
  /** Public key (hex or base64 encoded) */
  publicKey: string;
  /** Human-readable display name */
  name: string;
  /** Avatar URL or data URI */
  avatar: string | null;
}

/** A known peer */
export interface Peer {
  /** Public key */
  publicKey: string;
  /** Display name */
  name: string;
  /** Whether we trust this peer */
  trusted: boolean;
  /** Last time we saw this peer online (ISO string) */
  lastSeen: string | null;
}

/** Page metadata for list views */
export interface PageListItem {
  id: string;
  title: string;
  /**
   * The title's rich projection: the same title line as inline MARKDOWN
   * (marks intact), for rendering rich title previews without loading the
   * doc. Like `title`, this is a LOCAL, rebuildable cache derived from the
   * doc content — the doc's operation log is the source of truth, and titles
   * are never replicated as metadata (peers re-derive from content ops).
   * Empty when not yet derived.
   */
  titleMd?: string;
  parentId: string | null;
  order: number;
  hasChildren: boolean;
  spaceId?: string | null;
  task?: boolean;
  color?: string | null;
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
  recurrenceId?: string | null;
}

/** A lightweight reference to a page in a breadcrumb path / parent chain. */
export interface PagePathSegment {
  id: string;
  title: string;
  /** Markdown projection of the title line (see {@link PageListItem.titleMd}). */
  titleMd?: string;
  color?: string | null;
}

/** A soft-deleted page surfaced in the Bin (root of an archived subtree) */
export interface ArchivedPageItem {
  id: string;
  title: string;
  /** Markdown projection of the title line (see {@link PageListItem.titleMd}). */
  titleMd?: string;
  spaceId?: string | null;
  color?: string | null;
  /** ISO timestamp when the page was archived (deleted) */
  archivedAt: string;
}

/** Full page with content */
export interface PageFull extends PageListItem {
  blocks: Block[] | null;
  createdAt: string;
  updatedAt: string;
  parents?: PagePathSegment[];
}

/** Data needed to create a page */
export interface PageCreateInput {
  title: string;
  /** Markdown projection of the title line (see {@link PageListItem.titleMd}). */
  titleMd?: string;
  parentId: string | null;
  spaceId?: string;
  scheduledAt?: string;
  duration?: number;
  allDay?: boolean;
  task?: boolean;
}

/** Data for updating a page */
export interface PageUpdateInput {
  id: string;
  title?: string;
  /** Markdown projection of the title line (see {@link PageListItem.titleMd}). */
  titleMd?: string;
  color?: string | null;
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
  task?: boolean;
}

/** Data for moving a page */
export interface PageMoveInput {
  id: string;
  parentId: string | null;
  order?: number;
}

/** Search result */
export interface PageSearchResult {
  id: string;
  title: string | null;
  /** Markdown projection of the title line (see {@link PageListItem.titleMd}). */
  titleMd?: string | null;
  parentId: string | null;
  path: PagePathSegment[] | null;
  color?: string | null;
  /**
   * A short plain-text excerpt of the page body around the first match, present
   * only when the query matched the body (not just the title). The matched
   * substring is highlighted client-side; ellipses mark elided context.
   */
  snippet?: string | null;
}

/** Calendar page result */
export interface PageCalendarItem {
  id: string;
  title: string;
  /** Markdown projection of the title line (see {@link PageListItem.titleMd}). */
  titleMd?: string;
  parentId: string | null;
  order: number;
  color: string | null;
  scheduledAt: string;
  duration: number | null;
  allDay: boolean | null;
  recurrenceId: string | null;
  task: boolean;
  path: PagePathSegment[] | null;
  createdAt: string;
}

/** Page version for version history (derived from operation log) */
export interface PageSnapshot {
  id: string;
  pageId: string;
  blocks: Block[];
  clock: HLC | null;
  /** Total operations at this version point */
  opCount: number;
  /** Wall-clock timestamp (ms since epoch). 0 if unknown. */
  createdAt: number;
}

/** Stored asset metadata */
export interface Asset {
  /** Content hash — used as the filename */
  hash: string;
  /** Original filename */
  fileName: string;
  /** MIME type */
  mimeType: string;
  /** Size in bytes */
  size: number;
}

/** Peer user info for awareness */
export interface RoomUser {
  name?: string;
  avatar?: string | null;
  color?: string;
  deviceType?: DeviceType;
  /**
   * Stable device/person id (the device public key), shared across all of this
   * person's tabs. Lets a peer recognize presence from the local user's own
   * other tabs and label it "You" instead of as a separate anonymous peer.
   */
  deviceId?: string;
}

// =============================================================================
// Spaces
// =============================================================================

/** A shared space — a CRDT-replicated collection of pages between peers */
export interface Space {
  id: string;
  name: string;
  createdAt: string;
}

/** An archived space surfaced in the Bin */
export interface ArchivedSpaceItem {
  id: string;
  name: string;
  /** ISO timestamp when the space was archived */
  archivedAt: string;
}

/** A member of a space */
export interface SpaceMember {
  spaceId: string;
  publicKey: string;
  name: string;
  avatar: string | null;
  addedAt: string;
}

// =============================================================================
// Space Operations (CRDT)
// =============================================================================

/** Base fields for all space operations */
export interface SpaceBaseOp {
  /** Unique operation ID: `${peerId}:${counter}` */
  id: string;
  /** Hybrid logical clock timestamp */
  clock: HLC;
  /** Space this operation belongs to */
  spaceId: string;
}

/** Set a space property (LWW) */
export interface SpaceSet extends SpaceBaseOp {
  op: "space_set";
  field: string;
  value: unknown;
}

/** Add a member to the space */
export interface MemberAdd extends SpaceBaseOp {
  op: "member_add";
  publicKey: string;
  name: string;
}

/** Update a member property (name, avatar, etc.) */
export interface MemberSet extends SpaceBaseOp {
  op: "member_set";
  publicKey: string;
  field: string;
  value: unknown;
}

/**
 * Add a page to the space (page created).
 *
 * Deliberately carries NO title: the page's title (plain and markdown) is a
 * derived projection of the doc content, and the doc's operation log is the
 * source of truth. Every peer derives the title columns locally from the
 * content ops it receives (see Engine.refreshDerivedTitles), so replicated
 * metadata can never contradict the document.
 */
export interface PageAdd extends SpaceBaseOp {
  op: "page_add";
  pageId: string;
  parentId: string | null;
  order: number;
  task?: boolean;
  color?: string | null;
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
}

/** Remove a page from the space (page deleted) */
export interface PageRemove extends SpaceBaseOp {
  op: "page_remove";
  pageId: string;
}

/** Set a page property (title, parentId, order, color, etc.) */
export interface PageSet extends SpaceBaseOp {
  op: "page_set";
  pageId: string;
  field: string;
  value: unknown;
}

/** Union of all space operation types */
export type SpaceOperation =
  | SpaceSet
  | MemberAdd
  | MemberSet
  | PageAdd
  | PageRemove
  | PageSet;

// =============================================================================
// Pairing
// =============================================================================

/** An invite for peer pairing + space joining */
export interface SpaceInvite {
  /** One-time topic for signaling discovery (random hex) */
  topic: string;
  /** Shared secret for mutual authentication (random hex) */
  secret: string;
  /** Space to join after pairing */
  spaceId: string;
}

/** Pairing lifecycle callbacks */
export interface PairCallbacks {
  onConnected?: () => void;
  onPeerIdentity?: (peer: { publicKey: string; name: string }) => void;
  onComplete?: (peer: Peer, spaceName?: string) => void | Promise<void>;
  onError?: (error: string) => void;
  /** Multi-peer mode: allow multiple peers to join before explicitly stopping */
  multi?: boolean;
}

// =============================================================================
// Sync Event Types
// =============================================================================

/** Events emitted by the sync layer */
export interface SyncEvents {
  /** Operations received from a peer */
  onOperations: (operations: Operation[]) => void;
  /** A sync request from a peer */
  onSyncRequest: (
    versionVector: Record<string, number>,
    snapshotClock: undefined,
    requesterId?: string,
  ) => void;
  /** A sync response from a peer */
  onSyncResponse: (
    operations: Operation[],
    versionVector: Record<string, number>,
  ) => void;
  /** Peer joined a document room */
  onPeerJoined: (peerId: string, user?: RoomUser) => void;
  /** Peer left a document room */
  onPeerLeft: (peerId: string) => void;
  /** Initial peer list when joining a room */
  onRoomPeers: (
    peers: string[],
    awarenessStates?: Record<string, CursorPresence>,
  ) => void;
  /** Awareness update from a peer */
  onAwareness: (peerId: string, state: CursorPresence) => void;
  /** Error in sync */
  onError: (message: string) => void;
}

/** Events for page lifecycle changes from other devices/peers */
export interface PageEvents {
  onPageCreated: (page: { id: string; title: string | null; parentId: string | null; order: number }) => void;
  onPageDeleted: (pageId: string) => void;
  onPageMoved: (pageId: string, oldParentId: string | null, newParentId: string | null) => void;
  onPageReordered: (pageId: string, parentId: string | null, order: number) => void;
  onPageTitleUpdated: (pageId: string, title: string) => void;
}

/** Connection state */
export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

/**
 * Versions a remote peer advertised in its `hello`, with our local values for
 * comparison. Surfaced via `sync.onPeerVersionMismatch` whenever either number
 * differs so the host can notify the user. `wireCompatible: false` means the
 * byte-level op encoding differs — the replicator refuses that peer entirely
 * (no ops exchanged in either direction); a protocol-only mismatch still syncs.
 */
export interface PeerVersionInfo {
  publicKey: string;
  remoteProtocolVersion: number;
  remoteWireVersion: number;
  localProtocolVersion: number;
  localWireVersion: number;
  /** True when the byte-level wire encoding matches (ops are decodable). */
  wireCompatible: boolean;
}

// =============================================================================
// Platform Interface
// =============================================================================

/**
 * The platform interface — implemented once per target.
 *
 * - Web: wa-sqlite (OPFS) + WebRTC
 * - Electron: IPC → better-sqlite3 + WebRTC
 * - Capacitor: native SQLite plugin + WebRTC
 */
export interface Platform {
  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  identity: {
    /** Get the local user's identity (generates keypair on first call) */
    get(): Promise<Identity>;
    /** Update display name or avatar */
    update(data: { name?: string; avatar?: string | null }): Promise<Identity>;
  };

  // ---------------------------------------------------------------------------
  // Peers
  // ---------------------------------------------------------------------------

  peers: {
    /** List all known peers */
    list(): Promise<Peer[]>;
    /** Trust a peer by their public key */
    trust(publicKey: string, name?: string): Promise<Peer>;
    /** Remove trust for a peer */
    untrust(publicKey: string): Promise<void>;
    /** Remove a peer entirely */
    remove(publicKey: string): Promise<void>;
  };

  // ---------------------------------------------------------------------------
  // Spaces
  // ---------------------------------------------------------------------------

  spaces: {
    /** List all spaces this device is a member of */
    list(): Promise<Space[]>;
    /** List archived spaces this device is a member of (for the Bin) */
    listArchived(): Promise<ArchivedSpaceItem[]>;
    /** Get a space with its members */
    get(id: string): Promise<Space & { members: SpaceMember[] }>;
    /** Create a new space (adds self as owner) */
    create(name: string): Promise<Space>;
    /** Rename a space */
    rename(id: string, name: string): Promise<void>;
    /** Archive a space locally (stop syncing, hide from list) */
    archive(id: string): Promise<void>;
    /** Unarchive a previously archived space */
    unarchive(id: string): Promise<void>;
    /** Update a member property (name, role, etc.) */
    updateMember(
      spaceId: string,
      publicKey: string,
      field: string,
      value: unknown,
    ): Promise<void>;
    /** Subscribe to space change events */
    onChange(cb: (spaceId: string) => void): () => void;
  };

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  pairing: {
    /** Create an invite for a space (generates one-time topic + secret) */
    createInvite(spaceId: string): Promise<SpaceInvite>;
    /** Wait for a peer to accept the invite (inviter side) */
    waitForPeer(invite: SpaceInvite, callbacks?: PairCallbacks): Promise<void>;
    /** Accept a pairing invite (acceptor side) */
    acceptInvite(invite: SpaceInvite, callbacks?: PairCallbacks): Promise<void>;
    /** Cancel an active pairing session */
    cancel(): Promise<void>;
  };

  // ---------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------

  pages: {
    /** List pages — filter by space, optionally by parent */
    list(spaceId: string, parentId?: string | null, options?: { includeTasks?: boolean }): Promise<PageListItem[]>;
    /** Get a single page with content */
    get(id: string): Promise<PageFull>;
    /** Create a new page */
    create(data: PageCreateInput): Promise<PageFull>;
    /** Update a page */
    update(data: PageUpdateInput): Promise<PageFull>;
    /** Delete a page */
    delete(id: string): Promise<void>;
    /** List soft-deleted (archived) pages across all spaces — roots of archived subtrees */
    listArchived(): Promise<ArchivedPageItem[]>;
    /** Restore a soft-deleted page (and its archived subtree) */
    restore(id: string): Promise<void>;
    /** Move a page to a new parent */
    move(data: PageMoveInput): Promise<void>;
    /** Reorder a page within its parent */
    reorder(id: string, order: number): Promise<void>;
    /** Search pages by title */
    search(query: string): Promise<PageSearchResult[]>;
    /** Get pages in a calendar date range */
    calendar(start: number, end: number): Promise<PageCalendarItem[]>;
    /** Get version history snapshots */
    snapshots(pageId: string): Promise<PageSnapshot[]>;
    /** Subscribe to page deletion events (fired for both local and remote deletions) */
    onDeleted(cb: (pageId: string) => void): () => void;
  };

  // ---------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------

  assets: {
    /** Store a file, returns the content hash */
    store(file: File): Promise<Asset>;
    /** Get a URL for an asset (may be blob:, file://, or http://) */
    getUrl(hash: string): Promise<string>;
    /** Delete an asset */
    delete(hash: string): Promise<void>;
  };

  // ---------------------------------------------------------------------------
  // Sync (P2P + CRDT)
  // ---------------------------------------------------------------------------

  sync: {
    /** Join a document room for live editing (within a space topic) */
    joinRoom(
      roomId: string,
      peerId: string,
      user?: RoomUser,
      callbacks?: Partial<SyncEvents>,
      spaceId?: string,
    ): Promise<void>;
    /** Leave a document room */
    leaveRoom(roomId: string): Promise<void>;
    /** Send operations to peers in the room */
    sendOperations(roomId: string, operations: Operation[]): void;
    /** Send a sync request */
    sendSyncRequest(
      roomId: string,
      versionVector: Record<string, number>,
    ): void;
    /** Send a sync response to a specific peer */
    sendSyncResponse(
      roomId: string,
      operations: Operation[],
      versionVector: Record<string, number>,
      targetPeerId?: string,
    ): void;
    /** Send awareness update */
    sendAwareness(roomId: string, state: CursorPresence): void;
    /** Subscribe to page lifecycle events */
    onPageEvents(callbacks: Partial<PageEvents>): () => void;
    /** Get current connection state */
    getConnectionState(): ConnectionState;
    /** Subscribe to connection state changes */
    onConnectionChange(cb: (state: ConnectionState) => void): () => void;
    /** Get currently connected peers by public key */
    getConnectedPeers(): string[];
    /** Subscribe to connected peer list changes */
    onConnectedPeersChange(cb: (peers: string[]) => void): () => void;
    /**
     * Subscribe to protocol/wire-version mismatches detected during a peer's
     * `hello` handshake — used to notify the user (e.g. "a connected device is
     * on an incompatible version"). Fires once per hello on any mismatch.
     */
    onPeerVersionMismatch(cb: (info: PeerVersionInfo) => void): () => void;
  };

  // ---------------------------------------------------------------------------
  // Ops (CRDT operation persistence)
  // ---------------------------------------------------------------------------

  ops: {
    /** Persist locally-generated operations */
    persist(pageId: string, ops: Operation[]): Promise<void>;
    /** Load all persisted operations for a page (on mount) */
    load(pageId: string): Promise<Operation[]>;
    /** Convert blocks to CRDT ops and persist them (used by import) */
    writeBlocks(pageId: string, blocks: Block[]): Promise<void>;
  };

  snapshots: {
    /**
     * Save a snapshot of the current block state to the filesystem.
     * Called after local edits and after applying remote ops, so that
     * subsequent page opens can skip the full op-log rebuild.
     *
     * `vv` is the clock-based version vector (`{ [clockPeerId]: maxClockCounter }`)
     * of the exact op set these `blocks` reflect — it MUST be captured atomically
     * with `blocks` from the same source (the doc), never re-derived from storage
     * at a later time. On open, the snapshot is only trusted when this vv exactly
     * matches the op log's current frontier; otherwise the log is replayed. A raw
     * op count cannot be used here: the count is read at a different instant than
     * the blocks are captured, so a remote op persisted (but not yet folded into
     * the blocks) can make a stale snapshot's count match — silently seeding the
     * doc with state that lags its own op log.
     */
    save(
      pageId: string,
      blocks: Block[],
      vv: Record<string, number>,
    ): Promise<void>;
  };

  // ---------------------------------------------------------------------------
  // Raw database access (developer tooling only)
  // ---------------------------------------------------------------------------

  /**
   * Direct SQL access for the DevToolbar. Not for app logic — application data
   * goes through the typed namespaces above. Exposed here (rather than as an
   * `Engine` method) because on web the engine and its database live in the
   * SharedWorker, so tooling must reach them over the platform RPC seam.
   */
  db: {
    /** Run a SELECT/PRAGMA/etc. and return rows. */
    execute<T extends DbRow = DbRow>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]>;
    /** Run an INSERT/UPDATE/DELETE statement. */
    run(sql: string, params?: unknown[]): Promise<DbRunResult>;
    /** Run a raw statement (DDL, pragma, etc.). */
    exec(sql: string): Promise<void>;
    /** Number of pending forward-only migrations (0 = schema up to date). */
    getPendingMigrations(): Promise<number>;
    /** Apply all pending migrations. */
    applyMigrations(): Promise<void>;
  };

}
