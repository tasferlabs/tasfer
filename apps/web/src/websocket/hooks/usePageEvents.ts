/**
 * usePageEvents Hook
 *
 * Subscribe to page lifecycle events (create, delete, move, reorder, title update).
 * Used by components that need to react to real-time page changes.
 */

import { useEffect, useRef } from "react";
import { useWebSocket } from "@/app/contexts/WebSocketContext";
import { useQueryClient } from "@tanstack/react-query";
import type { PageEventCallbacks, PageInfo } from "../types";
import type { IPage } from "@/app/api/pages.api";

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
 * Uses broad invalidation since query keys now include spaceId.
 */
export function usePageEventsWithQueryClient(): void {
  const queryClient = useQueryClient();

  usePageEvents({
    onPageCreated: () => {
      // Invalidate all page lists (broad match covers all spaceId/parentId combos)
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },

    onPageDeleted: (pageId) => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
      queryClient.invalidateQueries({ queryKey: ["shared-with-me"] });
      queryClient.invalidateQueries({ queryKey: ["shared-by-me"] });
    },

    onPageMoved: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["shared-with-me"] });
    },

    onPageReordered: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },

    onPageTitleUpdated: (pageId, title) => {
      // Optimistically update the page cache
      queryClient.setQueryData(["page", pageId], (old: any) => {
        if (!old) return old;
        return { ...old, title };
      });

      // Update parents array in all cached pages that have this page as a parent
      const cache = queryClient.getQueryCache();
      const pageQueries = cache.findAll({ queryKey: ["page"] });
      for (const query of pageQueries) {
        const data = query.state.data as IPage | undefined;
        if (data?.parents?.some((p) => p.id === pageId)) {
          queryClient.setQueryData(query.queryKey, (old: IPage | undefined) => {
            if (!old?.parents) return old;
            return {
              ...old,
              parents: old.parents.map((p) =>
                p.id === pageId ? { ...p, title } : p
              ),
            };
          });
        }
      }

      // Also invalidate page lists in case title affects sorting
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["shared-with-me"] });
    },
  });
}
