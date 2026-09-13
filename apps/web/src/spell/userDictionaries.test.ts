import { describe, expect, it } from "vitest";
import type { FsDriver } from "@/platform/driver";
import {
  DictionaryImportError,
  declaredLanguage,
  IMPORTED_DICTS_KEY,
  inferScript,
  inspectList,
  inspectPair,
  type KeyValueStorage,
  looksLikeAff,
  looksLikeDic,
  parseDescriptor,
  UserDictionaryStore,
  wordListSize,
} from "./userDictionaries";
import { FakeDictionaryAssets, FakeOwnPrefsStore } from "./testUtils";
import { SPELL_PREF_KEYS } from "./personalDictionary";

class MemoryFs implements FsDriver {
  readonly files = new Map<string, Uint8Array>();
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, data: Uint8Array) {
    this.files.set(path, data);
  }
  async delete(path: string) {
    this.files.delete(path);
  }
  async list(dir: string) {
    const prefix = `${dir}/`;
    return [...this.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length));
  }
  async exists(path: string) {
    return this.files.has(path);
  }
}

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text);

const AFF = utf8("SET UTF-8\nLANG ar_SA\nTRY \u0627\u0628\n");
const DIC = utf8("2\n\u0643\u062a\u0627\u0628\n\u0645\u062f\u0631\u0633\u0629\n");
const LATIN_AFF = utf8("SET UTF-8\nTRY esiat\n");
const LATIN_DIC = utf8("3\nhullo\nquux\nzarf\n");

function store() {
  const prefs = new FakeOwnPrefsStore();
  const assets = new FakeDictionaryAssets();
  const fs = new MemoryFs();
  const storage = new MemoryStorage();
  const dicts = new UserDictionaryStore({
    prefs: prefs.asStore(),
    assets,
    legacy: { fs, storage },
  });
  return { prefs, assets, fs, storage, dicts };
}

