import {
  charsetLabel,
  createHunspellFactory,
  transcodeDictionary,
} from "./index";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const wasmPath = resolve(
  here,
  "../../node_modules/hunspell-wasm/wasm/hunspell.wasm",
);
const dictRoot = resolve(here, "../../../../apps/web/public/app/spell");

function wasmBytes(): ArrayBuffer {
  const buf = readFileSync(wasmPath);
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

const utf8 = new TextEncoder();

function factory() {
  return createHunspellFactory({ wasm: wasmBytes() });
}

describe("createHunspellFactory", () => {
  it("handles affixes and IGNORE with a handcrafted UTF-8 dictionary", async () => {
    // Prefix و (and), suffix ات (plural) and tashkeel ignored; plus an English
    // suffix rule to show both scripts in one file.
    const aff = [
      "SET UTF-8",
      "IGNORE ًٌٍَُِّْ",
      "PFX W Y 1",
      "PFX W 0 و .",
      "SFX T Y 1",
      "SFX T 0 ات .",
      "SFX S Y 1",
      "SFX S 0 s .",
      "",
    ].join("\n");
    const dic = ["4", "كتاب/WT", "قلم/W", "hello/S", "world", ""].join("\n");
    const engine = await factory().create({
      lang: "test",
      script: "arab",
      aff: utf8.encode(aff),
      dic: utf8.encode(dic),
    });
    try {
      expect(engine.spell("كتاب")).toBe(true);
      expect(engine.spell("وكتاب")).toBe(true);
      expect(engine.spell("كتابات")).toBe(true);
      expect(engine.spell("وكتابات")).toBe(true);
      // IGNORE strips the marks: كِتَابٌ → كتاب
      expect(engine.spell("كِتَابٌ")).toBe(true);
      expect(engine.spell("قلمات")).toBe(false); // قلم has no T flag
      expect(engine.spell("كتب")).toBe(false);
      expect(engine.spell("hello")).toBe(true);
      expect(engine.spell("hellos")).toBe(true);
      expect(engine.spell("Hello")).toBe(true); // Hunspell accepts capitalised forms
      expect(engine.spell("helo")).toBe(false);
      expect(engine.suggest("helo", 5)).toContain("hello");
      expect(engine.suggest("helo", 0)).toEqual([]);

      engine.add("tasfer");
      expect(engine.spell("tasfer")).toBe(true);
      engine.remove("tasfer");
      expect(engine.spell("tasfer")).toBe(false);

      engine.addDictionary("2\nextra\nكلمة\n");
      expect(engine.spell("extra")).toBe(true);
      expect(engine.spell("كلمة")).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it("merges extras at creation time", async () => {
    const engine = await factory().create({
      lang: "x",
      script: "latn",
      aff: utf8.encode("SET UTF-8\n"),
      dic: utf8.encode("1\nalpha\n"),
      extras: [utf8.encode("1\nbeta\n"), utf8.encode("gamma\n")],
    });
    try {
      expect(engine.spell("alpha")).toBe(true);
      expect(engine.spell("beta")).toBe(true);
      expect(engine.spell("gamma")).toBe(true);
      expect(engine.spell("delta")).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it("transcodes a latin1 dictionary", async () => {
    const latin1 = (s: string): Uint8Array => {
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code > 0xff) throw new Error("not latin1");
        out[i] = code;
      }
      return out;
    };
    const affBytes = latin1(
      "SET ISO8859-1\nTRY esianrtolcdugmphbyfvkwzé\nSFX S Y 1\nSFX S 0 s .\n",
    );
    const dicBytes = latin1("2\ncafé/S\nnaïve\n");
    const transcoded = transcodeDictionary(affBytes, dicBytes);
    expect(transcoded.charset).toBe("latin1");
    expect(transcoded.aff.startsWith("SET UTF-8\n")).toBe(true);
    expect(transcoded.dic).toContain("café/S");

    const engine = await factory().create({
      lang: "fr",
      script: "latn",
      aff: affBytes,
      dic: dicBytes,
    });
    try {
      expect(engine.spell("café")).toBe(true);
      expect(engine.spell("cafés")).toBe(true);
      expect(engine.spell("naïve")).toBe(true);
      expect(engine.spell("cafe")).toBe(false);
      expect(engine.suggest("cafe", 5)).toContain("café");
    } finally {
      engine.dispose();
    }
  });

  it("defaults to UTF-8 and adds a SET line when the .aff has none", () => {
    const t = transcodeDictionary(
      utf8.encode("TRY abc\n"),
      utf8.encode("1\nabc\n"),
    );
    expect(t.charset).toBe("utf-8");
    expect(t.aff).toBe("SET UTF-8\nTRY abc\n");
  });

  it("maps Hunspell charset names to TextDecoder labels", () => {
    expect(charsetLabel("UTF-8")).toBe("utf-8");
    expect(charsetLabel("ISO8859-1")).toBe("latin1");
    expect(charsetLabel("ISO8859-15")).toBe("iso-8859-15");
    expect(charsetLabel("ISO8859-2")).toBe("iso-8859-2");
    expect(charsetLabel("microsoft-cp1251")).toBe("windows-1251");
    expect(charsetLabel("cp1252")).toBe("windows-1252");
    expect(charsetLabel("KOI8-R")).toBe("koi8-r");
    expect(charsetLabel("TIS620-2533")).toBe("windows-874");
  });

  it("compiles the module once per factory and shares it across engines", async () => {
    const f = factory();
    const t0 = performance.now();
    const a = await f.create({
      lang: "a",
      script: "latn",
      aff: utf8.encode("SET UTF-8\n"),
      dic: utf8.encode("1\nalpha\n"),
    });
    const t1 = performance.now();
    const b = await f.create({
      lang: "b",
      script: "latn",
      aff: utf8.encode("SET UTF-8\n"),
      dic: utf8.encode("1\nbeta\n"),
    });
    const t2 = performance.now();
    try {
      expect(a.spell("alpha")).toBe(true);
      expect(a.spell("beta")).toBe(false);
      expect(b.spell("beta")).toBe(true);
      // The second engine skips wasm compilation.
      console.log(
        `[spell] wasm compile + first engine: ${(t1 - t0).toFixed(1)} ms; second engine: ${(t2 - t1).toFixed(1)} ms`,
      );
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it("accepts a precompiled WebAssembly.Module", async () => {
    const module = await WebAssembly.compile(wasmBytes());
    const engine = await createHunspellFactory({ wasm: module }).create({
      lang: "x",
      script: "latn",
      aff: utf8.encode("SET UTF-8\n"),
      dic: utf8.encode("1\nalpha\n"),
    });
    try {
      expect(engine.spell("alpha")).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it("fetches a wasm URL through fetchBytes", async () => {
    const urls: string[] = [];
    const engine = await createHunspellFactory({
      wasm: "https://example.invalid/hunspell.wasm",
      fetchBytes: async (url) => {
        urls.push(url);
        return wasmBytes();
      },
    }).create({
      lang: "x",
      script: "latn",
      aff: utf8.encode("SET UTF-8\n"),
      dic: utf8.encode("1\nalpha\n"),
    });
    try {
      expect(urls).toEqual(["https://example.invalid/hunspell.wasm"]);
      expect(engine.spell("alpha")).toBe(true);
    } finally {
      engine.dispose();
    }
  });
});

const enAff = resolve(dictRoot, "en/index.aff.txt");
const enDic = resolve(dictRoot, "en/index.dic.txt");
const arAff = resolve(dictRoot, "ar/index.aff.txt");
const arDic = resolve(dictRoot, "ar/index.dic.txt");
const haveReal = [enAff, enDic, arAff, arDic].every((p) => existsSync(p));

describe.skipIf(!haveReal)(
  "real dictionaries (apps/web/public/app/spell)",
  () => {
    it("loads English and Arabic and spells the fixtures", async () => {
      const f = factory();
      const load = async (
        lang: string,
        script: "latn" | "arab",
        affPath: string,
        dicPath: string,
      ) => {
        const aff = new Uint8Array(readFileSync(affPath));
        const dic = new Uint8Array(readFileSync(dicPath));
        const t0 = performance.now();
        const engine = await f.create({ lang, script, aff, dic });
        const ms = performance.now() - t0;
        console.log(
          `[spell] ${lang}: aff ${aff.byteLength} B + dic ${dic.byteLength} B loaded in ${ms.toFixed(1)} ms`,
        );
        return engine;
      };

      const en = await load("en", "latn", enAff, enDic);
      const ar = await load("ar", "arab", arAff, arDic);
      try {
        expect(en.spell("hello")).toBe(true);
        expect(en.spell("Hello")).toBe(true);
        expect(en.spell("helo")).toBe(false);
        let t0 = performance.now();
        const enSuggestions = en.suggest("helo", 8);
        console.log(
          `[spell] en suggest("helo") ${(performance.now() - t0).toFixed(1)} ms → ${enSuggestions.join(", ")}`,
        );
        expect(enSuggestions).toContain("hello");

        expect(ar.spell("الكتاب")).toBe(true);
        expect(ar.spell("وبالكتاب")).toBe(true);
        // كِتَابٌ with tashkeel
        expect(ar.spell("كِتَابٌ")).toBe(true);
        expect(ar.spell("الى")).toBe(false);
        t0 = performance.now();
        const arSuggestions = ar.suggest("الى", 8);
        console.log(
          `[spell] ar suggest("الى") ${(performance.now() - t0).toFixed(1)} ms → ${arSuggestions.join(", ")}`,
        );
        expect(arSuggestions).toContain("إلى");

        // Throughput: how many lookups per millisecond each engine sustains.
        const bench = (
          name: string,
          spell: (w: string) => boolean,
          words: string[],
        ) => {
          const start = performance.now();
          let n = 0;
          for (let i = 0; i < 20; i++) {
            for (const w of words) {
              spell(w);
              n++;
            }
          }
          const ms = performance.now() - start;
          console.log(
            `[spell] ${name}: ${n} lookups in ${ms.toFixed(1)} ms (${(n / ms).toFixed(0)} / ms)`,
          );
        };
        bench("en spell", (w) => en.spell(w), [
          "hello",
          "world",
          "helo",
          "spelling",
          "checker",
          "Tasfer",
          "editor",
          "canvas",
        ]);
        bench("ar spell", (w) => ar.spell(w), [
          "الكتاب",
          "وبالكتاب",
          "الى",
          "مدرسة",
          "يكتبون",
          "تصفر",
          "محرر",
          "لوحة",
        ]);
      } finally {
        en.dispose();
        ar.dispose();
      }
    });
  },
);
