/**
 * Block move under the fractional-index model: a move is a single LWW
 * `block_set` of the block's `orderKey`, minted by `orderKeyAfter` to sit
 * immediately after a target. These tests pin single-user ordering, apply-time
 * totality (malformed/edge ops never throw or corrupt order), concurrency
 * convergence (LWW — last writer by HLC wins, no neighbour drift),
 * incremental/rebuild merge parity, and undo reversibility.
 */

import type { Block, Page } from "../serlization/loadPage";
import type { BlockSet, HLC, Operation } from "../state-types";
import { orderKeyAfter, sortBlocksByOrder } from "./crdt-utils";
import { generateKeyBetween, generateNKeysBetween } from "./fractional-index";
import { compareHLC } from "./hlc";
import { invertOperation } from "./inverse";
import { createOpLog, mergeOps } from "./oplog";
import { applyOp, rebuildState } from "./reducer";
import { createCRDTbinding } from "./sync";
import { describe, expect, it } from "vitest";

/**
 * Canonical apply: ops are applied in HLC order regardless of arrival order,
 * exactly as `mergeOps`/`rebuildState` define convergence. Folding `applyOp`
 * in raw arrival order is NOT the convergence contract.
 */
function applyCanonical(base: Page, ops: Operation[]): Page {
  return [...ops]
    .sort((a, b) => compareHLC(a.clock, b.clock))
    .reduce((page, op) => applyOp(page, op), base);
}

const PAGE = "page-1";

function block(id: string, orderKey: string): Block {
  return { id, orderKey, type: "paragraph", charRuns: [], formats: [] };
}

function pageWith(...blocks: Block[]): Page {
  return { id: PAGE, title: "", blocks };
}

/** Visible (non-deleted) block ids in document order. */
function ids(page: Page): string[] {
  return sortBlocksByOrder(page.blocks)
    .filter((b) => !b.deleted)
    .map((b) => b.id);
}

/** All block ids in document order, including tombstones. */
function allIds(page: Page): string[] {
  return sortBlocksByOrder(page.blocks).map((b) => b.id);
}

/**
 * A move op: a `block_set` of `orderKey`, with the new key minted from `page`
 * so the block lands immediately after `afterBlockId` (null = head). The key is
 * computed against the supplied page snapshot, mirroring how a peer mints it
 * from its local view.
 */
function move(
  page: Page,
  blockId: string,
  afterBlockId: string | null,
  clock: HLC = { counter: 100, peerId: "z" },
): BlockSet {
  return {
    op: "block_set",
    id: `${clock.peerId}:${clock.counter}`,
    clock,
    pageId: PAGE,
    blockId,
    field: "orderKey",
    value: orderKeyAfter(page.blocks, afterBlockId),
  };
}

// A,B,C,D as a clean linear chain with ascending keys.
function linearABCD(): Page {
  const [k1, k2, k3, k4] = generateNKeysBetween(null, null, 4);
  return pageWith(
    block("p:1", k1),
    block("p:2", k2),
    block("p:3", k3),
    block("p:4", k4),
  );
}

describe("block move — single-user ordering", () => {
  it("moves a block to sit immediately after the target (B after C ⇒ A,C,B,D)", () => {
    const page = linearABCD();
    const next = applyOp(page, move(page, "p:2", "p:3"));
    expect(ids(next)).toEqual(["p:1", "p:3", "p:2", "p:4"]);
  });

  it("moves a block to the head (afterBlockId = null)", () => {
    const page = linearABCD();
    const next = applyOp(page, move(page, "p:3", null));
    expect(ids(next)).toEqual(["p:3", "p:1", "p:2", "p:4"]);
  });

  it("moves a block backwards (D after A ⇒ A,D,B,C)", () => {
    const page = linearABCD();
    const next = applyOp(page, move(page, "p:4", "p:1"));
    expect(ids(next)).toEqual(["p:1", "p:4", "p:2", "p:3"]);
  });

  it("is idempotent: applying the same move twice equals applying it once", () => {
    const page = linearABCD();
    const op = move(page, "p:2", "p:3");
    const once = applyOp(page, op);
    const twice = applyOp(once, op);
    expect(ids(twice)).toEqual(ids(once));
  });

  it("leaves order unchanged when the block already sits after the target", () => {
    const page = linearABCD();
    const next = applyOp(page, move(page, "p:2", "p:1"));
    expect(ids(next)).toEqual(["p:1", "p:2", "p:3", "p:4"]);
  });
});

