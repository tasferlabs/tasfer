import { describe, expect, it } from "vitest";
import {
  BUNDLED_DICTIONARIES,
  dictionaryUrls,
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
      expect(d.labelKey).toMatch(/^spelling\./);
      expect(d.source.kind).toBe("bundled");
    }
  });
});
