import {
  createMemoryEngine,
  type SpellEngine,
  type SpellEngineFactory,
  wordListToDic,
} from "./engine";
import type {
  CheckOptions,
  CheckPriority,
  Script,
  SpellRequest,
  SpellResponse,
} from "./protocol";
import { createWorkerHost, type WorkerHostOptions } from "./worker-host";
import { describe, expect, it } from "vitest";

const decoder = new TextDecoder();

/** Engine factory over `createMemoryEngine`, parsing the `.dic` body it receives. */
function fakeFactory(created: SpellEngine[] = []): SpellEngineFactory {
  return {
    async create(opts) {
      const words: string[] = [];
      for (const line of decoder.decode(opts.dic).split("\n")) {
        const w = line.replace(/\/.*$/, "").trim();
        if (w && !/^\d+$/.test(w)) words.push(w);
      }
      const engine = createMemoryEngine(opts.lang, opts.script, words);
      for (const extra of opts.extras ?? [])
        engine.addDictionary(decoder.decode(extra));
      created.push(engine);
      return engine;
    },
  };
}

function dictionarySource(words: string[]) {
  const { aff, dic } = wordListToDic(words);
  return {
    kind: "bytes" as const,
    aff: aff.buffer.slice(
      aff.byteOffset,
      aff.byteOffset + aff.byteLength,
    ) as ArrayBuffer,
    dic: dic.buffer.slice(
      dic.byteOffset,
      dic.byteOffset + dic.byteLength,
    ) as ArrayBuffer,
  };
}

const defaultOptions: CheckOptions = {
  flagAllCaps: false,
  lenientArabic: false,
  ignored: [],
};

interface Harness {
  posted: SpellResponse[];
  handle: (msg: SpellRequest) => Promise<void>;
  load: (
    lang: string,
    script: Script,
    words: string[],
    id?: number,
  ) => Promise<void>;
  check: (
    id: number,
    blocks: Array<{
      blockId: string;
      text: string;
      version?: number;
      skip?: Array<[number, number]>;
    }>,
    options?: Partial<CheckOptions>,
    priority?: CheckPriority,
    docId?: string,
  ) => Promise<void>;
  flagsOf: (blockId: string) => string[] | undefined;
  checked: () => Extract<SpellResponse, { type: "checked" }>[];
}

function harness(
  hostOptions?: WorkerHostOptions,
  created?: SpellEngine[],
): Harness {
  const posted: SpellResponse[] = [];
  const handle = createWorkerHost(
    (msg) => void posted.push(msg),
    fakeFactory(created),
    async () => {
      throw new Error("no network in tests");
    },
    hostOptions,
  );
  const checked = () =>
    posted.filter(
      (m): m is Extract<SpellResponse, { type: "checked" }> =>
        m.type === "checked",
    );
  return {
    posted,
    handle,
    load: (lang, script, words, id = 1) =>
      handle({
        type: "loadDictionary",
        id,
        lang,
        script,
        source: dictionarySource(words),
      }),
    check: (id, blocks, options = {}, priority = "local", docId = "doc") =>
      handle({
        type: "check",
        id,
        docId,
        priority,
        options: { ...defaultOptions, ...options },
        blocks: blocks.map((b) => ({
          blockId: b.blockId,
          version: b.version ?? 1,
          text: b.text,
          skip: b.skip ?? [],
        })),
      }),
    flagsOf: (blockId) => {
      for (let i = posted.length - 1; i >= 0; i--) {
        const m = posted[i];
        if (m.type !== "checked") continue;
        const r = m.results.find((x) => x.blockId === blockId);
        if (r) return r.flags.map((f) => f.word);
      }
      return undefined;
    },
    checked,
  };
}

