/**
 * Platform Interface Types
 *
 * Defines the contract between the UI/editor layer and the backend.
 * Each platform (web, electron, capacitor) implements this interface
 * with its own storage and networking strategy.
 */

import type { Block, HLC, Operation } from "@tasfer/editor";
import type {
  VersionChange,
  VersionKind,
} from "@tasfer/editor/sync/version-history";
import type { CursorPresence } from "@tasfer/provider-core/cursors";
import type { DbRow, DbRunResult } from "./driver";

// =============================================================================
// Data Types
// =============================================================================

/** Device type identifier */
export type DeviceType = "laptop" | "desktop" | "phone" | "tablet" | "";

/** User identity — local device owner */
export interface Identity {
  /** Public key (hex or base64 encoded) */
  publicKey: string;
  /** Human-readable display name */
  name: string;
  /** Avatar URL or data URI */
  avatar: string | null;
  /**
   * Root ("person") public key. `publicKey` names this DEVICE — every install
   * generates its own — while this names the human who owns it and signs the
   * certificate for each device they link. Null only on a replica that has not
   * finished bootstrapping its identity.
   */
  rootPublicKey: string | null;
  /**
   * A free-text note about THIS device ("work laptop", "the one in the
   * studio"). Unlike `name` and `avatar`, it never leaves the machine it was
   * typed on: it is not published as `member_set` and not carried in the
   * own-state profile message, so each linked device keeps its own.
   */
  deviceDescription: string;
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

/** A soft-deleted page surfaced in the Archive (root of an archived subtree) */
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

/**
 * Identity of a page a link can still reach but the app no longer shows —
 * archived itself, or live inside an archived space. Backs the read-only view
 * those links open.
 */
export interface ArchivedPageRef {
  id: string;
  title: string;
  /** Markdown projection of the title line (see {@link PageListItem.titleMd}). */
  titleMd?: string;
  spaceId?: string | null;
  color?: string | null;
  /** ISO timestamp of the archive that hid this page — its own, or its space's. */
  archivedAt: string;
  /**
   * Root of the archived subtree to restore. Restoring a lone descendant would
   * re-parent it to the top level and lose its place, so the whole subtree the
   * user deleted comes back together. Null when the page itself is live and
   * only its space is archived — there is nothing to restore at the page level.
   */
  restoreRootId: string | null;
  /**
   * Set when the page's space is archived too — it has to be restored first, or
   * the page comes back into a space nothing can see.
   */
  archivedSpaceId?: string | null;
}

/** Full page with content */
export interface PageFull extends PageListItem {
  blocks: Block[] | null;
  createdAt: string;
  updatedAt: string;
  parents?: PagePathSegment[];
  /**
   * ISO timestamp when the page's space was archived, if it was. The page
   * itself is live — an archived space is hidden as a whole rather than
   * deleted page by page — so it still loads, but editing it would write into
   * a space nothing can see. Null for pages in a live space.
   */
  spaceArchivedAt?: string | null;
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

/** One node of a page subtree, parent-before-child, for a cross-space move. */
export interface PageSubtreeItem {
  id: string;
  parentId: string | null;
  order: number;
}

/** Recreate a single source page as a fresh page in another space. */
export interface RecreatePageInput {
  /** Existing page whose content and metadata are copied. */
  sourceId: string;
  /** Space the new page is created in. */
  spaceId: string;
  /** Parent for the new page — already remapped to a target-space id, or null. */
  parentId: string | null;
  /** Sort order among the new parent's children; omit to append to the end. */
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

/**
 * One offered revert point, derived from the page's operation log by
 * `buildVersionHistory`. Metadata only — the blocks at this point are built on
 * demand by `pages.versionBlocks`, because materializing every entry costs a
 * full reducer replay each and the user opens at most one.
 */
export interface PageVersion {
  id: string;
  pageId: string;
  clock: HLC;
  /** Total operations in the log at this version point. */
  opCount: number;
  /** Operations belonging to this entry alone. */
  opSpan: number;
  /** Wall-clock timestamp (ms since epoch). 0 if unknown. */
  createdAt: number;
  /** Wall-clock timestamp of the entry's first operation. */
  startedAt: number;
  /** CRDT peers that contributed, most-active first. */
  peerIds: string[];
  /** Live block count once this entry landed. */
  blockCount: number;
  /** What changed, for labelling. */
  change: VersionChange;
  kind: VersionKind;
  /** Text this entry introduced that best names it, when it created any. */
  subject?: string;
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
  /**
   * Root ("person") public key behind `deviceId`, shared by every device this
   * person has linked, so a presence UI can show them once with a card per
   * device. Absent until the local identity has a root key.
   */
  personId?: string;
}

// =============================================================================
// Spaces
// =============================================================================

/** A shared space — a CRDT-replicated collection of pages between peers */
export interface Space {
  id: string;
  name: string;
  createdAt: string;
  /**
   * A personal space admits only the owner's own devices and mints no invites,
   * so nothing written in it can later become someone else's to read. Set at
   * creation and never cleared — see the `spaces.personal` column for why the
   * one-way direction is the point.
   */
  personal?: boolean;
}

/** An archived space surfaced in the Archive */
export interface ArchivedSpaceItem {
  id: string;
  name: string;
  /** ISO timestamp when the space was archived */
  archivedAt: string;
}

/** A member of a space */
export interface SpaceMember {
  spaceId: string;
  /** Device public key — one row per device, not per person. */
  publicKey: string;
  name: string;
  avatar: string | null;
  addedAt: string;
  /**
   * Root ("person") key that certified this device, when one is known. Members
   * sharing a root key are the same human on different devices and should be
   * presented as one. Null for a device whose certificate this replica has not
   * seen — including every member that predates device identity.
   */
  rootKey: string | null;
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
 * Publish a device certificate: "this device key belongs to this person".
 *
 * Carries the proof itself rather than a claim, so any replica verifies it
 * locally (see `verifyDeviceCert`). That is what keeps personal-space
 * membership a pure function of the log — every replica holding these ops
 * computes the same answer, instead of each one needing to be told separately
 * which keys are the owner's.
 *
 * Not LWW and not removable. A device key binds to one root permanently; the
 * first valid certificate a replica sees wins, so a second root cannot later
 * claim a device that peers already resolved. There is no revocation op —
 * see ./device-cert for why one would be theatre in a P2P network.
 */
export interface DeviceAdd extends SpaceBaseOp {
  op: "device_add";
  /** Root ("person") public key that signed the certificate. */
  rootKey: string;
  /** Device public key being vouched for. */
  deviceKey: string;
  /** Ed25519 signature over the canonical certificate statement. */
  cert: string;
  /** Unix ms of issuance; part of the signed statement. */
  issuedAt: number;
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
  SpaceSet | MemberAdd | MemberSet | DeviceAdd | PageAdd | PageRemove | PageSet;

// =============================================================================
// Pairing
// =============================================================================

/**
 * Sentinel `spaceId` marking a code as a device link, which joins no single
 * space. Both kinds of code share one wire format, so this is what lets any
 * paste or scan surface tell them apart offline, before pairing is attempted.
 *
 * Not a valid nanoid(10), so it can never collide with a real space, and the
 * `invites.space_id` UNIQUE constraint keeps at most one device link pending.
 */
export const DEVICE_LINK_SCOPE = "@device";

/** An invite for peer pairing + space joining */
export interface SpaceInvite {
  /**
   * Shared secret (random hex) — the invite capability. The signaling topic,
   * pairing proof, and encryption keys all derive from it (HKDF, one label
   * each); the secret itself never goes on the wire.
   */
  secret: string;
  /** Space to join after pairing */
  spaceId: string;
  /**
   * Expiry (unix ms). Carried inside the invite code so the acceptor can
   * reject a stale invite offline; the inviter stops listening and drops the
   * persisted invite at this time.
   */
  expiresAt: number;
}

/** Pairing lifecycle callbacks */
export interface PairCallbacks {
  onConnected?: () => void;
  onPeerIdentity?: (peer: { publicKey: string; name: string }) => void;
  onComplete?: (peer: Peer, spaceName?: string) => void | Promise<void>;
  onError?: (error: string) => void;
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
  onPageCreated: (page: {
    id: string;
    title: string | null;
    parentId: string | null;
    order: number;
  }) => void;
  onPageDeleted: (pageId: string) => void;
  onPageMoved: (
    pageId: string,
    oldParentId: string | null,
    newParentId: string | null,
  ) => void;
  onPageReordered: (
    pageId: string,
    parentId: string | null,
    order: number,
  ) => void;
  onPageTitleUpdated: (pageId: string, title: string) => void;
}

/** Connection state */
export type ConnectionState =
  "connecting" | "connected" | "disconnected" | "error";

/**
 * Versions a remote peer advertised in its `hello`, with our local values for
 * comparison. Surfaced via `sync.onPeerVersionMismatch` whenever either number
 * differs so the host can notify the user. Replication requires an exact match
 * for both numbers; `wireCompatible` separately describes only the byte codec.
 */
export interface PeerVersionInfo {
  publicKey: string;
  remoteProtocolVersion: number;
  remoteWireVersion: number;
  localProtocolVersion: number;
  localWireVersion: number;
  /** True when both peers implement the same operation/merge semantics. */
  protocolCompatible: boolean;
  /** True when the byte-level wire encoding matches (ops are decodable). */
  wireCompatible: boolean;
  /** True only when replication is allowed in either direction. */
  syncCompatible: boolean;
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
    /**
     * Update display name, avatar, or this device's description. The first two
     * are replicated to the person's other devices and their co-members; the
     * description stays local (see `Identity.deviceDescription`).
     */
    update(data: {
      name?: string;
      avatar?: string | null;
      deviceDescription?: string;
    }): Promise<Identity>;
    /**
     * Fires when the profile changes underneath the caller — a device link
     * handing this device the person it belongs to, or a rename made on one of
     * their other devices.
     */
    onChange(cb: () => void): () => void;
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
    /** List archived spaces this device is a member of (for the Archive) */
    listArchived(): Promise<ArchivedSpaceItem[]>;
    /** Get a space with its members */
    get(id: string): Promise<Space & { members: SpaceMember[] }>;
    /**
     * Create a new space (adds self as owner, plus every other device linked
     * to this identity). `personal: true` restricts it to those devices
     * permanently — it mints no invites and cannot be un-personalised.
     */
    create(name: string, options?: { personal?: boolean }): Promise<Space>;
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
  // Person-private preferences
  // ---------------------------------------------------------------------------

