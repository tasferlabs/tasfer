/**
 * Trace test: deleting a math block then undoing the delete restores the block
 * and its `displayMode` field from the captured inverse.
 *
 * Math is now a TEXTUAL block (its char-run text IS the LaTeX), so the equation
 * *content* is restored by the char-level `text_insert` inverse — the general
 * textual-undo path. This test pins the block-level half: `block_delete`'s
 * inverse re-inserts the math block and replays its descriptor fields
 * (`displayMode`) via `initialProps`, read straight off the still-live block
 * before the delete is applied.
 */

import { createMathTestSyncEngine } from "../../__testutils__/math";
import { invertOperation } from "../inverse";
import { applyOp } from "../reducer";
import { createCRDTbinding } from "../sync";
import { describe, expect, it } from "vitest";

describe("math block delete + undo", () => {
  it("restores the math block and its displayMode from the captured inverse", () => {
    const binding = createCRDTbinding("math-undo-page", "p001");
    const engine = createMathTestSyncEngine(binding);

    const insertOp = engine.createBlockInsert(null, "math", {
      displayMode: true,
    });
    engine.emit([insertOp]);
    const blockId = insertOp.blockId;

    const block1 = engine.getState().blocks.find((b) => b.id === blockId);
    expect(block1).toBeDefined();
    expect(block1!.type).toBe("math");
    expect((block1 as { displayMode?: boolean }).displayMode).toBe(true);

    // Capture the inverse against pageBefore (the state immediately before the
    // delete is applied) — same as `recordUndoOps` does in production.
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
    expect(initialProps?.displayMode).toBe(true);

    const restoredPage = applyOp(engine.getState(), inverseOp);
    const restoredBlock = restoredPage.blocks.find((b) => b.id === blockId);
    expect(restoredBlock).toBeDefined();
    expect(restoredBlock!.type).toBe("math");
    expect((restoredBlock as { displayMode?: boolean }).displayMode).toBe(true);
    expect(restoredBlock!.deleted).toBeFalsy();
  });
});
