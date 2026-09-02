/**
 * Worker-side host (`@tasfer/spell/worker`).
 *
 * Owns the engines, the user's personal dictionary, the check queue and the
 * suggestion path. It is transport-agnostic: the host passes a `post`
 * function and feeds every incoming {@link SpellRequest} to the returned
 * handler, so the same code runs behind `self.onmessage` in a Web Worker and
 * in-process in Node tests. No `self`, no DOM, no module-level state — a
 * page may run several hosts.
 *
 * Checking is cooperative: blocks are processed in slices of ~8 ms and the
 * host yields to the event loop between slices so `suggest` and `cancel`
 * messages interleave with a long initial pass.
 */

import type { SpellEngine, SpellEngineFactory } from "./engine";
import type {
  CheckBlock,
  CheckedBlock,
  CheckOptions,
  CheckPriority,
  DictionarySource,
  ExtraDictionarySource,
  Flag,
  Script,
  SpellRequest,
  SpellResponse,
} from "./protocol";
import {
  arabicVariants,
  caseVariants,
  collapseRepeats,
  matchCase,
  normalizeForLookup,
  scriptOf,
} from "./script";
import { createSegmenter, tokenize } from "./tokenizer";

export type PostResponse = (
  msg: SpellResponse,
  transfer?: Transferable[],
) => void;
export type FetchBytes = (url: string) => Promise<ArrayBuffer>;

/** Tuning knobs, mainly for tests; production hosts use the defaults. */
export interface WorkerHostOptions {
  /** Time budget per slice before yielding (default 8 ms). */
  readonly sliceMs?: number;
  /** Clock used for slicing (default `performance.now`). */
  readonly now?: () => number;
  /** Yield primitive (default: MessageChannel, else `setTimeout(0)`). */
  readonly yieldToLoop?: () => Promise<void>;
  /** Per-engine lookup cache size (default 100 000 words). */
  readonly cacheSize?: number;
}

const PRIORITY_ORDER: readonly CheckPriority[] = [
  "caret",
  "local",
  "remote",
  "initial",
];
const DEFAULT_SLICE_MS = 8;
const DEFAULT_CACHE_SIZE = 100_000;

interface QueueItem {
  readonly key: string;
  readonly requestId: number;
  readonly docId: string;
  readonly block: CheckBlock;
  readonly options: CheckOptions;
  readonly ignored: ReadonlySet<string>;
  readonly priority: CheckPriority;
  /** Superseded by a newer request for the same block, or cancelled. */
  dropped: boolean;
}

/** Insertion-ordered map used as an LRU: a hit moves the key to the end. */
class LruCache {
  private readonly map = new Map<string, boolean>();
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  get(key: string): boolean | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key: string, value: boolean): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

interface LoadedEngine {
  readonly engine: SpellEngine;
  readonly cache: LruCache;
  /** User words this engine did not know before we added them (safe to remove). */
  readonly added: Set<string>;
}

type BytesSource =
  { kind: "url"; url: string } | { kind: "bytes"; bytes: ArrayBuffer };

async function defaultFetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

