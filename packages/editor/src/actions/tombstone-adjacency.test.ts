/**
 * Tombstone-adjacency guards.
 *
 * `page.blocks` keeps tombstones, sorted by orderKey with ties broken
 * newer-id-first. Two invariants protect every action against that:
 *
 * 1. STRICT CONVERGENCE — the local page after an action must be
 *    shape-identical (ids, orderKeys, tombstone flags, array positions) to
 *    replaying the action's emitted ops on the pre-action page. Hand-splicing
 *    or hard-removing blocks breaks this: the local array diverges from what
 *    every remote peer and every reload computes.
 *
 * 2. CURSOR NEVER RESTS ON A TOMBSTONE — index arithmetic (blockIndex ± 1)
 *    can land on a deleted block; the caret must resolve to visible content.
 *
 * The fixture puts a tombstone with an orderKey TIED to the anchor's right
 * after it (a concurrent insert after the same block, later deleted — ties
 * sort newer-id-first, so the anchor's higher id keeps it first). Fresh keys
 * minted after the anchor sort past the whole tie group, so "anchor index + 1"
 * is the tombstone, not the new block.
 */

import { CREATE_PARAGRAPH_BELOW_IMAGE } from "../nodes/ImageNode";
import { moveCursorToPosition } from "../selection";
import type { Block, Page } from "../serlization/loadPage";
import type { CursorState, EditorState, Operation } from "../state-types";
import { createInitialState } from "../state-utils";
import { applyOps } from "../sync/reducer";
import {
  convertBlockAtCursor,
  deleteForward,
  deleteText,
  splitBlock,
} from "./actions";
import { SPLIT_BLOCK } from "./edit-actions";
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

function cursorAt(blockIndex: number, textIndex: number): CursorState {
  return { position: { blockIndex, textIndex }, lastUpdate: 0 };
}

function stateWith(blocks: Block[], cursor: CursorState): EditorState {
  const page: Page = { id: "page-1", title: "", blocks };
  const base = createInitialState(page);
  return { ...base, document: { ...base.document, cursor } };
}

/** Shape of the blocks array: id, orderKey and tombstone flag per position. */
function shape(p: Page): string[] {
  return p.blocks.map(
    (b) => `${b.id}@${b.orderKey}${b.deleted ? ":dead" : ""}`,
  );
}

/** The strict convergence invariant: local page === op replay, tombstones included. */
function expectStrictConvergence(
  prevPage: Page,
  result: { state: EditorState; ops: Operation[] },
): void {
  expect(shape(result.state.document.page)).toEqual(
    shape(applyOps(prevPage, result.ops)),
  );
}

function expectCursorOnVisibleBlock(state: EditorState): Block {
  const cursor = state.document.cursor;
  expect(cursor).toBeDefined();
  const b = state.document.page.blocks[cursor!.position.blockIndex];
  expect(b).toBeDefined();
  expect(b.deleted).not.toBe(true);
  return b;
}

describe("moveCursorToPosition tombstone fallback", () => {
  it("resolves a deleted target to the next visible block", () => {
    const s = stateWith(
      [
        block("paragraph", "b-x:3", "a1", "one"),
        tombstone("b-x:1", "a1"),
        block("paragraph", "b-x:2", "a2", "two"),
      ],
      cursorAt(0, 0),
    );
    const next = moveCursorToPosition(s, 1, 0);
    expect(next.document.cursor?.position).toEqual({
      blockIndex: 2,
      textIndex: 0,
    });
  });

  it("falls back to the previous visible block at the document tail", () => {
    const s = stateWith(
      [block("paragraph", "b-x:2", "a1", "one"), tombstone("b-x:1", "a2")],
      cursorAt(0, 0),
    );
    const next = moveCursorToPosition(s, 1, 0);
    expect(next.document.cursor?.position.blockIndex).toBe(0);
  });
});