describe("createWorkerHost", () => {
  it("answers init with ready", async () => {
    const h = harness();
    await h.handle({ type: "init", id: 7, wasm: new ArrayBuffer(0) });
    expect(h.posted).toEqual([{ type: "ready", id: 7 }]);
  });

  it("reports dictionaryLoaded with timing and byte counts", async () => {
    const h = harness();
    await h.load("en", "latn", ["hello", "world"], 3);
    const msg = h.posted[0];
    expect(msg.type).toBe("dictionaryLoaded");
    if (msg.type !== "dictionaryLoaded") return;
    expect(msg.id).toBe(3);
    expect(msg.lang).toBe("en");
    expect(msg.bytes).toBeGreaterThan(0);
    expect(msg.ms).toBeGreaterThanOrEqual(0);
  });

  it("posts dictionaryError when a source cannot be fetched", async () => {
    const h = harness();
    await h.handle({
      type: "loadDictionary",
      id: 4,
      lang: "en",
      script: "latn",
      source: { kind: "url", aff: "https://x/a.aff", dic: "https://x/a.dic" },
    });
    expect(h.posted).toEqual([
      {
        type: "dictionaryError",
        id: 4,
        lang: "en",
        message: "no network in tests",
      },
    ]);
  });

  it("routes tokens by script and never lets one script's dictionary accept the other's typo", async () => {
    const h = harness();
    await h.load("en", "latn", ["hello", "world", "helo"]); // "helo" deliberately listed
    await h.load("ar", "arab", ["كتاب", "قلم", "wrold"]); // a Latin word in the Arabic list
    await h.check(10, [{ blockId: "b1", text: "hello wrold كتاب قلن helo" }]);
    // "wrold" is only in the Arabic list → still flagged; "قلن" flagged;
    // "helo" is in the English list → accepted.
    expect(h.flagsOf("b1")).toEqual(["wrold", "قلن"]);
    const msg = h.checked()[0];
    expect(msg.id).toBe(10);
    expect(msg.docId).toBe("doc");
    expect(msg.results[0].version).toBe(1);
    expect(msg.results[0].flags[0]).toEqual({
      from: 6,
      to: 11,
      word: "wrold",
      script: "latn",
    });
  });

  it("applies the union rule across two dictionaries of one script", async () => {
    const h = harness();
    await h.load("en", "latn", ["colour"]);
    await h.load("en-us", "latn", ["color"]);
    await h.check(1, [{ blockId: "b", text: "color colour colr" }]);
    expect(h.flagsOf("b")).toEqual(["colr"]);
  });

  it("does not flag scripts without a dictionary, defers them and re-checks after load", async () => {
    const h = harness();
    await h.load("en", "latn", ["hello"]);
    await h.check(1, [{ blockId: "b", text: "hello كتاب قلن", version: 5 }]);
    const first = h.checked()[0].results[0];
    expect(first.flags).toEqual([]);
    expect(first.deferredScripts).toEqual(["arab"]);
    expect(first.version).toBe(5);

    await h.load("ar", "arab", ["كتاب"]);
    // The re-check is queued by the load; let it drain.
    await h.check(2, []);
    const again = h.checked().at(-1)!;
    expect(again.id).toBe(1);
    expect(again.results[0]).toEqual({
      blockId: "b",
      version: 5,
      flags: [{ from: 11, to: 14, word: "قلن", script: "arab" }],
    });
  });

  it("does not re-check a deferred block that was checked again meanwhile", async () => {
    const h = harness();
    await h.load("en", "latn", ["hello"]);
    await h.check(1, [{ blockId: "b", text: "hello كتاب", version: 1 }]);
    await h.check(2, [{ blockId: "b", text: "hello", version: 2 }]);
    await h.load("ar", "arab", ["كتاب"]);
    await h.check(3, []);
    expect(h.checked()).toHaveLength(2);
  });

  it("accepts user words and always flags forbidden ones", async () => {
    const created: SpellEngine[] = [];
    const h = harness(undefined, created);
    await h.load("en", "latn", ["hello", "teh"]);
    await h.handle({
      type: "setUserWords",
      id: 1,
      words: ["Tasfer", "كِتَابٌ"],
      forbidden: ["teh"],
    });
    await h.load("ar", "arab", ["قلم"]);
    await h.check(2, [
      { blockId: "b", text: "Hello Tasfer tasfer TASFER teh كتاب قلن" },
    ]);
    // Like a dictionary proper noun, a capitalised user word does not accept
    // its lowercase form; the all-caps form is accepted.
    expect(h.flagsOf("b")).toEqual(["tasfer", "teh", "قلن"]);
    // Replayed into the matching engines only.
    expect(created[0].spell("Tasfer")).toBe(true);
    expect(created[0].spell("كتاب")).toBe(false);
    expect(created[1].spell("كتاب")).toBe(true);

    await h.handle({ type: "setUserWords", id: 3, words: [], forbidden: [] });
    await h.check(4, [{ blockId: "b", text: "Tasfer teh" }]);
    expect(h.flagsOf("b")).toEqual(["Tasfer"]);
    expect(created[0].spell("Tasfer")).toBe(false);
  });

  it("keeps dictionary words when a user word that duplicates one is removed", async () => {
    const created: SpellEngine[] = [];
    const h = harness(undefined, created);
    await h.load("en", "latn", ["hello"]);
    await h.handle({
      type: "setUserWords",
      id: 1,
      words: ["hello"],
      forbidden: [],
    });
    await h.handle({ type: "setUserWords", id: 2, words: [], forbidden: [] });
    expect(created[0].spell("hello")).toBe(true);
    await h.check(3, [{ blockId: "b", text: "hello" }]);
    expect(h.flagsOf("b")).toEqual([]);
  });

  it("honours per-document ignored words", async () => {
    const h = harness();
    await h.load("en", "latn", ["hello"]);
    await h.check(1, [{ blockId: "b", text: "hello Wrold wrold" }], {
      ignored: ["wrold"],
    });
    expect(h.flagsOf("b")).toEqual([]);
    await h.check(2, [{ blockId: "b", text: "hello wrold" }]);
    expect(h.flagsOf("b")).toEqual(["wrold"]);
  });

  it("accepts case variants and collapsed repeats", async () => {
    const h = harness();
    await h.load("en", "latn", ["hello", "so"]);
    await h.check(
      1,
      [{ blockId: "b", text: "Hello HELLO sooo Soooo hellooo xyz" }],
      { flagAllCaps: true },
    );
    expect(h.flagsOf("b")).toEqual(["xyz"]);
  });

  it("applies lenient Arabic variants only when asked", async () => {
    const h = harness();
    await h.load("ar", "arab", ["إلى", "مدرسة", "على"]);
    const text = "الى مدرسه علي";
    await h.check(1, [{ blockId: "b", text }]);
    expect(h.flagsOf("b")).toEqual(["الى", "مدرسه", "علي"]);
    await h.check(2, [{ blockId: "b", text }], { lenientArabic: true });
    expect(h.flagsOf("b")).toEqual([]);
  });

  it("skips code ranges and protected spans", async () => {
    const h = harness();
    await h.load("en", "latn", ["run", "now"]);
    const text = "run npmm instal now https://exampl.com/x";
    await h.check(1, [{ blockId: "b", text, skip: [[4, 15]] }]);
    expect(h.flagsOf("b")).toEqual([]);
  });

  it("suggests from every engine of the script, deduplicated, casing restored", async () => {
    const h = harness();
    await h.load("en", "latn", ["hello", "hells", "help"]);
    await h.load("en-2", "latn", ["hello", "helot"]);
    await h.load("ar", "arab", ["إلى"]);
    await h.handle({
      type: "suggest",
      id: 9,
      word: "Helo",
      script: "latn",
      limit: 10,
    });
    await h.handle({
      type: "suggest",
      id: 10,
      word: "HELO",
      script: "latn",
      limit: 2,
    });
    await h.handle({
      type: "suggest",
      id: 11,
      word: "الى",
      script: "arab",
      limit: 5,
    });
    await h.handle({
      type: "suggest",
      id: 12,
      word: "helo",
      script: "other",
      limit: 5,
    });
    expect(h.posted.filter((m) => m.type === "suggestions")).toEqual([
      {
        type: "suggestions",
        id: 9,
        word: "Helo",
        suggestions: ["Hello", "Help", "Helot"],
      },
      {
        type: "suggestions",
        id: 10,
        word: "HELO",
        suggestions: ["HELLO", "HELP"],
      },
      { type: "suggestions", id: 11, word: "الى", suggestions: ["إلى"] },
      { type: "suggestions", id: 12, word: "helo", suggestions: [] },
    ]);
  });

  it("lets a newer request replace an older one for the same block", async () => {
    // A ticking clock makes every slice about 8 blocks long, so the second
    // request arrives while the first is parked at a yield.
    let tick = 0;
    const h = harness({ now: () => tick++ });
    await h.load("en", "latn", ["hello"]);
    const filler = Array.from({ length: 20 }, (_, i) => ({
      blockId: `f${i}`,
      text: "hello",
    }));
    const p1 = h.check(
      1,
      [...filler, { blockId: "b", text: "helo", version: 1 }],
      {},
      "initial",
    );
    const p2 = h.check(
      2,
      [{ blockId: "b", text: "hello", version: 2 }],
      {},
      "local",
    );
    await Promise.all([p1, p2]);
    const results = h
      .checked()
      .flatMap((m) =>
        m.results
          .filter((r) => r.blockId === "b")
          .map((r) => ({ id: m.id, version: r.version })),
      );
    expect(results).toEqual([{ id: 2, version: 2 }]);
  });

  it("processes caret blocks before the rest of an initial pass", async () => {
    let tick = 0;
    const h = harness({ now: () => tick++ });
    await h.load("en", "latn", ["hello"]);
    const initial = Array.from({ length: 30 }, (_, i) => ({
      blockId: `i${i}`,
      text: "x hello",
    }));
    const p1 = h.check(1, initial, {}, "initial");
    const p2 = h.check(2, [{ blockId: "c1", text: "x hello" }], {}, "caret");
    await Promise.all([p1, p2]);
    const order: string[] = [];
    for (const m of h.checked())
      for (const r of m.results) order.push(r.blockId);
    expect(order).toHaveLength(31);
    expect(order.indexOf("c1")).toBeGreaterThan(0);
    expect(order.indexOf("c1")).toBeLessThan(order.indexOf("i29"));
  });

  it("yields between slices so a suggest interleaves with a long check", async () => {
    // A clock that advances 1 ms per read → about 8 blocks per slice.
    let tick = 0;
    const yields: number[] = [];
    const h = harness({
      now: () => tick++,
      yieldToLoop: async () => {
        yields.push(h.posted.length);
        await new Promise((r) => setTimeout(r, 0));
      },
    });
    await h.load("en", "latn", ["hello", "world"]);
    const blocks = Array.from({ length: 500 }, (_, i) => ({
      blockId: `b${i}`,
      text: "hello world worl",
    }));
    const checking = h.check(1, blocks, {}, "initial");

    // Sent while the check is in flight; answered before the queue drains.
    await h.handle({
      type: "suggest",
      id: 2,
      word: "worl",
      script: "latn",
      limit: 5,
    });
    const suggestIndex = h.posted.findIndex((m) => m.type === "suggestions");
    expect(suggestIndex).toBeGreaterThanOrEqual(0);
    expect(h.checked().length).toBeGreaterThan(0);
    expect(h.checked().reduce((n, m) => n + m.results.length, 0)).toBeLessThan(
      500,
    );

    await checking;
    const messages = h.checked();
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.reduce((n, m) => n + m.results.length, 0)).toBe(500);
    expect(yields.length).toBe(messages.length - 1);
    expect(h.posted.at(-1)!.type).toBe("checked");
    expect(h.posted[suggestIndex]).toEqual({
      type: "suggestions",
      id: 2,
      word: "worl",
      suggestions: ["world"],
    });
  });

  it("does more than one slice on real time for a large check", async () => {
    const h = harness();
    await h.load("en", "latn", ["hello", "world"]);
    const text = "hello world wrold ".repeat(40);
    const blocks = Array.from({ length: 500 }, (_, i) => ({
      blockId: `b${i}`,
      text,
    }));
    await h.check(1, blocks, {}, "initial");
    const messages = h.checked();
    expect(messages.reduce((n, m) => n + m.results.length, 0)).toBe(500);
    expect(messages.length).toBeGreaterThan(1);
  });

  it("cancels pending blocks of a request", async () => {
    let tick = 0;
    const h = harness({ now: () => tick++ });
    await h.load("en", "latn", ["hello"]);
    const blocks = Array.from({ length: 50 }, (_, i) => ({
      blockId: `b${i}`,
      text: "hello helo",
    }));
    const checking = h.check(1, blocks, {}, "initial");
    await h.handle({ type: "cancel", id: 1 });
    await checking;
    const done = h.checked().reduce((n, m) => n + m.results.length, 0);
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(50);
  });

  it("unloads a dictionary and stops using it", async () => {
    const created: SpellEngine[] = [];
    const h = harness(undefined, created);
    await h.load("en", "latn", ["hello"]);
    await h.handle({ type: "unloadDictionary", id: 2, lang: "en" });
    expect((created[0] as unknown as { isDisposed: boolean }).isDisposed).toBe(
      true,
    );
    await h.check(3, [{ blockId: "b", text: "hello" }]);
    expect(h.checked()[0].results[0].deferredScripts).toEqual(["latn"]);
  });

  it("reports thrown errors and keeps serving", async () => {
    const h = harness();
    const broken: SpellEngineFactory = {
      async create() {
        throw new Error("boom");
      },
    };
    const posted: SpellResponse[] = [];
    const handle = createWorkerHost((m) => void posted.push(m), broken);
    await handle({
      type: "loadDictionary",
      id: 1,
      lang: "en",
      script: "latn",
      source: dictionarySource(["a"]),
    });
    expect(posted[0]).toEqual({
      type: "dictionaryError",
      id: 1,
      lang: "en",
      message: "boom",
    });
    await handle({
      type: "suggest",
      id: 2,
      word: "x",
      script: "latn",
      limit: 3,
    });
    expect(posted[1]).toEqual({
      type: "suggestions",
      id: 2,
      word: "x",
      suggestions: [],
    });
    expect(h.posted).toEqual([]);
  });
});
