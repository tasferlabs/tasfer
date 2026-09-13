import {
  declaredCharset,
  decoderFor,
  type Script,
  scriptOf,
  wordListToDic,
} from "@tasfer/spell";
import type { OwnPrefsStore } from "@/app/contexts/OwnPrefsContext";
import type { FsDriver } from "@/platform/driver";
import type { Platform } from "@/platform/types";
import { SPELL_PREF_KEYS } from "./personalDictionary";

/**
 * Dictionaries the person added themselves: a Hunspell `.aff`/`.dic` pair or a
 * plain word list.
 *
 * These follow the person, not the machine. The split is what makes that
 * affordable: the descriptor goes into own-prefs, one key per dictionary, and
 * the files go into the content-addressed asset store, which already knows how
 * to pull bytes by hash from whichever of this person's devices has them. A
 * pref is re-sent on every handshake, so the megabytes have to travel by the
 * channel built for megabytes.
 *
 * A device that has the descriptor but not the files is a normal state, not an
 * error: it says "on your other devices" and fetches them the first time
 * something needs checking (see {@link UserDictionaryStore.read}).
 *
 * A word list is kept in its original form and converted with `wordListToDic`
 * on every read, so re-importing the same file is idempotent and the cspell
 * markers (`!word`, `~word`) keep their meaning after an upgrade.
 */

/** localStorage key a pre-sync build kept its descriptor array under. */
export const IMPORTED_DICTS_KEY = "tasfer.spell.dicts";

/** Directory a pre-sync build wrote imported files to, read once by `adopt`. */
const DICT_DIR = "spell/dicts";

/** Largest file we accept, per file. Ayaspell's own `.dic` is about 7 MB. */
export const MAX_DICTIONARY_BYTES = 32 * 1024 * 1024;

/**
 * A word list this big goes in as its own dictionary rather than into the
 * synced personal list, which is one own-prefs key per word.
 */
export const PERSONAL_LIST_CAP = 5000;

/** A stored dictionary and the id it is filed under. */
export interface ImportedDictionary extends SyncedDictionary {
  /** Also the `lang` the worker keys the engine on; never `"en"`/`"ar"`. */
  readonly id: string;
}

