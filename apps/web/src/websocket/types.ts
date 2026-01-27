/**
 * WebSocket Types
 *
 * Shared TypeScript types for all WebSocket messages.
 * Used by the global WebSocket connection and hooks.
 */

import type { Operation as CRDTOperation } from "@/editor/sync/types";
import type { AwarenessState, AwarenessUser } from "@/editor/sync/awareness";

// Re-export Operation type for consumers
export type Operation = CRDTOperation;

// =============================================================================
// Connection States
// =============================================================================

export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface ConnectionInfo {
  state: ConnectionState;
  error?: string;
  reconnectAttempt?: number;
}

// =============================================================================
// Room Messages (Existing - CRDT Sync)
// =============================================================================

/** User awareness info for room messages */
export interface RoomUser extends AwarenessUser {}

/** Hello message sent on connect to register client version */
export interface HelloMessage {
  type: "hello";
  clientVersion: number;
}

/** Join a document room for CRDT sync */
export interface JoinMessage {
  type: "join";
  roomId: string;
  peerId: string;
  user?: RoomUser;
  clientVersion?: number;
}

/** Leave a document room */
export interface LeaveMessage {
  type: "leave";
  roomId: string;
  peerId: string;
}

/** Request sync from other peers */
export interface SyncRequestMessage {
  type: "sync-request";
  versionVector: Record<string, number>;
  snapshotClock?: { counter: number; peerId: string } | null;
  requesterId?: string;
}

/** Response to sync request with operations */
export interface SyncResponseMessage {
  type: "sync-response";
  operations: Operation[];
  versionVector: Record<string, number>;
  targetPeerId?: string;
}

/** Broadcast operations to room */
export interface OperationsMessage {
  type: "operations";
  operations: Operation[];
}

/** Notification when a peer joins the room */
export interface PeerJoinedMessage {
  type: "peer-joined";
  peerId: string;
  user?: RoomUser;
}

/** Notification when a peer leaves the room */
export interface PeerLeftMessage {
  type: "peer-left";
  peerId: string;
}

/** List of peers in a room (sent on join) */
export interface RoomPeersMessage {
  type: "room-peers";
  peers: string[];
  awarenessStates?: Record<string, AwarenessState>;
}

/** Awareness state update from a peer */
export interface AwarenessMessage {
  type: "awareness";
  peerId: string;
  state: AwarenessState;
}

/** Error message from server */
export interface ErrorMessage {
  type: "error";
  message: string;
}

/** Server notifies client of available update */
export interface UpdateAvailableMessage {
  type: "update-available";
  serverVersion: number;
  clientVersion: number;
  forceUpdate: boolean;
}

// =============================================================================
// Page Events (New - Page Lifecycle)
// =============================================================================

/** Page info for page events */
export interface PageInfo {
  id: string;
  title: string | null;
  parentId: string | null;
  order: number;
}

/** A new page was created */
export interface PageCreatedEvent {
  type: "page-created";
  page: PageInfo;
}

/** A page was deleted */
export interface PageDeletedEvent {
  type: "page-deleted";
  pageId: string;
}

/** A page was moved to a new parent */
export interface PageMovedEvent {
  type: "page-moved";
  pageId: string;
  oldParentId: string | null;
  newParentId: string | null;
}

/** A page was reordered within its parent */
export interface PageReorderedEvent {
  type: "page-reordered";
  pageId: string;
  parentId: string | null;
  order: number;
}

/** A page's title was updated */
export interface PageTitleUpdatedEvent {
  type: "page-title-updated";
  pageId: string;
  title: string;
}

// =============================================================================
// Union Types
// =============================================================================

/** Room-related messages (CRDT sync) */
export type RoomMessage =
  | JoinMessage
  | LeaveMessage
  | SyncRequestMessage
  | SyncResponseMessage
  | OperationsMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | RoomPeersMessage
  | AwarenessMessage
  | ErrorMessage
  | UpdateAvailableMessage;

/** Page lifecycle events */
export type PageEvent =
  | PageCreatedEvent
  | PageDeletedEvent
  | PageMovedEvent
  | PageReorderedEvent
  | PageTitleUpdatedEvent;

/** All server message types */
export type ServerMessage = RoomMessage | PageEvent;

/** Client-to-server messages */
export type ClientMessage =
  | HelloMessage
  | JoinMessage
  | LeaveMessage
  | SyncRequestMessage
  | SyncResponseMessage
  | OperationsMessage
  | AwarenessMessage;

// =============================================================================
// Type Guards
// =============================================================================

export function isRoomMessage(msg: ServerMessage): msg is RoomMessage {
  return [
    "join",
    "leave",
    "sync-request",
    "sync-response",
    "operations",
    "peer-joined",
    "peer-left",
    "room-peers",
    "awareness",
    "error",
    "update-available",
  ].includes(msg.type);
}

export function isPageEvent(msg: ServerMessage): msg is PageEvent {
  return [
    "page-created",
    "page-deleted",
    "page-moved",
    "page-reordered",
    "page-title-updated",
  ].includes(msg.type);
}

// =============================================================================
// Room Callbacks
// =============================================================================

/** Callbacks for room subscription */
export interface RoomCallbacks {
  /** Called when receiving operations from other peers */
  onOperations?: (operations: Operation[]) => void;
  /** Called when a sync request is received (respond with operations) */
  onSyncRequest?: (
    versionVector: Record<string, number>,
    snapshotClock: { counter: number; peerId: string } | null | undefined,
    requesterId?: string
  ) => void;
  /** Called when receiving sync response */
  onSyncResponse?: (
    operations: Operation[],
    versionVector: Record<string, number>
  ) => void;
  /** Called when peer joins the room */
  onPeerJoined?: (peerId: string, user?: RoomUser) => void;
  /** Called when peer leaves the room */
  onPeerLeft?: (peerId: string) => void;
  /** Called with list of existing peers on room join */
  onRoomPeers?: (
    peers: string[],
    awarenessStates?: Record<string, AwarenessState>
  ) => void;
  /** Called when receiving awareness update from a peer */
  onAwareness?: (peerId: string, state: AwarenessState) => void;
  /** Called on room-specific errors */
  onError?: (message: string) => void;
}

/** Callbacks for page lifecycle events */
export interface PageEventCallbacks {
  onPageCreated?: (page: PageInfo) => void;
  onPageDeleted?: (pageId: string) => void;
  onPageMoved?: (
    pageId: string,
    oldParentId: string | null,
    newParentId: string | null
  ) => void;
  onPageReordered?: (
    pageId: string,
    parentId: string | null,
    order: number
  ) => void;
  onPageTitleUpdated?: (pageId: string, title: string) => void;
}
