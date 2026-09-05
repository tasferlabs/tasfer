import { describe, expect, it } from "vitest";
import {
  BUNDLED_DICTIONARIES,
  dictionaryEndonym,
  dictionaryUrls,
  makeDictionaryNamer,
  preferredLanguages,
  SPELL_WASM_URL,
} from "./dictionaries";

describe("bundled dictionaries", () => {
  it("resolves asset paths through the app base URL", () => {
    const en = BUNDLED_DICTIONARIES.find((d) => d.id === "en")!;
    const ar = BUNDLED_DICTIONARIES.find((d) => d.id === "ar")!;
    expect(dictionaryUrls(en)).toEqual({
      aff: "/app/spell/en/index.aff.txt",
      dic: "/app/spell/en/index.dic.txt",
      extras: [],
    });
    expect(dictionaryUrls(ar)).toEqual({
      aff: "/app/spell/ar/index.aff.txt",
      dic: "/app/spell/ar/index.dic.txt",
      extras: [],
    });
    expect(SPELL_WASM_URL).toBe("/app/spell/hunspell.wasm");
  });

  it("routes each dictionary to its script and records its licence", () => {
    expect(
      BUNDLED_DICTIONARIES.map((d) => [d.id, d.script, d.license]),
    ).toEqual([
      ["en", "latn", "MIT AND BSD"],
      ["ar", "arab", "LGPL-2.1"],
    ]);
    for (const d of BUNDLED_DICTIONARIES) {
      expect(d.lang).toBe(d.id);
      expect(d.sizeBytes).toBeGreaterThan(0);
      expect(d.source.kind).toBe("bundled");
    }
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

  it("ignores locales the catalog has no dictionary for", () => {
    expect(preferredLanguages(["pt-BR", "ja", "  "], catalog)).toEqual([]);
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
