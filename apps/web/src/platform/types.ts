/**
 * Platform Interface Types
 *
 * Defines the contract between the UI/editor layer and the backend.
 * Each platform (web, electron, capacitor) implements this interface
 * with its own storage and networking strategy.
 */

import type { Block } from "@/deserializer/loadPage";
import type { HLC, Operation } from "@/editor/sync/types";
import type { AwarenessState } from "@/editor/sync/awareness";

// =============================================================================
// Data Types
// =============================================================================

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
  autoTitle: boolean;
  parentId: string | null;
  order: number;
  hasChildren: boolean;
  task?: boolean;
  color?: string | null;
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
  recurrenceId?: string | null;
}

/** Full page with content */
export interface PageFull extends PageListItem {
  snapshot: Block[] | null;
  snapshotClock: HLC | null;
  createdAt: string;
  updatedAt: string;
  parents?: { id: string; title: string; color?: string | null }[];
}

/** Data needed to create a page */
export interface PageCreateInput {
  title: string;
  parentId: string | null;
  scheduledAt?: string;
  duration?: number;
  allDay?: boolean;
  task?: boolean;
}

/** Data for updating a page */
export interface PageUpdateInput {
  id: string;
  title?: string;
  autoTitle?: boolean;
  color?: string | null;
  snapshot?: Block[];
  snapshotClock?: HLC | null;
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
  parentId: string | null;
  path: { id: string; title: string }[] | null;
  color?: string | null;
}

/** Calendar page result */
export interface PageCalendarItem {
  id: string;
  title: string;
  autoTitle: boolean;
  parentId: string | null;
  order: number;
  color: string | null;
  scheduledAt: string;
  duration: number | null;
  allDay: boolean | null;
  recurrenceId: string | null;
  task: boolean;
  path: { id: string; title: string }[] | null;
  createdAt: string;
}

/** Page snapshot for version history */
export interface PageSnapshot {
  id: string;
  pageId: string;
  blocks: Block[];
  size: number;
  clock: HLC | null;
  createdAt: string;
  updatedAt: string;
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

/** Workspace info for the sidebar */
export interface Workspace {
  id: string;
  name: string;
  description: string;
}

/** Peer user info for awareness */
export interface RoomUser {
  name?: string;
  color?: string;
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
    snapshotClock: { counter: number; peerId: string } | null | undefined,
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
    awarenessStates?: Record<string, AwarenessState>,
  ) => void;
  /** Awareness update from a peer */
  onAwareness: (peerId: string, state: AwarenessState) => void;
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

// =============================================================================
// Platform Interface
// =============================================================================

/**
 * The platform interface — implemented once per target.
 *
 * - Web: IndexedDB + WebRTC
 * - Electron: IPC → SQLite + hyperswarm
 * - Capacitor: plugins → SQLite + WebRTC
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
  // Pages
  // ---------------------------------------------------------------------------

  pages: {
    /** List pages — optionally filter by parent */
    list(parentId?: string | null, options?: { includeTasks?: boolean }): Promise<PageListItem[]>;
    /** Get a single page with content */
    get(id: string): Promise<PageFull>;
    /** Create a new page */
    create(data: PageCreateInput): Promise<PageFull>;
    /** Update a page */
    update(data: PageUpdateInput): Promise<PageFull>;
    /** Delete a page */
    delete(id: string): Promise<void>;
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
    /** Join a document room for live editing */
    joinRoom(
      roomId: string,
      peerId: string,
      user?: RoomUser,
      callbacks?: Partial<SyncEvents>,
    ): Promise<void>;
    /** Leave a document room */
    leaveRoom(roomId: string): Promise<void>;
    /** Send operations to peers in the room */
    sendOperations(roomId: string, operations: Operation[]): void;
    /** Send a sync request */
    sendSyncRequest(
      roomId: string,
      versionVector: Record<string, number>,
      snapshotClock?: { counter: number; peerId: string } | null,
    ): void;
    /** Send a sync response to a specific peer */
    sendSyncResponse(
      roomId: string,
      operations: Operation[],
      versionVector: Record<string, number>,
      targetPeerId?: string,
    ): void;
    /** Send awareness update */
    sendAwareness(roomId: string, state: AwarenessState): void;
    /** Subscribe to page lifecycle events */
    onPageEvents(callbacks: Partial<PageEvents>): () => void;
    /** Get current connection state */
    getConnectionState(): ConnectionState;
    /** Subscribe to connection state changes */
    onConnectionChange(cb: (state: ConnectionState) => void): () => void;
  };

  // ---------------------------------------------------------------------------
  // Storage (key-value for preferences, settings, etc.)
  // ---------------------------------------------------------------------------

  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
}
