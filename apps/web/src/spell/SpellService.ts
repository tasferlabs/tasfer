import type { Editor } from "@tasfer/editor";
import type {
  CheckedBlock,
  DictionarySource,
  Script,
  SpellRequest,
  SpellResponse,
  SpellTransport,
} from "@tasfer/spell";
import type { OwnPrefsStore } from "@/app/contexts/OwnPrefsContext";
import { type DictionaryDescriptor, dictionaryUrls } from "./dictionaries";
import { PersonalDictionary, SPELL_PREF_KEYS } from "./personalDictionary";

export type { DictionaryDescriptor } from "./dictionaries";

export type DictionaryStatus = "missing" | "downloading" | "ready" | "error";

/**
 * What `transportFor` hands out: the checker-facing transport plus the
 * release the host must call when the editor goes away (`editor.destroy()`
 * has no hook, so the UI layer that mounts the checker owns this call — do
 * it in the same effect cleanup that destroys the checker). The idle timer
 * that stops the worker only runs while no transport is live.
 */
export interface SpellTransportHandle extends SpellTransport {
  readonly docId: string;
  release(): void;
}

export interface SpellServiceDeps {
  prefs: OwnPrefsStore;
  wasmUrl: string;
  dictionaries: DictionaryDescriptor[];
  /** Test hook; defaults to the Vite module worker `./spell.worker.ts`. */
  createWorker?: () => Worker;
  /** Test hook; defaults to `fetch` — always on the main thread, never in the worker. */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  /** Test hook; idle time before the worker is stopped (default 10 minutes). */
  idleMs?: number;
}

type CheckRequest = Omit<
  Extract<SpellRequest, { type: "check" }>,
  "id" | "type"
>;

type Pending =
  | { kind: "ready"; resolve: () => void; reject: (e: Error) => void }
  | { kind: "dictionary"; resolve: () => void; reject: (e: Error) => void }
  | {
      kind: "check";
      resolve: (r: readonly CheckedBlock[]) => void;
      reject: (e: Error) => void;
    }
  | {
      kind: "suggest";
      resolve: (r: string[]) => void;
      reject: (e: Error) => void;
    };

const DEFAULT_LANGUAGES = ["en", "ar"];
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const SUGGEST_CACHE_SIZE = 500;

class Lru<K, V> {
  private map = new Map<K, V>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

function defaultFetchBytes(url: string): Promise<ArrayBuffer> {
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`spell: ${res.status} fetching ${url}`);
    return res.arrayBuffer();
  });
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL("./spell.worker.ts", import.meta.url), {
    type: "module",
    name: "tasfer-spell",
  });
}

/**
 * The app's one spell worker and everything around it: settings, the personal
 * dictionary, dictionary loading, and per-editor transports.
 *
 * One instance per app (SpellProvider owns it) — never module-global; several
 * editors on one page share it through `transportFor`. The worker starts on
 * the first check while spelling is enabled, loads dictionaries only when a
 * check meets a script that has an enabled-but-unloaded one, and stops after
 * `idleMs` with no live transport. Dictionary and wasm bytes are fetched here
 * on the main thread (so the same code works under file:// and the Capacitor
 * origin) and transferred to the worker, never cloned.
 */
export class SpellService {
  private readonly prefs: OwnPrefsStore;
  private readonly wasmUrl: string;
  private readonly dictionaries: DictionaryDescriptor[];
  private readonly createWorker: () => Worker;
  private readonly fetchBytes: (url: string) => Promise<ArrayBuffer>;
  private readonly idleMs: number;
  readonly personal: PersonalDictionary;

  private worker: Worker | null = null;
  /** Bumped on every worker start/stop so async work from a dead worker is ignored. */
  private generation = 0;
  private initPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private dictStatus = new Map<string, DictionaryStatus>();
  private dictLoads = new Map<string, Promise<void>>();

  private transports = new Set<TransportImpl>();
  private byEditor = new Map<Editor, TransportImpl>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private suggestCache = new Lru<string, string[]>(SUGGEST_CACHE_SIZE);
  private flagCounts = new Map<string, number>();
  private listeners = new Set<() => void>();

  private active = false;
  private unsubPrefs: (() => void) | null = null;
  private unsubPersonal: (() => void) | null = null;
  private lastSettings = "";

  constructor(deps: SpellServiceDeps) {
    this.prefs = deps.prefs;
    this.wasmUrl = deps.wasmUrl;
    this.dictionaries = deps.dictionaries;
    this.createWorker = deps.createWorker ?? defaultCreateWorker;
    this.fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.personal = new PersonalDictionary(deps.prefs);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Start watching settings and the personal dictionary. Idempotent; every public entry point calls it. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.lastSettings = this.settingsSignature();
    this.unsubPrefs = this.prefs.subscribe(() => this.onPrefsChange());
    this.unsubPersonal = this.personal.subscribe((diff) => {
      this.suggestCache.clear();
      if (this.worker) this.pushUserWords();
      this.invalidateAll([...diff.added, ...diff.removed]);
      this.emit();
    });
  }

