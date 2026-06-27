import type { Block } from "../serlization/loadPage";
import { sortBlocksByOrder } from "./crdt-utils";
import { generateNKeysBetween } from "./fractional-index";
import { describe, expect, it } from "vitest";

function block(id: string, orderKey: string): Block {
  return {
    id,
    orderKey,
    type: "paragraph",
    charRuns: [],
    formats: [],
  };
}

describe("sortBlocksByOrder", () => {
  it("orders a large shuffled document by orderKey", () => {
    const count = 25_000;
    const keys = generateNKeysBetween(null, null, count);
    const blocks = Array.from({ length: count }, (_, index) =>
      block(`block-${index}`, keys[index]),
    ).reverse();

    const ordered = sortBlocksByOrder(blocks);

    expect(ordered).toHaveLength(count);
    expect(ordered[0].id).toBe("block-0");
    expect(ordered[count - 1].id).toBe(`block-${count - 1}`);
  });

  it("orders blocks by their fractional-index key", () => {
    const [a, b, c] = generateNKeysBetween(null, null, 3);
    const ordered = sortBlocksByOrder([
      block("c", c),
      block("a", a),
      block("b", b),
    ]);

    expect(ordered.map(({ id }) => id)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties on equal keys by newer id first", () => {
    // Two concurrent inserts after the same anchor mint the SAME key; the
    // higher-counter (newer) id sorts ahead, matching the Enter-key rule.
    const ordered = sortBlocksByOrder([
      block("peer:1", "a1"),
      block("peer:3", "a1"),
      block("peer:2", "a1"),
    ]);

    expect(ordered.map(({ id }) => id)).toEqual(["peer:3", "peer:2", "peer:1"]);
  });
});
