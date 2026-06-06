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
import type { Math as MathBlock } from "../../serlization/loadPage";
import { applyOp } from "../reducer";
import { createCRDTbinding, SyncEngine } from "../sync";

const binding = createCRDTbinding("math-undo-page", "p001");

const pageId = "math-undo-page";
const engine = new SyncEngine(pageId, "p001");

const insertOp = engine.createBlockInsert(null, "math", {
  latex: "x^2",
  displayMode: true,
});
engine.emit([insertOp]);

const blockId = insertOp.blockId;
const state1 = engine.getState();
const block1 = state1.blocks.find((b) => b.id === blockId) as
  | MathBlock
  | undefined;
if (!block1 || block1.type !== "math") {
  console.log("FAIL: math block was not inserted");
  process.exit(1);
}
if (block1.latex !== "x^2") {
  console.log(
    `FAIL: expected latex="x^2", got ${JSON.stringify(block1.latex)}`,
  );
  process.exit(1);
}
if (block1.displayMode !== true) {
  console.log(
    `FAIL: expected displayMode=true, got ${JSON.stringify(block1.displayMode)}`,
  );
  process.exit(1);
}

// Capture the inverse against pageBefore (the state immediately before the
// delete is applied) — same as `recordUndoOps` does in production code.
const pageBeforeDelete = engine.getState();
const deleteOp = engine.createBlockDelete(blockId);
engine.emit([deleteOp]);

const inverses = invertOperation(deleteOp, pageBeforeDelete, binding);
if (inverses.length === 0) {
  console.log("FAIL: invertOperation returned no ops");
  process.exit(1);
}
const inverseOp = inverses[0];
if (inverseOp.op !== "block_insert") {
  console.log(`FAIL: expected inverse op block_insert, got ${inverseOp.op}`);
  process.exit(1);
}

const initialProps = (inverseOp as { initialProps?: Record<string, unknown> })
  .initialProps;
console.log("inverse initialProps:", JSON.stringify(initialProps));
if (!initialProps || initialProps.latex !== "x^2") {
  console.log(
    `FAIL: inverse initialProps.latex expected "x^2", got ${JSON.stringify(initialProps?.latex)}`,
  );
  process.exit(1);
}
if (initialProps.displayMode !== true) {
  console.log(
    `FAIL: inverse initialProps.displayMode expected true, got ${JSON.stringify(initialProps.displayMode)}`,
  );
  process.exit(1);
}

const stateAfterDelete = engine.getState();
const restoredPage = applyOp(stateAfterDelete, inverseOp);
const restoredBlock = restoredPage.blocks.find((b) => b.id === blockId) as
  | MathBlock
  | undefined;
if (!restoredBlock || restoredBlock.type !== "math") {
  console.log("FAIL: restored block missing or wrong type");
  process.exit(1);
}
if (restoredBlock.latex !== "x^2") {
  console.log(
    `FAIL: restored latex expected "x^2", got ${JSON.stringify(restoredBlock.latex)}`,
  );
  process.exit(1);
}
if (restoredBlock.displayMode !== true) {
  console.log(
    `FAIL: restored displayMode expected true, got ${JSON.stringify(restoredBlock.displayMode)}`,
  );
  process.exit(1);
}
if (restoredBlock.deleted) {
  console.log("FAIL: restored block is still tombstoned");
  process.exit(1);
}

console.log("PASS: math block undo restored latex=x^2 displayMode=true");
process.exit(0);