describe("splitBlock over a tied tombstone", () => {
  it("converges strictly and lands the caret in the new block", () => {
    const s = stateWith(
      [
        block("paragraph", "b-x:2", "a1", "HeadTail"),
        tombstone("b-x:1", "a1"),
        block("paragraph", "b-x:0", "a2", "next"),
      ],
      cursorAt(0, 4),
    );
    const result = splitBlock(s);
    expectStrictConvergence(s.document.page, result);
    const landed = expectCursorOnVisibleBlock(result.state);
    expect(landed.id).not.toBe("b-x:2");
    expect(result.state.document.cursor?.position.textIndex).toBe(0);
  });
});

describe("convertBlockAtCursor to an atomic type", () => {
  it("moves the caret past a tied tombstone to the next visible block", () => {
    const s = stateWith(
      [
        block("paragraph", "b-x:2", "a1", ""),
        tombstone("b-x:1", "a1"),
        block("paragraph", "b-x:0", "a2", "after"),
      ],
      cursorAt(0, 0),
    );
    const result = convertBlockAtCursor(s, { type: "line" });
    expectStrictConvergence(s.document.page, result);
    const landed = expectCursorOnVisibleBlock(result.state);
    expect(landed.id).toBe("b-x:0");
  });

  it("creates a trailing paragraph when only tombstones follow", () => {
    const s = stateWith(
      [block("paragraph", "b-x:2", "a1", ""), tombstone("b-x:1", "a1")],
      cursorAt(0, 0),
    );
    const result = convertBlockAtCursor(s, { type: "line" });
    expectStrictConvergence(s.document.page, result);
    const landed = expectCursorOnVisibleBlock(result.state);
    expect(landed.type).toBe("paragraph");
    expect(landed.id).not.toBe("b-x:2");
  });
});

describe("MathNode SPLIT_BLOCK exit over a tied tombstone", () => {
  it("lands the caret in the new paragraph, not on the tombstone", () => {
    const s = stateWith(
      [
        block("math", "b-x:2", "a1", "x+1"),
        tombstone("b-x:1", "a1"),
        block("paragraph", "b-x:0", "a2", "next"),
      ],
      cursorAt(0, 3),
    );
    const result = s.actionBus.dispatchState(SPLIT_BLOCK, s);
    expectStrictConvergence(s.document.page, result);
    const landed = expectCursorOnVisibleBlock(result.state);
    expect(landed.type).toBe("paragraph");
    expect(landed.id).not.toBe("b-x:0");
  });
});

describe("CREATE_PARAGRAPH_BELOW_IMAGE with a trailing tombstone", () => {
  it("lands the caret in the new paragraph and converges strictly", () => {
    const image = block("image", "b-x:2", "a1", "", { src: "" });
    const s = stateWith([image, tombstone("b-x:1", "a1")], cursorAt(0, 0));
    const result = s.actionBus.dispatchState(CREATE_PARAGRAPH_BELOW_IMAGE, s, {
      afterBlock: image,
      afterBlockIndex: 0,
      binding: s.CRDTbinding,
    });
    expectStrictConvergence(s.document.page, result);
    const landed = expectCursorOnVisibleBlock(result.state);
    expect(landed.type).toBe("paragraph");
  });
});

describe("delete paths tombstone instead of hard-removing", () => {
  it("backspace on an empty list block keeps the tombstone locally", () => {
    const s = stateWith(
      [
        block("paragraph", "b-x:3", "a0", "prev"),
        block("bullet_list", "b-x:2", "a1", "", { indent: 0 }),
        tombstone("b-x:1", "a1"),
      ],
      cursorAt(1, 0),
    );
    const result = deleteText(s);
    expectStrictConvergence(s.document.page, result);
    expectCursorOnVisibleBlock(result.state);
    // The deleted block must remain in the local array as a tombstone.
    const deleted = result.state.document.page.blocks.find(
      (b) => b.id === "b-x:2",
    );
    expect(deleted?.deleted).toBe(true);
  });

  it("forward-delete before an image keeps indices replica-identical", () => {
    const image = block("image", "b-x:0", "a2", "", { src: "" });
    const s = stateWith(
      [block("paragraph", "b-x:2", "a1", ""), tombstone("b-x:1", "a1"), image],
      cursorAt(0, 0),
    );
    const result = deleteForward(s);
    expectStrictConvergence(s.document.page, result);
    const landed = expectCursorOnVisibleBlock(result.state);
    expect(landed.id).toBe("b-x:0");
  });
});