  /** Stop the worker and detach from the stores. Reversible: the next call re-activates. */
  dispose(): void {
    this.unsubPrefs?.();
    this.unsubPersonal?.();
    this.unsubPrefs = null;
    this.unsubPersonal = null;
    this.active = false;
    this.stopWorker();
  }

  // ----------------------------------------------------------------- settings

  enabled(): boolean {
    return this.prefs.get<boolean>(SPELL_PREF_KEYS.enabled, true) !== false;
  }

  /** Enabled dictionary ids, in preference order. */
  languages(): string[] {
    const raw = this.prefs.get<unknown>(
      SPELL_PREF_KEYS.languages,
      DEFAULT_LANGUAGES,
    );
    return Array.isArray(raw)
      ? raw.filter((l): l is string => typeof l === "string")
      : [...DEFAULT_LANGUAGES];
  }

  lenientArabic(): boolean {
    return (
      this.prefs.get<boolean>(SPELL_PREF_KEYS.lenientArabic, false) === true
    );
  }

  flagAllCaps(): boolean {
    return this.prefs.get<boolean>(SPELL_PREF_KEYS.flagAllCaps, false) === true;
  }

  highContrast(): boolean {
    return (
      this.prefs.get<boolean>(SPELL_PREF_KEYS.highContrast, false) === true
    );
  }

  setEnabled(on: boolean): void {
    this.activate();
    this.prefs.set(SPELL_PREF_KEYS.enabled, on);
  }

  availableDictionaries(): readonly DictionaryDescriptor[] {
    return this.dictionaries;
  }

  async enableLanguage(lang: string): Promise<void> {
    this.activate();
    const langs = this.languages();
    if (!langs.includes(lang)) {
      this.prefs.set(SPELL_PREF_KEYS.languages, [...langs, lang]);
    }
    if (this.worker) await this.ensureLoaded(lang);
  }

  async disableLanguage(lang: string): Promise<void> {
    this.activate();
    const langs = this.languages();
    if (langs.includes(lang)) {
      this.prefs.set(
        SPELL_PREF_KEYS.languages,
        langs.filter((l) => l !== lang),
      );
    }
    this.unload(lang);
  }

  // ------------------------------------------------------------- dictionaries

  /** Whether `lang` is loaded in the running worker. Resets to "missing" whenever the worker stops. */
  status(lang: string): DictionaryStatus {
    return this.dictStatus.get(lang) ?? "missing";
  }

  /** Fetch and load a dictionary into the worker (starting it if needed). Resolves when it is ready. */
  ensureLoaded(lang: string): Promise<void> {
    this.activate();
    const existing = this.dictLoads.get(lang);
    if (existing) return existing;
    if (this.status(lang) === "ready") return Promise.resolve();
    const descriptor = this.dictionaries.find((d) => d.id === lang);
    if (!descriptor) {
      return Promise.reject(new Error(`spell: unknown dictionary ${lang}`));
    }

    // `ready()` starts the worker (bumping the generation) when none runs;
    // read the generation after that so a restart during the fetch is seen.
    const readyPromise = this.ready();
    const generation = this.generation;
    // Definite-assignment: only read inside the async body, after assignment.
    let load!: Promise<void>;
    load = (async () => {
      this.setStatus(lang, "downloading");
      try {
        const urls = dictionaryUrls(descriptor);
        const [, aff, dic] = await Promise.all([
          readyPromise,
          this.fetchBytes(urls.aff),
          this.fetchBytes(urls.dic),
        ]);
        if (this.generation !== generation) {
          throw new Error("spell: worker restarted");
        }
        const source: DictionarySource = { kind: "bytes", aff, dic };
        await this.request(
          { type: "loadDictionary", lang, script: descriptor.script, source },
          "dictionary",
          [aff, dic],
        );
        if (this.generation !== generation) {
          throw new Error("spell: worker restarted");
        }
        this.suggestCache.clear();
        this.setStatus(lang, "ready");
        this.invalidateAll();
      } catch (err) {
        if (this.generation === generation && this.worker) {
          console.warn(`[spell] could not load dictionary ${lang}:`, err);
          this.setStatus(lang, "error");
        } else {
          this.setStatus(lang, "missing");
        }
        throw err;
      } finally {
        if (this.dictLoads.get(lang) === load) this.dictLoads.delete(lang);
      }
    })();
    // Fire-and-forget callers must not surface an unhandled rejection; the
    // status carries the outcome.
    load.catch(() => {});
    this.dictLoads.set(lang, load);
    return load;
  }

