/**
 * The empty paragraph a range delete leaves behind: whether it is minted at
 * all, and where it lands.
 *
 * Two separate faults put a blank line above the document's title (in
 * `apps/web` the title is simply the first `heading1` block, so anything
 * ordered before it reads as a gap — and `TextNode.contentInsetY` only
 * collapses a heading's 32px space-above for the FIRST visible block, so the
 * heading regains that padding too):
 *
 * 1. "Did this delete empty the document?" was answered with the selection's
 *    raw index SPAN. `blockIndex` is the index into `page.blocks`, which keeps
 *    tombstones forever, so on a well-edited page the span runs ahead of the
 *    visible count and a replacement was minted while content still stood.
 *
 * 2. The replacement's key came from `orderKeyAfter(blocks, null)`. A null
 *    anchor means "no lower bound", so that key sorts BEFORE every existing
 *    block — it is how `prependLeadingParagraph` puts a paragraph at the head
 *    of the document, not an append.
 */

import type { Block, Page } from "../serlization/loadPage";
import type {
  CursorState,
  EditorState,
  SelectionState,
  ViewWindow,
} from "../state-types";
import { createInitialState } from "../state-utils";
import { sortBlocksByOrder } from "../sync/crdt-utils";
import { generateNKeysBetween } from "../sync/fractional-index";
import { applyOps } from "../sync/reducer";
import { deleteSelectedText } from "./actions";
import { describe, expect, it } from "vitest";

function block(
  type: Block["type"],
  id: string,
  orderKey: string,
  text: string,
  extra: Record<string, unknown> = {},
): Block {
  return {
    id,
    orderKey,
    type,
    charRuns: text ? [{ peerId: "seed", startCounter: 0, text }] : [],
    formats: [],
    ...extra,
  } as unknown as Block;
}

function tombstone(id: string, orderKey: string): Block {
  return block("paragraph", id, orderKey, "", { deleted: true });
}

function stateWith(
  blocks: Block[],
  cursorBlock: number,
  selection: SelectionState,
  window?: ViewWindow,
): EditorState {
  const page: Page = { id: "page-1", title: "", blocks };
  const base = createInitialState(page, window ? { window } : undefined);
  const cursor: CursorState = {
    position: { blockIndex: cursorBlock, textIndex: 0 },
    lastUpdate: 0,
  };
  return { ...base, document: { ...base.document, cursor, selection } };
}

function selectionOver(
  startBlock: number,
  startText: number,
  endBlock: number,
  endText: number,
): SelectionState {
  return {
    anchor: { blockIndex: startBlock, textIndex: startText },
    focus: { blockIndex: endBlock, textIndex: endText },
    isForward: true,
    isCollapsed: false,
  };
}

/** Visible ids in the order the renderer walks them. */
function visibleOrder(page: Page): string[] {
  return sortBlocksByOrder(page.blocks)
    .filter((b) => !b.deleted)
    .map((b) => b.id);
}

describe("replacement paragraph after a range delete", () => {
  it("is not minted just because tombstones inflate the index span", () => {
    // Title, image, three tombstones, paragraph. Three blocks are visible; the
    // image-through-paragraph selection spans five array slots.
    const k = generateNKeysBetween(null, null, 6);
    const s = stateWith(
      [
        block("heading1", "b:1", k[0], "Hello"),
        block("image", "b:2", k[1], ""),
        tombstone("b:d1", k[2]),
        tombstone("b:d2", k[3]),
        tombstone("b:d3", k[4]),
        block("paragraph", "b:3", k[5], "tail"),
      ],
      1,
      selectionOver(1, 0, 5, 4),
    );

    const result = deleteSelectedText(s);

    // The title survived, so the document was never emptied.
    expect(result.ops.filter((op) => op.op === "block_insert")).toHaveLength(0);
    expect(visibleOrder(result.state.document.page)).toEqual(["b:1"]);
  });

  it("lands below the surviving content when it is minted", () => {
    // A body editor windowed past the title: emptying the window legitimately
    // mints a replacement, which must not sort above the title outside it.
    const k = generateNKeysBetween(null, null, 3);
    const blocks = [
      block("heading1", "b:1", k[0], "Hello"),
      block("image", "b:2", k[1], ""),
      block("paragraph", "b:3", k[2], "tail"),
    ];
    const bodyWindow: ViewWindow = {
      select: (all) =>
        new Set(all.map((_, i) => i).filter((i) => all[i].id !== "b:1")),
    };
    const s = stateWith(blocks, 1, selectionOver(1, 0, 2, 4), bodyWindow);

    const result = deleteSelectedText(s);

    const inserts = result.ops.filter((op) => op.op === "block_insert");
    expect(inserts).toHaveLength(1);

    const order = visibleOrder(result.state.document.page);
    expect(order[0]).toBe("b:1");
    // A peer replaying the ops must resolve the same order.
    expect(visibleOrder(applyOps(s.document.page, result.ops))).toEqual(order);
  });
});
