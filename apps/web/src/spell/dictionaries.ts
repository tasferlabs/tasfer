import type { Script } from "@tasfer/spell";
import { publicAssetUrl } from "@/lib/publicAssetUrl";

/**
 * A dictionary the app can load into the spell worker.
 *
 * `source` paths are public-asset paths (relative to the app's base URL), never
 * absolute URLs: the same descriptor must resolve on the web (`/app/spell/…`),
 * in Electron's `file://` renderer and under Capacitor's `https://tasfer.app`
 * origin, so callers go through {@link dictionaryUrls}. `labelKey` is an i18n
 * key: the UI never shows a raw language id.
 */
export interface DictionaryDescriptor {
  /** Dictionary id — doubles as the `lang` sent to the worker. */
  id: string;
  lang: string;
  script: Script;
  labelKey: string;
  /** Total bytes of `aff + dic`, so the settings UI can show a download size. */
  /** Uncompressed bytes on disk (what the cache holds). */
  sizeBytes: number;
  /** Approximate compressed bytes on the wire (what a first enable downloads). */
  wireSizeBytes: number;
  /** SPDX expression of the option Tasfer distributes the dictionary under. */
  license: string;
  source: { kind: "bundled"; aff: string; dic: string; extras?: string[] };
}

/**
 * Dictionaries shipped under `public/app/spell/<lang>/`. Their notices are
 * reproduced in THIRD-PARTY-LICENSES.txt by scripts/gen-third-party-licenses.mjs.
 */
export const BUNDLED_DICTIONARIES: DictionaryDescriptor[] = [
  {
    id: "en",
    lang: "en",
    script: "latn",
    labelKey: "spelling.dictionary.en",
    sizeBytes: 551762 + 3086,
    wireSizeBytes: 195_000,
    license: "MIT AND BSD",
    source: {
      kind: "bundled",
      aff: "app/spell/en/index.aff.txt",
      dic: "app/spell/en/index.dic.txt",
    },
  },
  {
    id: "ar",
    lang: "ar",
    script: "arab",
    labelKey: "spelling.dictionary.ar",
    sizeBytes: 7217161 + 86949,
    wireSizeBytes: 1_540_000,
    license: "LGPL-2.1",
    source: {
      kind: "bundled",
      aff: "app/spell/ar/index.aff.txt",
      dic: "app/spell/ar/index.dic.txt",
    },
  },
];

/** Resolve a descriptor's asset paths against the app's base URL. */
export function dictionaryUrls(d: DictionaryDescriptor): {
  aff: string;
  dic: string;
  extras: string[];
} {
  return {
    aff: publicAssetUrl(d.source.aff),
    dic: publicAssetUrl(d.source.dic),
    extras: (d.source.extras ?? []).map(publicAssetUrl),
  };
}

/** The Hunspell WebAssembly binary (copied in by scripts/copy-spell-wasm.mjs). */
export const SPELL_WASM_URL = publicAssetUrl("app/spell/hunspell.wasm");
