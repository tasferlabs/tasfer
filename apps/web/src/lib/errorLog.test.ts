import { describe, expect, it } from "vitest";
import {
  describeOccurrence,
  formatConsoleArgs,
  mergeOccurrences,
  parseEntries,
  pruneEntries,
  type ErrorLogEntry,
} from "./errorLog";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 2);
const context = {
  path: "/page/:id",
  version: "1.0.0",
  commit: "abc",
  time: NOW,
};

function entry(overrides: Partial<ErrorLogEntry>): ErrorLogEntry {
  return {
    id: "x",
    source: "console",
    name: "Error",
    message: "boom",
    path: "/",
    version: "1.0.0",
    commit: "abc",
    firstSeen: NOW,
    lastSeen: NOW,
    count: 1,
    ...overrides,
  };
}

describe("formatConsoleArgs", () => {
  it("joins plain arguments like the console does", () => {
    expect(formatConsoleArgs(["[Sync]", "failed", { code: 3 }])).toBe(
      '[Sync] failed {"code":3}',
    );
  });

  it("substitutes a leading format string and drops %c styling", () => {
    expect(
      formatConsoleArgs(["%cWarn%c %s: %d", "color:red", "", "x", 4]),
    ).toBe("Warn x: 4");
  });

  it("uses an Error's message and survives circular values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatConsoleArgs([new TypeError("bad"), circular])).toBe(
      "bad [object Object]",
    );
  });
});

describe("mergeOccurrences", () => {
  it("folds repeats of one error into a counted entry", () => {
    const error = new TypeError("x is undefined");
    const first = describeOccurrence(
      "console",
      ["[RouteError]", error],
      context,
    );
    const again = describeOccurrence("uncaught", [error], {
      ...context,
      time: NOW + 1000,
    });

    const [merged, ...rest] = mergeOccurrences([], [first, again], NOW + 1000);

    expect(rest).toEqual([]);
    expect(merged).toMatchObject({
      name: "TypeError",
      source: "uncaught",
      message: "x is undefined",
      count: 2,
      firstSeen: NOW,
      lastSeen: NOW + 1000,
    });
  });

  it("keeps one entry across builds, with the newest build's details", () => {
    const old = new Error("boom");
    old.stack = "Error: boom\n    at Xe (index-a1.js:1:200)";
    const fresh = new Error("boom");
    fresh.stack = "Error: boom\n    at ka (index-b2.js:1:900)";
    const a = describeOccurrence("console", [old], context);
    const b = describeOccurrence("console", [fresh], {
      ...context,
      version: "1.0.1",
      time: NOW + 1,
    });

    const merged = mergeOccurrences([], [a, b], NOW + 1);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      count: 2,
      version: "1.0.1",
      stack: fresh.stack,
    });
  });

  it("matches messages that differ only in numbers and ids", () => {
    const a = describeOccurrence(
      "console",
      ["page 3f9a2c1e-77b0 not found after 3 tries"],
      context,
    );
    const b = describeOccurrence(
      "console",
      ["page 0be41d9f-1a2c not found after 12 tries"],
      context,
    );
    const c = describeOccurrence("console", ["page missing"], context);
    const d = describeOccurrence(
      "console",
      ["[rpc] pages.get failed: Page not found: 0CHHuesvE2"],
      context,
    );
    const e = describeOccurrence(
      "console",
      ["[rpc] pages.get failed: Page not found: Zr7QxPmaa1"],
      context,
    );
    expect(mergeOccurrences([], [a, b, c, d, e], NOW)).toHaveLength(3);
  });

  it("adds to what another tab already stored", () => {
    const occurrence = describeOccurrence("console", ["boom"], context);
    const [stored] = mergeOccurrences([], [occurrence], NOW);
    const [merged] = mergeOccurrences([stored], [occurrence], NOW);
    expect(merged.count).toBe(2);
  });
});

describe("pruneEntries", () => {
  it("drops entries last seen more than 30 days ago", () => {
    const kept = entry({ id: "kept", lastSeen: NOW - 29 * DAY });
    const old = entry({ id: "old", lastSeen: NOW - 31 * DAY });
    expect(pruneEntries([old, kept], NOW).map((e) => e.id)).toEqual(["kept"]);
  });

  it("caps the list, keeping the newest", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      entry({ id: String(i), lastSeen: NOW - i }),
    );
    const pruned = pruneEntries(many, NOW);
    expect(pruned).toHaveLength(50);
    expect(pruned[0].id).toBe("0");
  });
});

describe("parseEntries", () => {
  it("reads malformed storage as empty and skips bad entries", () => {
    expect(parseEntries("not json")).toEqual([]);
    expect(parseEntries('{"a":1}')).toEqual([]);
    expect(parseEntries(JSON.stringify([entry({}), { id: 1 }]))).toHaveLength(
      1,
    );
  });
});
