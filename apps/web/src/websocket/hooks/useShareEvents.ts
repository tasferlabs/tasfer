// /**
//  * useShareEvents Hook
//  *
//  * Subscribe to share lifecycle events (create, update, remove).
//  * Used by components that need to react to real-time share changes.
//  */
//
// import { useEffect, useRef } from "react";
// import { useWebSocket } from "@/app/contexts/WebSocketContext";
// import { useQueryClient } from "@tanstack/react-query";
// import type {
//   ShareEventCallbacks,
//   ShareCreatedEvent,
//   ShareUpdatedEvent,
//   ShareRemovedEvent,
// } from "../types";
//
// // =============================================================================
// // Types
// // =============================================================================
//
// export interface ShareEventHandlers {
//   /** Called when a page is shared with a user */
//   onShareCreated?: (event: ShareCreatedEvent) => void;
//   /** Called when a share's permission is updated */
//   onShareUpdated?: (event: ShareUpdatedEvent) => void;
//   /** Called when a share is removed */
//   onShareRemoved?: (event: ShareRemovedEvent) => void;
// }
//
// // =============================================================================
// // Hook
// // =============================================================================
//
// export function useShareEvents(handlers: ShareEventHandlers): void {
//   const { onShareEvents, connectionState } = useWebSocket();
//
//   // Keep handlers in ref to avoid re-subscribing on every render
//   const handlersRef = useRef(handlers);
//   handlersRef.current = handlers;
//
//   useEffect(() => {
//     // Only subscribe when connected
//     if (connectionState !== "connected") {
//       return;
//     }
//
//     const callbacks: ShareEventCallbacks = {
//       onShareCreated: (event) => {
//         handlersRef.current.onShareCreated?.(event);
//       },
//       onShareUpdated: (event) => {
//         handlersRef.current.onShareUpdated?.(event);
//       },
//       onShareRemoved: (event) => {
//         handlersRef.current.onShareRemoved?.(event);
//       },
//     };
//
//     const unsubscribe = onShareEvents(callbacks);
//
//     return () => {
//       unsubscribe();
//     };
//   }, [onShareEvents, connectionState]);
// }
//
// // =============================================================================
// // Helper: useShareEventsWithQueryClient
// // =============================================================================
//
// /**
//  * Convenience hook that automatically invalidates React Query cache on share events.
//  * Invalidates ["shared-with-me"], ["shared-by-me"], and ["page-shares"] query keys.
//  */
// export function useShareEventsWithQueryClient(): void {
//   const queryClient = useQueryClient();
//
//   useShareEvents({
//     onShareCreated: (event) => {
//       queryClient.invalidateQueries({ queryKey: ["shared-with-me"] });
//       queryClient.invalidateQueries({ queryKey: ["shared-by-me"] });
//       queryClient.invalidateQueries({ queryKey: ["page-shares", event.pageId] });
//     },
//
//     onShareUpdated: (event) => {
//       queryClient.invalidateQueries({ queryKey: ["shared-with-me"] });
//       queryClient.invalidateQueries({ queryKey: ["shared-by-me"] });
//       queryClient.invalidateQueries({ queryKey: ["page-shares", event.pageId] });
//     },
//
//     onShareRemoved: (event) => {
//       queryClient.invalidateQueries({ queryKey: ["shared-with-me"] });
//       queryClient.invalidateQueries({ queryKey: ["shared-by-me"] });
//       queryClient.invalidateQueries({ queryKey: ["page-shares", event.pageId] });
//     },
//   });
// }
