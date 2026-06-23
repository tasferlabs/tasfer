/**
 * Forward compatibility (cross-peer): because the app is P2P and local-first,
 * a peer running an OLDER app version will receive ops produced by a NEWER one
 * — there is no central server to migrate and no flag day. The old code must
 * therefore *tolerate* data it doesn't understand rather than crash, reject, or
 * silently drop it (which would permanently break CRDT convergence).
 *
 * This pins the two ways "the future" shows up to an old replica:
 *   1. An op of a type that didn't exist yet (a new member of the `Operation`
 *      union) — `reducer.applyOp` no-ops it but `oplog` keeps it in the log +
 *      version vector.
 *   2. A `block_insert` for a block type this build's schema doesn't know — the
 *      block isn't materialized (renders as UnknownNode in the editor) but the
 *      op is likewise retained.
 *
 * The invariants asserted: no throw; known content is unaffected; the unknown
 * ops survive an `encodeState()` round-trip (so re-saving never deletes a newer
 * peer's content); and two replicas converge regardless of op arrival order.
 *
 * See the "Releasing Updates And Compatibility" note at
 * /docs/internals/compatibility.
 */

import { createDoc } from "../../doc";
import type { Block } from "../../serlization/loadPage";
import type { Operation } from "../../state-types";
import { getVisibleTextFromRuns } from "../char-runs";
import { describe, expect, it } from "vitest";

const PAGE_ID = "fwd-compat";
const PEER = "pZ";

/** An op stamped by peer PEER at the given counter. */
function clock(counter: number) {
  return { counter, peerId: PEER };
}
function id(counter: number) {
  return `${PEER}:${counter}`;
}

/** Insert a known paragraph block. */
const insertKnownBlock: Operation = {
  op: "block_insert",
  id: id(1),
  clock: clock(1),
  pageId: PAGE_ID,
  afterBlockId: null,
  blockId: "blk-known",
  blockType: "paragraph",
};

/** Type "Hi" into the known block. */
const insertText: Operation = {
  op: "text_insert",
  id: id(2),
  clock: clock(2),
  pageId: PAGE_ID,
  blockId: "blk-known",
  afterCharId: null,
  charRuns: [{ peerId: PEER, startCounter: 100, text: "Hi" }],
};

/** A block whose type this build's schema does not know about. */
const insertFutureBlock: Operation = {
  op: "block_insert",
  id: id(3),
  clock: clock(3),
  pageId: PAGE_ID,
  afterBlockId: "blk-known",
  blockId: "blk-future",
  blockType: "future_widget",
};

/**
 * An op of a type that does not exist in this build's `Operation` union — a
 * hypothetical future op. Cast through `unknown`: the whole point is that an
 * old build can't name this type, yet must carry it through untouched.
 */
const futureOp = {
  op: "reaction_add",
  id: id(4),
  clock: clock(4),
  pageId: PAGE_ID,
  blockId: "blk-known",
  emoji: "🎉",
} as unknown as Operation;

const ALL_OPS: Operation[] = [
  insertKnownBlock,
  insertText,
  insertFutureBlock,
  futureOp,
];

function visible(blocks: Block[]): Block[] {
  return blocks.filter((b) => !b.deleted);
}
function opIds(ops: Operation[]): string[] {
  return ops.map((o) => o.id).sort();
}

// Seed every doc ops-only (`ops: []`) rather than with the default starter
// paragraph: a seeded starter block is backed by no op, which would make
// mergeOps' dev-only incremental-vs-rebuild self-check (rebuild is ops-only)
// diverge — noise unrelated to forward compatibility.
function emptyDoc() {
  return createDoc({ pageId: PAGE_ID, ops: [] });
}

describe("forward compatibility with newer-peer ops", () => {
  it("ingests unknown op + block types without throwing", () => {
    const doc = emptyDoc();
    expect(() => doc.applyUpdate(ALL_OPS)).not.toThrow();
    doc.destroy();
  });

  it("materializes known content and leaves the unknown block unmaterialized", () => {
    const doc = emptyDoc();
    doc.applyUpdate(ALL_OPS);

    const blocks = visible(doc.getRawBlocks());
    const known = blocks.find((b) => b.id === "blk-known");
    expect(known?.type).toBe("paragraph");
    expect(
      getVisibleTextFromRuns((known as { charRuns?: never[] }).charRuns),
    ).toBe("Hi");

    // The future block type has no model in this schema → not materialized,
    // and absent from the markdown export (no codec for it).
    expect(blocks.some((b) => b.id === "blk-future")).toBe(false);
    expect(doc.getMarkdown()).toContain("Hi");

    doc.destroy();
  });

  it("retains the unknown ops in the log (kept known via the version vector)", () => {
    const doc = emptyDoc();
    doc.applyUpdate(ALL_OPS);

    const ids = opIds(doc.getOperations());
    expect(ids).toContain(insertFutureBlock.id);
    expect(ids).toContain(futureOp.id);
    // All four ops are retained — none dropped.
    expect(ids).toEqual(opIds(ALL_OPS));

    doc.destroy();
  });

  it("preserves unknown ops across an encodeState() round-trip", () => {
    const doc = emptyDoc();
    doc.applyUpdate(ALL_OPS);
    const bytes = doc.encodeState();
    doc.destroy();

    // A v1 replica re-saving its state must NOT silently delete the newer
    // peer's content — both unknown ops survive into the restored doc.
    const restored = createDoc(bytes);
    const ids = opIds(restored.getOperations());
    expect(ids).toContain(insertFutureBlock.id);
    expect(ids).toContain(futureOp.id);
    expect(ids).toEqual(opIds(ALL_OPS));
    restored.destroy();
  });

  it("converges across batching and idempotent redelivery", () => {
    // Peer A receives everything in one batch.
    const a = emptyDoc();
    a.applyUpdate(ALL_OPS);

    // Peer B receives the same ops split into two batches (per-origin counter
    // order preserved — the max-only version vector requires it), then has the
    // whole batch redelivered. The unknown ops in the middle must not corrupt
    // dedup: redelivery is a no-op and B ends identical to A.
    const b = emptyDoc();
    b.applyUpdate([insertKnownBlock, insertText]);
    b.applyUpdate([insertFutureBlock, futureOp]);
    b.applyUpdate(ALL_OPS); // redelivery — fully deduped by the version vector

    expect(opIds(b.getOperations())).toEqual(opIds(a.getOperations()));
    expect(b.getOperations()).toHaveLength(ALL_OPS.length); // no duplicates
    expect(visible(b.getRawBlocks()).map((blk) => blk.id)).toEqual(
      visible(a.getRawBlocks()).map((blk) => blk.id),
    );

    a.destroy();
    b.destroy();
  });
});
