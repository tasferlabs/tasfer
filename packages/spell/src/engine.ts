/**
 * The engine contract every spelling backend implements.
 *
 * One {@link SpellEngine} instance per loaded dictionary (language). The
 * worker host owns the instances and routes tokens to every engine of the
 * token's script (union rule: a word is correct if any enabled dictionary of
 * its script accepts it). Backends today: Hunspell compiled to WebAssembly
 * (`./hunspell`), plus an in-memory stub for tests. A backend never touches
 * the DOM and never holds module-level state — many editors share one page.
 */

import type { Script } from "./protocol";

export interface SpellEngine {
  /** Dictionary id this engine serves (`"en"`, `"ar"`, an import id …). */
  readonly lang: string;
  readonly script: Script;
  /** True when `word` (already normalised for lookup) is spelled correctly. */
  spell(word: string): boolean;
  /**
   * Suggestions for a misspelled word, best first, at most `limit`. Slow by
   * nature (Hunspell's n-gram phase scans every stem): call only on demand,
   * never inside a checking pass.
   */
  suggest(word: string, limit: number): string[];
  /** Personal-dictionary word: accepted from now on (session only). */
  add(word: string): void;
  remove(word: string): void;
  /** Merge an extra word list (a `.dic` body: optional count line, one entry per line). */
  addDictionary(dic: string): void;
  dispose(): void;
}

export interface CreateEngineOptions {
  readonly lang: string;
  readonly script: Script;
  /** Affix rules (`.aff`), raw bytes in the encoding the file declares. */
  readonly aff: Uint8Array;
  /** Dictionary (`.dic`), raw bytes. */
  readonly dic: Uint8Array;
  /** Extra `.dic` bodies merged after load (accept-lists, imports). */
  readonly extras?: readonly Uint8Array[];
}

export interface SpellEngineFactory {
  create(opts: CreateEngineOptions): Promise<SpellEngine>;
}

/**
 * Convert a plain word list (one word per line, `#` comments, cspell-style
 * prefixes: `!word` forbidden, `~word` case-insensitive, `+`/`*` compound
 * markers) into a Hunspell `.aff`/`.dic` pair so it loads into the same
 * engine as a real dictionary. Forbidden words are returned separately so
 * the host can keep flagging them.
 */
export function wordListToDic(words: Iterable<string>): {
  aff: Uint8Array;
  dic: Uint8Array;
  forbidden: string[];
} {
  const accepted: string[] = [];
  const forbidden: string[] = [];
  const seen = new Set<string>();
  for (const raw of words) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      const w = line.slice(1).trim();
      if (w) forbidden.push(w);
      continue;
    }
    // cspell markers: `~` (case-insensitive), leading `+`/`*` (compound).
    line = line.replace(/^[~+*]+/, "").replace(/[+*]+$/, "");
    if (!line || /\s/.test(line)) continue;
    const key = line.normalize("NFC");
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(key);
  }
  const encoder = new TextEncoder();
  return {
    aff: encoder.encode("SET UTF-8\n"),
    dic: encoder.encode(`${accepted.length}\n${accepted.join("\n")}\n`),
    forbidden,
  };
}

/**
 * Test double: a set-backed engine with trivial suggestions (words within
 * one insertion/deletion/substitution). Used by the worker-host and checker
 * tests so they never need the WASM binary.
 */
export function createMemoryEngine(
  lang: string,
  script: Script,
  words: Iterable<string>,
): SpellEngine {
  const dict = new Set<string>();
  for (const w of words) dict.add(w);
  let disposed = false;
  return {
    lang,
    script,
    spell: (word) => dict.has(word),
    suggest: (word, limit) => {
      const out: string[] = [];
      for (const w of dict) {
        if (out.length >= limit) break;
        if (Math.abs(w.length - word.length) <= 1 && editDistance1(w, word)) {
          out.push(w);
        }
      }
      return out;
    },
    add: (word) => void dict.add(word),
    remove: (word) => void dict.delete(word),
    addDictionary: (dic) => {
      for (const line of dic.split(/\r?\n/)) {
        const w = line.replace(/\/.*$/, "").trim();
        if (w && !/^\d+$/.test(w)) dict.add(w);
      }
    },
    dispose: () => {
      disposed = true;
      dict.clear();
    },
    get isDisposed() {
      return disposed;
    },
  } as SpellEngine;
}

function editDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i] && ++diff > 1) return false;
    return true;
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      j++;
    }
  }
  return true;
}
