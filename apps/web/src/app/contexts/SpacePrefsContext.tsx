import { useMemo, useSyncExternalStore } from "react";
import type { ISpace } from "../api/spaces.api";
import {
  OWN_PREF_KEYS,
  type OwnPrefsStore,
  useOwnPrefsStore,
} from "./OwnPrefsContext";

/**
 * Sidebar preferences for spaces: a custom display order and which spaces are
 * collapsed.
 *
 * How the person arranges their sidebar is theirs, not the machine's, so this is
 * stored in the database and replicated to their other devices — never to a
 * co-member of a space, who keeps their own arrangement (see
 * {@link OwnPrefsContext}). It still touches no CRDT: the order is not a fact
 * about the spaces.
 *
 * Order and collapse are separate registers so a collapse on one device does not
 * discard a reorder made on another at the same time.
 */

const NO_IDS: string[] = [];

function readOrder(store: OwnPrefsStore): string[] {
  return store.get<string[]>(OWN_PREF_KEYS.spaceOrder, NO_IDS);
}

function readCollapsed(store: OwnPrefsStore): string[] {
  return store.get<string[]>(OWN_PREF_KEYS.spacesCollapsed, NO_IDS);
}

export interface SpacePrefs {
  toggleCollapsed(id: string): void;
  /**
   * Move `activeId` so it sits immediately before `beforeSpaceId`, or to the
   * end of the list when `beforeSpaceId` is null. Operates on the full visible
   * order so the result is stable even when prior order had unknown ids.
   */
  reorder(
    visibleIds: string[],
    activeId: string,
    beforeSpaceId: string | null,
  ): void;
}

export function useSpacePrefs(): SpacePrefs {
  const store = useOwnPrefsStore();
  return useMemo<SpacePrefs>(
    () => ({
      toggleCollapsed: (id) => {
        const collapsed = readCollapsed(store);
        store.set(
          OWN_PREF_KEYS.spacesCollapsed,
          collapsed.includes(id)
            ? collapsed.filter((c) => c !== id)
            : [...collapsed, id],
        );
      },

      reorder: (visibleIds, activeId, beforeSpaceId) => {
        const without = visibleIds.filter((id) => id !== activeId);
        const at =
          beforeSpaceId === null
            ? without.length
            : (() => {
                const i = without.indexOf(beforeSpaceId);
                return i === -1 ? without.length : i;
              })();
        store.set(OWN_PREF_KEYS.spaceOrder, [
          ...without.slice(0, at),
          activeId,
          ...without.slice(at),
        ]);
      },
    }),
    [store],
  );
}

/** Subscribe to a single space's collapsed state. */
export function useIsSpaceCollapsed(id: string): boolean {
  const store = useOwnPrefsStore();
  // Subscribed for the re-render; the value itself is read off the store, which
  // is where a change from another device has already landed by then.
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  return readCollapsed(store).includes(id);
}

/**
 * Spaces sorted by the person's saved order, with any space missing from it
 * (newly created, or just joined) kept in its incoming order at the end so it
 * still appears.
 */
export function useOrderedSpaces(spaces: ISpace[]): ISpace[] {
  const store = useOwnPrefsStore();
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const order = readOrder(store);

  return useMemo(() => {
    if (order.length === 0) return spaces;
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...spaces].sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra === undefined && rb === undefined) return 0;
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    });
  }, [spaces, order]);
}
