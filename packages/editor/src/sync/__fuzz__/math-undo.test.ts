/**
 * Trace test: deleting a math block then undoing the delete must restore
 * latex + displayMode.
 *
 * Under the emit-time inverse-capture model: when block_delete is emitted,
 * `recordUndoOps` immediately invokes `invertOperation` against the page
 * BEFORE the delete is applied. At that point the math block is still
 * live, so the registry's `extractForInverse` reads every field straight
 * off the block and stores it in the inverse block_insert's `initialProps`.
 * Later when undo replays that captured inverse, the math block is
 * restored with full fidelity.
 */

import { invertOperation } from "../../inverse";
import type { MathBlock } from "../../rendering/blocks/MathBlockView";
import { applyOp } from "../reducer";
import { createCRDTbinding, createSyncEngine } from "../sync";
import { describe, expect, it } from "vitest";

describe("math block delete + undo", () => {
  it("restores latex and displayMode from the captured inverse", () => {
    const binding = createCRDTbinding("math-undo-page", "p001");
    const engine = createSyncEngine(binding);

    const insertOp = engine.createBlockInsert(null, "math", {
      latex: "x^2",
      displayMode: true,
    });
    engine.emit([insertOp]);

    const blockId = insertOp.blockId;
    const block1 = engine.getState().blocks.find((b) => b.id === blockId) as
      | MathBlock
      | undefined;
    expect(block1).toBeDefined();
    expect(block1!.type).toBe("math");
    expect(block1!.latex).toBe("x^2");
    expect(block1!.displayMode).toBe(true);

    // Capture the inverse against pageBefore (the state immediately before
    // the delete is applied) — same as `recordUndoOps` does in production.
    const pageBeforeDelete = engine.getState();
    const deleteOp = engine.createBlockDelete(blockId);
    engine.emit([deleteOp]);

    const inverses = invertOperation(deleteOp, pageBeforeDelete, binding);
    expect(inverses.length).toBeGreaterThan(0);
    const inverseOp = inverses[0];
    expect(inverseOp.op).toBe("block_insert");

    const initialProps = (
      inverseOp as { initialProps?: Record<string, unknown> }
    ).initialProps;
    expect(initialProps?.latex).toBe("x^2");
    expect(initialProps?.displayMode).toBe(true);

    const restoredPage = applyOp(engine.getState(), inverseOp);
    const restoredBlock = restoredPage.blocks.find((b) => b.id === blockId) as
      | MathBlock
      | undefined;
    expect(restoredBlock).toBeDefined();
    expect(restoredBlock!.type).toBe("math");
    expect(restoredBlock!.latex).toBe("x^2");
    expect(restoredBlock!.displayMode).toBe(true);
    expect(restoredBlock!.deleted).toBeFalsy();
  });
});
