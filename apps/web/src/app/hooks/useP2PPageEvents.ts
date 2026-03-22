/**
 * useP2PPageEvents — Subscribe to page lifecycle events from P2P sync.
 *
 * Replaces the legacy usePageEvents hook (which went through WebSocket relay).
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getPlatform } from "@/platform";
import type { PageEvents, PageFull } from "@/platform/types";

export type PageEventHandlers = Partial<PageEvents>;

export function useP2PPageEvents(handlers: PageEventHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let platform: ReturnType<typeof getPlatform>;
    try {
      platform = getPlatform();
    } catch {
      return;
    }

    const unsub = platform.sync.onPageEvents({
      onPageCreated: (page) => handlersRef.current.onPageCreated?.(page),
      onPageDeleted: (pageId) => handlersRef.current.onPageDeleted?.(pageId),
      onPageMoved: (pageId, oldParent, newParent) =>
        handlersRef.current.onPageMoved?.(pageId, oldParent, newParent),
      onPageReordered: (pageId, parentId, order) =>
        handlersRef.current.onPageReordered?.(pageId, parentId, order),
      onPageTitleUpdated: (pageId, title) =>
        handlersRef.current.onPageTitleUpdated?.(pageId, title),
    });

    return unsub;
  }, []);
}

/**
 * Convenience hook that automatically invalidates React Query cache on page events.
 *
 * Subscribes to two event sources:
 *   1. Replicator pageEventListeners — per-room page lifecycle events
 *   2. Engine spaceChangeListeners — space-level CRDT ops (page_add, page_remove, etc.)
 *
 * Source (2) is the primary path for remote changes: when a peer sends
 * space ops via replication, the engine applies them to SQLite and fires
 * notifySpaceChange.
 */
export function useP2PPageEventsWithQueryClient(): void {
  const queryClient = useQueryClient();

  // Subscribe to space-level changes (remote CRDT ops applied by engine)
  useEffect(() => {
    let platform: ReturnType<typeof getPlatform>;
    try {
      platform = getPlatform();
    } catch {
      return;
    }

    const unsub = platform.spaces.onChange(() => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
    });

    return unsub;
  }, [queryClient]);

  // Subscribe to per-room page events (awareness-level, future use)
  useP2PPageEvents({
    onPageCreated: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },

    onPageDeleted: (pageId) => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
    },

    onPageMoved: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },

    onPageReordered: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },

    onPageTitleUpdated: (pageId, title) => {
      queryClient.setQueryData(["page", pageId], (old: any) => {
        if (!old) return old;
        return { ...old, title };
      });

      const cache = queryClient.getQueryCache();
      const pageQueries = cache.findAll({ queryKey: ["page"] });
      for (const query of pageQueries) {
        const data = query.state.data as PageFull | undefined;
        if (data?.parents?.some((p) => p.id === pageId)) {
          queryClient.setQueryData(query.queryKey, (old: PageFull | undefined) => {
            if (!old?.parents) return old;
            return {
              ...old,
              parents: old.parents.map((p) =>
                p.id === pageId ? { ...p, title } : p,
              ),
            };
          });
        }
      }

      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });
}
