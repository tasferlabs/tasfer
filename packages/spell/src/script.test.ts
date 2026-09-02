import {
  arabicVariants,
  caseVariants,
  collapseRepeats,
  matchCase,
  normalizeForLookup,
  scriptOf,
} from "./script";
import { describe, expect, it } from "vitest";

describe("scriptOf", () => {
  it("classifies Latin and Arabic words", () => {
    expect(scriptOf("hello")).toBe("latn");
    expect(scriptOf("l'école")).toBe("latn");
    expect(scriptOf("كتاب")).toBe("arab");
    expect(scriptOf("مُحَمَّدٌ")).toBe("arab");
    // Persian/Urdu letters live in the Arabic blocks too.
    expect(scriptOf("پاکستان")).toBe("arab");
  });

  it("ignores marks, tatweel, digits and format characters", () => {
    expect(scriptOf("الـكتاب")).toBe("arab");
    expect(scriptOf("كتاب\u200F")).toBe("arab");
    expect(scriptOf("café")).toBe("latn");
    expect(scriptOf("café")).toBe("latn");
    expect(scriptOf("abc123")).toBe("latn");
    expect(scriptOf("ﻻ")).toBe("arab");
  });

  it("returns mixed for two scripts and other for the rest", () => {
    expect(scriptOf("الـWiFi")).toBe("mixed");
    expect(scriptOf("WiFiكتاب")).toBe("mixed");
    expect(scriptOf("привет")).toBe("other");
    expect(scriptOf("日本語")).toBe("other");
    expect(scriptOf("123")).toBe("other");
    expect(scriptOf("ـــ")).toBe("other");
    expect(scriptOf("")).toBe("other");
  });
});

describe("normalizeForLookup", () => {
  it("strips tashkeel and tatweel from Arabic", () => {
    expect(normalizeForLookup("مُحَمَّدٌ", "arab")).toBe("محمد");
    expect(normalizeForLookup("الْمَدْرَسَةِ", "arab")).toBe("المدرسة");
    expect(normalizeForLookup("الـــكتاب", "arab")).toBe("الكتاب");
    expect(normalizeForLookup("كِتَابٌ", "arab")).toBe("كتاب");
  });

  it("folds presentation forms but never hamza, ta marbuta or alif maqsura", () => {
    expect(normalizeForLookup("ﻻ", "arab")).toBe("لا");
    expect(normalizeForLookup("ﻷ", "arab")).toBe("لأ");
    expect(normalizeForLookup("ﺍﻟﻜﺘﺎﺏ", "arab")).toBe("الكتاب");
    // U+FE70 decomposes to a space plus fathatan; both go away.
    expect(normalizeForLookup("كتابﹰ", "arab")).toBe("كتاب");
    expect(normalizeForLookup("أحمد", "arab")).toBe("أحمد");
    expect(normalizeForLookup("إلى", "arab")).toBe("إلى");
    expect(normalizeForLookup("آمن", "arab")).toBe("آمن");
    expect(normalizeForLookup("مدرسة", "arab")).toBe("مدرسة");
    expect(normalizeForLookup("على", "arab")).toBe("على");
  });

  it("strips bidi controls, joiners and soft hyphens for every script", () => {
    expect(normalizeForLookup("\u202Bكتاب\u202C", "arab")).toBe("كتاب");
    expect(normalizeForLookup("hel\u00ADlo", "latn")).toBe("hello");
    expect(normalizeForLookup("\u200Ehello\u200F", "latn")).toBe("hello");
    expect(normalizeForLookup("مي\u200Cخواهم", "arab")).toBe("ميخواهم");
  });

  it("applies NFC", () => {
    expect(normalizeForLookup("café", "latn")).toBe("café");
    // Alif + madda combining → precomposed آ (canonical, so it is kept).
    expect(normalizeForLookup("آمن", "arab")).toBe("آمن");
  });

  it("leaves Latin marks alone", () => {
    expect(normalizeForLookup("naïve", "latn")).toBe("naïve");
  });
});

describe("arabicVariants", () => {
  it("swaps initial alif forms", () => {
    const v = arabicVariants("الى");
    expect(v).toEqual(
      expect.arrayContaining(["إلى", "ألى", "آلى", "الي", "إلي"]),
    );
    expect(v).not.toContain("الى");
    expect(v).toHaveLength(7);
  });

  it("swaps final ta marbuta / ha", () => {
    expect(arabicVariants("مدرسه")).toEqual(["مدرسة"]);
    expect(arabicVariants("مدرسة")).toEqual(["مدرسه"]);
  });

  it("swaps final alif maqsura / ya", () => {
    expect(arabicVariants("علي")).toEqual(["على"]);
    expect(arabicVariants("على")).toEqual(["علي"]);
  });

  it("varies the alif after a one-letter proclitic", () => {
    expect(arabicVariants("وامل")).toEqual(
      expect.arrayContaining(["وأمل", "وإمل", "وآمل"]),
    );
    expect(arabicVariants("وامل")).toHaveLength(3);
  });

  it("returns nothing when no position varies", () => {
    expect(arabicVariants("كتاب")).toEqual([]);
    expect(arabicVariants("")).toEqual([]);
  });
});

describe("caseVariants", () => {
  it("handles sentence-initial capitals and all caps", () => {
    expect(caseVariants("Hello")).toEqual(["hello"]);
    expect(caseVariants("HELLO")).toEqual(["hello", "Hello"]);
    expect(caseVariants("hello")).toEqual([]);
    expect(caseVariants("iPhone")).toEqual([]);
    expect(caseVariants("École")).toEqual(["école"]);
  });
});

describe("matchCase", () => {
  it("restores the original casing pattern", () => {
    expect(matchCase("hello", "Helo")).toBe("Hello");
    expect(matchCase("hello", "HELO")).toBe("HELLO");
    expect(matchCase("hello", "helo")).toBe("hello");
    expect(matchCase("hello", "hElo")).toBe("hello");
    expect(matchCase("كتاب", "كتب")).toBe("كتاب");
  });
});

describe("collapseRepeats", () => {
  it("collapses runs of three or more letters", () => {
    expect(collapseRepeats("sooo")).toEqual(["soo", "so"]);
    expect(collapseRepeats("soooooo")).toEqual(["soo", "so"]);
    expect(collapseRepeats("yesss")).toEqual(["yess", "yes"]);
    expect(collapseRepeats("جميييل")).toEqual(["جمييل", "جميل"]);
  });

  it("returns nothing for words without such runs", () => {
    expect(collapseRepeats("soo")).toEqual([]);
    expect(collapseRepeats("hello")).toEqual([]);
    expect(collapseRepeats("111")).toEqual([]);
  });
});
