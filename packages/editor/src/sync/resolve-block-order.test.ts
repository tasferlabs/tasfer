import type { Block } from "../serlization/loadPage";
import { resolveBlockOrder } from "./crdt-utils";
import { describe, expect, it } from "vitest";

function block(id: string, afterId: string | null): Block {
  return {
    id,
    afterId,
    type: "paragraph",
    charRuns: [],
    formats: [],
  };
}

describe("resolveBlockOrder", () => {
  it("resolves a long linear document without overflowing the call stack", () => {
    const count = 25_000;
    const blocks = Array.from({ length: count }, (_, index) =>
      block(`block-${index}`, index === 0 ? null : `block-${index - 1}`),
    ).reverse();

    const ordered = resolveBlockOrder(blocks);

    expect(ordered).toHaveLength(count);
    expect(ordered[0].id).toBe("block-0");
    expect(ordered[count - 1].id).toBe(`block-${count - 1}`);
  });

  it("keeps depth-first sibling ordering", () => {
    const ordered = resolveBlockOrder([
      block("root", null),
      block("older", "root"),
      block("newer", "root"),
      block("newer-child", "newer"),
    ]);

    expect(ordered.map(({ id }) => id)).toEqual([
      "root",
      "older",
      "newer",
      "newer-child",
    ]);
  });
});
