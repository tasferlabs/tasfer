import { createContext, useContext, useMemo, useSyncExternalStore } from "react";

type Listener = () => void;

class ExpandedStore {
  private ids = new Set<string>();
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.ids;

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

  expandMany(ids: string[]) {
    let changed = false;
    for (const id of ids) {
      if (!this.ids.has(id)) {
        this.ids.add(id);
        changed = true;
      }
    }
    if (changed) this.notify();
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

export function useIsExpanded(id: string) {
  const store = useContext(TreeExpandContext);
  const ids = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return ids.has(id);
}
