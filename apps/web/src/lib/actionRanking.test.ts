import { describe, expect, it } from "vitest";
import {
  frecencyBoost,
  frecencyValue,
  scoreMatch,
  type FrecencyEntry,
} from "./actionRanking";

describe("scoreMatch", () => {
  it("returns 0 for an empty query or a query that cannot plausibly match", () => {
    expect(scoreMatch("Groceries", "")).toBe(0);
    expect(scoreMatch("Groceries", "xyz")).toBe(0);
    // A lone character is never treated as fuzzy — it matches almost anything.
    expect(scoreMatch("Calendar", "z")).toBe(0);
  });

  it("ranks exact > prefix > word-boundary > mid-word substring", () => {
    const exact = scoreMatch("cal", "cal");
    const prefix = scoreMatch("calendar", "cal");
    const boundary = scoreMatch("my calendar", "cal");
    const mid = scoreMatch("physical", "cal");

    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
  });

  it("treats path separators as word boundaries", () => {
    expect(scoreMatch("physics/momentum", "momentum")).toBeGreaterThan(
      scoreMatch("amomentumx", "momentum"),
    );
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(scoreMatch("Calendar", "  CAL ")).toBe(scoreMatch("calendar", "cal"));
  });

  it("matches skipped letters via subsequence, below any substring match", () => {
    const fuzzy = scoreMatch("Grocery list", "grcy"); // g-r-c-y, not contiguous
    expect(fuzzy).toBeGreaterThan(0);
    expect(fuzzy).toBeLessThan(scoreMatch("Grocery list", "groc")); // real prefix wins
  });

  it("rejects subsequences scattered too thinly across the target", () => {
    expect(scoreMatch("a big colourful elephant", "ace")).toBe(0);
  });

  it("tolerates typos via bounded edit distance", () => {
    expect(scoreMatch("Calendar", "kalendar")).toBeGreaterThan(0); // substitution
    expect(scoreMatch("Settings", "setings")).toBeGreaterThan(0); // deletion
    expect(scoreMatch("Calendar", "calender")).toBeGreaterThan(0); // substitution
    expect(scoreMatch("Settings", "stetings")).toBeGreaterThan(0); // transposition
  });

  it("keeps every fuzzy match strictly below a real substring match", () => {
    const substring = scoreMatch("Calendar", "cal"); // prefix
    expect(scoreMatch("Calendar", "kalendar")).toBeLessThan(substring);
    expect(scoreMatch("Grocery", "grcy")).toBeLessThan(substring);
  });

  it("does not treat unrelated words as typos", () => {
    expect(scoreMatch("Calendar", "settings")).toBe(0);
  });
});

describe("frecency", () => {
  const now = 1_000 * 86_400_000; // day 1000

  it("weights recent usage above stale usage for equal counts", () => {
    const fresh: FrecencyEntry = { count: 3, last: now };
    const stale: FrecencyEntry = { count: 3, last: now - 60 * 86_400_000 };
    expect(frecencyValue(fresh, now)).toBeGreaterThan(frecencyValue(stale, now));
  });

  it("weights higher counts above lower counts for equal recency", () => {
    const many: FrecencyEntry = { count: 10, last: now };
    const few: FrecencyEntry = { count: 1, last: now };
    expect(frecencyValue(many, now)).toBeGreaterThan(frecencyValue(few, now));
  });

  it("produces a saturating boost that stays below a strong text match", () => {
    expect(frecencyBoost(0)).toBe(0);
    const huge = frecencyBoost(frecencyValue({ count: 1000, last: now }, now));
    expect(huge).toBeLessThan(0.3);
    expect(huge).toBeGreaterThan(0);
  });
});
