import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeOwnPrefsStore } from "./testUtils";

vi.mock("@tasfer/spell", async () => (await import("./testUtils")).spellMock);

const { PersonalDictionary, SPELL_PREF_KEYS, normalizeWordKey } =
  await import("./personalDictionary");

const W = SPELL_PREF_KEYS.wordPrefix;
const F = SPELL_PREF_KEYS.forbidPrefix;

describe("PersonalDictionary", () => {
  let store: FakeOwnPrefsStore;
  let dict: InstanceType<typeof PersonalDictionary>;

  beforeEach(() => {
    store = new FakeOwnPrefsStore();
    dict = new PersonalDictionary(store.asStore());
  });

  it("stores one key per word with an `added` stamp", () => {
    dict.add("Tasfer");
    expect(store.raw(`${W}Tasfer`)).toEqual({ added: expect.any(Number) });
    expect(dict.has("Tasfer")).toBe(true);
    expect(dict.words()).toEqual(["Tasfer"]);
    // Latin case is part of the word.
    expect(dict.has("tasfer")).toBe(false);
  });

  it("removes by writing a null tombstone that reads as absent", () => {
    dict.add("foo");
    dict.remove("foo");
    expect(store.raw(`${W}foo`)).toBeNull();
    expect(store.writes.at(-1)).toEqual([`${W}foo`, null]);
    expect(dict.has("foo")).toBe(false);
    expect(dict.words()).toEqual([]);
  });

  it("normalises Arabic: tashkeel and tatweel stripped, invisibles dropped, NFC", () => {
    expect(normalizeWordKey("مَدْرَسَة")).toBe("مدرسة");
    expect(normalizeWordKey("كتـاب")).toBe("كتاب");
    expect(normalizeWordKey("‏عربي‌")).toBe("عربي");
    expect(normalizeWordKey("café")).toBe("café");
    dict.add("مَدْرَسَة");
    expect(store.raw(`${W}مدرسة`)).toBeTruthy();
    expect(dict.has("مدرسة")).toBe(true);
    expect(dict.has("مُدرسة")).toBe(true);
  });

  it("ignores empty and multi-token input", () => {
    dict.add("   ");
    dict.add("two words");
    expect(store.writes).toEqual([]);
  });

  it("does not rewrite a word that is already present", () => {
    dict.add("foo");
    dict.add("foo");
    expect(store.writes).toHaveLength(1);
  });

  it("adding a forbidden word lifts the forbid", () => {
    dict.forbid("bad");
    expect(store.raw(`${F}bad`)).toBeTruthy();
    expect(dict.forbidden()).toEqual(["bad"]);
    dict.add("bad");
    expect(store.raw(`${F}bad`)).toBeNull();
    expect(dict.forbidden()).toEqual([]);
    expect(dict.has("bad")).toBe(true);
  });

  describe("importText", () => {
    it("merges words, skips comments/blank/duplicates/whitespace, stores forbids", () => {
      dict.add("existing");
      const result = dict.importText(
        [
          "# personal words",
          "",
          "alpha",
          "existing",
          "two words",
          "!nope",
          "  beta  ",
          "alpha",
        ].join("\n"),
      );
      expect(result).toEqual({ added: 3, skipped: 3 });
      expect(new Set(dict.words())).toEqual(
        new Set(["existing", "alpha", "beta"]),
      );
      expect(dict.forbidden()).toEqual(["nope"]);
      expect(store.raw(`${F}nope`)).toEqual({ added: expect.any(Number) });
    });

    it("never wipes and enforces the cap, reporting what did not fit", () => {
      dict.add("kept");
      const result = dict.importText("a\nb\nc\nd", 3);
      expect(result).toEqual({ added: 2, skipped: 2 });
      expect(dict.has("kept")).toBe(true);
      expect(dict.words()).toHaveLength(3);
    });

    it("handles CRLF and a BOM", () => {
      const result = dict.importText("﻿one\r\ntwo\r\n");
      expect(result).toEqual({ added: 2, skipped: 0 });
      expect(dict.has("one")).toBe(true);
    });
  });

  describe("exportText", () => {
    it("is LF-terminated, Latin first (collated), then Arabic, then !forbidden", () => {
      dict.importText("zeta\nApple\nbanana\nكتاب\nأمل\n!nope");
      expect(dict.exportText()).toBe("Apple\nbanana\nzeta\nأمل\nكتاب\n!nope\n");
    });

    it("is empty for an empty dictionary", () => {
      expect(dict.exportText()).toBe("");
    });
  });

  it("reports diffs for remote changes and detaches with the last subscriber", () => {
    const seen: Array<{ added: string[]; removed: string[] }> = [];
    const off = dict.subscribe((diff) => seen.push(diff));
    store.receive({ [`${W}remote`]: { added: 1 } });
    expect(seen).toEqual([{ added: ["remote"], removed: [] }]);
    expect(dict.has("remote")).toBe(true);
    store.receive({ [`${W}remote`]: null });
    expect(seen).toEqual([
      { added: ["remote"], removed: [] },
      { added: [], removed: ["remote"] },
    ]);
    // Unrelated keys do not fire.
    store.receive({ "sidebar.spaceOrder": ["x"] });
    expect(seen).toHaveLength(2);
    off();
    store.receive({ [`${W}later`]: { added: 1 } });
    expect(seen).toHaveLength(2);
  });
});
