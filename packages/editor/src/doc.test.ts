/**
 * Doc facade tests — headless CRDT document behavior: projections,
 * convergence across delivery orders, version-vector dedup, update events,
 * and persistence round-trips. Ops are fabricated with `createSyncEngine`
 * (the same way the convergence fuzz does), so no canvas/editor is needed.
 */

import { createDoc, type DocUpdate } from "./doc";
import { loadPage } from "./serlization/loadPage";
import { serializeToMarkdown } from "./serlization/serializer";
import type { Operation } from "./state-types";
import { rebuildState } from "./sync/reducer";
import { createCRDTbinding, createSyncEngine, serializeVV } from "./sync/sync";
import { describe, expect, it } from "vitest";

/**
 * Fabricate op batches from a simulated peer: one paragraph per text, each
 * batch = [block_insert, text_insert]. Batches must be delivered in order
 * per peer (the log's per-origin ordering invariant), but may interleave
 * freely across peers.
 */
function makePeerBatches(peerId: string, texts: string[]): Operation[][] {
  const binding = createCRDTbinding("page-1", peerId);
  const engine = createSyncEngine(binding);
  const batches: Operation[][] = [];
  let after: string | null = null;
  for (const text of texts) {
    const blockInsert = engine.createBlockInsert(after, "paragraph");
    engine.emit([blockInsert]);
    const textInsert = engine.insertText(blockInsert.blockId, 0, text);
    engine.emit([textInsert]);
    after = blockInsert.blockId;
    batches.push([blockInsert, textInsert]);
  }
  return batches;
}