  /**
   * Decisions that belong to the person rather than to a space or a device: how
   * the sidebar is arranged, which walkthroughs have been read. Replicated to
   * this person's other devices only, never to a co-member, and merged
   * last-decision-wins per key (see `OwnPref` in ./sync).
   *
   * Values must be JSON-serializable; each key's shape is the caller's business.
   * Genuinely per-device state (theme, last route, which banner this browser
   * dismissed) does not belong here — it stays in the browser.
   */
  prefs: {
    /** Every preference this device holds, keyed. Missing keys are unset. */
    getAll(): Promise<Record<string, unknown>>;
    /** Record a decision made here and announce it to the person's devices. */
    set(key: string, value: unknown): Promise<void>;
    /**
     * Adopt a value this device held outside the register — a preference that
     * used to live in browser storage — only if the key is still unset.
     * Returns whether it took.
     *
     * Deliberately not `set`: the value is an old decision with no recorded
     * time, so it is stamped to lose to every dated one. A device migrating its
     * own leftover copy must not thereby outvote the arrangement the person has
     * since made elsewhere.
     */
    seed(key: string, value: unknown): Promise<boolean>;
    /**
     * Fires with the changed keys when a preference moves underneath the
     * caller — a decision made on another of the person's devices, or in
     * another tab sharing this engine.
     */
    onChange(cb: (changed: Record<string, unknown>) => void): () => void;
  };

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  pairing: {
    /**
     * Create (and persist) the invite for a space, replacing any previous
     * one. The engine listens for acceptors until the invite expires or is
     * revoked — surviving dialog close and app restarts.
     */
    createInvite(spaceId: string, ttlMs: number): Promise<SpaceInvite>;
    /** The space's pending (unexpired) invite, if any */
    getInvite(spaceId: string): Promise<SpaceInvite | null>;
    /** Revoke the space's pending invite and stop listening for it */
    revokeInvite(spaceId: string): Promise<void>;
    /**
     * Attach UI callbacks to the invite's listening session (inviter side),
     * starting it if not already open (e.g. ephemeral QR invites).
     */
    waitForPeer(invite: SpaceInvite, callbacks?: PairCallbacks): Promise<void>;
    /** Accept a pairing invite (acceptor side) */
    acceptInvite(invite: SpaceInvite, callbacks?: PairCallbacks): Promise<void>;
    /** Cancel the pairing session for an invite (acceptor side) */
    cancel(invite: SpaceInvite): Promise<void>;

    /**
     * Create (and persist) a device-link code — the invite that adds another
     * of YOUR OWN devices rather than another person.
     *
     * Distinct from `createInvite` in what it grants: the accepting device
     * receives the root identity and joins every space, personal ones
     * included. At most one is pending at a time, and it should be given a
     * short TTL, because for its lifetime the code is the account.
     */
    createDeviceLink(ttlMs: number): Promise<SpaceInvite>;
    /** The pending (unexpired) device-link code, if any */
    getDeviceLink(): Promise<SpaceInvite | null>;
    /** Revoke the pending device-link code and stop listening for it */
    revokeDeviceLink(): Promise<void>;
    /** Attach UI callbacks to the device-link session (existing-device side) */
    waitForDevice(
      invite: SpaceInvite,
      callbacks?: PairCallbacks,
    ): Promise<void>;
    /** Accept a device-link code on a new device */
    acceptDeviceLink(
      invite: SpaceInvite,
      callbacks?: PairCallbacks,
    ): Promise<void>;
  };

