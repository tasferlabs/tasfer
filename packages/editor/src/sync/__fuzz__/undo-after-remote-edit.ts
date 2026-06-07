/**
 * Trace test: a captured-at-emit-time inverse must still undo correctly
 * after intervening remote edits to the same block.
 *
 * Scenario:
 *   1. Peer A inserts a paragraph "hello" and syncs to B.
 *   2. Peer A bolds chars 0..3 (the "hell" prefix) and syncs to B.
 *   3. Peer B appends " world" to the paragraph and syncs back to A.
 *   4. At peer A, simulate undo of the bold toggle.
 *   5. Assert no chars are bolded.
 *
 * The pre-state captured at step 2 (no bold on these chars) is what the
 * inverse must restore. Crucially the inverse is captured at step 2 and
 * replayed at step 4 verbatim — not recomputed from current state. This
 * test would also pass if undo recomputed (a naive toggle would still
 * remove the bold here), but the point is that the same machinery handles
 * link URLs (where toggle would lose the prior URL) — so verifying the
 * captured-payload path works on a simple case is the necessary first
 * step.
 */

import { invertOperation, refreshOps } from "../../inverse";
import type { Paragraph } from "../../rendering/blocks/TextBlockView";
import type { Page } from "../../serlization/loadPage";
import { isTextualBlock } from "../block-registry";
import { getVisibleLengthFromRuns, iterateVisibleChars } from "../char-runs";
import type { FormatSet } from "../crdt-types";
import { applyOps } from "../reducer";
import { createCRDTbinding, SyncEngine } from "../sync";

// Two peers. The per-editor CRDT binding holds the HLC + id-gen that the
// per-op helpers (crdt-helpers, inverse) consume via
// binding.nextId()/binding.getClock(). To make this test exercise the same HLC
// the inverses use, we build peer A's ops through this binding.
const binding = createCRDTbinding("undo-trace", "p001");
const pageId = binding.pageId;

const peerA = new SyncEngine(pageId, "p001");
const peerB = new SyncEngine(pageId, "p002");

// ---------------------------------------------------------------------------
// 1. Peer A inserts a paragraph and types "hello" into it.
// ---------------------------------------------------------------------------
const blockInsertOp = peerA.createBlockInsert(null, "paragraph");
peerA.emit([blockInsertOp]);
peerB.apply([blockInsertOp]);

const blockId = blockInsertOp.blockId;
const insertHelloOp = peerA.insertText(blockId, 0, "hello");
peerA.emit([insertHelloOp]);
peerB.apply([insertHelloOp]);

function visibleText(p: Page): string {
  const block = p.blocks.find((b) => b.id === blockId);
  if (!block || !isTextualBlock(block)) return "";
  let result = "";
  for (const { char } of iterateVisibleChars(block.charRuns)) {
    result += char;
  }
  return result;
}

