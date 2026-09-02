/**
 * Hunspell-in-WebAssembly engine (`@tasfer/spell/hunspell`).
 *
 * Wraps the `hunspell-wasm` package: one Emscripten module per factory
 * (compiled once, shared by every dictionary the factory creates) and one
 * `Hunspell` instance per {@link SpellEngine}. The wasm binary is supplied by
 * the host — a URL, bytes or a compiled `WebAssembly.Module` — so the glue's
 * own `import.meta.url`-relative lookup is never used and nothing is fetched
 * behind the host's back.
 *
 * Dictionaries arrive as raw bytes in whatever encoding their `.aff` declares
 * (`SET ISO8859-1`, …). The wasm FS stores strings as UTF-8, so both files are
 * transcoded here and the `SET` line rewritten to `SET UTF-8` before Hunspell
 * reads them.
 */

import type {
  CreateEngineOptions,
  SpellEngine,
  SpellEngineFactory,
} from "../engine";
import { Hunspell } from "hunspell-wasm";
import createModuleUntyped from "hunspell-wasm/wasm/hunspell.js";

export interface HunspellFactoryOptions {
  /** The `hunspell.wasm` binary: a URL to fetch, its bytes, or a compiled module. */
  readonly wasm: string | ArrayBuffer | WebAssembly.Module;
  /** Fetcher for `wasm` when it is a URL (defaults to global `fetch`). */
  readonly fetchBytes?: (url: string) => Promise<ArrayBuffer>;
}

/** The subset of the Emscripten `Module` object this package relies on. */
interface EmscriptenModule {
  FS: unknown;
}

interface EmscriptenInit {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    receive: (
      instance: WebAssembly.Instance,
      module?: WebAssembly.Module,
    ) => void,
  ) => Record<string, never>;
}

// The shipped `hunspell.d.ts` types the factory as `() => any`; it does accept
// a Module-init object (see the glue: `async function(moduleArg = {})`).
const createModule = createModuleUntyped as unknown as (
  init: EmscriptenInit,
) => Promise<EmscriptenModule>;

/** Read `Response` bytes through the global fetch. */
async function defaultFetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function instantiateModule(
  opts: HunspellFactoryOptions,
): Promise<EmscriptenModule> {
  // `locateFile` returning "" keeps the glue from building a URL relative to
  // its own import.meta.url; with `wasmBinary` set it never reads that URL.
  const init: EmscriptenInit = { locateFile: () => "" };
  const { wasm } = opts;
  if (wasm instanceof WebAssembly.Module) {
    init.instantiateWasm = (imports, receive) => {
      WebAssembly.instantiate(wasm, imports).then(
        (instance) => receive(instance, wasm),
        (error: unknown) => {
          throw error;
        },
      );
      return {};
    };
  } else if (typeof wasm === "string") {
    init.wasmBinary = await (opts.fetchBytes ?? defaultFetchBytes)(wasm);
  } else {
    init.wasmBinary = wasm;
  }
  return createModule(init);
}

/**
 * Build a {@link SpellEngineFactory} over Hunspell. The wasm module is
 * compiled on the first `create()` and reused for every later dictionary.
 */