describe("block move — totality (never throws, converges)", () => {
  it("ignores a move of a non-existent block", () => {
    const page = linearABCD();
    // block_set targeting a missing block is a no-op (same reference).
    expect(applyOp(page, move(page, "p:999", "p:1"))).toBe(page);
  });

  it("orphans the block at the end when the target does not exist", () => {
    const page = linearABCD();
    const next = applyOp(page, move(page, "p:2", "p:404"));
    // orderKeyAfter appends past the last block when the anchor is missing.
    expect(ids(next)).toEqual(["p:1", "p:3", "p:4", "p:2"]);
  });

  it("mints a valid key when a neighbour carries the empty-string placeholder", () => {
    // `""` is the sentinel orderKey a freshly-parsed/pasted block holds until a
    // real fractional-index key is assigned. If one survives into a live edit,
    // `orderKeyAfter` must coerce it to "no bound" and still mint a valid key —
    // not feed `""` to `generateKeyBetween`, which throws "invalid order key".
    const page = pageWith(block("p:1", ""), block("p:2", "a1"));
    expect(() => orderKeyAfter(page.blocks, "p:1")).not.toThrow();
    const key = orderKeyAfter(page.blocks, "p:1");
    expect(key).not.toBe("");
    // The minted key is a valid fractional index usable as a real bound.
    expect(() => generateKeyBetween(key, null)).not.toThrow();
  });

  it("allows moving a block after a tombstoned target", () => {
    const [k1, k2, k3] = generateNKeysBetween(null, null, 3);
    const page = pageWith(
      block("p:1", k1),
      { ...block("p:2", k2), deleted: true },
      block("p:3", k3),
    );
    const next = applyOp(page, move(page, "p:3", "p:2"));
    // p:3 still sorts after the tombstone p:2; tombstone stays in the order.
    expect(allIds(next)).toEqual(["p:1", "p:2", "p:3"]);
  });
});

describe("block move — concurrency convergence", () => {
  it("converges (LWW) when two peers move the same block to different targets", () => {
    const base = linearABCD();
    // Peer A moves p:2 after p:3; peer B moves p:2 to head. Higher HLC wins.
    const moveA = move(base, "p:2", "p:3", { counter: 5, peerId: "a" });
    const moveB = move(base, "p:2", null, { counter: 9, peerId: "b" });

    // Arrival order must not matter once ops are HLC-ordered.
    const order1 = applyCanonical(base, [moveA, moveB]);
    const order2 = applyCanonical(base, [moveB, moveA]);
    expect(ids(order1)).toEqual(ids(order2));
    // moveB (higher counter) is the last writer: p:2 ends at head.
    expect(ids(order1)[0]).toBe("p:2");
  });

  it("converges and loses nothing when two peers reciprocally move into each other", () => {
    const base = linearABCD();
    // p:2 → after p:3 and p:3 → after p:2 concurrently — the antagonistic case.
    const m1 = move(base, "p:2", "p:3", { counter: 5, peerId: "a" });
    const m2 = move(base, "p:3", "p:2", { counter: 6, peerId: "b" });

    const order1 = applyCanonical(base, [m1, m2]);
    const order2 = applyCanonical(base, [m2, m1]);
    // Both arrival orders agree, and every block survives — each move is an
    // independent LWW write of one block's key, so nothing is dropped.
    expect(ids(order1)).toEqual(ids(order2));
    expect(new Set(ids(order1))).toEqual(new Set(["p:1", "p:2", "p:3", "p:4"]));
  });
});

describe("block move — merge-path parity & undo", () => {
  // Build a real op log: insert A,B,C,D then move B after C.
  function buildLog() {
    const binding = createCRDTbinding(PAGE, "peer");
    const inserts: Operation[] = [];
    let prevKey: string | null = null;
    const blockIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const blockId = `b-peer:${i}`;
      const orderKey = generateKeyBetween(prevKey, null);
      inserts.push({
        op: "block_insert",
        id: binding.nextId(),
        clock: binding.getClock(),
        pageId: PAGE,
        orderKey,
        blockId,
        blockType: "paragraph",
      });
      blockIds.push(blockId);
      prevKey = orderKey;
    }

    // Materialize the post-insert page so the move's key is minted correctly.
    let page: Page = { id: PAGE, title: "", blocks: [] };
    for (const op of inserts) page = applyOp(page, op);

    const moveOp: BlockSet = {
      op: "block_set",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: PAGE,
      blockId: blockIds[1], // B
      field: "orderKey",
      value: orderKeyAfter(page.blocks, blockIds[2]), // after C
    };
    return { inserts, moveOp, blockIds };
  }

  it("incremental mergeOps matches a full rebuild", () => {
    const { inserts, moveOp } = buildLog();
    const allOps = [...inserts, moveOp];

    // Incremental: feed ops through mergeOps in arrival order.
    let log = createOpLog(PAGE);
    for (const op of allOps) log = mergeOps(log, [op]);

    const rebuilt = rebuildState(PAGE, allOps);
    expect(JSON.stringify(log.state)).toEqual(JSON.stringify(rebuilt));
  });

  it("undo of a move restores the original order", () => {
    const { inserts, moveOp, blockIds } = buildLog();
    const binding = createCRDTbinding(PAGE, "undoer");

    let page = createEmpty();
    for (const op of inserts) page = applyOp(page, op);
    const before = page; // state immediately before the move
    const moved = applyOp(before, moveOp);
    expect(ids(moved)).toEqual([
      blockIds[0],
      blockIds[2],
      blockIds[1],
      blockIds[3],
    ]);

    const [inverse] = invertOperation(moveOp, before, binding);
    expect(inverse).toBeDefined();
    const undone = applyOp(moved, inverse);
    expect(ids(undone)).toEqual(ids(before));
  });

  function createEmpty(): Page {
    return { id: PAGE, title: "", blocks: [] };
  }
});
