import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ISpace } from "../api/spaces.api";

/**
 * Per-device sidebar preferences for spaces: a custom display order and which
 * spaces are collapsed/hidden. This is intentionally local-only — each device
 * arranges its own sidebar (e.g. collapsing private spaces) and nothing here
 * touches the CRDT or syncs to peers. Persisted to localStorage.
 */

const STORAGE_KEY = "tasfer.spacePrefs";

type Listener = () => void;

interface PersistShape {
  order: string[];
  collapsed: string[];
}

interface Snapshot {
  order: string[];
  collapsed: Set<string>;
}

function loadFromStorage(): Snapshot {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(STORAGE_KEY)
        : null;
    if (!raw) return { order: [], collapsed: new Set() };
    const parsed = JSON.parse(raw) as Partial<PersistShape>;
    return {
      order: Array.isArray(parsed.order) ? parsed.order : [],
      collapsed: new Set(Array.isArray(parsed.collapsed) ? parsed.collapsed : []),
    };
  } catch {
    return { order: [], collapsed: new Set() };
  }
}

class SpacePrefsStore {
  private snapshot: Snapshot = loadFromStorage();
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private commit(next: Snapshot) {
    this.snapshot = next;
    try {
      if (typeof localStorage !== "undefined") {
        const payload: PersistShape = {
          order: next.order,
          collapsed: [...next.collapsed],
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      }
    } catch {
      // Storage may be unavailable (private mode, quota); keep state in memory.
    }
    for (const l of this.listeners) l();
  }

  isCollapsed(id: string) {
    return this.snapshot.collapsed.has(id);
  }

  toggleCollapsed(id: string) {
    const collapsed = new Set(this.snapshot.collapsed);
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    this.commit({ order: this.snapshot.order, collapsed });
  }

  /**
   * Move `activeId` so it sits immediately before `beforeSpaceId`, or to the
   * end of the list when `beforeSpaceId` is null. Operates on the full visible
   * order so the result is stable even when prior order had unknown ids.
   */
  reorder(visibleIds: string[], activeId: string, beforeSpaceId: string | null) {
    const without = visibleIds.filter((id) => id !== activeId);
    const insertAt =
      beforeSpaceId === null
        ? without.length
        : (() => {
            const i = without.indexOf(beforeSpaceId);
            return i === -1 ? without.length : i;
          })();
    const order = [
      ...without.slice(0, insertAt),
      activeId,
      ...without.slice(insertAt),
    ];
    this.commit({ order, collapsed: this.snapshot.collapsed });
  }

  /**
   * Sort spaces by the saved order, appending any spaces not present in the
   * saved order (newly created or joined) in their incoming order so they
   * still appear.
   */
  orderSpaces(spaces: ISpace[]): ISpace[] {
    const { order } = this.snapshot;
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
  }
}

const SpacePrefsContext = createContext<SpacePrefsStore>(null!);

export function SpacePrefsProvider({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => new SpacePrefsStore(), []);
  return (
    <SpacePrefsContext.Provider value={store}>
      {children}
    </SpacePrefsContext.Provider>
  );
}

export function useSpacePrefs() {
  return useContext(SpacePrefsContext);
}

/** Subscribe to a single space's collapsed state. */
export function useIsSpaceCollapsed(id: string) {
  const store = useContext(SpacePrefsContext);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return snapshot.collapsed.has(id);
}

/** Returns spaces sorted by the saved per-device order. */
export function useOrderedSpaces(spaces: ISpace[]): ISpace[] {
  const store = useContext(SpacePrefsContext);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return useMemo(
    () => store.orderSpaces(spaces),
    // Re-sort when the spaces list or the saved order changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spaces, snapshot.order],
  );
}
