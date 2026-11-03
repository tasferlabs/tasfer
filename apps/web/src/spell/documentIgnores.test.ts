import { beforeEach, describe, expect, it } from "vitest";
import { FakeOwnPrefs } from "@/lib/fakeOwnPrefs.testing";
import {
  addDocumentIgnore,
  clearDocumentIgnores,
  IGNORES_PREF_PREFIX,
  readDocumentIgnores,
  readLegacyDocumentIgnores,
  removeDocumentIgnore,
} from "./documentIgnores";

let laptop: FakeOwnPrefs;

describe("documentIgnores", () => {
  beforeEach(() => {
    laptop = new FakeOwnPrefs("laptop");
  });

  it("keeps a page's words apart from other pages'", () => {
    addDocumentIgnore(laptop, "p1", "teh");
    addDocumentIgnore(laptop, "p2", "recieve");

    expect([...readDocumentIgnores(laptop, "p1")]).toEqual(["teh"]);
    expect([...readDocumentIgnores(laptop, "p2")]).toEqual(["recieve"]);
  });

  it("keeps words two devices ignore at the same time", () => {
    const phone = new FakeOwnPrefs("phone");
    addDocumentIgnore(laptop, "p1", "teh");
    addDocumentIgnore(phone, "p1", "recieve");

    laptop.syncFrom(phone);
    phone.syncFrom(laptop);

    for (const device of [laptop, phone]) {
      expect([...readDocumentIgnores(device, "p1")].sort()).toEqual([
        "recieve",
        "teh",
      ]);
    }
  });

  it("carries a removal to the other device", () => {
    const phone = new FakeOwnPrefs("phone");
    addDocumentIgnore(laptop, "p1", "teh");
    phone.syncFrom(laptop);

    removeDocumentIgnore(phone, "p1", "teh");
    laptop.syncFrom(phone);

    expect(readDocumentIgnores(laptop, "p1").size).toBe(0);
  });

  it("clears every word on the page", () => {
    addDocumentIgnore(laptop, "p1", "teh");
    addDocumentIgnore(laptop, "p1", "recieve");
    clearDocumentIgnores(laptop, "p1");

    expect(readDocumentIgnores(laptop, "p1").size).toBe(0);
  });

  it("drops the oldest word past the cap", () => {
    for (let i = 0; i < 201; i++)
      addDocumentIgnore(laptop, "p1", `w${i}`, i + 1);

    const words = readDocumentIgnores(laptop, "p1");
    expect(words.size).toBe(200);
    expect(words.has("w0")).toBe(false);
    expect(words.has("w200")).toBe(true);
  });

  it("is empty without a prefs store", () => {
    expect(readDocumentIgnores(null, "p1").size).toBe(0);
  });

  it("adopts an old browser list one key per word", () => {
    expect(
      readLegacyDocumentIgnores(
        "tasfer.spell.ignored.p1",
        JSON.stringify(["teh", "recieve"]),
      ),
    ).toEqual([
      [IGNORES_PREF_PREFIX + "p1.teh", { added: 1 }],
      [IGNORES_PREF_PREFIX + "p1.recieve", { added: 2 }],
    ]);
  });
});
