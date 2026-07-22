/**
 * Regression: after a split, the cursor must land in the NEW block even when
 * the blocks array holds a tombstone right after the anchor.
 *
 * `page.blocks` keeps tombstones, sorted by orderKey with ties broken
 * newer-id-first. A concurrent insert after the same anchor mints the same
 * orderKey as the anchor; if that sibling was later deleted, the tombstone
 * sits at `blockIndex + 1` and the fresh split block sorts in AFTER it (its
 * key is strictly greater than the tie-group's). A hardcoded
 * `moveCursorToPosition(state, blockIndex + 1, 0)` then targets the tombstone,
 * which moveCursorToPosition silently refuses — the split happens but the
 * cursor never moves.
 */

import type { Block, Page } from "../serlization/loadPage";
import type { CursorState, EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { splitBlock } from "./actions";
import { describe, expect, it } from "vitest";

function paragraph(
  id: string,
  orderKey: string,
  text: string,
  extra: Partial<Block> = {},
): Block {
  return {
    id,
    orderKey,
    type: "paragraph",
    charRuns: text ? [{ peerId: "seed", startCounter: 0, text }] : [],
    formats: [],
    ...extra,
  } as Block;
}

function cursorAt(blockIndex: number, textIndex: number): CursorState {
  return { position: { blockIndex, textIndex }, lastUpdate: 0 };
}

function stateWith(page: Page, cursor: CursorState): EditorState {
  const base = createInitialState(page);
  return { ...base, document: { ...base.document, cursor } };
}

describe("splitBlock cursor placement with tombstones", () => {
  it("moves the cursor into the new block when a tombstone follows the anchor", () => {
    // Anchor and tombstone share an orderKey (concurrent inserts after the
    // same block); the anchor's higher id sorts it first. Canonical order:
    // [anchor, tombstone, tail].
    const text =
      "These software programs could show you plots and make drafting reports so easy.";
    const page: Page = {
      id: "page-1",
      title: "",
      blocks: [
        paragraph("b-x:2", "a1", text),
        paragraph("b-x:1", "a1", "", { deleted: true }),
        paragraph("b-x:0", "a2", "Next paragraph."),
      ],
    };
    const state = stateWith(page, cursorAt(0, text.length));

    const result = splitBlock(state);
    const blocks = result.state.document.page.blocks;

    // The split created a new empty paragraph after the tie-group.
    const visible = blocks.filter((b) => !b.deleted);
    expect(visible).toHaveLength(3);

    // The cursor must sit at the start of the NEW block, not stay behind on
    // the anchor or point at the tombstone.
    const cursor = result.state.document.cursor;
    expect(cursor).toBeDefined();
    const cursorBlock = blocks[cursor!.position.blockIndex];
    expect(cursorBlock.deleted).not.toBe(true);
    expect(cursorBlock.id).not.toBe("b-x:2");
    expect(cursor!.position.textIndex).toBe(0);
  });

  it("carries the text after the caret into the block the cursor lands on", () => {
    const page: Page = {
      id: "page-1",
      title: "",
      blocks: [
        paragraph("b-x:2", "a1", "HeadTail"),
        paragraph("b-x:1", "a1", "", { deleted: true }),
      ],
    };
    const state = stateWith(page, cursorAt(0, "Head".length));

    const result = splitBlock(state);
    const blocks = result.state.document.page.blocks;
    const cursor = result.state.document.cursor!;
    const cursorBlock = blocks[cursor.position.blockIndex];

    expect(cursorBlock.deleted).not.toBe(true);
    expect(
      cursorBlock.type === "paragraph" &&
        "charRuns" in cursorBlock &&
        cursorBlock.charRuns.map((r) => r.text).join(""),
    ).toBe("Tail");
    expect(cursor.position.textIndex).toBe(0);
  });
});
