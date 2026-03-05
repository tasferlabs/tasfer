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
// Space Events (Space/Group Lifecycle)
// =============================================================================

/** A new space was created */
export interface SpaceCreatedEvent {
  type: "space-created";
  space: { id: string; name: string; type: string; ownerId: string };
}

/** A space was updated */
export interface SpaceUpdatedEvent {
  type: "space-updated";
  spaceId: string;
  name: string;
  description?: string;
}

/** A space was deleted */
export interface SpaceDeletedEvent {
  type: "space-deleted";
  spaceId: string;
}

/** A member was added to a space */
export interface MemberAddedEvent {
  type: "member-added";
  spaceId: string;
  member: { id: string; userId: string; role: string; userName: string | null; userEmail: string };
}

/** A member was removed from a space */
export interface MemberRemovedEvent {
  type: "member-removed";
  spaceId: string;
  memberId: string;
  userId: string;
}

/** A member left a space */
export interface MemberLeftEvent {
  type: "member-left";
  spaceId: string;
  userId: string;
}

// // =============================================================================
// // Share Events (Share Lifecycle)
// // =============================================================================
//
// /** A page was shared with a user */
// export interface ShareCreatedEvent {
//   type: "share-created";
//   shareId: string;
//   pageId: string;
//   userId: string;
//   permission: "view" | "edit";
//   includeChildren: boolean;
//   pageTitle: string | null;
//   sharedByName: string | null;
// }
//
// /** A share's permission was updated */
// export interface ShareUpdatedEvent {
//   type: "share-updated";
//   shareId: string;
//   pageId: string;
//   userId: string;
//   permission: "view" | "edit";
//   includeChildren: boolean;
// }
//
// /** A share was removed */
// export interface ShareRemovedEvent {
//   type: "share-removed";
//   shareId: string;
//   pageId: string;
//   userId: string;
// }

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

/** Space/group lifecycle events */
export type SpaceEvent =
  | SpaceCreatedEvent
  | SpaceUpdatedEvent
  | SpaceDeletedEvent
  | MemberAddedEvent
  | MemberRemovedEvent
  | MemberLeftEvent;

// /** Share lifecycle events */
// export type ShareEvent =
//   | ShareCreatedEvent
//   | ShareUpdatedEvent
//   | ShareRemovedEvent;

/** All server message types */
export type ServerMessage = RoomMessage | PageEvent | SpaceEvent;

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

export function isSpaceEvent(msg: ServerMessage): msg is SpaceEvent {
  return [
    "space-created",
    "space-updated",
    "space-deleted",
    "member-added",
    "member-removed",
    "member-left",
  ].includes(msg.type);
}

// export function isShareEvent(msg: ServerMessage): msg is ShareEvent {
//   return [
//     "share-created",
//     "share-updated",
//     "share-removed",
//   ].includes(msg.type);
// }

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

/** Callbacks for space/group lifecycle events */
export interface SpaceEventCallbacks {
  onSpaceCreated?: (space: SpaceCreatedEvent["space"]) => void;
  onSpaceUpdated?: (spaceId: string, name: string, description?: string) => void;
  onSpaceDeleted?: (spaceId: string) => void;
  onMemberAdded?: (spaceId: string, member: MemberAddedEvent["member"]) => void;
  onMemberRemoved?: (spaceId: string, memberId: string, userId: string) => void;
  onMemberLeft?: (spaceId: string, userId: string) => void;
}

// /** Callbacks for share lifecycle events */
// export interface ShareEventCallbacks {
//   onShareCreated?: (event: ShareCreatedEvent) => void;
//   onShareUpdated?: (event: ShareUpdatedEvent) => void;
//   onShareRemoved?: (event: ShareRemovedEvent) => void;
// }
