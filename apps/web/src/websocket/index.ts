/**
 * WebSocket Module
 *
 * Exports for the global WebSocket connection system.
 */

// Types
export type {
  ConnectionState,
  ConnectionInfo,
  RoomMessage,
  PageEvent,
  ServerMessage,
  ClientMessage,
  RoomCallbacks,
  PageEventCallbacks,
  RoomUser,
  PageInfo,
} from "./types";

// Type guards
export { isRoomMessage, isPageEvent } from "./types";

// Core
export {
  GlobalWebSocket,
  getGlobalWebSocket,
  resetGlobalWebSocket,
} from "./GlobalWebSocket";

// Hooks
export { useRoom } from "./hooks/useRoom";
export type { SyncState, RoomConfig, UseRoomReturn } from "./hooks/useRoom";

export {
  usePageEvents,
  usePageEventsWithQueryClient,
} from "./hooks/usePageEvents";
export type { PageEventHandlers } from "./hooks/usePageEvents";
