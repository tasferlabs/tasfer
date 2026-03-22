/**
 * Snapshot → Operations
 *
 * Converts a Block[] snapshot into CRDT operations so the content can be
 * replicated via the P2P sync protocol. This is needed because snapshots
 * created by the old server-based model have no corresponding operations
 * in the ops table.
 *
 * The generated ops, when applied to an empty page, reproduce the exact
 * snapshot state (including tombstoned characters and format spans).
 */

import type { Block, CharRun } from "@/deserializer/loadPage";
import { isTextualBlock } from "@/deserializer/loadPage";
import type {
  Operation,
  BlockInsert,
  TextInsert,
  TextDelete,
  FormatSet,
  BlockDelete,
  BlockType,
  BlockProps,
} from "./types";
import { getCharIdFromRun, isCharDeleted } from "./char-runs";

/** Synthetic peerId for structural ops (block_insert, block_delete, etc.) */
const SNAP_PEER = "__snap__";

/**
 * Convert a Block[] snapshot into CRDT operations.
 *
 * Generates:
 *  - block_insert for each block (with initialProps)
 *  - block_delete for deleted blocks
 *  - text_insert for each charRun (including tombstoned chars)
 *  - text_delete for chars with deletedMask bits set
 *  - format_set for each format span
 */
export function snapshotToOps(pageId: string, blocks: Block[]): Operation[] {
  const ops: Operation[] = [];
  let snapCounter = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const prevBlock = i > 0 ? blocks[i - 1] : null;

    // --- block_insert ---
    const initialProps = extractBlockProps(block);
    const blockInsert: BlockInsert = {
      op: "block_insert",
      id: `${SNAP_PEER}:${snapCounter}`,
      clock: { counter: snapCounter, peerId: SNAP_PEER },
      pageId,
      afterBlockId: prevBlock?.id ?? null,
      blockId: block.id,
      blockType: block.type as BlockType,
      ...(initialProps ? { initialProps } : {}),
    };
    ops.push(blockInsert);
    snapCounter++;

    // --- block_delete for tombstoned blocks ---
    if (block.deleted) {
      const blockDelete: BlockDelete = {
        op: "block_delete",
        id: `${SNAP_PEER}:${snapCounter}`,
        clock: { counter: snapCounter, peerId: SNAP_PEER },
        pageId,
        blockId: block.id,
      };
      ops.push(blockDelete);
      snapCounter++;
    }

    // --- text_insert for charRuns ---
    if (isTextualBlock(block) && block.charRuns && block.charRuns.length > 0) {
      let lastCharId: string | null = null;

      for (const run of block.charRuns) {
        if (run.text.length === 0) continue;

        // Use the max char counter in this run as the op's clock counter.
        // This ensures the VV correctly reflects the chars we have.
        const maxCounter = run.startCounter + run.text.length - 1;

        const textInsert: TextInsert = {
          op: "text_insert",
          id: `${run.peerId}:${maxCounter}`,
          clock: { counter: maxCounter, peerId: run.peerId },
          pageId,
          blockId: block.id,
          afterCharId: lastCharId,
          // Send the run WITHOUT deletedMask — inserts create live chars.
          // Deletions are handled by separate text_delete ops below.
          charRuns: [
            { peerId: run.peerId, startCounter: run.startCounter, text: run.text },
          ],
        };
        ops.push(textInsert);

        // Track the last char for the next run's afterCharId
        lastCharId = getCharIdFromRun(run, run.text.length - 1);

        // --- text_delete for tombstoned chars in this run ---
        if (run.deletedMask) {
          const deletedCharIds = collectDeletedCharIds(run);
          if (deletedCharIds.length > 0) {
            const textDelete: TextDelete = {
              op: "text_delete",
              id: `${SNAP_PEER}:${snapCounter}`,
              clock: { counter: snapCounter, peerId: SNAP_PEER },
              pageId,
              blockId: block.id,
              charIds: deletedCharIds,
            };
            ops.push(textDelete);
            snapCounter++;
          }
        }
      }
    }

    // --- format_set for format spans ---
    if (isTextualBlock(block) && block.formats && block.formats.length > 0) {
      for (const span of block.formats) {
        const charIds = getCharIdsBetweenSpan(
          block.charRuns,
          span.startCharId,
          span.endCharId,
        );
        if (charIds.length === 0) continue;

        // Use the span's own clock if available, otherwise use synthetic
        const clock = span.clock || { counter: snapCounter, peerId: SNAP_PEER };
        const opId =
          span.clock
            ? `${span.clock.peerId}:${span.clock.counter}`
            : `${SNAP_PEER}:${snapCounter}`;

        const formatSet: FormatSet = {
          op: "format_set",
          id: opId,
          clock,
          pageId,
          blockId: block.id,
          charIds,
          format: span.format,
          value: span.format.type === "link" ? (span.format.url || true) : true,
        };
        ops.push(formatSet);

        // Only increment snapCounter if we used the synthetic peerId
        if (!span.clock) {
          snapCounter++;
        }
      }
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract block-specific properties as BlockProps for initialProps. */
function extractBlockProps(block: Block): BlockProps | undefined {
  switch (block.type) {
    case "bullet_list":
    case "numbered_list":
      return { indent: block.indent ?? 0 };
    case "todo_list":
      return { indent: block.indent ?? 0, checked: block.checked ?? false };
    case "image":
      return {
        url: block.url,
        alt: block.alt,
        width: block.width,
        height: block.height,
        objectFit: block.objectFit,
      };
    default:
      return undefined;
  }
}

/** Collect char IDs for all deleted chars in a run. */
function collectDeletedCharIds(run: CharRun): string[] {
  const ids: string[] = [];
  for (let i = 0; i < run.text.length; i++) {
    if (isCharDeleted(run, i)) {
      ids.push(getCharIdFromRun(run, i));
    }
  }
  return ids;
}

/**
 * Get all char IDs between startCharId and endCharId (inclusive)
 * in the order they appear in charRuns.
 */
function getCharIdsBetweenSpan(
  charRuns: CharRun[] | undefined,
  startCharId: string,
  endCharId: string,
): string[] {
  if (!charRuns) return [];

  const ids: string[] = [];
  let collecting = false;

  for (const run of charRuns) {
    for (let i = 0; i < run.text.length; i++) {
      const charId = getCharIdFromRun(run, i);

      if (charId === startCharId) {
        collecting = true;
      }

      if (collecting) {
        ids.push(charId);
      }

      if (charId === endCharId) {
        return ids;
      }
    }
  }

  return ids;
}
