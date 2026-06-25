/**
 * `block_move` operation: applies a deterministic, convergent block reposition.
 *
 * A move re-anchors the block plus up to two neighbours (close the gap it left,
 * open a gap at the destination). These tests pin the single-user ordering,
 * apply-time totality (malformed/edge ops never throw or corrupt order),
 * concurrency convergence (LWW + cycle handling), incremental/rebuild merge
 * parity, and undo reversibility.
 */

import type { Block, Page } from "../serlization/loadPage";
import type { BlockMove, HLC, Operation } from "../state-types";
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
function applyCanonical(base: Page, ops: BlockMove[]): Page {
  return [...ops]
    .sort((a, b) => compareHLC(a.clock, b.clock))
    .reduce(applyOp, base);
}

const PAGE = "page-1";

function block(id: string, afterId: string | null): Block {
  return { id, afterId, type: "paragraph", charRuns: [], formats: [] };
}

function pageWith(...blocks: Block[]): Page {
  return { id: PAGE, title: "", blocks };
}

/** Visible (non-deleted) block ids in document order. */
function ids(page: Page): string[] {
  return page.blocks.filter((b) => !b.deleted).map((b) => b.id);
}

/** All block ids in document order, including tombstones. */
function allIds(page: Page): string[] {
  return page.blocks.map((b) => b.id);
}

function move(
  blockId: string,
  afterBlockId: string | null,
  clock: HLC = { counter: 100, peerId: "z" },
): BlockMove {
  return {
    op: "block_move",
    id: `${clock.peerId}:${clock.counter}`,
    clock,
    pageId: PAGE,
    blockId,
    afterBlockId,
  };
}

// A,B,C,D as a clean linear chain. Counters ascend so the RGA sibling
// tie-break (newer-first) is well-defined if a collision ever arises.
function linearABCD(): Page {
  return pageWith(
    block("p:1", null),
    block("p:2", "p:1"),
    block("p:3", "p:2"),
    block("p:4", "p:3"),
  );
}

describe("applyBlockMove — single-user ordering", () => {
  it("moves a block to sit immediately after the target (B after C ⇒ A,C,B,D)", () => {
    const next = applyOp(linearABCD(), move("p:2", "p:3"));
    expect(ids(next)).toEqual(["p:1", "p:3", "p:2", "p:4"]);
  });

  it("moves a block to the head (afterBlockId = null)", () => {
    const next = applyOp(linearABCD(), move("p:3", null));
    expect(ids(next)).toEqual(["p:3", "p:1", "p:2", "p:4"]);
  });

  it("moves a block backwards (D after A ⇒ A,D,B,C)", () => {
    const next = applyOp(linearABCD(), move("p:4", "p:1"));
    expect(ids(next)).toEqual(["p:1", "p:4", "p:2", "p:3"]);
  });

  it("is idempotent: applying the same move twice equals applying it once", () => {
    const once = applyOp(linearABCD(), move("p:2", "p:3"));
    const twice = applyOp(once, move("p:2", "p:3"));
    expect(ids(twice)).toEqual(ids(once));
  });

  it("is a no-op when the block already sits after the target", () => {
    const page = linearABCD();
    const next = applyOp(page, move("p:2", "p:1"));
    expect(next).toBe(page); // same reference — no rebuild
  });
});

describe("applyBlockMove — totality (never throws, converges)", () => {
  it("ignores a move of a non-existent block", () => {
    const page = linearABCD();
    expect(applyOp(page, move("p:999", "p:1"))).toBe(page);
  });

  it("ignores a self-targeting move", () => {
    const page = linearABCD();
    expect(applyOp(page, move("p:2", "p:2"))).toBe(page);
  });

  it("orphans the block at the end when the target does not exist", () => {
    const next = applyOp(linearABCD(), move("p:2", "p:404"));
    // p:2 anchors to a missing block → emitted as an orphan at the end.
    expect(ids(next)).toEqual(["p:1", "p:3", "p:4", "p:2"]);
  });

  it("allows moving a block after a tombstoned target", () => {
    const page = pageWith(
      block("p:1", null),
      { ...block("p:2", "p:1"), deleted: true },
      block("p:3", "p:2"),
    );
    const next = applyOp(page, move("p:3", "p:2"));
    // p:3 still anchors after the tombstone p:2; tombstone stays in the chain.
    expect(allIds(next)).toEqual(["p:1", "p:2", "p:3"]);
  });
});

describe("block_move — concurrency convergence", () => {
  it("converges (LWW) when two peers move the same block to different targets", () => {
    const base = linearABCD();
    // Peer A moves p:2 after p:3; peer B moves p:2 to head. Higher HLC wins.
    const moveA = move("p:2", "p:3", { counter: 5, peerId: "a" });
    const moveB = move("p:2", null, { counter: 9, peerId: "b" });

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
    const m1 = move("p:2", "p:3", { counter: 5, peerId: "a" });
    const m2 = move("p:3", "p:2", { counter: 6, peerId: "b" });

    const order1 = applyCanonical(base, [m1, m2]);
    const order2 = applyCanonical(base, [m2, m1]);
    // Both arrival orders agree, and every block survives (resolveBlockOrder
    // never drops a block, even if a re-anchoring chain becomes degenerate).
    expect(ids(order1)).toEqual(ids(order2));
    expect(new Set(ids(order1))).toEqual(new Set(["p:1", "p:2", "p:3", "p:4"]));
  });
});

describe("block_move — merge-path parity & undo", () => {
  // Build a real op log: insert A,B,C,D then move B after C.
  function buildLog() {
    const binding = createCRDTbinding(PAGE, "peer");
    const inserts: Operation[] = [];
    let prev: string | null = null;
    const blockIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const blockId = `b-peer:${i}`;
      inserts.push({
        op: "block_insert",
        id: binding.nextId(),
        clock: binding.getClock(),
        pageId: PAGE,
        afterBlockId: prev,
        blockId,
        blockType: "paragraph",
      });
      blockIds.push(blockId);
      prev = blockId;
    }
    const moveOp: BlockMove = {
      op: "block_move",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: PAGE,
      blockId: blockIds[1], // B
      afterBlockId: blockIds[2], // C
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
