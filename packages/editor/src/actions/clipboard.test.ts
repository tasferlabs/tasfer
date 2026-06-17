/**
 * Pins `atomicBlockInsertOps` — the descriptor-driven replacement for the old
 * per-type `createImageBlockOps` / `createLineBlockOps` / `createMathBlockOps`
 * paste closures. Asserts it emits exactly the block_insert + block_set ops the
 * hand-written versions did, so the generic field-driven path can't silently
 * drift from per-type behavior.
 */

import type { Block } from "../serlization/loadPage";
import type { BlockSet } from "../state-types";
import { createCRDTbinding } from "../sync/sync";
import { atomicBlockInsertOps } from "./clipboard";
import { describe, expect, it } from "vitest";

function setFields(block: Block): Record<string, unknown> {
  const binding = createCRDTbinding("page-1", "peer-a");
  const ops = atomicBlockInsertOps(block, "new-block", "after-block", binding);

  // First op is always the block_insert for the type.
  expect(ops[0]).toMatchObject({
    op: "block_insert",
    blockId: "new-block",
    afterBlockId: "after-block",
    blockType: block.type,
  });

  // The rest are block_sets; collapse to a field→value map for assertions.
  const fields: Record<string, unknown> = {};
  for (const op of ops.slice(1)) {
    expect(op.op).toBe("block_set");
    const set = op as BlockSet;
    expect(set.blockId).toBe("new-block");
    fields[set.field] = set.value;
  }
  return fields;
}

describe("atomicBlockInsertOps", () => {
  it("emits every set image property (url/alt/width/height/objectFit)", () => {
    const image = {
      id: "i1",
      afterId: null,
      type: "image",
      url: "https://example.com/a.png",
      alt: "alt text",
      width: 200,
      height: 100,
      objectFit: "cover",
    } as unknown as Block;

    expect(setFields(image)).toEqual({
      url: "https://example.com/a.png",
      alt: "alt text",
      width: 200,
      height: 100,
      objectFit: "cover",
    });
  });

  it("omits unset image properties (only url present)", () => {
    const image = {
      id: "i2",
      afterId: null,
      type: "image",
      url: "https://example.com/b.png",
    } as unknown as Block;

    // alt/width/height/objectFit are undefined → no block_set for them.
    expect(setFields(image)).toEqual({
      url: "https://example.com/b.png",
    });
  });

  it("emits latex + displayMode for math", () => {
    const math = {
      id: "m1",
      afterId: null,
      type: "math",
      latex: "x^2",
      displayMode: false,
    } as unknown as Block;

    expect(setFields(math)).toEqual({ latex: "x^2", displayMode: false });
  });

  it("emits only a block_insert for a line (no fields)", () => {
    const line = {
      id: "l1",
      afterId: null,
      type: "line",
    } as unknown as Block;

    expect(setFields(line)).toEqual({});
  });
});