function defaultYield(): Promise<void> {
  if (typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function blockKey(docId: string, blockId: string): string {
  return `${docId} ${blockId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create the worker host. Feed every incoming request to the returned
 * handler; responses go out through `post`. The returned promise settles when
 * the request has been fully handled (for `check`: when the queue drains).
 */
export function createWorkerHost(
  post: PostResponse,
  factory: SpellEngineFactory,
  fetchBytes: FetchBytes = defaultFetchBytes,
  hostOptions: WorkerHostOptions = {},
): (msg: SpellRequest) => Promise<void> {
  const sliceMs = hostOptions.sliceMs ?? DEFAULT_SLICE_MS;
  const now = hostOptions.now ?? (() => performance.now());
  const yieldToLoop = hostOptions.yieldToLoop ?? defaultYield;
  const cacheSize = hostOptions.cacheSize ?? DEFAULT_CACHE_SIZE;
  const seg = createSegmenter();

  const engines = new Map<string, LoadedEngine>();
  const userWords = new Set<string>();
  const forbidden = new Set<string>();

  /** Pending blocks by priority; `byKey` finds the live item for a block. */
  const buckets = new Map<CheckPriority, QueueItem[]>(
    PRIORITY_ORDER.map((p) => [p, []]),
  );
  const byKey = new Map<string, QueueItem>();
  /** Blocks checked while a script had no dictionary, re-queued when one lands. */
  const deferred = new Map<string, { item: QueueItem; scripts: Set<Script> }>();
  let pumping: Promise<void> | null = null;

  // -------------------------------------------------------------------------
  // Engines
  // -------------------------------------------------------------------------

  function enginesOf(script: Script): LoadedEngine[] {
    const out: LoadedEngine[] = [];
    for (const loaded of engines.values())
      if (loaded.engine.script === script) out.push(loaded);
    return out;
  }

  function lookup(loaded: LoadedEngine, word: string): boolean {
    const cached = loaded.cache.get(word);
    if (cached !== undefined) return cached;
    const accepted = loaded.engine.spell(word);
    loaded.cache.set(word, accepted);
    return accepted;
  }

  function addUserWordTo(loaded: LoadedEngine, word: string): void {
    if (scriptOf(word) !== loaded.engine.script) return;
    // Hunspell's `remove` forbids the word outright, so never add (and later
    // remove) a word the dictionary already knows.
    if (loaded.engine.spell(word)) return;
    loaded.engine.add(word);
    loaded.added.add(word);
    loaded.cache.set(word, true);
  }

  function removeUserWordFrom(loaded: LoadedEngine, word: string): void {
    if (!loaded.added.delete(word)) return;
    loaded.engine.remove(word);
    loaded.cache.set(word, false);
  }

  async function resolveBytes(source: BytesSource): Promise<Uint8Array> {
    return source.kind === "url"
      ? new Uint8Array(await fetchBytes(source.url))
      : new Uint8Array(source.bytes);
  }

  function affSource(source: DictionarySource): BytesSource {
    return source.kind === "url"
      ? { kind: "url", url: source.aff }
      : { kind: "bytes", bytes: source.aff };
  }

  function dicSource(
    source: DictionarySource | ExtraDictionarySource,
  ): BytesSource {
    return source.kind === "url"
      ? { kind: "url", url: source.dic }
      : { kind: "bytes", bytes: source.dic };
  }

  async function loadDictionary(
    id: number,
    lang: string,
    script: Script,
    source: DictionarySource,
    extras: readonly ExtraDictionarySource[] = [],
  ): Promise<void> {
    const t0 = now();
    try {
      const [aff, dic] = await Promise.all([
        resolveBytes(affSource(source)),
        resolveBytes(dicSource(source)),
      ]);
      const extraBytes = await Promise.all(
        extras.map((e) => resolveBytes(dicSource(e))),
      );
      const engine = await factory.create({
        lang,
        script,
        aff,
        dic,
        extras: extraBytes,
      });
      const loaded: LoadedEngine = {
        engine,
        cache: new LruCache(cacheSize),
        added: new Set(),
      };
      for (const word of userWords) addUserWordTo(loaded, word);

      engines.get(lang)?.engine.dispose();
      engines.set(lang, loaded);

      let bytes = aff.byteLength + dic.byteLength;
      for (const e of extraBytes) bytes += e.byteLength;
      post({ type: "dictionaryLoaded", id, lang, ms: now() - t0, bytes });
      requeueDeferred(script, id);
    } catch (error) {
      post({ type: "dictionaryError", id, lang, message: errorMessage(error) });
    }
  }

  function unloadDictionary(lang: string): void {
    const loaded = engines.get(lang);
    if (!loaded) return;
    engines.delete(lang);
    loaded.engine.dispose();
  }

  function normalizeWord(raw: string): string {
    const trimmed = raw.trim();
    return normalizeForLookup(trimmed, scriptOf(trimmed));
  }

  function setUserWords(
    words: readonly string[],
    forbiddenWords: readonly string[],
  ): void {
    const next = new Set<string>();
    for (const raw of words) {
      const w = normalizeWord(raw);
      if (w) next.add(w);
    }
    for (const w of userWords) {
      if (next.has(w)) continue;
      userWords.delete(w);
      for (const loaded of engines.values()) removeUserWordFrom(loaded, w);
    }
    for (const w of next) {
      if (userWords.has(w)) continue;
      userWords.add(w);
      for (const loaded of engines.values()) addUserWordTo(loaded, w);
    }
    forbidden.clear();
    for (const raw of forbiddenWords) {
      const w = normalizeWord(raw);
      if (w) forbidden.add(w);
    }
  }

  // -------------------------------------------------------------------------
  // Checking
  // -------------------------------------------------------------------------

  function inSet(set: ReadonlySet<string>, word: string): boolean {
    if (set.size === 0) return false;
    if (set.has(word)) return true;
    for (const v of caseVariants(word)) if (set.has(v)) return true;
    return false;
  }

  /** Every form a dictionary may store the word under. */
  function candidates(
    word: string,
    script: Script,
    lenientArabic: boolean,
  ): string[] {
    const base = [word, ...caseVariants(word)];
    if (lenientArabic && script === "arab") {
      for (const v of arabicVariants(word)) base.push(v);
    }
    const out = base.slice();
    for (const w of base) for (const c of collapseRepeats(w)) out.push(c);
    return out;
  }

  /** True = correct, false = misspelled, null = no dictionary for this script. */
  function isAccepted(
    word: string,
    script: Script,
    options: CheckOptions,
    ignored: ReadonlySet<string>,
    scriptEngines: readonly LoadedEngine[],
  ): boolean | null {
    if (inSet(forbidden, word)) return false;
    if (inSet(userWords, word) || inSet(ignored, word)) return true;
    if (scriptEngines.length === 0) return null;
    for (const candidate of candidates(word, script, options.lenientArabic)) {
      for (const loaded of scriptEngines)
        if (lookup(loaded, candidate)) return true;
    }
    return false;
  }

  function checkBlock(item: QueueItem): CheckedBlock {
    const { block, options, ignored } = item;
    const tokens = tokenize(
      block.text,
      { skip: block.skip, flagAllCaps: options.flagAllCaps },
      seg,
    );
    const flags: Flag[] = [];
    const deferredScripts = new Set<Script>();
    const enginesByScript = new Map<Script, LoadedEngine[]>();
    for (const token of tokens) {
      let scriptEngines = enginesByScript.get(token.script);
      if (!scriptEngines) {
        scriptEngines = enginesOf(token.script);
        enginesByScript.set(token.script, scriptEngines);
      }
      const verdict = isAccepted(
        token.normalized,
        token.script,
        options,
        ignored,
        scriptEngines,
      );
      if (verdict === null) deferredScripts.add(token.script);
      else if (!verdict) {
        flags.push({
          from: token.from,
          to: token.to,
          word: token.text,
          script: token.script,
        });
      }
    }
    const result: CheckedBlock = {
      blockId: block.blockId,
      version: block.version,
      flags,
    };
    if (deferredScripts.size === 0) {
      deferred.delete(item.key);
      return result;
    }
    deferred.set(item.key, { item, scripts: deferredScripts });
    return { ...result, deferredScripts: [...deferredScripts] };
  }

  function enqueue(item: QueueItem): void {
    const previous = byKey.get(item.key);
    if (previous) previous.dropped = true;
    byKey.set(item.key, item);
    (buckets.get(item.priority) as QueueItem[]).push(item);
  }

  function dequeue(): QueueItem | null {
    for (const priority of PRIORITY_ORDER) {
      const bucket = buckets.get(priority) as QueueItem[];
      while (bucket.length > 0) {
        const item = bucket.shift() as QueueItem;
        if (item.dropped) continue;
        byKey.delete(item.key);
        return item;
      }
    }
    return null;
  }

  function requeueDeferred(script: Script, id: number): void {
    for (const [key, entry] of deferred) {
      if (!entry.scripts.has(script)) continue;
      deferred.delete(key);
      if (byKey.has(key)) continue; // a newer check for the block is already pending
      enqueue({ ...entry.item, dropped: false });
    }
    pump().catch((error: unknown) =>
      post({ type: "error", id, message: errorMessage(error) }),
    );
  }

  function cancel(requestId: number): void {
    for (const [key, item] of byKey) {
      if (item.requestId !== requestId) continue;
      item.dropped = true;
      byKey.delete(key);
    }
    for (const [key, entry] of deferred) {
      if (entry.item.requestId === requestId) deferred.delete(key);
    }
  }

  interface Batch {
    id: number;
    docId: string;
    results: CheckedBlock[];
  }

  function flush(batch: Map<string, Batch>): void {
    for (const group of batch.values()) {
      post({
        type: "checked",
        id: group.id,
        docId: group.docId,
        results: group.results,
      });
    }
    batch.clear();
  }

  function pump(): Promise<void> {
    // `.finally` runs asynchronously, so the reset always happens after the
    // assignment below — even when the queue drains without a single yield.
    if (!pumping) {
      pumping = drainQueue().finally(() => {
        pumping = null;
      });
    }
    return pumping;
  }

  async function drainQueue(): Promise<void> {
    const batch = new Map<string, Batch>();
    for (;;) {
      const start = now();
      let item = dequeue();
      while (item) {
        let result: CheckedBlock;
        try {
          result = checkBlock(item);
        } catch (error) {
          post({
            type: "error",
            id: item.requestId,
            message: errorMessage(error),
          });
          result = {
            blockId: item.block.blockId,
            version: item.block.version,
            flags: [],
          };
        }
        const groupKey = `${item.requestId} ${item.docId}`;
        let group = batch.get(groupKey);
        if (!group) {
          group = { id: item.requestId, docId: item.docId, results: [] };
          batch.set(groupKey, group);
        }
        group.results.push(result);
        if (now() - start >= sliceMs) break;
        item = dequeue();
      }
      flush(batch);
      if (byKey.size === 0) return;
      await yieldToLoop();
    }
  }

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  function suggest(word: string, script: Script, limit: number): string[] {
    const normalized = normalizeForLookup(word, script);
    const seen = new Set<string>();
    const out: string[] = [];
    const collect = (query: string) => {
      for (const loaded of enginesOf(script)) {
        for (const s of loaded.engine.suggest(query, limit)) {
          const cased = matchCase(s, word);
          if (seen.has(cased)) continue;
          seen.add(cased);
          out.push(cased);
        }
      }
    };
    collect(normalized);
    // Engines that are case-sensitive (word lists, the memory engine) only
    // know the lowercase form; ask for it too while there is room.
    for (const variant of caseVariants(normalized)) {
      if (out.length >= limit) break;
      collect(variant);
    }
    return out.slice(0, Math.max(0, limit));
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  return async function handle(msg: SpellRequest): Promise<void> {
    try {
      switch (msg.type) {
        case "init":
          post({ type: "ready", id: msg.id });
          return;
        case "loadDictionary":
          await loadDictionary(
            msg.id,
            msg.lang,
            msg.script,
            msg.source,
            msg.extras,
          );
          return;
        case "unloadDictionary":
          unloadDictionary(msg.lang);
          return;
        case "setUserWords":
          setUserWords(msg.words, msg.forbidden);
          return;
        case "check": {
          const ignored = new Set(msg.options.ignored);
          for (const block of msg.blocks) {
            enqueue({
              key: blockKey(msg.docId, block.blockId),
              requestId: msg.id,
              docId: msg.docId,
              block,
              options: msg.options,
              ignored,
              priority: msg.priority,
              dropped: false,
            });
          }
          await pump();
          return;
        }
        case "suggest":
          post({
            type: "suggestions",
            id: msg.id,
            word: msg.word,
            suggestions: suggest(msg.word, msg.script, msg.limit),
          });
          return;
        case "cancel":
          cancel(msg.id);
          return;
      }
    } catch (error) {
      post({ type: "error", id: msg.id, message: errorMessage(error) });
    }
  };
}
