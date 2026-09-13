import {
  createSegmenter,
  mergeSpans,
  protectedSpans,
  type Token,
  tokenize,
  type TokenizeOptions,
  wordAt,
} from "./tokenizer";
import { describe, expect, it } from "vitest";

const seg = createSegmenter();
const opts: TokenizeOptions = { skip: [], flagAllCaps: false };

function words(
  text: string,
  o = opts,
  s: Intl.Segmenter | null = seg,
): string[] {
  return tokenize(text, o, s).map((t) => t.text);
}

function offsetsMatch(text: string, tokens: Token[]): void {
  for (const t of tokens) expect(text.slice(t.from, t.to)).toBe(t.text);
}

describe("tokenize (English)", () => {
  it("has a segmenter in this runtime", () => {
    expect(seg).not.toBeNull();
  });

  it("keeps contractions whole and splits hyphenated words", () => {
    expect(words("don't")).toEqual(["don't"]);
    expect(words("I don’t know")).toEqual(["don’t", "know"]);
    const tokens = tokenize("a well-known fact", opts, seg);
    expect(tokens.map((t) => t.text)).toEqual(["well", "known", "fact"]);
    offsetsMatch("a well-known fact", tokens);
    expect(tokens[0]).toMatchObject({ from: 2, to: 6 });
    expect(tokens[1]).toMatchObject({ from: 7, to: 12 });
  });

  it("splits at en dashes too", () => {
    expect(words("Paris–Berlin")).toEqual(["Paris", "Berlin"]);
  });

  it("drops tokens with digits, identifiers and single letters", () => {
    expect(words("abc123 10kg x")).toEqual([]);
    expect(words("foo_bar camelCase snake_case")).toEqual([]);
    expect(words("a b I am")).toEqual(["am"]);
  });

  it("drops URLs, emails, mentions and hashtags", () => {
    expect(words("https://example.com/x foo@bar.com @user #tag #وسم")).toEqual(
      [],
    );
    expect(words("see www.example.org now")).toEqual(["see", "now"]);
    expect(words("visit example.com today")).toEqual(["visit", "today"]);
    expect(words("mailto:someone@example.com works")).toEqual(["works"]);
  });

  it("drops file paths and long ids", () => {
    expect(words("open /usr/local/bin/x or C:\\Users\\me\\file.txt")).toEqual([
      "open",
      "or",
    ]);
    expect(words("id deadbeefdeadbeefcafe done")).toEqual(["id", "done"]);
    expect(words("token QUJDREVGR0hJSktMTU5PUA== done")).toEqual([
      "token",
      "done",
    ]);
    // A long ordinary word is not an "id".
    expect(words("internationalization")).toEqual(["internationalization"]);
  });

  it("keeps and/or and slashes between words", () => {
    expect(words("and/or")).toEqual(["and", "or"]);
  });

  it("drops ALL-CAPS unless asked", () => {
    expect(words("NASA launched")).toEqual(["launched"]);
    expect(words("NASA launched", { skip: [], flagAllCaps: true })).toEqual([
      "NASA",
      "launched",
    ]);
    // A capitalised word is not all caps.
    expect(words("Hello")).toEqual(["Hello"]);
  });

  it("trims quotes and apostrophes", () => {
    const text = `she said "hello" and 'bye' and students’ books`;
    const tokens = tokenize(text, opts, seg);
    expect(tokens.map((t) => t.text)).toEqual([
      "she",
      "said",
      "hello",
      "and",
      "bye",
      "and",
      "students",
      "books",
    ]);
    offsetsMatch(text, tokens);
  });

  it("respects skip ranges", () => {
    const text = "run `npm instal` now";
    const code: [number, number] = [
      text.indexOf("`"),
      text.lastIndexOf("`") + 1,
    ];
    expect(words(text, { skip: [code], flagAllCaps: false })).toEqual([
      "run",
      "now",
    ]);
    // A token straddling the edge of a skip span is dropped as well.
    expect(
      words("hello world", { skip: [[3, 5]], flagAllCaps: false }),
    ).toEqual(["world"]);
  });

  it("normalises Latin tokens with NFC and strips soft hyphens", () => {
    const tokens = tokenize("cafe\u0301 hel\u00ADlo", opts, seg);
    expect(tokens.map((t) => t.normalized)).toEqual(["café", "hello"]);
    expect(tokens.map((t) => t.script)).toEqual(["latn", "latn"]);
    offsetsMatch("cafe\u0301 hel\u00ADlo", tokens);
  });

  it("drops tokens longer than 100 characters", () => {
    expect(words("x".repeat(101))).toEqual([]);
    expect(words("x".repeat(100))).toHaveLength(1);
  });
});

