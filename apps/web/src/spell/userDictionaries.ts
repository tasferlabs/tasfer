import {
  declaredCharset,
  decoderFor,
  type Script,
  scriptOf,
  wordListToDic,
} from "@tasfer/spell";
import type { FsDriver } from "@/platform/driver";

/**
 * Dictionaries the person added themselves: a Hunspell `.aff`/`.dic` pair or a
 * plain word list.
 *
 * They are device-local, not synced: the bytes go through the platform
 * `FsDriver` under `spell/dicts/<id>/` and the descriptors into localStorage,
 * because own-prefs is a small last-writer-wins register and a phone must not
 * inherit a dictionary whose files it does not have. The personal word list
 * (`PersonalDictionary`) is the synced surface; this one is "on this device".
 *
 * A word list is kept in its original form and converted with `wordListToDic`
 * on every read, so re-importing the same file is idempotent and the cspell
 * markers (`!word`, `~word`) keep their meaning after an upgrade.
 */

/** localStorage key holding the descriptor array. */
export const IMPORTED_DICTS_KEY = "tasfer.spell.dicts";

/** Directory (relative to the driver's root) holding the imported files. */
const DICT_DIR = "spell/dicts";

/** Largest file we accept, per file. Ayaspell's own `.dic` is about 7 MB. */
export const MAX_DICTIONARY_BYTES = 32 * 1024 * 1024;

/**
 * A word list this big goes in as its own dictionary rather than into the
 * synced personal list, which is one own-prefs key per word.
 */
export const PERSONAL_LIST_CAP = 5000;

export interface ImportedDictionary {
  /** Also the `lang` the worker keys the engine on; never `"en"`/`"ar"`. */
  readonly id: string;
  /** What the person called it. Shown as typed — not an i18n key. */
  readonly label: string;
  /** BCP-47-ish language tag, from the `.aff`'s `LANG` or inferred. May be "". */
  readonly lang: string;
  readonly script: Script;
  readonly kind: "pair" | "list";
  /** Bytes on disk, for the settings row. */
  readonly bytes: number;
  readonly importedAt: number;
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

/** The slice of `Storage` we use, so tests need no DOM. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isScript(value: unknown): value is Script {
  return (
    value === "latn" ||
    value === "arab" ||
    value === "other" ||
    value === "mixed"
  );
}

function parseDescriptors(raw: string | null): ImportedDictionary[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ImportedDictionary[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const d = entry as Record<string, unknown>;
    if (typeof d.id !== "string" || !d.id) continue;
    if (d.kind !== "pair" && d.kind !== "list") continue;
    if (!isScript(d.script)) continue;
    out.push({
      id: d.id,
      label: typeof d.label === "string" ? d.label : d.id,
      lang: typeof d.lang === "string" ? d.lang : "",
      script: d.script,
      kind: d.kind,
      bytes: typeof d.bytes === "number" ? d.bytes : 0,
      importedAt: typeof d.importedAt === "number" ? d.importedAt : 0,
    });
  }
  return out;
}

/** Ids are path segments and worker engine keys: keep them opaque and safe. */
function newId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `u_${Date.now().toString(36)}_${random}`;
}

export class UserDictionaryStore {
  private readonly fs: FsDriver;
  private readonly storage: KeyValueStorage | null;
  private cache: ImportedDictionary[] | null = null;
  private listeners = new Set<() => void>();

  /**
   * `storage` defaults to `localStorage` where there is one; without it the
   * store still works for the current session and forgets on reload, which is
   * the right behaviour in a private window that denies storage.
   */
  constructor(
    fs: FsDriver,
    storage: KeyValueStorage | null = defaultStorage(),
  ) {
    this.fs = fs;
    this.storage = storage;
  }

  /** Descriptors, newest last. Cheap: parsed once and kept until a write. */
  list(): ImportedDictionary[] {
    if (!this.cache) {
      this.cache = parseDescriptors(
        this.storage?.getItem(IMPORTED_DICTS_KEY) ?? null,
      );
    }
    return this.cache;
  }

  get(id: string): ImportedDictionary | undefined {
    return this.list().find((d) => d.id === id);
  }