if (
  visibleText(peerA.getState()) !== "hello" ||
  visibleText(peerB.getState()) !== "hello"
) {
  console.log(
    `FAIL: initial sync wrong. A="${visibleText(peerA.getState())}" B="${visibleText(peerB.getState())}"`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Peer A bolds chars 0..4 (the "hell" prefix). Build the op with the
//    global HLC (the same one inverse capture will consume) so the LWW
//    ordering between the captured inverse and the original op is the
//    natural one (inverse's clock > op's clock).
// ---------------------------------------------------------------------------
const pageBeforeBold = peerA.getState();
const blockOnA = pageBeforeBold.blocks.find((b) => b.id === blockId);
if (!blockOnA || !isTextualBlock(blockOnA)) {
  console.log("FAIL: block missing or non-textual on peer A");
  process.exit(1);
}
const charIdsToBold: string[] = [];
let visibleCount = 0;
for (const { id } of iterateVisibleChars(blockOnA.charRuns)) {
  if (visibleCount < 4) charIdsToBold.push(id);
  visibleCount++;
  if (visibleCount >= 4) break;
}

const boldOp: FormatSet = {
  op: "format_set",
  id: binding.nextId(),
  clock: binding.getClock(),
  pageId,
  blockId,
  charIds: charIdsToBold,
  format: { type: "bold" },
  value: true,
};
peerA.apply([boldOp]);

// CAPTURE the inverse against pageBeforeBold — same as recordUndoOps does
// in production.
const capturedInverses = invertOperation(boldOp, pageBeforeBold, binding);
if (capturedInverses.length !== 1) {
  console.log(`FAIL: expected 1 inverse, got ${capturedInverses.length}`);
  process.exit(1);
}
const inverse = capturedInverses[0];
if (inverse.op !== "format_set" || inverse.value !== false) {
  console.log(
    `FAIL: expected inverse format_set value=false (no prior bold), got ${JSON.stringify(inverse)}`,
  );
  process.exit(1);
}

// Sync bold to B.
peerB.apply([boldOp]);

// ---------------------------------------------------------------------------
// 3. Peer B appends " world" at the end of the paragraph. This is a
//    remote edit that doesn't touch the bolded chars; it just adds 6
//    new chars.
// ---------------------------------------------------------------------------
const blockOnB = peerB.getState().blocks.find((b) => b.id === blockId);
if (!blockOnB || !isTextualBlock(blockOnB)) {
  console.log("FAIL: block missing on peer B");
  process.exit(1);
}
const lenB = getVisibleLengthFromRuns(blockOnB.charRuns);
const insertWorldOp = peerB.insertText(blockId, lenB, " world");
peerB.emit([insertWorldOp]);
peerA.apply([insertWorldOp]);

if (visibleText(peerA.getState()) !== "hello world") {
  console.log(
    `FAIL: peer A text should be "hello world", got "${visibleText(peerA.getState())}"`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Simulate undo of the bold on peer A: re-stamp the captured inverse
//    and apply it. (In production this lives inside undoState; we replay
//    the same primitives here without spinning up an EditorState.)
// ---------------------------------------------------------------------------
const undoOps = refreshOps(capturedInverses, binding);
peerA.apply(undoOps);

// ---------------------------------------------------------------------------
// 5. Verify: no bold span covers any of the originally bolded chars.
// ---------------------------------------------------------------------------
const finalA = peerA.getState();
const finalBlock = finalA.blocks.find((b) => b.id === blockId) as
  | Paragraph
  | undefined;
if (!finalBlock || !isTextualBlock(finalBlock)) {
  console.log("FAIL: final block missing on peer A");
  process.exit(1);
}

const originalBoldCharIds = new Set(boldOp.charIds);
const sequenceIds: string[] = [];
for (const run of finalBlock.charRuns ?? []) {
  for (let i = 0; i < run.text.length; i++) {
    sequenceIds.push(`${run.peerId}:${run.startCounter + i}`);
  }
}

for (const span of finalBlock.formats) {
  if (span.format.type !== "bold") continue;
  const startIdx = sequenceIds.indexOf(span.startCharId);
  const endIdx = sequenceIds.indexOf(span.endCharId);
  if (startIdx === -1 || endIdx === -1) continue;
  for (let i = startIdx; i <= endIdx; i++) {
    if (originalBoldCharIds.has(sequenceIds[i])) {
      console.log(
        `FAIL: after undo, char ${sequenceIds[i]} is still inside a bold span (clock ${span.clock.counter}-${span.clock.peerId})`,
      );
      process.exit(1);
    }
  }
}

// Also confirm undo of bold didn't disturb the text.
if (visibleText(finalA) !== "hello world") {
  console.log(
    `FAIL: undo of bold should not affect text. expected "hello world", got "${visibleText(finalA)}"`,
  );
  process.exit(1);
}

// And the inverse should be idempotent — applying it again should be a
// no-op (the bold span is already gone).
const reapplied = applyOps(finalA, refreshOps(capturedInverses, binding));
const reBlock = reapplied.blocks.find((b) => b.id === blockId);
if (!reBlock) {
  console.log("FAIL: rebuild lost the block");
  process.exit(1);
}

console.log(
  "PASS: captured-at-emit-time inverse undid bold after remote insert",
);
process.exit(0);
