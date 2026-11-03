import { useCallback, useRef, useSyncExternalStore } from "react";
import type { OwnPrefsStore } from "@/app/contexts/OwnPrefsContext";

type EntriesSource = Pick<
  OwnPrefsStore,
  "entries" | "getSnapshot" | "subscribe"
>;
type Entries = ReadonlyArray<readonly [string, unknown]>;

const NONE: Entries = [];
const noSubscribe = () => () => {};

function sameEntries(a: Entries, b: Entries): boolean {
  return (
    a.length === b.length &&
    a.every(([key, value], i) => key === b[i]![0] && value === b[i]![1])
  );
}

/**
 * The own-prefs entries under `prefix`, as a value that changes only when one
 * of them does.
 *
 * Every write to the register — a sidebar drag, a fold toggled, a change from
 * another device — makes a new snapshot. Whatever is derived from one prefix
 * (a ranking, a set of ignored words) should not be rebuilt, or re-run
 * downstream work, for writes to other keys. With no store (onboarding) there
 * are no entries.
 */
export function usePrefEntries(
  store: EntriesSource | null,
  prefix: string,
): Entries {
  const last = useRef<{
    values: object | null;
    prefix: string;
    entries: Entries;
  } | null>(null);

  const getSnapshot = useCallback((): Entries => {
    if (!store) return NONE;
    const values = store.getSnapshot().values;
    const prev = last.current;
    if (prev && prev.values === values && prev.prefix === prefix) {
      return prev.entries;
    }
    const next = store.entries(prefix);
    const entries =
      prev && prev.prefix === prefix && sameEntries(prev.entries, next)
        ? prev.entries
        : next;
    last.current = { values, prefix, entries };
    return entries;
  }, [store, prefix]);

  return useSyncExternalStore(store?.subscribe ?? noSubscribe, getSnapshot);
}
