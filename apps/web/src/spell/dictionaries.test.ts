import { describe, expect, it } from "vitest";
import {
  BUNDLED_DICTIONARIES,
  dictionaryEndonym,
  dictionaryUrls,
  makeDictionaryNamer,
  preferredLanguages,
  SPELL_CATALOG_BASES,
  SPELL_WASM_URL,
} from "./dictionaries";

describe("bundled dictionaries", () => {
  it("resolves a vendored dictionary through the app base URL alone", () => {
    const en = BUNDLED_DICTIONARIES.find((d) => d.id === "en")!;
    const ar = BUNDLED_DICTIONARIES.find((d) => d.id === "ar")!;
    expect(dictionaryUrls(en)).toEqual({
      aff: ["/app/spell/en/index.aff.txt"],
      dic: ["/app/spell/en/index.dic.txt"],
      extras: [],
    });
    expect(dictionaryUrls(ar)).toEqual({
      aff: ["/app/spell/ar/index.aff.txt"],
      dic: ["/app/spell/ar/index.dic.txt"],
      extras: [],
    });
    expect(SPELL_WASM_URL).toBe("/app/spell/hunspell.wasm");
  });

  it("reads a catalogue language from every CDN, pinned to one version", () => {
    const de = BUNDLED_DICTIONARIES.find((d) => d.id === "de")!;
    const urls = dictionaryUrls(de);
    expect(urls.aff).toHaveLength(SPELL_CATALOG_BASES.length);
    expect(urls.aff).toEqual(
      SPELL_CATALOG_BASES.map((b) => `${b}dictionary-de@3.0.0/index.aff`),
    );
    expect(urls.dic).toEqual(
      SPELL_CATALOG_BASES.map((b) => `${b}dictionary-de@3.0.0/index.dic`),
    );
    expect(urls.extras).toEqual([]);
    // Nothing catalogue-related resolves against this app's own assets.
    for (const url of [...urls.aff, ...urls.dic]) {
      expect(url.startsWith("https://")).toBe(true);
    }
  });

  it("routes each dictionary to its script and records its licence", () => {
    const byId = new Map(BUNDLED_DICTIONARIES.map((d) => [d.id, d]));
    expect([byId.get("en")!.script, byId.get("en")!.license]).toEqual([
      "latn",
      "MIT AND BSD",
    ]);
    expect([byId.get("ar")!.script, byId.get("ar")!.license]).toEqual([
      "arab",
      "LGPL-2.1",
    ]);
    const ids = new Set<string>();
    for (const d of BUNDLED_DICTIONARIES) {
      expect(d.lang).toBe(d.id);
      expect(ids.has(d.id)).toBe(false);
      ids.add(d.id);
      expect(d.sizeBytes).toBeGreaterThan(0);
      expect(d.wireSizeBytes).toBeGreaterThan(0);
      expect(d.license).toBeTruthy();
      // Vendored or from the CDN — never the imported-dictionary shape, which
      // reads its bytes off the device instead of a URL.
      expect(["bundled", "upstream"]).toContain(d.source.kind);
      expect(dictionaryUrls(d).dic.length).toBeGreaterThan(0);
    }
    // Only English and Arabic ship inside the app; the rest are fetched.
    expect(
      BUNDLED_DICTIONARIES.filter((d) => d.source.kind === "bundled").map(
        (d) => d.id,
      ),
    ).toEqual(["ar", "en"]);
  });
});

describe("preferredLanguages", () => {
  const catalog = BUNDLED_DICTIONARIES;

  it("picks the languages the device says it reads, in that order", () => {
    expect(preferredLanguages(["ar-EG", "en-GB"], catalog)).toEqual([
      "ar",
      "en",
    ]);
  });

  it("falls back from a region to the base language and never repeats one", () => {
    expect(preferredLanguages(["en-US", "en-AU", "en"], catalog)).toEqual([
      "en",
    ]);
  });

  it("ignores locales no dictionary in the bundle covers", () => {
    expect(preferredLanguages(["ja", "zh-Hans", "  "], catalog)).toEqual([]);
  });

  it("never picks a language that would have to be downloaded", () => {
    // de and en-GB are both in the catalog, but neither is in the bundle.
    expect(catalog.some((d) => d.id === "de")).toBe(true);
    expect(catalog.some((d) => d.id === "en-GB")).toBe(true);
    expect(preferredLanguages(["de-AT", "de", "en-GB"], catalog)).toEqual([
      "en",
    ]);
  });

  it("checks the interface language when the device asks for none", () => {
    expect(preferredLanguages(["ja"], catalog, "en")).toEqual(["en"]);
    expect(preferredLanguages([], catalog, "ar")).toEqual(["ar"]);
  });

  it("leaves the interface language out when the device already picked it", () => {
    expect(preferredLanguages(["ar-EG", "en-GB"], catalog, "en")).toEqual([
      "ar",
      "en",
    ]);
  });
});

describe("dictionary names", () => {
  it("names a bundled dictionary in the interface language", () => {
    const nameOf = makeDictionaryNamer("en");
    const ar = BUNDLED_DICTIONARIES.find((d) => d.id === "ar")!;
    expect(nameOf(ar)).toBe("Arabic");
  });

  it("shows a language's own name only when it differs from the interface one", () => {
    const ar = BUNDLED_DICTIONARIES.find((d) => d.id === "ar")!;
    expect(dictionaryEndonym(ar, "en")).toBe("العربية");
    expect(dictionaryEndonym(ar, "ar")).toBeNull();
  });

  it("shows an imported dictionary under the name that was typed for it", () => {
    const nameOf = makeDictionaryNamer("en");
    const imported = {
      id: "team-terms",
      lang: "en",
      script: "latn" as const,
      label: "Team terms",
      sizeBytes: 120,
      wireSizeBytes: 0,
      source: { kind: "imported" as const, format: "list" as const },
    };
    expect(nameOf(imported)).toBe("Team terms");
    expect(dictionaryEndonym(imported, "en")).toBeNull();
  });
});
