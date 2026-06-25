/**
 * A CRDT binding's peerId is the origin half of every op id and the version
 * vector's per-origin key. An empty peerId makes two peers share one VV bucket
 * and collide op ids (`:5` vs `:5`), so `isOpKnown` silently drops the second —
 * permanent divergence. `createCRDTbinding` must never accept an empty origin.
 */
import { getVisibleTextFromRuns } from "./char-runs";
import { extractPeerId } from "./id";
import { createOpLog, mergeOps } from "./oplog";
import { createCRDTbinding } from "./sync";
import { describe, expect, it } from "vitest";

describe("createCRDTbinding peerId guard", () => {
  it("generates a non-empty unique peerId when given an empty string", () => {
    const a = createCRDTbinding("pg", "");
    const b = createCRDTbinding("pg", "");
    expect(a.getPeerId().length).toBeGreaterThan(0);
    expect(b.getPeerId().length).toBeGreaterThan(0);
    expect(a.getPeerId()).not.toBe(b.getPeerId());
    // op ids carry the generated peer id, not ""
    expect(extractPeerId(a.nextId()).length).toBeGreaterThan(0);
  });

  it("two empty-peerId peers no longer collide — both edits survive the merge", () => {
    // Reproduce the field bug: two peers both created with "" used to emit
    // colliding op ids (`:N`) under one VV bucket, dropping one peer's ops.
    const bindH = createCRDTbinding("pg", "");
    const bindA = createCRDTbinding("pg", "");

    // A shared block both peers already have.
    const seed = {
      op: "block_insert",
      id: "seed:0",
      clock: { counter: 0, peerId: "seed" },
      pageId: "pg",
      afterBlockId: null,
      blockId: "b1",
      blockType: "paragraph",
    } as const;

    // Each peer inserts text into the same block via its own binding.
    const opH = {
      op: "text_insert",
      id: bindH.nextId(),
      clock: bindH.getClock(),
      pageId: "pg",
      blockId: "b1",
      afterCharId: null,
      charRuns: [
        { peerId: extractPeerId(bindH.nextId()), startCounter: 1, text: "H" },
      ],
    } as any;
    const opA = {
      op: "text_insert",
      id: bindA.nextId(),
      clock: bindA.getClock(),
      pageId: "pg",
      blockId: "b1",
      afterCharId: null,
      charRuns: [
        { peerId: extractPeerId(bindA.nextId()), startCounter: 1, text: "A" },
      ],
    } as any;

    // Distinct op-id origins => no collision in the version vector.
    expect(extractPeerId(opH.id)).not.toBe(extractPeerId(opA.id));

    let log = createOpLog("pg");
    log = mergeOps(log, [seed]);
    log = mergeOps(log, [opH]);
    log = mergeOps(log, [opA]);
    const b1 = log.state.blocks.find((b) => b.id === "b1")!;
    const txt = getVisibleTextFromRuns((b1 as any).charRuns);
    // Both peers' chars present (order by RGA, but neither dropped).
    expect(txt.includes("H")).toBe(true);
    expect(txt.includes("A")).toBe(true);
  });
});