  /** Store a Hunspell pair. `meta` overrides what {@link inspectPair} inferred. */
  async importPair(
    aff: ImportBytes,
    dic: ImportBytes,
    meta: Partial<Pick<ImportedDictionary, "label" | "lang" | "script">> = {},
  ): Promise<ImportedDictionary> {
    const inferred = inspectPair(aff, dic);
    const id = newId();
    await this.fs.write(`${DICT_DIR}/${id}/index.aff`, aff.bytes);
    await this.fs.write(`${DICT_DIR}/${id}/index.dic`, dic.bytes);
    return this.add({
      id,
      label: meta.label?.trim() || inferred.label,
      lang: meta.lang ?? inferred.lang,
      script: meta.script ?? inferred.script,
      kind: "pair",
      bytes: aff.bytes.length + dic.bytes.length,
      importedAt: Date.now(),
    });
  }

  /** Store a plain word list; it is converted to a `.dic` on every read. */
  async importList(
    list: ImportBytes,
    meta: Partial<Pick<ImportedDictionary, "label" | "lang" | "script">> = {},
  ): Promise<ImportedDictionary> {
    const inferred = inspectList(list);
    const id = newId();
    await this.fs.write(`${DICT_DIR}/${id}/words.txt`, list.bytes);
    return this.add({
      id,
      label: meta.label?.trim() || inferred.label,
      lang: meta.lang ?? inferred.lang,
      script: meta.script ?? inferred.script,
      kind: "list",
      bytes: list.bytes.length,
      importedAt: Date.now(),
    });
  }

  /**
   * The bytes to hand the worker, or null when the files are gone (another
   * device's descriptor synced in, or storage was cleared under us). Word
   * lists also report their `!word` entries, which stay flagged everywhere.
   */
  async read(id: string): Promise<{
    aff: Uint8Array;
    dic: Uint8Array;
    forbidden: readonly string[];
  } | null> {
    const descriptor = this.get(id);
    if (!descriptor) return null;
    if (descriptor.kind === "list") {
      const bytes = await this.fs.read(`${DICT_DIR}/${id}/words.txt`);
      if (!bytes) return null;
      const text = new TextDecoder("utf-8").decode(bytes);
      const { aff, dic, forbidden } = wordListToDic(text.split(/\r?\n|\r/));
      return { aff, dic, forbidden };
    }
    const [aff, dic] = await Promise.all([
      this.fs.read(`${DICT_DIR}/${id}/index.aff`),
      this.fs.read(`${DICT_DIR}/${id}/index.dic`),
    ]);
    if (!aff || !dic) return null;
    return { aff, dic, forbidden: [] };
  }

  /** Forget a dictionary and delete its files. Unknown ids are a no-op. */
  async remove(id: string): Promise<void> {
    const descriptor = this.get(id);
    if (!descriptor) return;
    this.write(this.list().filter((d) => d.id !== id));
    // The driver has no recursive delete; the three names are all we write.
    for (const name of ["index.aff", "index.dic", "words.txt"]) {
      await this.fs.delete(`${DICT_DIR}/${id}/${name}`);
    }
  }

  /** Rename or relabel an existing dictionary. */
  update(
    id: string,
    patch: Partial<Pick<ImportedDictionary, "label" | "lang" | "script">>,
  ): void {
    const next = this.list().map((d) =>
      d.id === id
        ? {
            ...d,
            label: patch.label?.trim() || d.label,
            lang: patch.lang ?? d.lang,
            script: patch.script ?? d.script,
          }
        : d,
    );
    this.write(next);
  }

  /** Fires after any add, update or remove on this device. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private add(descriptor: ImportedDictionary): ImportedDictionary {
    this.write([...this.list(), descriptor]);
    return descriptor;
  }

  private write(next: ImportedDictionary[]): void {
    this.cache = next;
    try {
      this.storage?.setItem(IMPORTED_DICTS_KEY, JSON.stringify(next));
    } catch {
      // Quota or a storage-denying window: the session still has `cache`.
    }
    for (const l of this.listeners) l();
  }
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