export function createHunspellFactory(
  opts: HunspellFactoryOptions,
): SpellEngineFactory {
  let modulePromise: Promise<EmscriptenModule> | null = null;
  const getModule = (): Promise<EmscriptenModule> => {
    if (!modulePromise) {
      modulePromise = instantiateModule(opts).catch((error: unknown) => {
        modulePromise = null; // allow a retry after a transient failure
        throw error;
      });
    }
    return modulePromise;
  };

  return {
    async create(options: CreateEngineOptions): Promise<SpellEngine> {
      const wasmModule = await getModule();
      const { aff, dic } = transcodeDictionary(options.aff, options.dic);
      const hunspell = new Hunspell(wasmModule, aff, dic);
      const utf8 = new TextDecoder("utf-8");
      try {
        for (const extra of options.extras ?? []) {
          hunspell.addDictionaryFromString(
            withCountLine(stripBom(utf8.decode(extra))),
          );
        }
      } catch (error) {
        hunspell.dispose();
        throw error;
      }
      return {
        lang: options.lang,
        script: options.script,
        spell: (word) => hunspell.testSpelling(word),
        suggest: (word, limit) =>
          hunspell.getSpellingSuggestions(word).slice(0, Math.max(0, limit)),
        add: (word) => hunspell.addWord(word),
        remove: (word) => hunspell.removeWord(word),
        addDictionary: (body) =>
          hunspell.addDictionaryFromString(withCountLine(stripBom(body))),
        dispose: () => {
          if (!hunspell.isDisposed) hunspell.dispose();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Transcoding
// ---------------------------------------------------------------------------

const SET_LINE_RE = /^[ \t]*SET[ \t]+(\S+)[^\r\n]*/m;

/**
 * Hunspell's `SET` value → a `TextDecoder` label. Hunspell names follow the
 * `ISO8859-N`, `microsoft-cp125N` conventions; WHATWG wants `iso-8859-N`,
 * `windows-125N`.
 */
export function charsetLabel(hunspellCharset: string): string {
  const cs = hunspellCharset.trim().toLowerCase();
  if (cs === "utf-8" || cs === "utf8") return "utf-8";
  if (cs === "iso8859-1" || cs === "iso-8859-1" || cs === "latin1")
    return "latin1";
  const iso = /^iso-?8859-(\d{1,2})$/.exec(cs);
  if (iso) return `iso-8859-${iso[1]}`;
  const cp = /^(?:microsoft-)?cp(\d{3,4})$/.exec(cs);
  if (cp) return `windows-${cp[1]}`;
  const win = /^windows-?(\d{3,4})$/.exec(cs);
  if (win) return `windows-${win[1]}`;
  if (cs === "tis620-2533" || cs === "tis-620") return "windows-874";
  return cs; // koi8-r, koi8-u, … are already valid labels
}

function decoderFor(label: string): TextDecoder {
  try {
    return new TextDecoder(label);
  } catch {
    // Unknown encoding (e.g. ISCII-DEVANAGARI): best effort as UTF-8.
    return new TextDecoder("utf-8");
  }
}

/**
 * Hunspell treats the first line of a `.dic` as the entry count and skips it,
 * so a bare word list would lose its first word. Add a count line when the
 * body has none.
 */
function withCountLine(dic: string): string {
  const firstLine = dic
    .slice(0, dic.indexOf("\n") === -1 ? dic.length : dic.indexOf("\n"))
    .trim();
  if (/^\d+$/.test(firstLine)) return dic;
  let count = 0;
  for (const line of dic.split("\n")) if (line.trim()) count++;
  return `${count}\n${dic}`;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Decode `.aff`/`.dic` bytes in the charset the `.aff` declares (UTF-8 when
 * it declares none) and rewrite the declaration to `SET UTF-8`, which is how
 * the wasm FS will store them.
 */
export function transcodeDictionary(
  affBytes: Uint8Array,
  dicBytes: Uint8Array,
): { aff: string; dic: string; charset: string } {
  // The header is ASCII in every encoding Hunspell supports, so a latin1 view
  // of the first bytes is enough to find the SET line.
  const head = new TextDecoder("latin1").decode(
    affBytes.subarray(0, Math.min(affBytes.length, 65536)),
  );
  const declared = SET_LINE_RE.exec(head)?.[1] ?? "UTF-8";
  const label = charsetLabel(declared);
  const decoder = decoderFor(label);
  let aff = stripBom(decoder.decode(affBytes));
  const dic = stripBom(decoder.decode(dicBytes));
  aff = SET_LINE_RE.test(aff)
    ? aff.replace(SET_LINE_RE, "SET UTF-8")
    : `SET UTF-8\n${aff}`;
  return { aff, dic, charset: label };
}