/** Presence is settled off a microtask sweep; let it land before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("dictionary file inspection", () => {
  it("recognises an affix file by its directives, with or without SET", () => {
    expect(looksLikeAff(AFF)).toBe(true);
    expect(looksLikeAff(utf8("PFX A Y 1\nPFX A 0 re .\n"))).toBe(true);
    expect(looksLikeAff(DIC)).toBe(false);
  });

  it("recognises a .dic by its leading entry count", () => {
    expect(looksLikeDic(DIC)).toBe(true);
    expect(looksLikeDic(utf8("﻿2\nكتاب\nمدرسة\n"))).toBe(true);
    expect(looksLikeDic(utf8("hullo\nquux\n"))).toBe(false);
  });

  it("reads the declared language and falls back to the script", () => {
    expect(declaredLanguage(AFF)).toBe("ar");
    expect(declaredLanguage(LATIN_AFF)).toBe("");
    expect(
      inspectPair(
        { name: "ar.aff", bytes: LATIN_AFF },
        {
          name: "ar.dic",
          bytes: DIC,
        },
      ).lang,
    ).toBe("ar");
  });

  it("routes a dictionary to the script of its entries, ignoring flags", () => {
    expect(inferScript(DIC)).toBe("arab");
    expect(inferScript(LATIN_DIC)).toBe("latn");
    expect(inferScript(utf8("2\nhullo/SM\nquux/S\n"))).toBe("latn");
  });

  it("names a pair after its .dic and keeps what the aff declared", () => {
    expect(
      inspectPair(
        { name: "ayaspell.aff", bytes: AFF },
        {
          name: "ayaspell.dic",
          bytes: DIC,
        },
      ),
    ).toEqual({ label: "ayaspell", lang: "ar", script: "arab" });
  });

  it("refuses files that are not a dictionary", () => {
    const notAff = () =>
      inspectPair(
        { name: "a.txt", bytes: utf8("hullo\n") },
        {
          name: "b.dic",
          bytes: DIC,
        },
      );
    expect(notAff).toThrow(DictionaryImportError);
    expect(() =>
      inspectPair(
        { name: "a.aff", bytes: AFF },
        {
          name: "b.txt",
          bytes: utf8("hullo\nquux\n"),
        },
      ),
    ).toThrow(/notDic/);
    expect(() => inspectList({ name: "empty.txt", bytes: utf8("") })).toThrow(
      /empty/,
    );
    expect(() =>
      inspectList({ name: "comments.txt", bytes: utf8("# nothing here\n") }),
    ).toThrow(/noWords/);
  });

  it("counts a word list the way the converter does", () => {
    // Comments and blanks drop out; `!word` still counts as an entry.
    expect(wordListSize("# c\n\nhullo\nquux\n!nope\n")).toBe(3);
    expect(wordListSize("hullo\nhullo\n")).toBe(1);
  });
});

describe("UserDictionaryStore", () => {
  it("puts the bytes in the asset store and the descriptor in own-prefs", async () => {
    const { prefs, assets, dicts } = store();
    const d = await dicts.importPair(
      { name: "ayaspell.aff", bytes: AFF },
      { name: "ayaspell.dic", bytes: DIC },
    );
    expect(d.kind).toBe("pair");
    expect(d.script).toBe("arab");
    expect(d.bytes).toBe(AFF.length + DIC.length);

    // The descriptor names hashes; the register never carries the bytes.
    const stored = prefs.raw(SPELL_PREF_KEYS.dictPrefix + d.id);
    expect(parseDescriptor(stored)).toMatchObject({
      kind: "pair",
      script: "arab",
      aff: d.aff,
      dic: d.dic,
    });
    expect(JSON.stringify(stored)).not.toContain("SET UTF-8");
    expect(assets.local.get(d.aff!)).toEqual(AFF);
    expect(assets.local.get(d.dic!)).toEqual(DIC);

    const read = await dicts.read(d.id);
    expect(read?.aff).toEqual(AFF);
    expect(read?.dic).toEqual(DIC);
    expect(read?.forbidden).toEqual([]);
  });

  it("keeps a word list verbatim and converts it on every read", async () => {
    const { assets, dicts } = store();
    const list = utf8("# mine\nhullo\nquux\n!definately\n");
    const d = await dicts.importList({ name: "team.txt", bytes: list });
    expect(d.kind).toBe("list");
    expect(d.label).toBe("team");
    expect(assets.local.get(d.words!)).toEqual(list);
    const read = await dicts.read(d.id);
    const dic = new TextDecoder().decode(read!.dic);
    expect(dic).toBe("2\nhullo\nquux\n");
    expect(read?.forbidden).toEqual(["definately"]);
  });

  it("lets the person override the inferred name and script", async () => {
    const { dicts } = store();
    const d = await dicts.importPair(
      { name: "ayaspell.aff", bytes: AFF },
      { name: "ayaspell.dic", bytes: DIC },
      { label: "  Work terms  ", script: "latn" },
    );
    expect(d.label).toBe("Work terms");
    expect(d.script).toBe("latn");
  });

  it("shows a dictionary another device added, and pulls its files on read", async () => {
    const { prefs, assets, dicts } = store();
    const d = await dicts.importList({
      name: "team.txt",
      bytes: utf8("hullo\n"),
    });
    const descriptor = prefs.raw(SPELL_PREF_KEYS.dictPrefix + d.id);

    // A device that has never seen this dictionary: the descriptor arrives
    // over own-prefs, the bytes are still on the sibling.
    const fresh = new FakeOwnPrefsStore();
    const freshAssets = new FakeDictionaryAssets();
    freshAssets.remote.set(d.words!, utf8("hullo\n"));
    const other = new UserDictionaryStore({
      prefs: fresh.asStore(),
      assets: freshAssets,
    });
    fresh.receive({ [SPELL_PREF_KEYS.dictPrefix + d.id]: descriptor });

    expect(other.list().map((x) => x.id)).toEqual([d.id]);
    await settle();
    expect(other.presence(d.id)).toBe("elsewhere");

    const read = await other.read(d.id);
    expect(new TextDecoder().decode(read!.dic)).toBe("1\nhullo\n");
    expect(freshAssets.pulled).toEqual([d.words]);
    expect(other.presence(d.id)).toBe("here");
    expect(assets.local.size).toBeGreaterThan(0);
  });

  it("reports a dictionary no reachable device holds, without inventing bytes", async () => {
    const { dicts, assets } = store();
    const d = await dicts.importPair(
      { name: "a.aff", bytes: AFF },
      { name: "a.dic", bytes: DIC },
    );
    assets.local.delete(d.dic!);
    expect(await dicts.read(d.id)).toBeNull();
    expect(dicts.presence(d.id)).toBe("elsewhere");
  });

  it("removes everywhere with a tombstone, and drops this device's bytes", async () => {
    const { prefs, assets, dicts } = store();
    let calls = 0;
    dicts.subscribe(() => calls++);
    const d = await dicts.importList({
      name: "team.txt",
      bytes: utf8("hullo\n"),
    });
    await dicts.remove(d.id);

    expect(prefs.raw(SPELL_PREF_KEYS.dictPrefix + d.id)).toBeNull();
    expect(dicts.list()).toEqual([]);
    expect(assets.local.size).toBe(0);
    expect(await dicts.read(d.id)).toBeNull();
    expect(calls).toBeGreaterThan(0);

    const before = calls;
    await dicts.remove("nope");
    expect(calls).toBe(before);
  });

  it("keeps bytes another dictionary still shares", async () => {
    const { assets, dicts } = store();
    const list = utf8("hullo\n");
    const a = await dicts.importList({ name: "a.txt", bytes: list });
    const b = await dicts.importList({ name: "b.txt", bytes: list });
    expect(a.words).toBe(b.words); // identical files, one asset
    await dicts.remove(a.id);
    expect(assets.local.has(b.words!)).toBe(true);
    expect((await dicts.read(b.id))?.dic).toBeTruthy();
  });

  it("drops a dictionary another device removed, and forgets its bytes", async () => {
    const { prefs, assets, dicts } = store();
    const d = await dicts.importList({
      name: "team.txt",
      bytes: utf8("hullo\n"),
    });
    expect(assets.local.size).toBe(1);
    prefs.receive({ [SPELL_PREF_KEYS.dictPrefix + d.id]: null });
    expect(dicts.list()).toEqual([]);
    await settle();
    expect(assets.local.size).toBe(0);
  });

  it("ignores descriptors it cannot use rather than showing a row that never loads", () => {
    const { prefs, dicts } = store();
    const P = SPELL_PREF_KEYS.dictPrefix;
    prefs.receive({
      [`${P}nokind`]: { script: "latn", words: "a".repeat(64) },
      [`${P}noscript`]: { kind: "list", words: "a".repeat(64) },
      [`${P}nohash`]: { kind: "list", script: "latn" },
      [`${P}badhash`]: { kind: "list", script: "latn", words: "../escape" },
      [`${P}pairhalf`]: { kind: "pair", script: "latn", aff: "b".repeat(64) },
      [`${P}bad id`]: { kind: "list", script: "latn", words: "c".repeat(64) },
      [`${P}good`]: { kind: "list", script: "latn", words: "d".repeat(64) },
    });
    expect(dicts.list().map((x) => x.id)).toEqual(["good"]);
  });

  it("renames on every device, keeping the bytes it already named", async () => {
    const { prefs, dicts } = store();
    const d = await dicts.importList({
      name: "team.txt",
      bytes: utf8("hullo\n"),
    });
    dicts.update(d.id, { label: "  Work terms  " });
    const after = dicts.get(d.id);
    expect(after?.label).toBe("Work terms");
    expect(after?.words).toBe(d.words);
    expect(
      parseDescriptor(prefs.raw(SPELL_PREF_KEYS.dictPrefix + d.id))?.label,
    ).toBe("Work terms");
  });

  it("adopts imports made before dictionaries synced, then forgets the old copy", async () => {
    const { prefs, assets, fs, storage, dicts } = store();
    await fs.write("spell/dicts/old1/index.aff", AFF);
    await fs.write("spell/dicts/old1/index.dic", DIC);
    await fs.write("spell/dicts/old2/words.txt", utf8("hullo\n"));
    storage.map.set(
      IMPORTED_DICTS_KEY,
      JSON.stringify([
        { id: "old1", label: "Aya", lang: "ar", script: "arab", kind: "pair" },
        { id: "old2", label: "Team", lang: "", script: "latn", kind: "list" },
        { id: "gone", label: "Gone", lang: "", script: "latn", kind: "list" },
      ]),
    );

    await dicts.adopt();

    expect(dicts.list().map((x) => x.id)).toEqual(["old1", "old2"]);
    expect((await dicts.read("old1"))?.aff).toEqual(AFF);
    expect(new TextDecoder().decode((await dicts.read("old2"))!.dic)).toBe(
      "1\nhullo\n",
    );
    // Seeded, not set: an adopted copy must lose to a later decision elsewhere.
    expect(prefs.writes).toEqual([]);
    expect(prefs.seeds.map(([k]) => k)).toEqual([
      `${SPELL_PREF_KEYS.dictPrefix}old1`,
      `${SPELL_PREF_KEYS.dictPrefix}old2`,
    ]);
    expect(assets.local.size).toBe(3);
    expect(storage.map.has(IMPORTED_DICTS_KEY)).toBe(false);

    await dicts.adopt(); // Idempotent: nothing left to find.
    expect(prefs.seeds).toHaveLength(2);
  });

  it("does not adopt over a dictionary the register already knows", async () => {
    const { prefs, fs, storage, dicts } = store();
    await fs.write("spell/dicts/old1/words.txt", utf8("hullo\n"));
    storage.map.set(
      IMPORTED_DICTS_KEY,
      JSON.stringify([
        { id: "old1", label: "Stale", lang: "", script: "latn", kind: "list" },
      ]),
    );
    prefs.receive({
      [`${SPELL_PREF_KEYS.dictPrefix}old1`]: {
        kind: "list",
        script: "latn",
        label: "Current",
        lang: "",
        bytes: 6,
        importedAt: 1,
        words: "e".repeat(64),
      },
    });

    await dicts.adopt();
    expect(dicts.get("old1")?.label).toBe("Current");
    expect(prefs.seeds).toEqual([]);
  });

  it("works with no legacy storage, for a window that denies it", async () => {
    const prefs = new FakeOwnPrefsStore();
    const dicts = new UserDictionaryStore({
      prefs: prefs.asStore(),
      assets: new FakeDictionaryAssets(),
    });
    const d = await dicts.importList({
      name: "team.txt",
      bytes: utf8("hullo\n"),
    });
    expect(dicts.list().map((x) => x.id)).toEqual([d.id]);
    await expect(dicts.adopt()).resolves.toBeUndefined();
  });
});
