import { useMemo } from "react";
import type { OwnPrefsStore } from "@/app/contexts/OwnPrefsContext";
import { usePrefEntries } from "@/lib/usePrefEntries";
import { normalizeWordKey } from "./personalDictionary";

/**
 * Words ignored "for this document only" — a decision about one page rather
 * than about the person's vocabulary (that is the personal dictionary).
 *
 * Kept in the own-prefs register, so a word waved through on the laptop is not
 * flagged again on the phone. One key per word, `null` once removed, for the
 * same reason the personal dictionary does it: the register is last-writer-wins
 * per key and cannot delete, so a single list per page would let two devices
 * overwrite each other's additions.
 */

/**
 * Key PREFIX: `spell.ignore.<pageId>.<word>` → `{ added: ms }`. Mirrored in
 * `OWN_PREF_KEYS` so this module stays importable without the React context
 * module.
 */
export const IGNORES_PREF_PREFIX = "spell.ignore.";

/** Where this device kept a page's list before it moved to the register. */
export const LEGACY_IGNORES_PREFIX = "tasfer.spell.ignored.";

const CAP = 200;

type IgnorePrefs = Pick<
  OwnPrefsStore,
  "entries" | "set" | "getSnapshot" | "subscribe"
>;

interface IgnoreEntry {
  added: number;
}

function pagePrefix(pageId: string): string {
  return `${IGNORES_PREF_PREFIX}${pageId}.`;
}

/** The page's ignored words, oldest first, as `[word, added]` pairs. */
function readEntries(
  prefs: IgnorePrefs,
  pageId: string,
): Array<[string, number]> {
  return toWords(prefs.entries(pagePrefix(pageId)), pageId);
}

function toWords(
  entries: ReadonlyArray<readonly [string, unknown]>,
  pageId: string,
): Array<[string, number]> {
  const prefix = pagePrefix(pageId);
  const words: Array<[string, number]> = [];
  for (const [key, value] of entries) {
    const added = (value as Partial<IgnoreEntry>).added;
    words.push([
      key.slice(prefix.length),
      typeof added === "number" ? added : 0,
    ]);
  }
  return words.sort((a, b) => a[1] - b[1]);
}

const EMPTY: ReadonlySet<string> = new Set();

/** The page's ignored words, in key form. */
export function readDocumentIgnores(
  prefs: IgnorePrefs | null,
  pageId: string,
): ReadonlySet<string> {
  // Onboarding renders the editor with no own-prefs store above it.
  if (!prefs) return EMPTY;
  return new Set(readEntries(prefs, pageId).map(([word]) => word));
}

export function addDocumentIgnore(
  prefs: IgnorePrefs,
  pageId: string,
  word: string,
  now: number = Date.now(),
): void {
  const key = normalizeWordKey(word);
  if (!key) return;
  prefs.set(pagePrefix(pageId) + key, { added: now } satisfies IgnoreEntry);
  // Oldest first out: a 200-word ignore list is a document nobody is
  // proof-reading any more.
  const entries = readEntries(prefs, pageId);
  for (const [old] of entries.slice(0, Math.max(0, entries.length - CAP))) {
    prefs.set(pagePrefix(pageId) + old, null);
  }
}

export function removeDocumentIgnore(
  prefs: IgnorePrefs,
  pageId: string,
  word: string,
): void {
  const key = normalizeWordKey(word);
  if (readDocumentIgnores(prefs, pageId).has(key)) {
    prefs.set(pagePrefix(pageId) + key, null);
  }
}

export function clearDocumentIgnores(prefs: IgnorePrefs, pageId: string): void {
  for (const [word] of readEntries(prefs, pageId)) {
    prefs.set(pagePrefix(pageId) + word, null);
  }
}

/**
 * The list this device kept for one page in `localStorage`, one register entry
 * per word. It carried no times, so the order is kept with small stand-in ones
 * that any real ignore outranks.
 */
export function readLegacyDocumentIgnores(
  storageKey: string,
  raw: string,
): Array<[string, unknown]> {
  const pageId = storageKey.slice(LEGACY_IGNORES_PREFIX.length);
  const parsed: unknown = JSON.parse(raw);
  if (!pageId || !Array.isArray(parsed)) return [];
  return parsed
    .filter((w): w is string => typeof w === "string" && w.length > 0)
    .map((word, i) => [pagePrefix(pageId) + word, { added: i + 1 }]);
}

export interface DocumentIgnores {
  ignored: ReadonlySet<string>;
  add(word: string): void;
  remove(word: string): void;
  clear(): void;
}

/**
 * The ignore list of one page, re-rendering when it changes here or on
 * another of the person's devices. `ignored` keeps its identity until this
 * page's words change, so a write to any other preference does not re-check
 * the document. Without a prefs store (onboarding) the list is empty and
 * changes are dropped.
 */
export function useDocumentIgnores(
  prefs: IgnorePrefs | null,
  pageId: string,
): DocumentIgnores {
  const entries = usePrefEntries(prefs, pagePrefix(pageId));
  return useMemo(
    () => ({
      ignored: new Set(toWords(entries, pageId).map(([word]) => word)),
      add: (word: string) => {
        if (prefs) addDocumentIgnore(prefs, pageId, word);
      },
      remove: (word: string) => {
        if (prefs) removeDocumentIgnore(prefs, pageId, word);
      },
      clear: () => {
        if (prefs) clearDocumentIgnores(prefs, pageId);
      },
    }),
    [prefs, pageId, entries],
  );
}