  // ---------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------

  pages: {
    /** List pages — filter by space, optionally by parent */
    list(
      spaceId: string,
      parentId?: string | null,
      options?: { includeTasks?: boolean },
    ): Promise<PageListItem[]>;
    /** Get a single page with content */
    get(id: string): Promise<PageFull>;
    /** Create a new page */
    create(data: PageCreateInput): Promise<PageFull>;
    /** Update a page */
    update(data: PageUpdateInput): Promise<PageFull>;
    /** Delete a page */
    delete(id: string): Promise<void>;
    /**
     * Resolve an archived page by id, for links that outlived the page.
     * Returns null when the id is unknown or the page is live.
     */
    getArchived(id: string): Promise<ArchivedPageRef | null>;
    /** List soft-deleted (archived) pages across all spaces — roots of archived subtrees */
    listArchived(): Promise<ArchivedPageItem[]>;
    /** Restore a soft-deleted page (and its archived subtree) */
    restore(id: string): Promise<void>;
    /** Move a page to a new parent (in-space reparent/reorder only) */
    move(data: PageMoveInput): Promise<void>;
    /**
     * Enumerate a page and all its descendants, parent-before-child, for a
     * cross-space move. Each item carries the id/parent/order needed to
     * recreate the tree in another space.
     */
    subtree(pageId: string): Promise<PageSubtreeItem[]>;
    /**
     * Recreate one source page as a brand-new page (new id) in the target
     * space, copying its content and metadata but overriding parent/order.
     * Returns the new id. Drives the app-layer cross-space move orchestrator,
     * which supplies the already-remapped parent.
     */
    recreateInSpace(input: RecreatePageInput): Promise<string>;
    /** Reorder a page within its parent */
    reorder(id: string, order: number): Promise<void>;
    /** Search pages by title */
    search(spaceId: string, query: string): Promise<PageSearchResult[]>;
    /** Get pages in a calendar date range */
    calendar(start: number, end: number): Promise<PageCalendarItem[]>;
    /**
     * Version-history entries derived from the op log, newest first. Metadata
     * only; see `versionBlocks` for the content at one entry.
     */
    versions(pageId: string): Promise<PageVersion[]>;
    /**
     * Build the page's content as of one version entry. Returns `[]` when the
     * id names no entry in the current log.
     */
    versionBlocks(pageId: string, versionId: string): Promise<Block[]>;
    /**
     * Rebuild the page's latest content straight from the op log, bypassing the
     * `archived_at IS NULL` filter that `get` applies. This is how an archived
     * or otherwise unloadable page is still previewable.
     */
    rebuild(pageId: string): Promise<Block[]>;
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
    query<T extends DbRow = DbRow>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]>;
    /** Run an INSERT/UPDATE/DELETE statement. */
    mutate(sql: string, params?: unknown[]): Promise<DbRunResult>;
    /** Run a raw statement (DDL, pragma, etc.). */
    exec(sql: string): Promise<void>;
    /** Number of pending forward-only migrations (0 = schema up to date). */
    getPendingMigrations(): Promise<number>;
    /** Apply all pending migrations. */
    applyMigrations(): Promise<void>;
  };
}
