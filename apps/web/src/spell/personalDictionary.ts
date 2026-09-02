import { normalizeForLookup, scriptOf } from "@tasfer/spell";
import type { OwnPrefsStore } from "@/app/contexts/OwnPrefsContext";

/**
 * Own-prefs keys used by spelling. Mirrored in `OWN_PREF_KEYS`
 * (app/contexts/OwnPrefsContext.tsx) — keep both in step; this copy exists so
 * the service layer stays importable without the React context module.
 */
export const SPELL_PREF_KEYS = {
  /** `boolean` — default true. */
  enabled: "spell.enabled",
  /** `string[]` of dictionary ids — default `["en", "ar"]`. */
  languages: "spell.languages",
  /** `boolean` — accept common Arabic orthographic variants (default false). */
  lenientArabic: "spell.lenientArabic",
  /** `boolean` — flag ALL-CAPS Latin tokens (default false). */
  flagAllCaps: "spell.flagAllCaps",
  /** `boolean` — stronger squiggle colours (default false). */
  highContrast: "spell.highContrast",
  /** `spell.word.<word>` → `{ added: ms }`; one key per accepted word. */
  wordPrefix: "spell.word.",
  /** `spell.forbid.<word>` → `{ added: ms }`; one key per forbidden word. */
  forbidPrefix: "spell.forbid.",
} as const;

/** Value stored under a word key. Removal writes `null` (a tombstone). */
export interface PersonalWordEntry {
  added: number;
}

// Bidi controls (LRM/RLM, LRE…PDF, LRI…PDI), ZWNJ, ZWJ, BOM, word joiner.
const INVISIBLES =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * The key form of a word: NFC, invisible controls stripped, then the lookup
 * normalisation the checker itself applies (Arabic tashkeel/tatweel dropped;
 * Latin case kept). Two spellings that the checker treats as one word map to
 * one key, so a word accepted once is accepted however it was typed.
 */
export function normalizeWordKey(word: string): string {
  const cleaned = word.replace(INVISIBLES, "").normalize("NFC").trim();
  if (!cleaned) return "";
  return normalizeForLookup(cleaned, scriptOf(cleaned));
}

export interface PersonalDictionaryDiff {
  added: string[];
  removed: string[];
}

/** Sort words for export: Latin first, then Arabic, then anything else; each group by its own collator. */
function sortWords(words: Iterable<string>): string[] {
  const groups: Record<string, string[]> = {};
  for (const w of words) (groups[scriptOf(w)] ??= []).push(w);
  const order: Array<[string, string]> = [
    ["latn", "en"],
    ["arab", "ar"],
    ["mixed", "en"],
    ["other", "en"],
  ];
  const out: string[] = [];
  for (const [script, locale] of order) {
    const group = groups[script];
    if (!group) continue;
    const collator = new Intl.Collator(locale, { sensitivity: "base" });
    out.push(
      ...group.sort(
        (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0),
      ),
    );
  }
  return out;
}

/**
 * The person's own word list, kept in own-prefs as ONE KEY PER WORD.
 *
 * The register is last-writer-wins per key with whole-value replacement and
 * has no delete, so a single `string[]` would let two devices overwrite each
 * other's additions and could never shrink. One key per word means adding on
 * the phone and removing on the laptop both survive a merge; removal writes
 * `null`, which the store reads back as absent.
 */
export class PersonalDictionary {
  private accepted = new Set<string>();
  private forbiddenSet = new Set<string>();
  private listeners = new Set<(diff: PersonalDictionaryDiff) => void>();
  private unsubscribe: (() => void) | null = null;
  private readonly store: OwnPrefsStore;

  constructor(store: OwnPrefsStore) {
    this.store = store;
    this.rescan();
  }

  /**
   * Without a subscriber nothing tracks the store, so reads re-derive from the
   * snapshot first; with one, `rescan` already ran on every change.
   */
  private sync(): void {
    if (!this.unsubscribe) this.rescan();
  }

  has(word: string): boolean {
    this.sync();
    return this.accepted.has(normalizeWordKey(word));
  }

  isForbidden(word: string): boolean {
    this.sync();
    return this.forbiddenSet.has(normalizeWordKey(word));
  }

  /** Accepted words, unsorted (call order is the snapshot's key order). */
  words(): string[] {
    this.sync();
    return [...this.accepted];
  }

  forbidden(): string[] {
    this.sync();
    return [...this.forbiddenSet];
  }

  add(word: string): void {
    this.sync();
    const key = normalizeWordKey(word);
    if (!key || /\s/.test(key)) return;
    if (this.forbiddenSet.has(key)) {
      this.store.set(SPELL_PREF_KEYS.forbidPrefix + key, null);
    }
    if (this.accepted.has(key)) return;
    this.store.set(SPELL_PREF_KEYS.wordPrefix + key, {
      added: Date.now(),
    } satisfies PersonalWordEntry);
    this.rescan();
  }

