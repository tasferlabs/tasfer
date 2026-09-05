import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tasfer/editor";
import type { CheckOptions } from "@tasfer/spell";
import {
  FakeOwnPrefsStore,
  FakeWorker,
  type FakeWorkerOptions,
  flush,
} from "./testUtils";
import type { DictionaryDescriptor } from "./dictionaries";
import type {
  ImportedDictionary,
  UserDictionaryStore,
} from "./userDictionaries";

vi.mock("@tasfer/spell", async () => (await import("./testUtils")).spellMock);

const { SpellService } = await import("./SpellService");
const { SPELL_PREF_KEYS } = await import("./personalDictionary");

const DICTS: DictionaryDescriptor[] = [
  {
    id: "en",
    lang: "en",
    script: "latn",
    sizeBytes: 10,
    wireSizeBytes: 5,
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
    sizeBytes: 10,
    wireSizeBytes: 5,
    license: "LGPL-2.1",
    source: {
      kind: "bundled",
      aff: "app/spell/ar/index.aff.txt",
      dic: "app/spell/ar/index.dic.txt",
    },
  },
];

const OPTIONS: CheckOptions = {
  flagAllCaps: false,
  lenientArabic: false,
  ignored: [],
};
const editorA = { id: "A" } as unknown as Editor;
const editorB = { id: "B" } as unknown as Editor;

/**
 * Stand-in for the imported-dictionary store: descriptors in memory and one
 * set of bytes for every id, so the service's file path is exercised without a
 * filesystem.
 */
function fakeImported(
  entries: ImportedDictionary[] = [],
  forbidden: string[] = [],
) {
  const listeners = new Set<() => void>();
  let list = [...entries];
  return {
    list: () => list,
    read: async (id: string) =>
      list.some((d) => d.id === id)
        ? {
            aff: new Uint8Array([1, 2, 3]),
            dic: new Uint8Array([4, 5]),
            forbidden,
          }
        : null,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** Test-only: drop a dictionary the way `remove()` would. */
    drop(id: string) {
      list = list.filter((d) => d.id !== id);
      for (const l of listeners) l();
    },
  };
}

const importedEntry = (
  over: Partial<ImportedDictionary> = {},
): ImportedDictionary => ({
  id: "u_1",
  label: "Work terms",
  lang: "en",
  script: "latn",
  kind: "pair",
  bytes: 5,
  importedAt: 0,
  ...over,
});

function setup(
  workerOpts: FakeWorkerOptions = {},
  idleMs?: number,
  imported?: ReturnType<typeof fakeImported>,
) {
  const store = new FakeOwnPrefsStore();
  const workers: FakeWorker[] = [];
  const fetched: string[] = [];
  const service = new SpellService({
    prefs: store.asStore(),
    wasmUrl: "/app/spell/hunspell.wasm",
    dictionaries: DICTS,
    // Spelled out rather than left to the service: the defaults now follow
    // the device's own locales, so a fixture must say which it starts with.
    defaultLanguages: ["en", "ar"],
    imported: imported as unknown as UserDictionaryStore | undefined,
    idleMs,
    createWorker: () => {
      const w = new FakeWorker(workerOpts);
      workers.push(w);
      return w.asWorker();
    },
    fetchBytes: async (url) => {
      fetched.push(url);
      return new ArrayBuffer(url.length);
    },
  });
  return {
    store,
    service,
    workers,
    fetched,
    imported,
    worker: () => workers.at(-1)!,
  };
}

const block = (id: string, version: number, text = "hello") => ({
  blockId: id,
  version,
  text,
  skip: [],
});