/** Bytes plus the name they arrived under (a `File` satisfies neither half alone). */
export interface ImportBytes {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Why an import was refused. The UI maps these to messages; never show the code. */
export type ImportProblem =
  "tooLarge" | "empty" | "notAff" | "notDic" | "noWords";

export class DictionaryImportError extends Error {
  readonly problem: ImportProblem;
  constructor(problem: ImportProblem) {
    super(`spell: dictionary import failed (${problem})`);
    this.name = "DictionaryImportError";
    this.problem = problem;
  }
}

// ---------------------------------------------------------------- inspection

const AFF_KEYWORD_RE = /^[ \t]*(SET|TRY|SFX|PFX|FLAG|WORDCHARS|LANG|IGNORE)\b/m;
const LANG_RE = /^[ \t]*LANG[ \t]+(\S+)/m;

/**
 * Decode the first `limit` bytes. The default is latin1, which never throws
 * and leaves the ASCII directives (`SET`, `LANG`, an entry count) readable
 * whatever the real encoding is; pass the charset the `.aff` declared when
 * the words themselves matter.
 */
function head(bytes: Uint8Array, limit = 65536, charset = "latin1"): string {
  return decoderFor(charset).decode(
    bytes.subarray(0, Math.min(bytes.length, limit)),
  );
}

/**
 * Does this look like an affix file? Hunspell tolerates an `.aff` with no
 * `SET`, so any of the directives that only ever appear in one counts.
 */
export function looksLikeAff(bytes: Uint8Array): boolean {
  return AFF_KEYWORD_RE.test(head(bytes));
}

/** A `.dic` starts with its entry count on the first non-empty line. */
export function looksLikeDic(bytes: Uint8Array): boolean {
  for (const line of head(bytes, 4096, "utf-8").split(/\r?\n/)) {
    const trimmed = line.replace(/^\uFEFF/, "").trim();
    if (!trimmed) continue;
    return /^\d+$/.test(trimmed);
  }
  return false;
}

/** The `.aff`'s declared language (`LANG ar_SA` → `ar`), or "" when it declares none. */
export function declaredLanguage(aff: Uint8Array): string {
  const match = LANG_RE.exec(head(aff));
  if (!match) return "";
  return match[1].replace(/_.*$/, "").toLowerCase();
}

/**
 * The script of a dictionary body: the commonest script among its first
 * entries, ignoring the count line, flags after `/` and morphology fields.
 * `mixed`/`other` tokens do not vote — they are never checked anyway.
 * `charset` is what the `.aff` declared; a word list is always read as UTF-8.
 */
export function inferScript(
  dic: Uint8Array,
  sample = 200,
  charset = "utf-8",
): Script {
  const text = head(dic, 64 * 1024, charset);
  const counts = new Map<Script, number>();
  let seen = 0;
  let first = true;
  for (const raw of text.split(/\r?\n/)) {
    if (seen >= sample) break;
    const line = raw.replace(/^\uFEFF/, "").trim();
    if (!line) continue;
    if (first) {
      first = false;
      if (/^\d+$/.test(line)) continue;
    }
    const word = line.split(/[\s/]/)[0];
    if (!word) continue;
    seen++;
    const script = scriptOf(word);
    if (script === "mixed" || script === "other") continue;
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  let best: Script = "latn";
  let bestCount = 0;
  for (const [script, count] of counts) {
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

/** The language we suggest when the file declares none. */
function languageForScript(script: Script): string {
  return script === "arab" ? "ar" : script === "latn" ? "en" : "";
}

/** Strip the extension from a file name, for the default label. */
function labelFromName(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim() || name;
}

/**
 * What an imported pair or list would become — the dialog shows this before
 * anything is written, and hands back whatever the person edited.
 */
export function inspectPair(
  aff: ImportBytes,
  dic: ImportBytes,
): { label: string; lang: string; script: Script } {
  if (aff.bytes.length === 0 || dic.bytes.length === 0) {
    throw new DictionaryImportError("empty");
  }
  if (
    aff.bytes.length > MAX_DICTIONARY_BYTES ||
    dic.bytes.length > MAX_DICTIONARY_BYTES
  ) {
    throw new DictionaryImportError("tooLarge");
  }
  if (!looksLikeAff(aff.bytes)) throw new DictionaryImportError("notAff");
  if (!looksLikeDic(dic.bytes)) throw new DictionaryImportError("notDic");
  // A pre-Unicode dictionary declares its encoding in the `.aff`; without it
  // the Arabic in an ISO-8859-6 `.dic` would read as Latin punctuation.
  const script = inferScript(dic.bytes, 200, declaredCharset(aff.bytes));
  return {
    label: labelFromName(dic.name),
    lang: declaredLanguage(aff.bytes) || languageForScript(script),
    script,
  };
}

export function inspectList(list: ImportBytes): {
  label: string;
  lang: string;
  script: Script;
  words: number;
} {
  if (list.bytes.length === 0) throw new DictionaryImportError("empty");
  if (list.bytes.length > MAX_DICTIONARY_BYTES) {
    throw new DictionaryImportError("tooLarge");
  }
  const text = new TextDecoder("utf-8").decode(list.bytes);
  const { dic, forbidden } = wordListToDic(text.split(/\r?\n|\r/));
  const words = countWords(dic) + forbidden.length;
  if (words === 0) throw new DictionaryImportError("noWords");
  const script = inferScript(dic);
  return {
    label: labelFromName(list.name),
    lang: languageForScript(script),
    script,
    words,
  };
}

/** Entry count from a generated `.dic` (its first line). */
function countWords(dic: Uint8Array): number {
  const firstLine = head(dic, 64).split("\n")[0]?.trim() ?? "";
  return /^\d+$/.test(firstLine) ? Number(firstLine) : 0;
}

/** Words in a `.txt` list, counted the way `wordListToDic` counts them. */
export function wordListSize(text: string): number {
  const { dic, forbidden } = wordListToDic(text.split(/\r?\n|\r/));
  return countWords(dic) + forbidden.length;
}

// -------------------------------------------------------------------- store

/**
 * What own-prefs holds for one imported dictionary: everything about it except
 * the bytes, which live in the asset store under the hashes named here.
 *
 * Remote input — a device running a newer build writes this key too — so
 * {@link parseDescriptor} validates every field rather than trusting the shape.
 */
export interface SyncedDictionary {
  /** What the person called it. Shown as typed — not an i18n key. */
  readonly label: string;
  /** BCP-47-ish language tag, from the `.aff`'s `LANG` or inferred. May be "". */
  readonly lang: string;
  readonly script: Script;
  readonly kind: "pair" | "list";
  /** Bytes of the original files, for the settings row. */
  readonly bytes: number;
  readonly importedAt: number;
  /** Content hash of the `.aff` (pair only). */
  readonly aff?: string;
  /** Content hash of the `.dic` (pair only). */
  readonly dic?: string;
  /** Content hash of the word list, kept in its original form (list only). */
  readonly words?: string;
}

/** Whether this device can open a dictionary without asking anyone. */
export type DictionaryPresence = "here" | "elsewhere" | "unknown";

/**
 * The asset-store operations a dictionary needs, narrowed so tests need no
 * platform. `get` is the one that crosses the network: it answers from disk
 * when it can and otherwise pulls the bytes from whichever of this person's
 * devices has them.
 */
export interface DictionaryAssets {
  /** Store bytes under their content hash and return it. Idempotent. */
  put(bytes: Uint8Array, ext: string): Promise<string>;
  /** Bytes for a hash, pulling from a peer if this device lacks them. Null when nobody has them. */
  get(hash: string): Promise<Uint8Array | null>;
  /** Is it on THIS device? Never asks a peer. */
  has(hash: string): Promise<boolean>;
  /** Forget this device's copy. Local only — it does not replicate. */
  drop(hash: string): Promise<void>;
}

/** The slice of `Storage` we use, so tests need no DOM. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where a pre-sync build kept its imports, for {@link UserDictionaryStore.adopt}. */
export interface LegacyImports {
  fs: FsDriver;
  storage: KeyValueStorage | null;
}

function isScript(value: unknown): value is Script {
  return (
    value === "latn" ||
    value === "arab" ||
    value === "other" ||
    value === "mixed"
  );
}

/** A hash we would put in a filesystem path: reject anything that is not one. */
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Read one `spell.dict.<id>` value, or null when it is a tombstone or is not a
 * descriptor this build can use. A dictionary missing the hashes for its own
 * kind is unusable, so it is dropped rather than shown as a row that can never
 * load.
 */
export function parseDescriptor(value: unknown): SyncedDictionary | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (d.kind !== "pair" && d.kind !== "list") return null;
  if (!isScript(d.script)) return null;
  const base = {
    label: typeof d.label === "string" ? d.label : "",
    lang: typeof d.lang === "string" ? d.lang : "",
    script: d.script,
    bytes: typeof d.bytes === "number" ? d.bytes : 0,
    importedAt: typeof d.importedAt === "number" ? d.importedAt : 0,
  };
  if (d.kind === "list") {
    if (!isHash(d.words)) return null;
    return { ...base, kind: "list", words: d.words };
  }
  if (!isHash(d.aff) || !isHash(d.dic)) return null;
  return { ...base, kind: "pair", aff: d.aff, dic: d.dic };
}

/** The asset hashes a descriptor names, in no particular order. */
function hashesOf(d: SyncedDictionary): string[] {
  return d.kind === "list" ? [d.words!] : [d.aff!, d.dic!];
}

/** Ids are pref-key suffixes and worker engine keys: keep them opaque and safe. */
function newId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `u_${Date.now().toString(36)}_${random}`;
}

/** Ids arrive from another device: they end up in a pref key, so bound them. */
function isId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export class UserDictionaryStore {
  private readonly prefs: OwnPrefsStore;
  private readonly assets: DictionaryAssets;
  private readonly legacy: LegacyImports | null;
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;

  /** `list()`'s answer, kept until the prefs snapshot it was derived from is replaced. */
  private cache: { from: unknown; value: ImportedDictionary[] } | null = null;
  private presenceById = new Map<string, DictionaryPresence>();
  /** Guards against two overlapping presence sweeps reporting out of order. */
  private presenceRun = 0;

  constructor(deps: {
    prefs: OwnPrefsStore;
    assets: DictionaryAssets;
    /** Only for adopting pre-sync imports; omit where there is no filesystem. */
    legacy?: LegacyImports;
  }) {
    this.prefs = deps.prefs;
    this.assets = deps.assets;
    this.legacy = deps.legacy ?? null;
    this.unsubscribe = this.prefs.subscribe(() => this.onPrefsChange());
    // The register may already have been read before this store existed, in
    // which case no change is coming to trigger the first sweep.
    this.refreshPresence();
  }

  /** Stop tracking own-prefs. The store is inert afterwards. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  /**
   * Descriptors, oldest first. Derived from the prefs snapshot, so a
   * dictionary added on another device is simply here on the next read.
   */
  list(): ImportedDictionary[] {
    const snapshot = this.prefs.getSnapshot();
    if (this.cache?.from === snapshot) return this.cache.value;
    const prefix = SPELL_PREF_KEYS.dictPrefix;
    const out: ImportedDictionary[] = [];
    for (const key in snapshot.values) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (!isId(id)) continue;
      const descriptor = parseDescriptor(snapshot.values[key]);
      if (!descriptor) continue;
      out.push({ id, ...descriptor, label: descriptor.label || id });
    }
    out.sort((a, b) => a.importedAt - b.importedAt || (a.id < b.id ? -1 : 1));
    this.cache = { from: snapshot, value: out };
    return out;
  }

  get(id: string): ImportedDictionary | undefined {
    return this.list().find((d) => d.id === id);
  }

  /**
   * Whether this device holds the files. "unknown" until the first sweep
   * lands, which is why the settings row treats it as "still working it out"
   * rather than as bad news.
   */
  presence(id: string): DictionaryPresence {
    return this.presenceById.get(id) ?? "unknown";
  }

  /** Store a Hunspell pair. `meta` overrides what {@link inspectPair} inferred. */
  async importPair(
    aff: ImportBytes,
    dic: ImportBytes,
    meta: Partial<Pick<ImportedDictionary, "label" | "lang" | "script">> = {},
  ): Promise<ImportedDictionary> {
    const inferred = inspectPair(aff, dic);
    const [affHash, dicHash] = await Promise.all([
      this.assets.put(aff.bytes, "aff"),
      this.assets.put(dic.bytes, "dic"),
    ]);
    return this.add({
      label: meta.label?.trim() || inferred.label,
      lang: meta.lang ?? inferred.lang,
      script: meta.script ?? inferred.script,
      kind: "pair",
      bytes: aff.bytes.length + dic.bytes.length,
      importedAt: Date.now(),
      aff: affHash,
      dic: dicHash,
    });
  }

  /** Store a plain word list; it is converted to a `.dic` on every read. */
  async importList(
    list: ImportBytes,
    meta: Partial<Pick<ImportedDictionary, "label" | "lang" | "script">> = {},
  ): Promise<ImportedDictionary> {
    const inferred = inspectList(list);
    const hash = await this.assets.put(list.bytes, "txt");
    return this.add({
      label: meta.label?.trim() || inferred.label,
      lang: meta.lang ?? inferred.lang,
      script: meta.script ?? inferred.script,
      kind: "list",
      bytes: list.bytes.length,
      importedAt: Date.now(),
      words: hash,
    });
  }

  /**
   * The bytes to hand the worker, or null when no device that has them is
   * reachable. This is also how a dictionary added elsewhere arrives: `get`
   * pulls it from the sibling that holds it, so loading a dictionary and
   * fetching one are the same call.
   *
   * Word lists also report their `!word` entries, which stay flagged everywhere.
   */
  async read(id: string): Promise<{
    aff: Uint8Array;
    dic: Uint8Array;
    forbidden: readonly string[];
  } | null> {
    const descriptor = this.get(id);
    if (!descriptor) return null;

    if (descriptor.kind === "list") {
      const bytes = await this.assets.get(descriptor.words!);
      if (!bytes) return this.notePresence(id, "elsewhere");
      const text = new TextDecoder("utf-8").decode(bytes);
      const { aff, dic, forbidden } = wordListToDic(text.split(/\r?\n|\r/));
      this.notePresence(id, "here");
      return { aff, dic, forbidden };
    }

    const [aff, dic] = await Promise.all([
      this.assets.get(descriptor.aff!),
      this.assets.get(descriptor.dic!),
    ]);
    if (!aff || !dic) return this.notePresence(id, "elsewhere");
    this.notePresence(id, "here");
    return { aff, dic, forbidden: [] };
  }

  /**
   * Forget a dictionary everywhere. The tombstone is what travels; each device
   * drops its own copy of the bytes when it sees the descriptor go.
   */
  async remove(id: string): Promise<void> {
    const descriptor = this.get(id);
    if (!descriptor) return;
    this.prefs.set(SPELL_PREF_KEYS.dictPrefix + id, null);
    await this.dropBytes(descriptor, id);
  }

  /** Rename or relabel an existing dictionary, on every device. */
  update(
    id: string,
    patch: Partial<Pick<ImportedDictionary, "label" | "lang" | "script">>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    const { id: _id, ...descriptor } = current;
    this.prefs.set(SPELL_PREF_KEYS.dictPrefix + id, {
      ...descriptor,
      label: patch.label?.trim() || current.label,
      lang: patch.lang ?? current.lang,
      script: patch.script ?? current.script,
    } satisfies SyncedDictionary);
  }

  /** Fires after any add, update or removal — from this device or another one. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Move imports made before dictionaries synced into the register.
   *
   * The bytes go into the asset store (which is what lets a sibling pull them)
   * and the descriptor is *seeded*, not set, so a device that adopts an old
   * copy of a dictionary cannot outrank the same dictionary's later removal
   * somewhere else. Call once, after the first prefs read has landed.
   */
  async adopt(): Promise<void> {
    const legacy = this.legacy;
    if (!legacy?.storage) return;
    let raw: string | null = null;
    try {
      raw = legacy.storage.getItem(IMPORTED_DICTS_KEY);
    } catch {
      return; // Storage unavailable (private mode) — nothing to adopt.
    }
    if (raw === null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed)) {
      this.forgetLegacy(legacy);
      return;
    }

    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const d = entry as Record<string, unknown>;
      const id = typeof d.id === "string" ? d.id : "";
      if (!id || !isId(id)) continue;
      if (d.kind !== "pair" && d.kind !== "list") continue;
      if (!isScript(d.script)) continue;
      try {
        const descriptor = await this.adoptOne(legacy, id, d, d.kind, d.script);
        if (!descriptor) continue;
        await this.prefs.seed(SPELL_PREF_KEYS.dictPrefix + id, descriptor);
      } catch (err) {
        // Left in place for the next launch: a half-adopted dictionary whose
        // files we deleted would be a row nobody can ever load.
        console.warn(`[spell] could not adopt dictionary ${id}:`, err);
        return;
      }
    }
    this.forgetLegacy(legacy);
    this.refreshPresence();
    this.emit();
  }

  // ------------------------------------------------------------------ private

  /** Read one legacy dictionary's files off disk and into the asset store. */
  private async adoptOne(
    legacy: LegacyImports,
    id: string,
    d: Record<string, unknown>,
    kind: "pair" | "list",
    script: Script,
  ): Promise<SyncedDictionary | null> {
    const base = {
      label: typeof d.label === "string" && d.label ? d.label : id,
      lang: typeof d.lang === "string" ? d.lang : "",
      script,
      bytes: typeof d.bytes === "number" ? d.bytes : 0,
      importedAt: typeof d.importedAt === "number" ? d.importedAt : 0,
    };
    if (kind === "list") {
      const bytes = await legacy.fs.read(`${DICT_DIR}/${id}/words.txt`);
      if (!bytes) return null;
      return { ...base, kind, words: await this.assets.put(bytes, "txt") };
    }
    const [aff, dic] = await Promise.all([
      legacy.fs.read(`${DICT_DIR}/${id}/index.aff`),
      legacy.fs.read(`${DICT_DIR}/${id}/index.dic`),
    ]);
    if (!aff || !dic) return null;
    const [affHash, dicHash] = await Promise.all([
      this.assets.put(aff, "aff"),
      this.assets.put(dic, "dic"),
    ]);
    return { ...base, kind, aff: affHash, dic: dicHash };
  }

  /**
   * Drop the browser-stored list once every entry has been dealt with. The
   * files under `spell/dicts/` are left alone: their bytes are in the asset
   * store now, and deleting a tree the driver has no recursive delete for is
   * not worth a half-finished sweep on a device that closes mid-way.
   */
  private forgetLegacy(legacy: LegacyImports): void {
    try {
      legacy.storage?.removeItem(IMPORTED_DICTS_KEY);
    } catch {
      // Next launch re-runs the adoption, which seeds nothing the second time.
    }
  }

  private async add(descriptor: SyncedDictionary): Promise<ImportedDictionary> {
    const id = newId();
    this.prefs.set(SPELL_PREF_KEYS.dictPrefix + id, descriptor);
    this.notePresence(id, "here");
    return { id, ...descriptor };
  }

  /**
   * Delete this device's copy of a removed dictionary's bytes, unless some
   * dictionary still standing names the same hash — identical files share one
   * asset, so the last reference is the one that may delete it.
   */
  private async dropBytes(
    descriptor: SyncedDictionary,
    removedId: string,
  ): Promise<void> {
    const stillUsed = new Set<string>();
    for (const other of this.list()) {
      if (other.id === removedId) continue;
      for (const hash of hashesOf(other)) stillUsed.add(hash);
    }
    this.presenceById.delete(removedId);
    for (const hash of hashesOf(descriptor)) {
      if (stillUsed.has(hash)) continue;
      try {
        await this.assets.drop(hash);
      } catch (err) {
        // Wasted disk, nothing worse: the descriptor is already gone.
        console.warn(`[spell] could not delete dictionary bytes:`, err);
      }
    }
  }

  /**
   * A `spell.dict.*` key changed — here, or on a device that just reached us.
   * Additions and removals both land through this one path, so a dictionary
   * arriving from a sibling is indistinguishable from one added locally.
   */
  private onPrefsChange(): void {
    const before = this.cache?.value;
    const after = this.list();
    if (before && sameDictionaries(before, after)) return;

    if (before) {
      const live = new Set(after.map((d) => d.id));
      for (const gone of before) {
        if (live.has(gone.id)) continue;
        void this.dropBytes(gone, gone.id);
      }
    }
    this.refreshPresence();
    this.emit();
  }

  /**
   * Ask the asset store which dictionaries this device can already open.
   * Local-only, so it costs a directory listing and never a round trip; the
   * answer is what separates "on this device" from "on your other devices".
   */
  private refreshPresence(): void {
    const run = ++this.presenceRun;
    void (async () => {
      for (const d of this.list()) {
        const here = await Promise.all(
          hashesOf(d).map((hash) => this.assets.has(hash)),
        );
        if (run !== this.presenceRun) return;
        this.notePresence(d.id, here.every(Boolean) ? "here" : "elsewhere");
      }
    })();
  }

  /** Record a presence answer, emitting only when it actually changed. */
  private notePresence(id: string, presence: DictionaryPresence): null {
    if (this.presenceById.get(id) === presence) return null;
    this.presenceById.set(id, presence);
    this.emit();
    return null;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** Do two descriptor lists say the same thing? Cheaper than re-rendering on every unrelated pref. */
function sameDictionaries(
  a: readonly ImportedDictionary[],
  b: readonly ImportedDictionary[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((d, i) => {
    const other = b[i];
    return (
      d.id === other.id &&
      d.label === other.label &&
      d.lang === other.lang &&
      d.script === other.script &&
      d.aff === other.aff &&
      d.dic === other.dic &&
      d.words === other.words
    );
  });
}

/**
 * The asset store, in the shape a dictionary wants: bytes in and bytes out
 * rather than `File`s and blob URLs.
 */
export function platformDictionaryAssets(
  // Resolved per call, not once: the store is built while the app is still
  // coming up, and the platform may not be there to ask yet.
  platform: () => Pick<Platform, "assets">,
): DictionaryAssets {
  return {
    put: async (bytes, ext) => {
      // `assets.store` reads the extension off the name; the rest is unused.
      const file = new File([bytes as BlobPart], `dictionary.${ext}`, {
        type: "application/octet-stream",
      });
      const asset = await platform().assets.store(file);
      return asset.hash;
    },
    get: async (hash) => (await platform().assets.getBytes(hash))?.data ?? null,
    has: (hash) => platform().assets.has(hash),
    drop: (hash) => platform().assets.delete(hash),
  };
}
