import { createContext, useContext, useMemo, useSyncExternalStore } from "react";

type Listener = () => void;

/**
 * A request for one sidebar row to bring itself into view. The nonce lets a row
 * tell a fresh request apart from the one it already handled, so re-opening the
 * same page scrolls to it again.
 */
export type RevealRequest = {
  id: string;
  /** Space the page lives in, so a collapsed one can open to show it. */
  spaceId: string | null;
  nonce: number;
};

class ExpandedStore {
  private ids = new Set<string>();
  private reveal: RevealRequest | null = null;
  private nonce = 0;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.ids;

  getRevealSnapshot = () => this.reveal;

  private notify() {
    // Create a new Set so React sees a new reference
    this.ids = new Set(this.ids);
    for (const l of this.listeners) l();
  }

  expand(id: string) {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.notify();
  }

  collapse(id: string) {
    if (!this.ids.has(id)) return;
    this.ids.delete(id);
    this.notify();
  }

  toggle(id: string) {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this.notify();
  }

  isExpanded(id: string) {
    return this.ids.has(id);
  }

  /**
   * Open the trees leading to a page and ask its sidebar row to scroll itself
   * into view. Nothing along that path is necessarily mounted yet — a deep page
   * loads its ancestors' children one query at a time, and the space may still
   * be collapsed — so the request is kept until the row claims it.
   */
  revealPath(target: {
    id: string;
    spaceId?: string | null;
    ancestorIds: string[];
  }) {
    for (const ancestorId of target.ancestorIds) this.ids.add(ancestorId);
    this.reveal = {
      id: target.id,
      spaceId: target.spaceId ?? null,
      nonce: ++this.nonce,
    };
    this.notify();
  }
}

const TreeExpandContext = createContext<ExpandedStore>(null!);

export function TreeExpandProvider({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => new ExpandedStore(), []);
  return (
    <TreeExpandContext.Provider value={store}>
      {children}
    </TreeExpandContext.Provider>
  );
}

export function useTreeExpand() {
  return useContext(TreeExpandContext);
}

/** The row asked to scroll itself into view, if any. */
export function useRevealRequest() {
  const store = useContext(TreeExpandContext);
  return useSyncExternalStore(store.subscribe, store.getRevealSnapshot);
}

export function useIsExpanded(id: string) {
  const store = useContext(TreeExpandContext);
  const ids = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return ids.has(id);
}