describe("SpellService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the worker lazily, sends init with transferred wasm bytes, then user words", async () => {
    const { store, service, workers, worker, fetched } = setup();
    store.set(`${SPELL_PREF_KEYS.wordPrefix}tasfer`, { added: 1 });
    expect(workers).toHaveLength(0);

    const transport = service.transportFor(editorA, "doc1");
    expect(workers).toHaveLength(0); // not until the first check

    const results = await transport.check({
      docId: "doc1",
      blocks: [block("b1", 7)],
      options: OPTIONS,
      priority: "caret",
    });

    expect(fetched).toEqual(["/app/spell/hunspell.wasm"]);
    const [init, userWords, check] = worker().posted;
    expect(init.msg.type).toBe("init");
    expect((init.msg as { wasm: unknown }).wasm).toBeInstanceOf(ArrayBuffer);
    expect(init.transfer).toEqual([(init.msg as { wasm: ArrayBuffer }).wasm]);
    expect(userWords.msg).toMatchObject({
      type: "setUserWords",
      words: ["tasfer"],
      forbidden: [],
    });
    expect(check.msg).toMatchObject({
      type: "check",
      docId: "doc1",
      priority: "caret",
    });
    expect(results).toEqual([{ blockId: "b1", version: 7, flags: [] }]);
    expect(service.running).toBe(true);
  });

  it("returns the same transport per editor and answers without a worker when disabled", async () => {
    const { store, service, workers } = setup();
    store.set(SPELL_PREF_KEYS.enabled, false);
    const t1 = service.transportFor(editorA, "doc1");
    expect(service.transportFor(editorA, "doc1")).toBe(t1);
    expect(service.transportFor(editorB, "doc2")).not.toBe(t1);
    const results = await t1.check({
      docId: "doc1",
      blocks: [block("b1", 3)],
      options: OPTIONS,
      priority: "local",
    });
    expect(results).toEqual([{ blockId: "b1", version: 3, flags: [] }]);
    expect(workers).toHaveLength(0);
    expect(service.enabled()).toBe(false);
  });

  it("loads an enabled dictionary when a check defers its script, then invalidates", async () => {
    const { service, worker, fetched } = setup({
      onCheck: (req) =>
        req.blocks.map((b) => ({
          blockId: b.blockId,
          version: b.version,
          flags: [],
          deferredScripts: ["latn"],
        })),
    });
    const transport = service.transportFor(editorA, "doc1");
    const invalidations: Array<readonly string[] | undefined> = [];
    transport.onInvalidate((words) => invalidations.push(words));
    const statuses: string[] = [];
    service.subscribe(() => statuses.push(service.status("en")));

    await transport.check({
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "initial",
    });
    expect(service.status("en")).toBe("downloading");
    await flush(20);

    expect(fetched).toEqual([
      "/app/spell/hunspell.wasm",
      "/app/spell/en/index.aff.txt",
      "/app/spell/en/index.dic.txt",
    ]);
    const load = worker().posted.find((p) => p.msg.type === "loadDictionary")!;
    expect(load.msg).toMatchObject({
      type: "loadDictionary",
      lang: "en",
      script: "latn",
      source: { kind: "bytes" },
    });
    const source = (
      load.msg as { source: { aff: ArrayBuffer; dic: ArrayBuffer } }
    ).source;
    expect(load.transfer).toEqual([source.aff, source.dic]);
    expect(service.status("en")).toBe("ready");
    expect(statuses).toContain("downloading");
    expect(statuses.at(-1)).toBe("ready");
    expect(invalidations).toEqual([undefined]);
    // The Arabic dictionary was never asked for.
    expect(service.status("ar")).toBe("missing");
  });

  it("does not load a dictionary whose language is not enabled", async () => {
    const { store, service, worker } = setup({
      onCheck: (req) =>
        req.blocks.map((b) => ({
          blockId: b.blockId,
          version: b.version,
          flags: [],
          deferredScripts: ["arab"],
        })),
    });
    store.set(SPELL_PREF_KEYS.languages, ["en"]);
    const transport = service.transportFor(editorA, "doc1");
    await transport.check({
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "local",
    });
    await flush();
    expect(worker().of("loadDictionary")).toEqual([]);
    expect(service.status("ar")).toBe("missing");
  });

  it("marks a failed dictionary as error and does not retry it on the next deferral", async () => {
    const { service, worker } = setup({
      failDictionaries: ["en"],
      onCheck: (req) =>
        req.blocks.map((b) => ({
          blockId: b.blockId,
          version: b.version,
          flags: [],
          deferredScripts: ["latn"],
        })),
    });
    const transport = service.transportFor(editorA, "doc1");
    const req = {
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "local" as const,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await transport.check(req);
    await flush(20);
    expect(service.status("en")).toBe("error");
    await transport.check(req);
    await flush(20);
    expect(worker().of("loadDictionary")).toHaveLength(1);
    warn.mockRestore();
  });

  it("replays personal words into the worker on every change and narrows the invalidation", async () => {
    const { store, service, worker } = setup();
    const transport = service.transportFor(editorA, "doc1");
    const invalidations: Array<readonly string[] | undefined> = [];
    transport.onInvalidate((words) => invalidations.push(words));
    await transport.check({
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "local",
    });

    await service.addWord("Tasfer");
    expect(worker().of("setUserWords").at(-1)).toMatchObject({
      words: ["Tasfer"],
      forbidden: [],
    });
    expect(invalidations).toEqual([["Tasfer"]]);
    expect(service.hasWord("Tasfer")).toBe(true);

    // A change from another device is replayed too.
    store.receive({ [`${SPELL_PREF_KEYS.forbidPrefix}nope`]: { added: 1 } });
    expect(worker().of("setUserWords").at(-1)).toMatchObject({
      words: ["Tasfer"],
      forbidden: ["nope"],
    });

    await service.removeWord("Tasfer");
    expect(worker().of("setUserWords").at(-1)).toMatchObject({
      words: [],
      forbidden: ["nope"],
    });
    expect(invalidations.at(-1)).toEqual(["Tasfer"]);
  });

  it("stops the worker after the idle period once every transport is released, and restarts on demand", async () => {
    vi.useFakeTimers();
    const { service, workers, worker } = setup(undefined, 10 * 60 * 1000);
    const t1 = service.transportFor(editorA, "doc1");
    const t2 = service.transportFor(editorB, "doc2");
    await t1.check({
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "local",
    });
    await service.ensureLoaded("en");
    expect(service.status("en")).toBe("ready");

    t1.release();
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(worker().terminated).toBe(false); // t2 still alive

    t2.release();
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(worker().terminated).toBe(false);
    vi.advanceTimersByTime(60 * 1000 + 1);
    expect(worker().terminated).toBe(true);
    expect(service.running).toBe(false);
    expect(service.status("en")).toBe("missing");

    // A new transport within the idle window cancels the timer.
    const t3 = service.transportFor(editorA, "doc1");
    await t3.check({
      docId: "doc1",
      blocks: [block("b1", 2)],
      options: OPTIONS,
      priority: "local",
    });
    expect(workers).toHaveLength(2);
    t3.release();
    const t4 = service.transportFor(editorB, "doc2");
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(worker().terminated).toBe(false);
    t4.release();
  });

  it("caches suggestions (LRU) and clears the cache when the personal dictionary changes", async () => {
    const { service, worker } = setup({ onSuggest: (r) => [`${r.word}!`] });
    const transport = service.transportFor(editorA, "doc1");
    expect(await transport.suggest("teh", "latn", 5)).toEqual(["teh!"]);
    expect(await transport.suggest("teh", "latn", 5)).toEqual(["teh!"]);
    expect(worker().of("suggest")).toHaveLength(1);
    expect(await transport.suggest("teh", "latn", 3)).toEqual(["teh!"]);
    expect(worker().of("suggest")).toHaveLength(2); // a different limit is a different key

    await service.addWord("teh");
    await transport.suggest("teh", "latn", 5);
    expect(worker().of("suggest")).toHaveLength(3);
  });

  it("turning spelling off stops the worker and tells checkers to rescan; languages removed remotely are unloaded", async () => {
    const { store, service, worker } = setup();
    const transport = service.transportFor(editorA, "doc1");
    let invalidated = 0;
    transport.onInvalidate(() => invalidated++);
    await transport.check({
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "local",
    });
    await service.ensureLoaded("en");
    await service.ensureLoaded("ar");

    store.receive({ [SPELL_PREF_KEYS.languages]: ["en"] });
    expect(worker().of("unloadDictionary")).toMatchObject([{ lang: "ar" }]);
    expect(service.status("ar")).toBe("missing");
    expect(service.status("en")).toBe("ready");
    expect(invalidated).toBeGreaterThan(0);

    const before = invalidated;
    store.set(SPELL_PREF_KEYS.enabled, false);
    expect(worker().terminated).toBe(true);
    expect(service.running).toBe(false);
    expect(invalidated).toBe(before + 1);
  });

  it("enableLanguage/disableLanguage update the preference and the worker", async () => {
    const { store, service, worker } = setup();
    store.set(SPELL_PREF_KEYS.languages, ["en"]);
    const transport = service.transportFor(editorA, "doc1");
    await transport.check({
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "local",
    });

    await service.enableLanguage("ar");
    expect(service.languages()).toEqual(["en", "ar"]);
    expect(service.status("ar")).toBe("ready");

    await service.disableLanguage("ar");
    expect(service.languages()).toEqual(["en"]);
    expect(service.status("ar")).toBe("missing");
    expect(worker().of("unloadDictionary")).toMatchObject([{ lang: "ar" }]);
  });

  it("tracks flag counts per document and notifies subscribers only on change", () => {
    const { service } = setup();
    let notified = 0;
    service.subscribe(() => notified++);
    service.reportFlagCount("doc1", 3);
    service.reportFlagCount("doc1", 3);
    expect(service.flagCount("doc1")).toBe(3);
    expect(notified).toBe(1);
    service.reportFlagCount("doc1", 0);
    expect(service.flagCount("doc1")).toBe(0);
    expect(notified).toBe(2);
  });

  it("loads a dictionary imported here from its own bytes, with no language ticked", async () => {
    const deferLatin: FakeWorkerOptions = {
      onCheck: (req) =>
        req.blocks.map((b) => ({
          blockId: b.blockId,
          version: b.version,
          flags: [],
          deferredScripts: ["latn" as const],
        })),
    };
    const imported = fakeImported([importedEntry()]);
    const { store, service, worker, fetched } = setup(
      deferLatin,
      undefined,
      imported,
    );
    // Nothing is ticked: an imported dictionary is opted into by existing.
    store.set(SPELL_PREF_KEYS.languages, []);

    const transport = service.transportFor(editorA, "doc1");
    await transport.check({
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "initial",
    });
    await flush(20);

    expect(fetched).toEqual(["/app/spell/hunspell.wasm"]);
    expect(worker().of("loadDictionary")).toMatchObject([
      { lang: "u_1", script: "latn", source: { kind: "bytes" } },
    ]);
    expect(service.status("u_1")).toBe("ready");
    expect(service.importedDictionaries()).toMatchObject([
      { id: "u_1", label: "Work terms", source: { kind: "imported" } },
    ]);
  });

  it("unloads an imported dictionary as soon as it is removed here", async () => {
    const imported = fakeImported([importedEntry()]);
    const { service, worker } = setup(
      {
        onCheck: (req) =>
          req.blocks.map((b) => ({
            blockId: b.blockId,
            version: b.version,
            flags: [],
            deferredScripts: ["latn" as const],
          })),
      },
      undefined,
      imported,
    );
    const transport = service.transportFor(editorA, "doc1");
    await transport.check({
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "initial",
    });
    await flush(20);
    expect(service.status("u_1")).toBe("ready");

    imported.drop("u_1");
    await flush();
    expect(worker().of("unloadDictionary")).toMatchObject([{ lang: "u_1" }]);
    expect(service.status("u_1")).toBe("missing");
    expect(service.importedDictionaries()).toEqual([]);
  });

  it("keeps flagging the words an imported list forbids", async () => {
    const imported = fakeImported(
      [importedEntry({ id: "u_2", kind: "list" })],
      ["definately"],
    );
    const { service, worker } = setup(
      {
        onCheck: (req) =>
          req.blocks.map((b) => ({
            blockId: b.blockId,
            version: b.version,
            flags: [],
            deferredScripts: ["latn" as const],
          })),
      },
      undefined,
      imported,
    );
    const transport = service.transportFor(editorA, "doc1");
    await transport.check({
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "initial",
    });
    await flush(20);

    expect(worker().of("setUserWords").at(-1)).toMatchObject({
      forbidden: ["definately"],
    });
  });

  it("dispose stops the worker and is reversible", async () => {
    const { service, workers, worker } = setup();
    const transport = service.transportFor(editorA, "doc1");
    await transport.check({
      docId: "doc1",
      blocks: [block("b1", 1)],
      options: OPTIONS,
      priority: "local",
    });
    service.dispose();
    expect(worker().terminated).toBe(true);
    service.activate();
    await transport.check({
      docId: "doc1",
      blocks: [block("b1", 2)],
      options: OPTIONS,
      priority: "local",
    });
    expect(workers).toHaveLength(2);
    service.dispose();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });
});
