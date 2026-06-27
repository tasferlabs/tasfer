/**
 * Import / snapshot-restore path: `blocksToOps` turns an ordered block array
 * into CRDT ops. Under the fractional-index model each emitted block must get a
 * strictly-ascending `orderKey` so replaying the ops reconstructs the original
 * document order — both for a fresh page and when reusing a pre-existing init
 * block (the createPage() flow).
 */

import { type Block, type Page } from "../serlization/loadPage";
import { getVisibleTextFromBlock } from "./reducer";
import { applyOps, getVisibleBlocks } from "./reducer";
import { blocksToOps } from "./snapshot-diff";
import { createCRDTbinding } from "./sync";
import { describe, expect, it } from "vitest";

const PAGE = "import-page";

function paragraph(text: string): Block {
  return {
    id: `src-${text}`,
    orderKey: "", // irrelevant: blocksToOps assigns fresh keys by array order
    type: "paragraph",
    charRuns: [{ peerId: "src", startCounter: 0, text }],
    formats: [],
  } as Block;
}

function ctxFrom(binding: ReturnType<typeof createCRDTbinding>) {
  return {
    pageId: PAGE,
    peerId: binding.getPeerId(),
    nextId: binding.nextId,
    getClock: binding.getClock,
  };
}

function emptyPage(): Page {
  return { id: PAGE, title: "", blocks: [] };
}

function visibleTexts(page: Page): string[] {
  return getVisibleBlocks(page).map((b) => getVisibleTextFromBlock(b));
}

describe("blocksToOps — import ordering", () => {
  it("reconstructs the original block order on a fresh page", () => {
    const binding = createCRDTbinding(PAGE, "importer");
    const input = ["one", "two", "three", "four", "five"].map(paragraph);

    const ops = blocksToOps(input, ctxFrom(binding));
    const page = applyOps(emptyPage(), ops);

    expect(visibleTexts(page)).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("emits strictly ascending orderKeys", () => {
    const binding = createCRDTbinding(PAGE, "importer");
    const input = ["a", "b", "c", "d"].map(paragraph);

    const ops = blocksToOps(input, ctxFrom(binding));
    const keys = ops
      .filter((op) => op.op === "block_insert")
      .map((op) => (op as { orderKey: string }).orderKey);

    expect(keys.length).toBe(4);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
  });

  it("keeps order when reusing a pre-existing init block", () => {
    const binding = createCRDTbinding(PAGE, "importer");
    // A page whose first block was already persisted by createPage().
    const initId = "b-init";
    const seeded: Page = {
      id: PAGE,
      title: "",
      blocks: [
        {
          id: initId,
          orderKey: "a0",
          type: "heading1",
          charRuns: [],
          formats: [],
        } as Block,
      ],
    };
    const input = ["first", "second", "third"].map(paragraph);

    const ops = blocksToOps(input, {
      ...ctxFrom(binding),
      existingFirstBlockId: initId,
    });
    const page = applyOps(seeded, ops);

    // The reused init block becomes "first"; the rest follow in order.
    expect(visibleTexts(page)).toEqual(["first", "second", "third"]);
    // Exactly one block carries the init id — no duplicate head block.
    expect(page.blocks.filter((b) => b.id === initId)).toHaveLength(1);
  });
});
