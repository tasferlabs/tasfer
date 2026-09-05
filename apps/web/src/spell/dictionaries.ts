import type { Script } from "@tasfer/spell";
import { publicAssetUrl } from "@/lib/publicAssetUrl";
import type { ImportedDictionary } from "./userDictionaries";

/**
 * A dictionary the app can load into the spell worker.
 *
 * `source` paths are public-asset paths (relative to the app's base URL), never
 * absolute URLs: the same descriptor must resolve on the web (`/app/spell/…`),
 * in Electron's `file://` renderer and under Capacitor's `https://tasfer.app`
 * origin, so callers go through {@link dictionaryUrls}. A bundled dictionary's
 * `id` is its BCP-47 tag and {@link makeDictionaryNamer} turns it into a name;
 * a dictionary imported on this device carries the `label` the person typed
 * and reads its bytes from the `UserDictionaryStore` instead.
 */
export interface DictionaryDescriptor {
  /** Dictionary id — doubles as the `lang` sent to the worker. */
  id: string;
  lang: string;
  script: Script;
  /** A name the person typed (imported dictionaries only); shown as written. */
  label?: string;
  /** Uncompressed bytes on disk (what the cache holds). */
  sizeBytes: number;
  /** Approximate compressed bytes on the wire (what a first enable downloads). */
  wireSizeBytes: number;
  /** SPDX expression of the option Tasfer distributes the dictionary under. */
  license?: string;
  source:
    | { kind: "bundled"; aff: string; dic: string; extras?: string[] }
    | { kind: "imported"; format: "pair" | "list" };
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

/** Resolve a bundled descriptor's asset paths against the app's base URL. */
export function dictionaryUrls(d: DictionaryDescriptor): {
  aff: string;
  dic: string;
  extras: string[];
} {
  if (d.source.kind !== "bundled") {
    throw new Error(`spell: ${d.id} has no bundled assets`);
  }
  return {
    aff: publicAssetUrl(d.source.aff),
    dic: publicAssetUrl(d.source.dic),
    extras: (d.source.extras ?? []).map(publicAssetUrl),
  };
}

/**
 * A dictionary imported on this device, in the shape the service loads.
 * Its bytes come from the `UserDictionaryStore`, never a URL, so there is
 * nothing to download and nothing on the wire.
 */
export function importedDescriptor(
  d: ImportedDictionary,
): DictionaryDescriptor {
  return {
    id: d.id,
    lang: d.lang,
    script: d.script,
    label: d.label,
    sizeBytes: d.bytes,
    wireSizeBytes: 0,
    source: { kind: "imported", format: d.kind },
  };
}

/** The Hunspell WebAssembly binary (copied in by scripts/copy-spell-wasm.mjs). */
export const SPELL_WASM_URL = publicAssetUrl("app/spell/hunspell.wasm");

/**
 * Names a dictionary for display.
 *
 * Bundled dictionaries are BCP-47 tags, so `Intl.DisplayNames` already knows
 * their name in every interface language Tasfer ships — a per-language i18n key
 * per dictionary would only be a worse copy of that table, and would go stale
 * the moment a language is added. A dictionary imported on this device carries
 * the label the person typed and is shown exactly as written.
 *
 * Returns a closure so the (comparatively costly) formatter is built once per
 * render rather than once per row, and never as module state.
 */
export function makeDictionaryNamer(
  uiLocale: string,
): (d: DictionaryDescriptor) => string {
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames([uiLocale], { type: "language" });
  } catch {
    display = null;
  }
  return (d) => {
    if (d.source.kind === "imported") return d.label ?? d.id;
    try {
      const name = display?.of(d.id);
      if (name && name !== d.id) return name;
    } catch {
      // An id Intl cannot parse: fall through to the tag itself.
    }
    return d.id;
  };
}

/**
 * The dictionary's name in its own language ("Deutsch", "العربية") — how
 * someone finds their language when the interface is in one they read poorly.
 * Null when it would only repeat {@link makeDictionaryNamer}'s answer, or for
 * a dictionary imported on this device (its label is already the person's own
 * words).
 */
export function dictionaryEndonym(
  d: DictionaryDescriptor,
  uiLocale: string,
): string | null {
  if (d.source.kind === "imported") return null;
  try {
    const own = new Intl.DisplayNames([d.id], { type: "language" }).of(d.id);
    if (!own || own === d.id) return null;
    const inUi = new Intl.DisplayNames([uiLocale], { type: "language" }).of(
      d.id,
    );
    return own === inUi ? null : own;
  } catch {
    return null;
  }
}

/**
 * The dictionaries to switch on for someone who has never opened these
 * settings: the languages their device says they read, in their own order,
 * matched against the catalog. Region is dropped when the catalog carries only
 * the base language ("pt-BR" finds "pt"), and the interface language is
 * appended so there is always something checking.
 *
 * `locales` is `navigator.languages` in the app and an explicit list in tests.
 */
export function preferredLanguages(
  locales: readonly string[],
  catalog: readonly DictionaryDescriptor[],
): string[] {
  const ids = new Set(catalog.map((d) => d.id));
  const picked: string[] = [];
  for (const locale of locales) {
    const tag = locale.trim();
    if (!tag) continue;
    // Longest match first: a "de-AT" dictionary beats plain "de" for de-AT.
    const parts = tag.split("-");
    for (let i = parts.length; i > 0; i--) {
      const candidate = parts.slice(0, i).join("-");
      const id = [...ids].find(
        (known) => known.toLowerCase() === candidate.toLowerCase(),
      );
      if (id && !picked.includes(id)) {
        picked.push(id);
        break;
      }
    }
  }
  return picked;
}

/**
 * A dictionary's size, in the units it actually lands in: the catalog runs from
 * a few tens of KB to tens of MB, and rounding the small ones to "0.0 MB" would
 * hide the difference that matters when choosing one.
 */
export function formatDictionarySize(bytes: number, locale: string): string {
  const kb = bytes / 1000;
  if (kb < 1000) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(kb)} KB`;
  }
  const mb = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(bytes / 1_000_000);
  return `${mb} MB`;
}
