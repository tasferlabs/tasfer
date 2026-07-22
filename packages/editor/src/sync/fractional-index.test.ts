import { generateKeyBetween, generateNKeysBetween } from "./fractional-index";
import { describe, expect, it } from "vitest";

describe("generateKeyBetween", () => {
  it("returns a canonical first key for the empty document", () => {
    expect(generateKeyBetween(null, null)).toBe("a0");
  });

  it("appends after a key when upper bound is null", () => {
    const first = generateKeyBetween(null, null);
    const next = generateKeyBetween(first, null);
    expect(next > first).toBe(true);
  });

  it("prepends before a key when lower bound is null", () => {
    const first = generateKeyBetween(null, null);
    const prev = generateKeyBetween(null, first);
    expect(prev < first).toBe(true);
  });

  it("produces a key strictly between two neighbours", () => {
    const a = generateKeyBetween(null, null);
    const c = generateKeyBetween(a, null);
    const b = generateKeyBetween(a, c);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("survives repeated subdivision of the same gap", () => {
    let lo = generateKeyBetween(null, null);
    let hi = generateKeyBetween(lo, null);
    const seen = new Set<string>([lo, hi]);
    for (let i = 0; i < 200; i++) {
      const mid = generateKeyBetween(lo, hi);
      expect(lo < mid).toBe(true);
      expect(mid < hi).toBe(true);
      expect(seen.has(mid)).toBe(false);
      seen.add(mid);
      // Keep squeezing the lower half so the gap keeps shrinking.
      hi = mid;
    }
  });

  it("throws when bounds are out of order", () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    expect(() => generateKeyBetween(b, a)).toThrow();
  });

  it("throws when bounds are equal", () => {
    const a = generateKeyBetween(null, null);
    expect(() => generateKeyBetween(a, a)).toThrow();
  });
});

describe("generateNKeysBetween", () => {
  it("returns an empty array for n = 0", () => {
    expect(generateNKeysBetween(null, null, 0)).toEqual([]);
  });

  it("generates n strictly ascending keys", () => {
    const keys = generateNKeysBetween(null, null, 64);
    expect(keys).toHaveLength(64);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fits all keys strictly between fixed bounds", () => {
    const lo = generateKeyBetween(null, null);
    const hi = generateKeyBetween(lo, null);
    const keys = generateNKeysBetween(lo, hi, 32);
    expect(keys).toHaveLength(32);
    expect(lo < keys[0]).toBe(true);
    expect(keys[keys.length - 1] < hi).toBe(true);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
  });

  it("matches generateKeyBetween for n = 1", () => {
    expect(generateNKeysBetween(null, null, 1)).toEqual([
      generateKeyBetween(null, null),
    ]);
  });
});
