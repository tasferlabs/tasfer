import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { IListPage } from "../api/pages.api";
import type { IParentsStack } from "../layout/components/PagesLinks";

/**
 * Everything a sidebar row knows about itself. A multi-page drag ends in
 * `SidebarContent`, which only receives dnd-kit's data for the one row the
 * pointer grabbed — so every visible row registers itself here and the drop
 * handler reads the rest of the batch back out.
 */
export type SelectedPage = {
  page: IListPage;
  spaceId?: string;
  parentsStack: IParentsStack;
};

type Listener = () => void;

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Visible (pre-order) position of a row in the tree. `parentsStack` carries one
 * entry per level, each holding the order of the row at that level, so the list
 * of orders is a path key: comparing them lexicographically — a prefix first —
 * is exactly the order the rows are painted in.
 */
function compareVisibleOrder(a: SelectedPage, b: SelectedPage): number {
  const pa = a.parentsStack;
  const pb = b.parentsStack;
  const depth = Math.min(pa.length, pb.length);
  for (let i = 0; i < depth; i++) {
    if (pa[i].order !== pb[i].order) return pa[i].order - pb[i].order;
  }
  if (pa.length !== pb.length) return pa.length - pb.length;
  // Same parent and same order: match the id tiebreak the page lists use.
  return a.page.id < b.page.id ? -1 : a.page.id > b.page.id ? 1 : 0;
}

/**
 * The rows of `selection` that are not nested under another row in it. Whatever
 * acts on an ancestor — a move, an archive — already carries its subtree, so
 * the descendants must be left out or they would be acted on twice.
 */
export function selectionRoots(selection: SelectedPage[]): SelectedPage[] {
  const ids = new Set(selection.map((r) => r.page.id));
  return selection.filter(
    (r) => !r.parentsStack.some((a) => a.id && ids.has(a.id)),
  );
}

/**
 * Which sidebar pages are selected, plus a registry of the rows on screen.
 *
 * A selection never spans spaces: one drag has one destination list, and a
 * cross-space move means something else entirely. Picking a row in another
 * space therefore starts a fresh selection rather than extending the old one.
 */
class PageSelectionStore {
  /** Every page row currently mounted in the sidebar, by id. */
  private rows = new Map<string, SelectedPage>();
  private ids: ReadonlySet<string> = EMPTY;
  private listeners = new Set<Listener>();
  /** Where a shift-range starts — the last row picked without shift. */
  private anchorId: string | null = null;
  /** Space the current selection lives in. */
  private spaceId: string | null = null;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.ids;

  private commit(
    ids: ReadonlySet<string>,
    anchorId: string | null,
    spaceId: string | null,
  ) {
    this.ids = ids;
    this.anchorId = ids.size > 0 ? anchorId : null;
    this.spaceId = ids.size > 0 ? spaceId : null;
    for (const l of this.listeners) l();
  }

  /** A row reports itself while it is on screen. Cheap and idempotent. */
  register(entry: SelectedPage) {
    this.rows.set(entry.page.id, entry);
  }

  /**
   * Collapsing a subtree unmounts its rows. Their ids stay in the selection —
   * an optimistic move remounts a row moments after it goes — and everything
   * that reads the selection back filters through the registry, so a row that
   * is gone simply stops counting until it returns.
   */
  unregister(id: string) {
    this.rows.delete(id);
  }

  has(id: string) {
    return this.ids.has(id);
  }

  /** Selected rows that are still on screen, in the order they are painted. */
  getSelection(): SelectedPage[] {
    const rows: SelectedPage[] = [];
    for (const id of this.ids) {
      const row = this.rows.get(id);
      if (row) rows.push(row);
    }
    return rows.sort(compareVisibleOrder);
  }

  private visibleRows(spaceId: string | null): SelectedPage[] {
    return [...this.rows.values()]
      .filter((r) => (r.spaceId ?? null) === spaceId)
      .sort(compareVisibleOrder);
  }

  /** Plain click: the selection becomes exactly this row. */
  selectOnly(id: string) {
    const row = this.rows.get(id);
    if (!row) return;
    if (this.ids.size === 1 && this.ids.has(id)) return;
    this.commit(new Set([id]), id, row.spaceId ?? null);
  }

  /** Cmd/Ctrl-click: add or remove one row. */
  toggle(id: string) {
    const row = this.rows.get(id);
    if (!row) return;
    const space = row.spaceId ?? null;
    if (this.ids.size > 0 && space !== this.spaceId) {
      this.selectOnly(id);
      return;
    }
    const next = new Set(this.ids);
    if (next.delete(id)) {
      this.commit(next, this.anchorId, space);
    } else {
      next.add(id);
      this.commit(next, id, space);
    }
  }

  /** Shift-click: replace the selection with the range anchor…id. */
  extendTo(id: string) {
    const row = this.rows.get(id);
    if (!row) return;
    const space = row.spaceId ?? null;
    if (!this.anchorId || space !== this.spaceId) {
      this.selectOnly(id);
      return;
    }
    const ordered = this.visibleRows(space);
    const from = ordered.findIndex((r) => r.page.id === this.anchorId);
    const to = ordered.findIndex((r) => r.page.id === id);
    if (from === -1 || to === -1) {
      this.selectOnly(id);
      return;
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    const next = new Set(ordered.slice(lo, hi + 1).map((r) => r.page.id));
    // The anchor stays put so a second shift-click re-aims from the same end.
    this.commit(next, this.anchorId, space);
  }

  clear() {
    if (this.ids.size === 0) return;
    this.commit(EMPTY, null, null);
  }
}

const PageSelectionContext = createContext<PageSelectionStore>(null!);

export function PageSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const store = useMemo(() => new PageSelectionStore(), []);
  return (
    <PageSelectionContext.Provider value={store}>
      {children}
    </PageSelectionContext.Provider>
  );
}

export function usePageSelection() {
  return useContext(PageSelectionContext);
}

export function useIsPageSelected(id: string) {
  const store = useContext(PageSelectionContext);
  const ids = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return ids.has(id);
}

/**
 * Keeps a row in the registry for as long as it is rendered, so shift-ranges
 * and multi-page drags can reach page data the drop handler never sees.
 */
export function usePageSelectionRow(entry: SelectedPage) {
  const store = useContext(PageSelectionContext);
  const id = entry.page.id;

  // No dependency list: re-registering on every render is a single Map write
  // and keeps the entry's order/parent in step with the query cache.
  useEffect(() => {
    store.register(entry);
  });

  useEffect(() => () => store.unregister(id), [store, id]);
}