describe("tokenize (Arabic)", () => {
  it("keeps diacritised words whole with diacritic-free normalised forms", () => {
    const text = "قال مُحَمَّدٌ في الْمَدْرَسَةِ";
    const tokens = tokenize(text, opts, seg);
    expect(tokens.map((t) => t.text)).toEqual([
      "قال",
      "مُحَمَّدٌ",
      "في",
      "الْمَدْرَسَةِ",
    ]);
    expect(tokens.map((t) => t.normalized)).toEqual([
      "قال",
      "محمد",
      "في",
      "المدرسة",
    ]);
    expect(tokens.every((t) => t.script === "arab")).toBe(true);
    offsetsMatch(text, tokens);
  });

  it("drops mixed-script, digit-bearing and tatweel-only tokens", () => {
    expect(words("الـWiFi")).toEqual([]);
    expect(words("في و2024 و٢٠٢٤ سنة")).toEqual(["في", "سنة"]);
    expect(words("ــــ كتاب")).toEqual(["كتاب"]);
    expect(words("الـــكتاب")).toEqual(["الـــكتاب"]);
    expect(tokenize("الـــكتاب", opts, seg)[0].normalized).toBe("الكتاب");
  });

  it("drops Arabic hashtags and mentions", () => {
    expect(words("#وسم @مستخدم كلمة")).toEqual(["كلمة"]);
  });

  it("drops other scripts", () => {
    expect(words("привет 日本語 hello")).toEqual(["hello"]);
  });
});

describe("tokenize (regex fallback)", () => {
  it("produces the same tokens for the common cases without a segmenter", () => {
    expect(words("don't stop well-known abc123 x NASA", opts, null)).toEqual([
      "don't",
      "stop",
      "well",
      "known",
    ]);
    expect(
      words("https://example.com/x foo@bar.com @user #tag", opts, null),
    ).toEqual([]);
    const text = "قال مُحَمَّدٌ في الْمَدْرَسَةِ";
    const tokens = tokenize(text, opts, null);
    expect(tokens.map((t) => t.normalized)).toEqual([
      "قال",
      "محمد",
      "في",
      "المدرسة",
    ]);
    offsetsMatch(text, tokens);
    expect(words("'hello' foo_bar", opts, null)).toEqual(["hello"]);
  });
});

describe("protectedSpans", () => {
  it("returns sorted merged spans and never throws", () => {
    const text = "see https://a.b/c and x@y.io";
    const spans = protectedSpans(text);
    expect(spans.map(([a, b]) => text.slice(a, b))).toEqual([
      "https://a.b/c",
      "x@y.io",
    ]);
    expect(protectedSpans("")).toEqual([]);
    expect(protectedSpans("plain words only")).toEqual([]);
  });

  it("merges overlapping spans", () => {
    expect(
      mergeSpans([
        [5, 9],
        [0, 3],
        [2, 6],
        [9, 10],
      ]),
    ).toEqual([[0, 10]]);
    expect(mergeSpans([[0, 0]])).toEqual([]);
  });

  it("stays fast on long inputs", () => {
    const text = (
      "word ".repeat(200) +
      "https://example.com/" +
      "a".repeat(50) +
      " aaaa.bbbb.cccc.dddd "
    ).repeat(50);
    const t0 = performance.now();
    protectedSpans(text);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("wordAt", () => {
  const text = "hello brave world";
  it("finds the word at the start, middle and end", () => {
    expect(wordAt(text, 0, seg)).toEqual({ from: 0, to: 5 });
    expect(wordAt(text, 7, seg)).toEqual({ from: 6, to: 11 });
    expect(wordAt(text, 5, seg)).toEqual({ from: 0, to: 5 });
    expect(wordAt(text, text.length, seg)).toEqual({ from: 12, to: 17 });
  });

  it("returns null in whitespace and out of range", () => {
    expect(wordAt("hello  world", 6, seg)).toBeNull();
    expect(wordAt(text, -1, seg)).toBeNull();
    expect(wordAt(text, 99, seg)).toBeNull();
    expect(wordAt("", 0, seg)).toBeNull();
  });

  it("works for Arabic and without a segmenter", () => {
    const ar = "قال مُحَمَّدٌ";
    expect(wordAt(ar, 5, seg)).toEqual({ from: 4, to: ar.length });
    expect(wordAt(ar, ar.length, null)).toEqual({ from: 4, to: ar.length });
    expect(wordAt(text, 5, null)).toEqual({ from: 0, to: 5 });
    expect(wordAt(text, 7, null)).toEqual({ from: 6, to: 11 });
    expect(wordAt("hello  world", 6, null)).toBeNull();
  });
});
