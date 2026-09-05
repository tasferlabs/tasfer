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
  UserDictionaryStore,
  wordListSize,
} from "./userDictionaries";

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
}

const utf8 = (text: string) => new TextEncoder().encode(text);

const AFF = utf8("SET UTF-8\nLANG ar_SA\nTRY اب\n");
const DIC = utf8("2\nكتاب\nمدرسة\n");
const LATIN_AFF = utf8("SET UTF-8\nTRY esiat\n");
const LATIN_DIC = utf8("3\nhullo\nquux\nzarf\n");

function store() {
  const fs = new MemoryFs();
  const storage = new MemoryStorage();
  return { fs, storage, dicts: new UserDictionaryStore(fs, storage) };
}

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
  it("writes a pair to the filesystem and reads it back", async () => {
    const { fs, dicts } = store();
    const d = await dicts.importPair(
      { name: "ayaspell.aff", bytes: AFF },
      { name: "ayaspell.dic", bytes: DIC },
    );
    expect(d.kind).toBe("pair");
    expect(d.script).toBe("arab");
    expect(d.bytes).toBe(AFF.length + DIC.length);
    expect([...fs.files.keys()].sort()).toEqual([
      `spell/dicts/${d.id}/index.aff`,
      `spell/dicts/${d.id}/index.dic`,
    ]);
    const read = await dicts.read(d.id);
    expect(read?.aff).toEqual(AFF);
    expect(read?.dic).toEqual(DIC);
    expect(read?.forbidden).toEqual([]);
  });

  it("keeps a word list verbatim and converts it on every read", async () => {
    const { fs, dicts } = store();
    const list = utf8("# mine\nhullo\nquux\n!definately\n");
    const d = await dicts.importList({ name: "team.txt", bytes: list });
    expect(d.kind).toBe("list");
    expect(d.label).toBe("team");
    expect(fs.files.get(`spell/dicts/${d.id}/words.txt`)).toEqual(list);
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

  it("survives a reload and ignores descriptors it cannot read", async () => {
    const { fs, storage, dicts } = store();
    const d = await dicts.importPair(
      { name: "a.aff", bytes: AFF },
      { name: "a.dic", bytes: DIC },
    );
    storage.map.set(
      IMPORTED_DICTS_KEY,
      `${storage.map.get(IMPORTED_DICTS_KEY)!.slice(0, -1)},{"id":"broken"}]`,
    );
    const reloaded = new UserDictionaryStore(fs, storage);
    expect(reloaded.list().map((x) => x.id)).toEqual([d.id]);
    expect(
      new UserDictionaryStore(fs, {
        getItem: () => "not json",
        setItem: () => {},
      }).list(),
    ).toEqual([]);
  });

  it("deletes the files when a dictionary is removed, and tells subscribers", async () => {
    const { fs, dicts } = store();
    let calls = 0;
    dicts.subscribe(() => calls++);
    const d = await dicts.importList({
      name: "team.txt",
      bytes: utf8("hullo\n"),
    });
    expect(calls).toBe(1);
    await dicts.remove(d.id);
    expect(calls).toBe(2);
    expect(dicts.list()).toEqual([]);
    expect(fs.files.size).toBe(0);
    expect(await dicts.read(d.id)).toBeNull();
    await dicts.remove("nope");
    expect(calls).toBe(2);
  });

  it("reports missing files rather than handing the worker nothing", async () => {
    const { fs, dicts } = store();
    const d = await dicts.importPair(
      { name: "a.aff", bytes: AFF },
      { name: "a.dic", bytes: DIC },
    );
    fs.files.delete(`spell/dicts/${d.id}/index.dic`);
    expect(await dicts.read(d.id)).toBeNull();
  });

  it("works without storage, for a window that denies it", async () => {
    const fs = new MemoryFs();
    const dicts = new UserDictionaryStore(fs, null);
    const d = await dicts.importList({
      name: "team.txt",
      bytes: utf8("hullo\n"),
    });
    expect(dicts.list().map((x) => x.id)).toEqual([d.id]);
  });
});
