import { describe, expect, it } from "vitest";
import {
  analyzeLineBidi,
  bidiRuns,
  resolveBidiLevels,
  visualRunOrder,
} from "./bidi";

describe("bidi level resolution", () => {
  it("pure LTR text is all level 0", () => {
    expect(resolveBidiLevels("hello", "ltr")).toEqual([0, 0, 0, 0, 0]);
  });

  it("pure Arabic text under RTL base is all level 1", () => {
    const levels = resolveBidiLevels("مرحبا", "rtl");
    expect(levels).toEqual([1, 1, 1, 1, 1]);
  });

  it("pure Arabic text under LTR base is one RTL run at level 1", () => {
    const levels = resolveBidiLevels("مرحبا", "ltr");
    expect(levels).toEqual([1, 1, 1, 1, 1]);
    const runs = bidiRuns(levels);
    expect(runs).toEqual([{ start: 0, end: 5, level: 1 }]);
  });

  it("two Arabic words with a separator in an LTR line form ONE rtl run", () => {
    // The reported case: "اااا. اتاااار aaaaa" — the period+space between the
    // two Arabic words (bidi N1) joins them into a single level-1 run, so the
    // first word ends up visually right and the second visually left.
    const text = "اااا. اتاااار aaaaa";
    const levels = resolveBidiLevels(text, "ltr");
    const runs = bidiRuns(levels);
    // Indices 0..12 = "اااا. اتاااار" → level 1; the space + "aaaaa" → level 0.
    expect(runs[0]).toEqual({ start: 0, end: 13, level: 1 });
    expect(runs[runs.length - 1].level).toBe(0);
    // The two words are inside one RTL run, so word2 (indices 6..12) is not at
    // its logical-cumulative position — which is the whole bug.
    expect(levels.slice(0, 13).every((l) => l === 1)).toBe(true);
  });

  it("Latin word inside an RTL line is a level-2 run", () => {
    const text = "مرحبا hello مرحبا";
    const levels = resolveBidiLevels(text, "rtl");
    // "hello" (indices 6..10) is LTR embedded in RTL → level 2.
    expect(levels.slice(6, 11)).toEqual([2, 2, 2, 2, 2]);
    expect(levels[0]).toBe(1);
    expect(levels[levels.length - 1]).toBe(1);
  });

  it("ASCII digits after Latin stay LTR (level 0) under LTR base", () => {
    expect(resolveBidiLevels("a12", "ltr")).toEqual([0, 0, 0]);
  });
});

describe("visual run order (L2)", () => {
  it("keeps LTR runs in logical order", () => {
    const runs = [
      { start: 0, end: 2, level: 0 },
      { start: 2, end: 4, level: 0 },
    ];
    expect(visualRunOrder(runs)).toEqual(runs);
  });

  it("places a leading RTL run to the left of a trailing LTR run", () => {
    // "اااا. اتاااار aaaaa" → [rtl run, ltr run]; visual order is rtl then ltr
    // (rtl run is logically first and stays leftmost in an LTR line).
    const { visual } = analyzeLineBidi("اااا. اتاااار aaaaa", "ltr");
    expect(visual[0].level).toBe(1);
    expect(visual[visual.length - 1].level).toBe(0);
  });

  it("reverses embedded RTL runs within an RTL line's visual order", () => {
    // RTL base with an embedded LTR word: visually the LTR word sits between
    // the Arabic runs but the Arabic runs swap ends.
    const { runs, visual } = analyzeLineBidi("مرحبا hello مرحبا", "rtl");
    expect(runs.length).toBe(3);
    // Highest level (2, the Latin) is not at either visual extreme.
    expect(visual[0].level).toBe(1);
    expect(visual[visual.length - 1].level).toBe(1);
  });
});