  private unload(lang: string): void {
    if (this.status(lang) === "missing") return;
    if (this.worker) {
      this.post({ type: "unloadDictionary", id: this.nextId++, lang });
    }
    this.suggestCache.clear();
    this.setStatus(lang, "missing");
    this.invalidateAll();
  }

  private setStatus(lang: string, status: DictionaryStatus): void {
    if (this.status(lang) === status) return;
    if (status === "missing") this.dictStatus.delete(lang);
    else this.dictStatus.set(lang, status);
    this.emit();
  }

  /** The first enabled dictionary of `script` that is not loaded (nor failed), if any. */
  private loadableFor(script: Script): DictionaryDescriptor | undefined {
    const enabled = this.languages();
    return this.dictionaries.find(
      (d) =>
        d.script === script &&
        enabled.includes(d.id) &&
        this.status(d.id) === "missing",
    );
  }

  // --------------------------------------------------------------- transports

  /**
   * The transport for `editor` (one per editor; repeat calls return the same
   * handle). Call `release()` when the editor is destroyed.
   */
  transportFor(editor: Editor, docId: string): SpellTransportHandle {
    this.activate();
    const existing = this.byEditor.get(editor);
    if (existing) return existing;
    const transport: TransportImpl = new TransportImpl(this, docId, () => {
      this.transports.delete(transport);
      if (this.byEditor.get(editor) === transport) this.byEditor.delete(editor);
      this.scheduleIdle();
    });
    this.transports.add(transport);
    this.byEditor.set(editor, transport);
    this.clearIdle();
    return transport;
  }

  /** @internal Transport entry point. */
  async check(req: CheckRequest): Promise<readonly CheckedBlock[]> {
    if (!this.enabled()) {
      return req.blocks.map((b) => ({
        blockId: b.blockId,
        version: b.version,
        flags: [],
      }));
    }
    await this.ready();
    const results = await this.request({ type: "check", ...req }, "check");
    for (const block of results) {
      if (!block.deferredScripts) continue;
      for (const script of block.deferredScripts) {
        const d = this.loadableFor(script);
        if (d && !this.dictLoads.has(d.id)) void this.ensureLoaded(d.id);
      }
    }
    return results;
  }

  /** @internal Transport entry point. */
  async suggest(
    word: string,
    script: Script,
    limit: number,
  ): Promise<string[]> {
    if (!this.enabled()) return [];
    const key = `${script} ${limit} ${word}`;
    const cached = this.suggestCache.get(key);
    if (cached) return cached;
    await this.ready();
    const result = await this.request(
      { type: "suggest", word, script, limit },
      "suggest",
    );
    this.suggestCache.set(key, result);
    return result;
  }

  /** Fire every live transport's invalidate callbacks (`words` narrows the rescan when known). */
  private invalidateAll(words?: readonly string[]): void {
    for (const t of this.transports) t.invalidate(words);
  }

  // ------------------------------------------------------------------- counts

  reportFlagCount(docId: string, count: number): void {
    if (this.flagCounts.get(docId) === count) return;
    if (count === 0) {
      if (!this.flagCounts.has(docId)) return;
      this.flagCounts.delete(docId);
    } else {
      this.flagCounts.set(docId, count);
    }
    this.emit();
  }

  flagCount(docId: string): number {
    return this.flagCounts.get(docId) ?? 0;
  }

  // ------------------------------------------------------------ personal words

  async addWord(word: string): Promise<void> {
    this.activate();
    this.personal.add(word);
  }

  async removeWord(word: string): Promise<void> {
    this.activate();
    this.personal.remove(word);
  }

  hasWord(word: string): boolean {
    return this.personal.has(word);
  }

  words(): string[] {
    return this.personal.words();
  }

  exportWords(): string {
    return this.personal.exportText();
  }

  async importWords(text: string): Promise<{ added: number; skipped: number }> {
    this.activate();
    return this.personal.importText(text);
  }

  // ---------------------------------------------------------------- observers

  /** Any status, setting, personal-word or flag-count change. */
  subscribe(cb: () => void): () => void {
    this.activate();
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Diagnostic: is a worker running right now? */
  get running(): boolean {
    return this.worker !== null;
  }

  // ------------------------------------------------------------------- worker

  private ready(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    const generation = ++this.generation;
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<SpellResponse>) => {
      if (this.worker === worker) this.onMessage(e.data);
    };
    worker.onerror = (e) => {
      if (this.worker !== worker) return;
      console.warn("[spell] worker failed:", e.message ?? e);
      this.stopWorker(new Error(e.message ?? "spell worker failed"));
    };
    const init = (async () => {
      const wasm = await this.fetchBytes(this.wasmUrl);
      if (this.generation !== generation) {
        throw new Error("spell: worker restarted");
      }
      await this.request({ type: "init", wasm }, "ready", [wasm]);
      if (this.generation !== generation) {
        throw new Error("spell: worker restarted");
      }
      this.pushUserWords();
    })();
    init.catch((err) => {
      if (this.generation === generation) {
        console.warn("[spell] could not start:", err);
        this.stopWorker(err instanceof Error ? err : new Error(String(err)));
      }
    });
    this.initPromise = init;
    this.scheduleIdle();
    return init;
  }

