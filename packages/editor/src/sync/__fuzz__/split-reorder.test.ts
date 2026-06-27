/**
 * Regression: a `block_insert` into a loaded page must land right after its
 * anchor, not at the end. Under the fractional-index model the loaded blocks
 * carry ascending `orderKey`s and the split mints a key in the gap after the
 * anchor via `orderKeyAfter`, so the new block sorts into place.
 */

import { type Block, type Page } from "../../serlization/loadPage";
import type { BlockInsert, Operation } from "../../state-types";
import { isTextualBlock } from "../block-registry";
import { iterateVisibleChars } from "../char-runs";
import { orderKeyAfter } from "../crdt-utils";
import { generateNKeysBetween } from "../fractional-index";
import { applyOps } from "../reducer";
import { createCRDTbinding } from "../sync";
import { describe, expect, it } from "vitest";

function visibleIds(p: Page): string[] {
  return p.blocks.filter((b) => !b.deleted).map((b) => b.id);
}

function textOf(p: Page, blockId: string): string {
  const block = p.blocks.find((b) => b.id === blockId);
  if (!block || !isTextualBlock(block)) return "";
  return [...iterateVisibleChars(block.charRuns)].map((c) => c.char).join("");
}

describe("block_insert into a loaded page", () => {
  it("places the new block right after its anchor, not at the end", () => {
    const binding = createCRDTbinding("split-reorder", "p001");
    const pageId = binding.pageId;

    // A "loaded" page the way loadPage() produces it: block-N ids with
    // evenly-spaced ascending orderKeys matching parser order.
    const [k0, k1, k2] = generateNKeysBetween(null, null, 3);
    const loaded: Page = {
      id: pageId,
      title: "",
      blocks: [
        {
          id: "block-10000",
          orderKey: k0,
          type: "paragraph",
          charRuns: [{ peerId: "x", startCounter: 0, text: "First" }],
          formats: [],
        } as Block,
        {
          id: "block-10001",
          orderKey: k1,
          type: "paragraph",
          charRuns: [{ peerId: "x", startCounter: 10, text: "Second" }],
          formats: [],
        } as Block,
        {
          id: "block-10002",
          orderKey: k2,
          type: "paragraph",
          charRuns: [{ peerId: "x", startCounter: 20, text: "Third" }],
          formats: [],
        } as Block,
      ],
    };

    // User presses Enter at end of "First" (block-10000). splitBlock mints a
    // key in the gap after block-10000 and applies the block_insert.
    const newBlockId = binding.nextId();
    const blockInsertOp: BlockInsert = {
      op: "block_insert",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId,
      orderKey: orderKeyAfter(loaded.blocks, "block-10000"),
      blockId: newBlockId,
      blockType: "paragraph",
    };
    const afterInsert = applyOps(loaded, [blockInsertOp] as Operation[]);

    expect(visibleIds(afterInsert)).toEqual([
      "block-10000",
      newBlockId,
      "block-10001",
      "block-10002",
    ]);
    expect(textOf(afterInsert, "block-10000")).toBe("First");
    expect(textOf(afterInsert, "block-10001")).toBe("Second");
    expect(textOf(afterInsert, "block-10002")).toBe("Third");
  });
});
