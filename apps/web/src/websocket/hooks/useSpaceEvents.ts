/**
 * useSpaceEvents Hook
 *
 * Subscribe to space/group lifecycle events (create, update, delete, member changes).
 * Used by components that need to react to real-time space changes.
 */

import { useEffect, useRef } from "react";
import { useWebSocket } from "@/app/contexts/WebSocketContext";
import { useQueryClient } from "@tanstack/react-query";
import type { SpaceEventCallbacks } from "../types";

// =============================================================================
// Types
// =============================================================================

export interface SpaceEventHandlers {
  /** Called when a new space is created */
  onSpaceCreated?: SpaceEventCallbacks["onSpaceCreated"];
  /** Called when a space is updated */
  onSpaceUpdated?: SpaceEventCallbacks["onSpaceUpdated"];
  /** Called when a space is deleted */
  onSpaceDeleted?: SpaceEventCallbacks["onSpaceDeleted"];
  /** Called when a member is added to a space */
  onMemberAdded?: SpaceEventCallbacks["onMemberAdded"];
  /** Called when a member is removed from a space */
  onMemberRemoved?: SpaceEventCallbacks["onMemberRemoved"];
  /** Called when a member leaves a space */
  onMemberLeft?: SpaceEventCallbacks["onMemberLeft"];
}

// =============================================================================
// Hook
// =============================================================================

export function useSpaceEvents(handlers: SpaceEventHandlers): void {
  const { onSpaceEvents, connectionState } = useWebSocket();

  // Keep handlers in ref to avoid re-subscribing on every render
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    // Only subscribe when connected
    if (connectionState !== "connected") {
      return;
    }

    const callbacks: SpaceEventCallbacks = {
      onSpaceCreated: (space) => {
        handlersRef.current.onSpaceCreated?.(space);
      },
      onSpaceUpdated: (spaceId, name, description) => {
        handlersRef.current.onSpaceUpdated?.(spaceId, name, description);
      },
      onSpaceDeleted: (spaceId) => {
        handlersRef.current.onSpaceDeleted?.(spaceId);
      },
      onMemberAdded: (spaceId, member) => {
        handlersRef.current.onMemberAdded?.(spaceId, member);
      },
      onMemberRemoved: (spaceId, memberId, userId) => {
        handlersRef.current.onMemberRemoved?.(spaceId, memberId, userId);
      },
      onMemberLeft: (spaceId, userId) => {
        handlersRef.current.onMemberLeft?.(spaceId, userId);
      },
    };

    const unsubscribe = onSpaceEvents(callbacks);

    return () => {
      unsubscribe();
    };
  }, [onSpaceEvents, connectionState]);
}

// =============================================================================
// Helper: useSpaceEventsWithQueryClient
// =============================================================================

/**
 * Convenience hook that automatically invalidates React Query cache on space events.
 * Invalidates ["spaces"] and ["space-members"] query keys.
 */
export function useSpaceEventsWithQueryClient(): void {
  const queryClient = useQueryClient();

  useSpaceEvents({
    onSpaceCreated: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },

    onSpaceUpdated: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },

    onSpaceDeleted: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },

    onMemberAdded: (spaceId) => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
      queryClient.invalidateQueries({ queryKey: ["space-members", spaceId] });
    },

    onMemberRemoved: (spaceId) => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
      queryClient.invalidateQueries({ queryKey: ["space-members", spaceId] });
    },

    onMemberLeft: (spaceId) => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
      queryClient.invalidateQueries({ queryKey: ["space-members", spaceId] });
    },
  });
}