describe("createDoc", () => {
  it("projects markdown of its initial content", () => {
    const md = "# Title\n\nHello **bold** world.";
    const doc = createDoc({ markdown: md });
    expect(doc.getMarkdown()).toBe(serializeToMarkdown(loadPage(md).blocks));
    expect(doc.getMarkdown()).toContain("# Title");
  });

  it("creates an empty editable doc by default", () => {
    const doc = createDoc();
    expect(doc.getBlocks().length).toBeGreaterThan(0);
    expect(doc.getMarkdown().trim()).toBe("");
  });

  it("ops-only init starts truly empty (no starter paragraph)", () => {
    const doc = createDoc({ pageId: "page-1", ops: [] });
    expect(doc.getBlocks()).toHaveLength(0);
  });

  it("converges regardless of cross-peer delivery order, and dedupes", () => {
    const a = makePeerBatches("p-aaa", ["alpha", "beta"]);
    const b = makePeerBatches("p-bbb", ["gamma"]);

    const doc1 = createDoc({ pageId: "page-1", ops: [] });
    const doc2 = createDoc({ pageId: "page-1", ops: [] });

    for (const batch of [a[0], a[1], b[0]]) doc1.applyUpdate(batch);
    for (const batch of [b[0], a[0], a[1]]) doc2.applyUpdate(batch);

    expect(doc1.getMarkdown()).toBe(doc2.getMarkdown());
    for (const text of ["alpha", "beta", "gamma"]) {
      expect(doc1.getMarkdown()).toContain(text);
    }
    expect(doc1.getOperations()).toHaveLength(6);

    // Re-delivering a known batch changes nothing.
    const before = doc1.getMarkdown();
    doc1.applyUpdate(a[0]);
    expect(doc1.getMarkdown()).toBe(before);
    expect(doc1.getOperations()).toHaveLength(6);
  });

  it("emits update events with fresh ops and the given origin", () => {
    const batches = makePeerBatches("p-ccc", ["hello", "again"]);
    const doc = createDoc({ pageId: "page-1", ops: [] });
    const events: DocUpdate[] = [];
    const off = doc.on("update", (u) => events.push(u));

    doc.applyUpdate(batches[0], "provider-1");
    expect(events).toHaveLength(1);
    expect(events[0].origin).toBe("provider-1");
    expect(events[0].local).toBe(false);
    expect(events[0].ops).toHaveLength(2);

    // Fully-known batch → no event at all.
    doc.applyUpdate(batches[0], "provider-1");
    expect(events).toHaveLength(1);

    off();
    doc.applyUpdate(batches[1]);
    expect(events).toHaveLength(1);
  });

  it("notifies listeners of locally ingested ops with local origin", () => {
    const doc = createDoc({ pageId: "page-1", ops: [] });
    const [batch] = makePeerBatches("p-ddd", ["local edit"]);
    const events: DocUpdate[] = [];
    doc.on("update", (u) => events.push(u));

    const origin = { editor: true };
    doc._ingestLocal(batch, origin);

    expect(events).toHaveLength(1);
    expect(events[0].local).toBe(true);
    expect(events[0].origin).toBe(origin);
    expect(doc.getMarkdown()).toContain("local edit");
  });

  it("round-trips through encodeState / createDoc(bytes)", () => {
    const [batch] = makePeerBatches("p-eee", ["persisted"]);
    const original = createDoc({ pageId: "page-9", ops: [] });
    original.applyUpdate(batch);

    const restored = createDoc(original.encodeState());
    expect(restored.pageId).toBe("page-9");
    expect(restored.getMarkdown()).toBe(original.getMarkdown());
    expect(serializeVV(restored.getVersionVector())).toEqual(
      serializeVV(original.getVersionVector()),
    );
    expect(restored.getOperations()).toHaveLength(2);

    // Ops already reflected in the restored state are recognized as known.
    const events: DocUpdate[] = [];
    restored.on("update", (u) => events.push(u));
    restored.applyUpdate(batch);
    expect(events).toHaveLength(0);
  });

  it("converges on a cross-origin dependent insert delivered out of order", () => {
    // Peer A creates a block and types "AAA". Peer B (having seen A's ops)
    // appends "BBB" into the SAME block — so B's text_insert references one of
    // A's character ids as its anchor. A transport may deliver B's batch
    // before A's (cross-origin order isn't guaranteed). A naive incremental
    // fold drops B's insert (its anchor doesn't exist yet) and never recovers;
    // the doc must match the canonical rebuild from its full op log.
    const bindingA = createCRDTbinding("page-1", "p-aaaa");
    const engineA = createSyncEngine(bindingA);
    const blockInsert = engineA.createBlockInsert(null, "paragraph");
    engineA.emit([blockInsert]);
    const insertA = engineA.insertText(blockInsert.blockId, 0, "AAA");
    engineA.emit([insertA]);
    const opsA = [blockInsert, insertA];

    const bindingB = createCRDTbinding("page-1", "p-bbbb");
    const engineB = createSyncEngine(bindingB);
    engineB.apply(opsA); // B sees A's block + chars first…
    const insertB = engineB.insertText(blockInsert.blockId, 3, "BBB"); // …then appends
    engineB.emit([insertB]);
    const opsB = [insertB];

    const doc = createDoc({ pageId: "page-1", ops: [] });
    doc.applyUpdate(opsB, "wire"); // dependent insert arrives BEFORE its anchor
    doc.applyUpdate(opsA, "wire");

    const canonical = serializeToMarkdown(
      rebuildState("page-1", doc.getOperations()).blocks,
    );
    expect(doc.getMarkdown()).toBe(canonical);
    expect(doc.getMarkdown()).toContain("AAABBB");
  });

  it("two docs cross-wired like a transport converge without echo loops", () => {
    // The pattern the docs prescribe for providers: forward updates you didn't
    // cause, tag inbound applies with yourself as origin. The origin guard
    // plus version-vector dedup must terminate (no infinite ping-pong).
    const doc1 = createDoc({ pageId: "page-1", ops: [] });
    const doc2 = createDoc({ pageId: "page-1", ops: [] });

    const wire1to2 = "wire:1→2";
    const wire2to1 = "wire:2→1";
    let forwarded = 0;
    doc1.on("update", (u) => {
      if (u.origin !== wire2to1) {
        forwarded++;
        doc2.applyUpdate(u.ops, wire1to2);
      }
    });
    doc2.on("update", (u) => {
      if (u.origin !== wire1to2) {
        forwarded++;
        doc1.applyUpdate(u.ops, wire2to1);
      }
    });

    // Each side ingests "local" edits from its own peer.
    const [fromPeerX] = makePeerBatches("p-xxx", ["from doc one"]);
    const [fromPeerY] = makePeerBatches("p-yyy", ["from doc two"]);
    doc1._ingestLocal(fromPeerX, "editor-1");
    doc2._ingestLocal(fromPeerY, "editor-2");

    expect(doc1.getMarkdown()).toBe(doc2.getMarkdown());
    expect(doc1.getMarkdown()).toContain("from doc one");
    expect(doc1.getMarkdown()).toContain("from doc two");
    // one forward per local batch, per direction — no echo amplification
    expect(forwarded).toBe(2);
  });

  it("initializes from snapshot blocks plus tail ops", () => {
    const binding = createCRDTbinding("page-1", "p-fff");
    const engine = createSyncEngine(binding);
    const blockInsert = engine.createBlockInsert(null, "paragraph");
    engine.emit([blockInsert]);
    const textInsert = engine.insertText(blockInsert.blockId, 0, "snapshotted");
    engine.emit([textInsert]);

    const base = createDoc({
      pageId: "page-1",
      ops: [blockInsert, textInsert],
    });
    const snapshotBlocks = structuredClone(base.getBlocks());

    // An op produced after the snapshot was taken.
    const tail = engine.insertText(
      blockInsert.blockId,
      "snapshotted".length,
      "!",
    );
    engine.emit([tail]);

    const doc = createDoc({
      pageId: "page-1",
      blocks: snapshotBlocks,
      ops: [tail],
    });
    expect(doc.getMarkdown()).toContain("snapshotted!");
    expect(doc.getOperations()).toHaveLength(1);
  });
});
