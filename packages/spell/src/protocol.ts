/**
 * Main-thread ↔ worker contract.
 *
 * The checker (main thread, one per editor) never talks to an engine
 * directly: it sends `check`/`suggest` requests through a {@link SpellTransport}
 * (see checker.ts) and the host routes them to a worker running
 * {@link createWorkerHost} (worker-host.ts). Everything in this file must be
 * structured-cloneable — plain data only — because it crosses `postMessage`.
 *
 * Requests are correlated by `id`; a `cancel` names the id to drop. Blocks are
 * versioned by the caller so a stale `checked` result (a newer check for the
 * same block is pending) can be discarded on arrival.
 */

/**
 * Writing-script class of a token. Dictionaries are routed by script: an
 * Arabic-script token is only ever checked against Arabic-script
 * dictionaries and a Latin token only against Latin ones, so an English typo
 * can never be "accepted" by the Arabic dictionary. `mixed` tokens
 * (Arabic letters joined to Latin letters, e.g. `الـWiFi`) and `other`
 * scripts are never flagged.
 */
export type Script = "latn" | "arab" | "other" | "mixed";

/** One misspelling in a block's visible text (UTF-16 offsets, `to` exclusive). */
export interface Flag {
  readonly from: number;
  readonly to: number;
  /** The token exactly as it appears in the text (display form). */
  readonly word: string;
  readonly script: Script;
}

/**
 * Where a dictionary's bytes come from. `url` lets the worker fetch them
 * itself (the service worker's CacheFirst route intercepts worker fetches);
 * `bytes` is for hosts that must read on the main thread (Electron's file://
 * renderer, imported dictionaries read through the platform FsDriver) — the
 * buffers are transferred, never cloned.
 */
export type DictionarySource =
  | { readonly kind: "url"; readonly aff: string; readonly dic: string }
  | {
      readonly kind: "bytes";
      readonly aff: ArrayBuffer;
      readonly dic: ArrayBuffer;
    };

/** A source for an extra word list merged into an engine (accept-lists, imports). */
export type ExtraDictionarySource =
  | { readonly kind: "url"; readonly dic: string }
  | { readonly kind: "bytes"; readonly dic: ArrayBuffer };

/** Per-check options; all of them are cheap to send with every request. */
export interface CheckOptions {
  /** Flag ALL-CAPS Latin tokens (default: skip them as acronyms). */
  readonly flagAllCaps: boolean;
  /**
   * Accept an Arabic token when any of its common orthographic variants
   * (initial hamza forms, final ة/ه, final ى/ي) is in the dictionary.
   */
  readonly lenientArabic: boolean;
  /** Words ignored for this document (already normalised for lookup). */
  readonly ignored: readonly string[];
}

export interface CheckBlock {
  readonly blockId: string;
  /** Caller-owned version stamp; echoed back so stale results can be dropped. */
  readonly version: number;
  readonly text: string;
  /** Offset spans the checker must not tokenise (code/link/math runs). */
  readonly skip: ReadonlyArray<readonly [number, number]>;
}

export type CheckPriority = "caret" | "local" | "remote" | "initial";

export type SpellRequest =
  | {
      readonly type: "init";
      readonly id: number;
      /** Engine binary: a URL the worker fetches, raw bytes, or a compiled module. */
      readonly wasm: string | ArrayBuffer | WebAssembly.Module;
    }
  | {
      readonly type: "loadDictionary";
      readonly id: number;
      /** Dictionary id (e.g. `"en"`, `"ar"`, or an imported dictionary's id). */
      readonly lang: string;
      readonly script: Script;
      readonly source: DictionarySource;
      readonly extras?: readonly ExtraDictionarySource[];
    }
  | {
      readonly type: "unloadDictionary";
      readonly id: number;
      readonly lang: string;
    }
  | {
      readonly type: "setUserWords";
      readonly id: number;
      /** Personal dictionary (accepted everywhere, replayed into every engine). */
      readonly words: readonly string[];
      /** `!word` entries: always flagged even if a dictionary has them. */
      readonly forbidden: readonly string[];
    }
  | {
      readonly type: "check";
      readonly id: number;
      readonly docId: string;
      readonly blocks: readonly CheckBlock[];
      readonly options: CheckOptions;
      readonly priority: CheckPriority;
    }
  | {
      readonly type: "suggest";
      readonly id: number;
      readonly word: string;
      readonly script: Script;
      readonly limit: number;
    }
  | { readonly type: "cancel"; readonly id: number };

export interface CheckedBlock {
  readonly blockId: string;
  readonly version: number;
  readonly flags: readonly Flag[];
  /**
   * Scripts present in the block whose dictionaries were not loaded yet:
   * those tokens were NOT flagged (never a squiggle the engine cannot
   * justify) and the block should be re-checked once a dictionary lands.
   */
  readonly deferredScripts?: readonly Script[];
}

export type SpellResponse =
  | { readonly type: "ready"; readonly id: number }
  | {
      readonly type: "dictionaryLoaded";
      readonly id: number;
      readonly lang: string;
      readonly ms: number;
      readonly bytes: number;
    }
  | {
      readonly type: "dictionaryError";
      readonly id: number;
      readonly lang: string;
      readonly message: string;
    }
  | {
      readonly type: "checked";
      readonly id: number;
      readonly docId: string;
      readonly results: readonly CheckedBlock[];
    }
  | {
      readonly type: "suggestions";
      readonly id: number;
      readonly word: string;
      readonly suggestions: readonly string[];
    }
  | { readonly type: "error"; readonly id: number; readonly message: string };
