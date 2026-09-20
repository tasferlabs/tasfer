import { describe, expect, it } from "vitest";
import { countUnsyncedOps, mergeVersions } from "./engine";

/**
 * What a paused peer would strand. The count is what the confirm step shows,
 * so it has to mean operations this device would receive by syncing with them —
 * not a rough "they look behind".
 */

describe("merging the vectors of a person's devices", () => {
  it("keeps the highest clock per replica", () => {
    expect(
      mergeVersions([
        { laptop: 4, phone: 1 },
        { laptop: 2, phone: 9 },
      ]),
    ).toEqual({ laptop: 4, phone: 9 });
  });

  it("counts an operation once however many of their devices hold it", () => {
    const theirs = mergeVersions([{ laptop: 10 }, { laptop: 10 }]);

    expect(countUnsyncedOps(theirs, { laptop: 8 })).toBe(2);
  });
});

describe("counting what a peer holds and this device does not", () => {
  it("is zero when we are level with them", () => {
    expect(countUnsyncedOps({ laptop: 5 }, { laptop: 5 })).toBe(0);
  });

  it("is zero when we are ahead of them", () => {
    expect(countUnsyncedOps({ laptop: 2 }, { laptop: 7 })).toBe(0);
  });

  it("counts every operation of a replica we have never heard from", () => {
    // Clocks start at 0, so a replica we know nothing about is at -1: its
    // clock 0 is already one operation we do not hold.
    expect(countUnsyncedOps({ newcomer: 0 }, {})).toBe(1);
    expect(countUnsyncedOps({ newcomer: 3 }, {})).toBe(4);
  });

  it("adds up across replicas", () => {
    expect(countUnsyncedOps({ a: 5, b: 3, c: 1 }, { a: 4, b: 3 })).toBe(3);
  });
});