  remove(word: string): void {
    this.sync();
    const key = normalizeWordKey(word);
    if (!key) return;
    if (this.accepted.has(key))
      this.store.set(SPELL_PREF_KEYS.wordPrefix + key, null);
    if (this.forbiddenSet.has(key))
      this.store.set(SPELL_PREF_KEYS.forbidPrefix + key, null);
    this.rescan();
  }

  /** Always flag `word`, even when a dictionary knows it. Drops it from the accepted list. */
  forbid(word: string): void {
    this.sync();
    const key = normalizeWordKey(word);
    if (!key || /\s/.test(key)) return;
    if (this.accepted.has(key))
      this.store.set(SPELL_PREF_KEYS.wordPrefix + key, null);
    if (this.forbiddenSet.has(key)) return;
    this.store.set(SPELL_PREF_KEYS.forbidPrefix + key, {
      added: Date.now(),
    } satisfies PersonalWordEntry);
    this.rescan();
  }

  /**
   * Merge a word list: one token per line, `#` comments, `!word` forbids a
   * word. Never removes anything. `cap` bounds the total accepted+forbidden
   * count after the merge; what does not fit is counted as skipped, as are
   * blank/duplicate lines and tokens containing whitespace.
   */
  importText(text: string, cap = 5000): { added: number; skipped: number } {
    this.sync();
    let added = 0;
    let skipped = 0;
    const now = Date.now();
    let total = this.accepted.size + this.forbiddenSet.size;
    for (const rawLine of text.split(/\r?\n|\r/)) {
      const line = rawLine.replace(/^\uFEFF/, "").trim();
      if (!line || line.startsWith("#")) continue;
      const isForbid = line.startsWith("!");
      const token = isForbid ? line.slice(1).trim() : line;
      if (!token || /\s/.test(token)) {
        skipped++;
        continue;
      }
      const key = normalizeWordKey(token);
      if (!key || /\s/.test(key)) {
        skipped++;
        continue;
      }
      const target = isForbid ? this.forbiddenSet : this.accepted;
      if (target.has(key)) {
        skipped++;
        continue;
      }
      if (total >= cap) {
        skipped++;
        continue;
      }
      const prefix = isForbid
        ? SPELL_PREF_KEYS.forbidPrefix
        : SPELL_PREF_KEYS.wordPrefix;
      this.store.set(prefix + key, { added: now } satisfies PersonalWordEntry);
      target.add(key);
      total++;
      added++;
    }
    this.rescan();
    return { added, skipped };
  }

  /** UTF-8 text, LF line ends, one word per line; forbidden words last as `!word`. */
  exportText(): string {
    this.sync();
    const lines = sortWords(this.accepted);
    for (const w of sortWords(this.forbiddenSet)) lines.push(`!${w}`);
    return lines.length ? `${lines.join("\n")}\n` : "";
  }

  /**
   * Fires with the words that appeared or disappeared — from this device or
   * another one. The first subscriber attaches to the prefs store; the last
   * unsubscribe detaches.
   */
  subscribe(cb: (diff: PersonalDictionaryDiff) => void): () => void {
    if (!this.unsubscribe) {
      // Catch up on anything written while nobody was listening, before the
      // new subscriber is in place (it wants diffs from now on, not history).
      this.rescan();
      this.unsubscribe = this.store.subscribe(() => this.rescan());
    }
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0 && this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    };
  }

  /** Re-derive the sets from the store and notify subscribers of any change. */
  private rescan(): void {
    const values = this.store.getSnapshot().values;
    const accepted = new Set<string>();
    const forbid = new Set<string>();
    for (const key in values) {
      if (values[key] === null || values[key] === undefined) continue;
      if (key.startsWith(SPELL_PREF_KEYS.wordPrefix)) {
        accepted.add(key.slice(SPELL_PREF_KEYS.wordPrefix.length));
      } else if (key.startsWith(SPELL_PREF_KEYS.forbidPrefix)) {
        forbid.add(key.slice(SPELL_PREF_KEYS.forbidPrefix.length));
      }
    }
    const added: string[] = [];
    const removed: string[] = [];
    for (const w of accepted) if (!this.accepted.has(w)) added.push(w);
    for (const w of this.accepted) if (!accepted.has(w)) removed.push(w);
    for (const w of forbid) if (!this.forbiddenSet.has(w)) added.push(w);
    for (const w of this.forbiddenSet) if (!forbid.has(w)) removed.push(w);
    this.accepted = accepted;
    this.forbiddenSet = forbid;
    if (added.length === 0 && removed.length === 0) return;
    const diff = { added, removed };
    for (const l of this.listeners) l(diff);
  }
}
