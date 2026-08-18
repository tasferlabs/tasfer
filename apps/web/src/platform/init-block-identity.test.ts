/**
 * A page's initial heading block is not replicated — every peer derives its
 * `block_insert` locally and they are expected to agree. That made the
 * operation's identity a constant (`__init__:0`), which is only unique as long
 * as no two pages' ops ever share a scope. When they did, UNIQUE(scope_id,
 * peer_id, clock) kept one heading block and dropped the other, and the lost
 * block's title text was left addressing a block the reducer no longer knew —
 * a page that renders with no title. The identity is now page-scoped.
 */

import { describe, expect, it } from "vitest";
import { extractCounter, extractPeerId } from "@tasfer/editor/sync/id";
import { initBlockId, initBlockOp, normalizeInitOp, pageIdOfInitBlock } from "./engine";

const PAGE_A = "i35T0yQK9J";
// A real nanoid(10) may start with "b-", which is also the block-id prefix.
const PAGE_B = "b-EcidYjZJ";

describe("initial heading block identity", () => {
  it("gives two pages two distinct operations", () => {
    const a = initBlockOp(PAGE_A);
    const b = initBlockOp(PAGE_B);
    expect(a.id).not.toBe(b.id);
    expect(a.clock.peerId).not.toBe(b.clock.peerId);
    expect(a.blockId).not.toBe(b.blockId);
  });

  it("derives the same operation on every peer", () => {
    expect(initBlockOp(PAGE_A)).toEqual(initBlockOp(PAGE_A));
  });

  it("stays parseable as a compound id", () => {
    const op = initBlockOp(PAGE_B);
    expect(extractPeerId(op.id)).toBe(op.clock.peerId);
    expect(extractCounter(op.id)).toBe(0);
  });

  it("round-trips the page through the block id", () => {
    expect(pageIdOfInitBlock(initBlockId(PAGE_A))).toBe(PAGE_A);
    expect(pageIdOfInitBlock("someone-elses-block:12")).toBeNull();
    expect(pageIdOfInitBlock(undefined)).toBeNull();
  });
});

describe("normalizeInitOp", () => {
  const legacy = {
    op: "block_insert",
    id: "__init__:0",
    clock: { counter: 0, peerId: "__init__" },
    pageId: PAGE_A,
    orderKey: "a0",
    blockId: initBlockId(PAGE_A),
    blockType: "heading1",
  };

  it("re-keys a legacy op from an un-upgraded peer", () => {
    expect(normalizeInitOp(legacy)).toEqual(initBlockOp(PAGE_A));
  });

  it("stops two pages' legacy ops from claiming one identity", () => {
    const a = normalizeInitOp(legacy);
    const b = normalizeInitOp({ ...legacy, pageId: PAGE_B, blockId: initBlockId(PAGE_B) });
    expect(a.id).not.toBe(b.id);
  });

  it("leaves an already-migrated op alone", () => {
    const migrated = initBlockOp(PAGE_A);
    expect(normalizeInitOp(migrated)).toEqual(migrated);
  });

  it("leaves every other operation alone", () => {
    const textInsert = {
      op: "text_insert",
      id: "abc123:7",
      clock: { counter: 7, peerId: "abc123" },
      blockId: initBlockId(PAGE_A),
    };
    expect(normalizeInitOp(textInsert)).toBe(textInsert);

    // A block_insert that is not an initial heading block.
    const other = { ...legacy, blockId: "b-abc123:4" };
    expect(normalizeInitOp(other)).toBe(other);
  });
});
