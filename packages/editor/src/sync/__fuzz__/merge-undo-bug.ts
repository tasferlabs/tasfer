/**
 * Repro for "blocks jump down" after undo of a merge.
 *
 * Symptom: user presses Backspace at the start of a paragraph (merging it
 * into the previous paragraph), then Cmd+Z. The merged-into block keeps the
 * merged content AND an empty paragraph appears below it where the merged
 * block used to live.
 *
 * Root cause: the old merge logic locally spliced the merged content onto
 * blockToPreserve.charRuns and removed blockToDelete from the array, but
 * only emitted `block_delete blockToDelete`. The captured inverse for that
 * op only restores an empty paragraph (paragraph's only registered field
 * is `type`, so no content travels with the inverse) and the local
 * charRuns-splice is never undone.
 *
 * Fix: merge through real ops — text_insert for the moved content + format
 * spans + block_delete — and apply via applyOps. The inverse text_delete
 * captured for the text_insert now reverses the chars-moving as part of
 * the same undo group.
 *
 * This file simulates both paths against the lower-level ops so we don't
 * need to drive the canvas editor.
 */

import { invertOperations, refreshOps } from "../../inverse";
import { isTextualBlock, type Page } from "../../serlization/loadPage";
import { getVisibleLengthFromRuns, iterateVisibleChars } from "../char-runs";
import { insertCharsAtPosition } from "../crdt-helpers";
import type { BlockInsert, Operation, TextInsert } from "../crdt-types";
import { applyOp, applyOps, createEmptyPageState } from "../reducer";
import { createCRDTbinding } from "../sync";

const binding = createCRDTbinding("merge-undo-repro", "p001");
const pageId = binding.pageId;

function describeVisible(p: Page): string {
  return p.blocks
    .filter((b) => !b.deleted)
    .map((b) =>
      isTextualBlock(b)
        ? `"${[...iterateVisibleChars(b.charRuns)].map((c) => c.char).join("")}"`
        : "[visual]",
    )
    .join("  ");
}

// Build initial page A="hello", B="world" via real ops so all char IDs come
// from a single id-gen stream.
function makeBlockInsert(
  afterBlockId: string | null,
  blockId: string,
): BlockInsert {
  return {
    op: "block_insert",
    id: binding.nextId(),
    clock: binding.getClock(),
    pageId,
    afterBlockId,
    blockId,
    blockType: "paragraph",
  };
}
function makeTextInsert(
  blockId: string,
  afterCharId: string | null,
  text: string,
): TextInsert {
  const firstId = binding.nextId();
  const peerId = firstId.split(":")[0];
  const startCounter = parseInt(firstId.split(":")[1], 10);
  for (let i = 1; i < text.length; i++) binding.nextId();
  return {
    op: "text_insert",
    id: binding.nextId(),
    clock: binding.getClock(),
    pageId,
    blockId,
    afterCharId,
    charRuns: [{ peerId, startCounter, text }],
  };
}

const aId = binding.nextId();
const bId = binding.nextId();
const initOps: Operation[] = [
  makeBlockInsert(null, aId),
  makeTextInsert(aId, null, "hello"),
  makeBlockInsert(aId, bId),
  makeTextInsert(bId, null, "world"),
];
const initial = applyOps(createEmptyPageState(pageId), initOps);
console.log("Initial:", describeVisible(initial));

// =============================================================================
// Old (buggy) path: local splice + block_delete only.
// =============================================================================
{
  const A = initial.blocks.find((b) => b.id === aId)!;
  const B = initial.blocks.find((b) => b.id === bId)!;
  if (!isTextualBlock(A) || !isTextualBlock(B)) throw new Error("not textual");

  const blockDelOp: Operation = {
    op: "block_delete",
    id: binding.nextId(),
    clock: binding.getClock(),
    pageId,
    blockId: bId,
  };
  // Local hack: A gets merged charRuns, B is spliced out.
  const buggyLocal: Page = {
    ...initial,
    blocks: [
      {
        ...A,
        charRuns: [...A.charRuns, ...B.charRuns],
        formats: [...A.formats, ...B.formats],
      },
      // B intentionally omitted
    ],
  };
  console.log("OLD merge result:", describeVisible(buggyLocal));

  // Capture inverses against the true pre-state.
  const inverses = invertOperations([blockDelOp], initial, applyOp, binding);
  const stamped = refreshOps(inverses, binding);
  const afterUndo = applyOps(buggyLocal, stamped);
  console.log("OLD after undo:  ", describeVisible(afterUndo), "  <-- BUG");
}

// =============================================================================
// New (fixed) path: text_insert + block_delete via applyOps.
// =============================================================================
{
  let pageAcc = initial;
  const mergeOps: Operation[] = [];

  const A = pageAcc.blocks.find((b) => b.id === aId)!;
  const B = pageAcc.blocks.find((b) => b.id === bId)!;
  if (!isTextualBlock(A) || !isTextualBlock(B)) throw new Error("not textual");

  const bText = [...iterateVisibleChars(B.charRuns)]
    .map((c) => c.char)
    .join("");
  const aLen = getVisibleLengthFromRuns(A.charRuns);
  const { newPage, op: insertOp } = insertCharsAtPosition(
    pageAcc,
    aId,
    aLen,
    bText,
    binding,
  );
  pageAcc = newPage;
  mergeOps.push(insertOp);

  const blockDelOp: Operation = {
    op: "block_delete",
    id: binding.nextId(),
    clock: binding.getClock(),
    pageId,
    blockId: bId,
  };
  mergeOps.push(blockDelOp);
  pageAcc = applyOps(pageAcc, [blockDelOp]);
  console.log("NEW merge result:", describeVisible(pageAcc));

  const inverses = invertOperations(mergeOps, initial, applyOp, binding);
  const stamped = refreshOps(inverses, binding);
  const afterUndo = applyOps(pageAcc, stamped);
  console.log(
    "NEW after undo:  ",
    describeVisible(afterUndo),
    '  <-- expected: "hello"  "world"',
  );
}
