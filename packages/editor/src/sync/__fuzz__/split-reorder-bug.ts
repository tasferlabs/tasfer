/**
 * Repro: loading a page produces blocks with no `afterId`. The first time
 * applyBlockInsert runs (e.g. user presses Enter to split), resolveBlockOrder
 * is called on the full block list. All loaded blocks (afterId === undefined
 * → null) become "children of null", get sorted by the higher-id-first
 * sibling rule, and end up reversed. The split's new block lands wherever its
 * fresh ID puts it — usually after the reversed loaded blocks, i.e. "at the
 * end of the page".
 */

import { iterateVisibleChars } from "../char-runs";
import { applyOps } from "../reducer";
import { getClock, getPageId, nextId, setCRDTContext } from "../sync";
import type { BlockInsert, Operation } from "../types";
import { type Block, isTextualBlock, type Page } from "@/deserializer/loadPage";

setCRDTContext("split-reorder", "p001");
const pageId = getPageId();

function describe(p: Page): string {
  return p.blocks
    .filter((b) => !b.deleted)
    .map((b) => {
      const text = isTextualBlock(b)
        ? [...iterateVisibleChars(b.charRuns)].map((c) => c.char).join("")
        : "[visual]";
      return `${b.id}="${text}"`;
    })
    .join("  |  ");
}

// Build a "loaded" page the way loadPage() now does: block-N ids chained
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
console.log("As loaded (rendered without applyOps):");
console.log(" ", describe(loaded));

// User presses Enter at end of "First" (block-10000). splitBlock builds a
// block_insert with afterBlockId = "block-10000", then applies via applyOps.
const newBlockId = nextId();
const blockInsertOp: BlockInsert = {
  op: "block_insert",
  id: nextId(),
  clock: getClock(),
  pageId,
  afterBlockId: "block-10000",
  blockId: newBlockId,
  blockType: "paragraph",
};
const afterInsert = applyOps(loaded, [blockInsertOp] as Operation[]);
console.log("\nAfter splitting after block-10000:");
console.log(" ", describe(afterInsert));
console.log(
  "\nEXPECTED order: block-10000  newBlock  block-10001  block-10002",
);
console.log(
  "BUG: loaded blocks get sorted by id (descending), and newBlock ends up wherever its fresh id falls.",
);
