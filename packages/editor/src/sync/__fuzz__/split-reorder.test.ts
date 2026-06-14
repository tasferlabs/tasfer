/**
 * Regression (FIXED): loading a page used to produce blocks with no
 * `afterId`. The first time applyBlockInsert ran (e.g. user presses Enter to
 * split), resolveBlockOrder was called on the full block list. All loaded
 * blocks (afterId === undefined → null) became "children of null", got
 * sorted by the higher-id-first sibling rule, and ended up reversed. The
 * split's new block landed wherever its fresh ID put it — usually after the
 * reversed loaded blocks, i.e. "at the end of the page".
 *
 * Fixed by (a) parsePage chaining `afterId` across parsed blocks, and
 * (b) createInitialState advancing the binding's id counter past every
 * counter in the loaded page (maxPageIdCounter) so fresh local ids win the
 * counter-first sibling tie-break.
 */

import { type Block, type Page } from "../../serlization/loadPage";
import type { BlockInsert, Operation } from "../../state-types";
import { isTextualBlock } from "../block-registry";
import { iterateVisibleChars } from "../char-runs";
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

    // A "loaded" page the way loadPage() produces it: block-N ids chained
    // via afterId so the linked-list order matches parser order.
    const loaded: Page = {
      id: pageId,
      title: "",
      blocks: [
        {
          id: "block-10000",
          afterId: null,
          type: "paragraph",
          charRuns: [{ peerId: "x", startCounter: 0, text: "First" }],
          formats: [],
        } as Block,
        {
          id: "block-10001",
          afterId: "block-10000",
          type: "paragraph",
          charRuns: [{ peerId: "x", startCounter: 10, text: "Second" }],
          formats: [],
        } as Block,
        {
          id: "block-10002",
          afterId: "block-10001",
          type: "paragraph",
          charRuns: [{ peerId: "x", startCounter: 20, text: "Third" }],
          formats: [],
        } as Block,
      ],
    };

    // User presses Enter at end of "First" (block-10000). splitBlock builds
    // a block_insert with afterBlockId = "block-10000" and applies it.
    const newBlockId = binding.nextId();
    const blockInsertOp: BlockInsert = {
      op: "block_insert",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId,
      afterBlockId: "block-10000",
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