  private stopWorker(reason?: Error): void {
    this.clearIdle();
    const worker = this.worker;
    if (!worker) return;
    this.generation++;
    this.worker = null;
    this.initPromise = null;
    worker.terminate();
    const error = reason ?? new Error("spell: worker stopped");
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.dictLoads.clear();
    this.suggestCache.clear();
    if (this.dictStatus.size > 0) {
      this.dictStatus.clear();
      this.emit();
    }
  }

  private pushUserWords(): void {
    this.post({
      type: "setUserWords",
      id: this.nextId++,
      words: this.personal.words(),
      forbidden: this.personal.forbidden(),
    });
  }

  private post(msg: SpellRequest, transfer?: Transferable[]): void {
    if (!this.worker) return;
    if (transfer && transfer.length > 0) this.worker.postMessage(msg, transfer);
    else this.worker.postMessage(msg);
  }

  private request(
    msg: Omit<Extract<SpellRequest, { type: "init" }>, "id">,
    kind: "ready",
    transfer?: Transferable[],
  ): Promise<void>;
  private request(
    msg: Omit<Extract<SpellRequest, { type: "loadDictionary" }>, "id">,
    kind: "dictionary",
    transfer?: Transferable[],
  ): Promise<void>;
  private request(
    msg: Omit<Extract<SpellRequest, { type: "check" }>, "id">,
    kind: "check",
  ): Promise<readonly CheckedBlock[]>;
  private request(
    msg: Omit<Extract<SpellRequest, { type: "suggest" }>, "id">,
    kind: "suggest",
  ): Promise<string[]>;
  private request(
    msg: Omit<SpellRequest, "id">,
    kind: Pending["kind"],
    transfer?: Transferable[],
  ): Promise<unknown> {
    if (!this.worker) {
      return Promise.reject(new Error("spell: worker not running"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { kind, resolve, reject } as Pending);
      this.post({ ...msg, id } as SpellRequest, transfer);
    });
  }

  private onMessage(msg: SpellResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    switch (msg.type) {
      case "ready":
      case "dictionaryLoaded":
        if (p.kind === "ready" || p.kind === "dictionary") p.resolve();
        return;
      case "checked":
        if (p.kind === "check") p.resolve(msg.results);
        return;
      case "suggestions":
        if (p.kind === "suggest") p.resolve([...msg.suggestions]);
        return;
      case "dictionaryError":
      case "error":
        p.reject(new Error(msg.message));
        return;
    }
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (!this.worker || this.transports.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.transports.size === 0) this.stopWorker();
    }, this.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ----------------------------------------------------------------- settings

  private settingsSignature(): string {
    return JSON.stringify([
      this.enabled(),
      this.languages(),
      this.lenientArabic(),
      this.flagAllCaps(),
      this.highContrast(),
    ]);
  }

  private onPrefsChange(): void {
    const next = this.settingsSignature();
    if (next === this.lastSettings) return;
    const [wasEnabled, prevLangs] = JSON.parse(this.lastSettings) as [
      boolean,
      string[],
    ];
    this.lastSettings = next;
    const nowEnabled = this.enabled();
    if (wasEnabled && !nowEnabled) {
      this.stopWorker();
    } else if (this.worker) {
      const langs = this.languages();
      for (const lang of prevLangs)
        if (!langs.includes(lang)) this.unload(lang);
    }
    // Checkers rescan: a turned-off service returns no flags, new options
    // change what counts as a mistake, and a newly enabled language shows up
    // as `deferredScripts` on the next pass, which triggers its load.
    this.invalidateAll();
    this.emit();
  }
}

class TransportImpl implements SpellTransportHandle {
  private callbacks = new Set<(words?: readonly string[]) => void>();
  private released = false;
  private readonly service: SpellService;
  readonly docId: string;
  private readonly onRelease: () => void;

  constructor(service: SpellService, docId: string, onRelease: () => void) {
    this.service = service;
    this.docId = docId;
    this.onRelease = onRelease;
  }

  check(req: CheckRequest) {
    return this.service.check(req);
  }

  suggest(word: string, script: Script, limit: number) {
    return this.service.suggest(word, script, limit);
  }

  onInvalidate(cb: (words?: readonly string[]) => void): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  /** @internal */
  invalidate(words?: readonly string[]): void {
    for (const cb of this.callbacks) cb(words);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.callbacks.clear();
    this.onRelease();
  }
}
