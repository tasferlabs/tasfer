import { useCallback, useMemo, useSyncExternalStore } from "react";
import { normalizeWordKey } from "./personalDictionary";

/**
 * Words ignored "for this document only". Per device, in localStorage: the
 * choice is about this reading session, not about the person's vocabulary
 * (that is the personal dictionary), so it does not replicate.
 */

const KEY_PREFIX = "tasfer.spell.ignored.";
const CAP = 200;
/** Same-tab change signal; `storage` events only fire in OTHER tabs. */
const EVENT = "tasfer:spell-ignored";

function storageKey(pageId: string): string {
  return KEY_PREFIX + pageId;
}

function readRaw(pageId: string): string | null {
  try {
    return localStorage.getItem(storageKey(pageId));
  } catch {
    return null;
  }
}

function parse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((w): w is string => typeof w === "string")
      : [];
  } catch {
    return [];
  }
}

function write(pageId: string, words: string[]): void {
  try {
    if (words.length === 0) localStorage.removeItem(storageKey(pageId));
    else localStorage.setItem(storageKey(pageId), JSON.stringify(words));
  } catch {
    // Storage unavailable (private mode, quota): the ignore lasts for the
    // in-memory checker run only, which is still what the person asked for.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: pageId }));
  }
}

/** Non-hook read, for the checker's `ignoredInDocument` callback. Words are in key form. */
export function readDocumentIgnores(pageId: string): ReadonlySet<string> {
  return new Set(parse(readRaw(pageId)));
}

export function addDocumentIgnore(pageId: string, word: string): void {
  const key = normalizeWordKey(word);
  if (!key) return;
  const words = parse(readRaw(pageId)).filter((w) => w !== key);
  words.push(key);
  // Oldest first out: a 200-word ignore list is a document nobody is
  // proof-reading any more.
  while (words.length > CAP) words.shift();
  write(pageId, words);
}

export function removeDocumentIgnore(pageId: string, word: string): void {
  const key = normalizeWordKey(word);
  const words = parse(readRaw(pageId));
  const next = words.filter((w) => w !== key);
  if (next.length !== words.length) write(pageId, next);
}

export function clearDocumentIgnores(pageId: string): void {
  write(pageId, []);
}

export interface DocumentIgnores {
  ignored: ReadonlySet<string>;
  add(word: string): void;
  remove(word: string): void;
  clear(): void;
}

/**
 * The ignore list of one page, re-rendering when it changes here or in
 * another tab.
 */
export function useDocumentIgnores(pageId: string): DocumentIgnores {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined") return () => {};
      const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key === storageKey(pageId)) onChange();
      };
      const onLocal = (e: Event) => {
        if ((e as CustomEvent<string>).detail === pageId) onChange();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(EVENT, onLocal);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(EVENT, onLocal);
      };
    },
    [pageId],
  );
  // The raw string is the snapshot: equal text means equal list, and the
  // parsed Set is derived once per change below.
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(pageId),
    () => null,
  );
  const ignored = useMemo(() => new Set(parse(raw)), [raw]);
  return useMemo(
    () => ({
      ignored,
      add: (word: string) => addDocumentIgnore(pageId, word),
      remove: (word: string) => removeDocumentIgnore(pageId, word),
      clear: () => clearDocumentIgnores(pageId),
    }),
    [ignored, pageId],
  );
}
