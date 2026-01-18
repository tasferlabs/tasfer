/**
 * usePageEvents Hook
 *
 * Subscribe to page lifecycle events (create, delete, move, reorder, title update).
 * Used by components that need to react to real-time page changes.
 */

import { useEffect, useRef } from "react";
import { useWebSocket } from "@/app/contexts/WebSocketContext";
import type { PageEventCallbacks, PageInfo } from "../types";

// =============================================================================
// Types
// =============================================================================

export interface PageEventHandlers {
  /** Called when a new page is created */
  onPageCreated?: (page: PageInfo) => void;
  /** Called when a page is deleted */
  onPageDeleted?: (pageId: string) => void;
  /** Called when a page is moved to a new parent */
  onPageMoved?: (
    pageId: string,
    oldParentId: string | null,
    newParentId: string | null
  ) => void;
  /** Called when a page is reordered within its parent */
  onPageReordered?: (
    pageId: string,
    parentId: string | null,
    order: number
  ) => void;
  /** Called when a page's title is updated */
  onPageTitleUpdated?: (pageId: string, title: string) => void;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Subscribe to page lifecycle events.
 *
 * @param handlers - Event handlers for page lifecycle events
 *
 * @example
 * usePageEvents({
 *   onPageCreated: (page) => {
 *     queryClient.invalidateQueries(["pages", { parentId: page.parentId }]);
 *   },
 *   onPageDeleted: (pageId) => {
 *     queryClient.invalidateQueries(["pages"]);
 *     queryClient.invalidateQueries(["page", pageId]);
 *   },
 *   onPageMoved: (pageId, oldParentId, newParentId) => {
 *     queryClient.invalidateQueries(["pages", { parentId: oldParentId }]);
 *     queryClient.invalidateQueries(["pages", { parentId: newParentId }]);
 *   },
 *   onPageReordered: (pageId, parentId) => {
 *     queryClient.invalidateQueries(["pages", { parentId }]);
 *   },
 *   onPageTitleUpdated: (pageId, title) => {
 *     queryClient.setQueryData(["page", pageId], (old) => ({
 *       ...old,
 *       title,
 *     }));
 *   },
 * });
 */
export function usePageEvents(handlers: PageEventHandlers): void {
  const { onPageEvents, connectionState } = useWebSocket();

  // Keep handlers in ref to avoid re-subscribing on every render
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    // Only subscribe when connected
    if (connectionState !== "connected") {
      return;
    }

    const callbacks: PageEventCallbacks = {
      onPageCreated: (page) => {
        handlersRef.current.onPageCreated?.(page);
      },
      onPageDeleted: (pageId) => {
        handlersRef.current.onPageDeleted?.(pageId);
      },
      onPageMoved: (pageId, oldParentId, newParentId) => {
        handlersRef.current.onPageMoved?.(pageId, oldParentId, newParentId);
      },
      onPageReordered: (pageId, parentId, order) => {
        handlersRef.current.onPageReordered?.(pageId, parentId, order);
      },
      onPageTitleUpdated: (pageId, title) => {
        handlersRef.current.onPageTitleUpdated?.(pageId, title);
      },
    };

    const unsubscribe = onPageEvents(callbacks);

    return () => {
      unsubscribe();
    };
  }, [onPageEvents, connectionState]);
}

// =============================================================================
// Helper: usePageEventsWithQueryClient
// =============================================================================

/**
 * Convenience hook that automatically invalidates React Query cache on page events.
 * Use this in components that use React Query for page data.
 *
 * @example
 * import { useQueryClient } from "@tanstack/react-query";
 *
 * function Sidebar() {
 *   const queryClient = useQueryClient();
 *   usePageEventsWithQueryClient(queryClient);
 *   // ...
 * }
 */
export function usePageEventsWithQueryClient(
  queryClient: {
    invalidateQueries: (options: { queryKey: any[] }) => void;
    setQueryData: (key: any[], updater: (old: any) => any) => void;
  }
): void {
  usePageEvents({
    onPageCreated: (page) => {
      // Invalidate the parent's page list
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: page.parentId }],
      });
      // Also invalidate root if parentId is null
      if (page.parentId === null) {
        queryClient.invalidateQueries({
          queryKey: ["pages", { parentId: null }],
        });
      }
    },

    onPageDeleted: (pageId) => {
      // Invalidate all page lists (page could have been anywhere)
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      // Invalidate the specific page query
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
    },

    onPageMoved: (_pageId, oldParentId, newParentId) => {
      // Invalidate both old and new parent's page lists
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: oldParentId }],
      });
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: newParentId }],
      });
      // Handle root cases
      if (oldParentId === null) {
        queryClient.invalidateQueries({
          queryKey: ["pages", { parentId: null }],
        });
      }
      if (newParentId === null) {
        queryClient.invalidateQueries({
          queryKey: ["pages", { parentId: null }],
        });
      }
    },

    onPageReordered: (_pageId, parentId) => {
      // Invalidate the parent's page list
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId }],
      });
      // Handle root case
      if (parentId === null) {
        queryClient.invalidateQueries({
          queryKey: ["pages", { parentId: null }],
        });
      }
    },

    onPageTitleUpdated: (pageId, title) => {
      // Optimistically update the page cache
      queryClient.setQueryData(["page", pageId], (old: any) => {
        if (!old) return old;
        return { ...old, title };
      });
      // Also invalidate page lists in case title affects sorting
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });
}
