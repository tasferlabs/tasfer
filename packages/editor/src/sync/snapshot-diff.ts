/**
 * Snapshot Diff and Restore Utilities
 *
 * Functions for comparing current page state with a snapshot and generating
 * operations to restore the page to a specific snapshot state.
 */

import { getBlockDescriptor, getBlockFieldNames } from "./block-registry";
import { getVisibleTextFromRuns, iterateVisibleChars } from "./char-runs";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  FormatSet,
  HLC,
  Operation,
  TextInsert,
} from "./types";
import type { Block, CharRun, FormatSpan } from "@/deserializer/loadPage";
import { isTextualBlock } from "@/deserializer/loadPage";

// =============================================================================
// Types
// =============================================================================

export interface BlockDiff {
  type: "added" | "removed" | "modified" | "unchanged";
  blockId: string;
  /** Block in current state (undefined if removed) */
  current?: Block;
  /** Block in snapshot (undefined if added) */
  snapshot?: Block;
  /** Details of modifications */
  changes?: BlockChanges;
}

export interface BlockChanges {
  typeChanged?: { from: string; to: string };
  textChanged?: { from: string; to: string };
  propsChanged?: Array<{ field: string; from: unknown; to: unknown }>;
}

export interface PageDiff {
  /** All block differences */
  blocks: BlockDiff[];
  /** Summary statistics */
  stats: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
  };
}

// =============================================================================
// Diffing Functions
// =============================================================================

/**
 * Compare current page state with a snapshot.
 * Returns detailed information about what has changed.
 */
export function diffPageWithSnapshot(
  currentBlocks: Block[],
  snapshotBlocks: Block[],
): PageDiff {
  const currentMap = new Map<string, Block>();
  const snapshotMap = new Map<string, Block>();

  // Build maps for O(1) lookup
  for (const block of currentBlocks) {
    if (!block.deleted) {
      currentMap.set(block.id, block);
    }
  }
  for (const block of snapshotBlocks) {
    if (!block.deleted) {
      snapshotMap.set(block.id, block);
    }
  }

  const blockDiffs: BlockDiff[] = [];
  const processedIds = new Set<string>();

  // Check blocks in current state
  for (const [id, currentBlock] of currentMap) {
    processedIds.add(id);
    const snapshotBlock = snapshotMap.get(id);

    if (!snapshotBlock) {
      // Block was added (exists in current but not in snapshot)
      blockDiffs.push({
        type: "added",
        blockId: id,
        current: currentBlock,
      });
    } else {
      // Block exists in both - check for modifications
      const changes = diffBlocks(currentBlock, snapshotBlock);
      if (changes) {
        blockDiffs.push({
          type: "modified",
          blockId: id,
          current: currentBlock,
          snapshot: snapshotBlock,
          changes,
        });
      } else {
        blockDiffs.push({
          type: "unchanged",
          blockId: id,
          current: currentBlock,
          snapshot: snapshotBlock,
        });
      }
    }
  }

  // Check blocks in snapshot that aren't in current (removed blocks)
  for (const [id, snapshotBlock] of snapshotMap) {
    if (!processedIds.has(id)) {
      blockDiffs.push({
        type: "removed",
        blockId: id,
        snapshot: snapshotBlock,
      });
    }
  }

  // Calculate stats
  const stats = {
    added: blockDiffs.filter((d) => d.type === "added").length,
    removed: blockDiffs.filter((d) => d.type === "removed").length,
    modified: blockDiffs.filter((d) => d.type === "modified").length,
    unchanged: blockDiffs.filter((d) => d.type === "unchanged").length,
  };

  return { blocks: blockDiffs, stats };
}

/**
 * Compare two blocks and return changes if any.
 */
function diffBlocks(current: Block, snapshot: Block): BlockChanges | null {
  const changes: BlockChanges = {};
  let hasChanges = false;

  if (current.type !== snapshot.type) {
    changes.typeChanged = { from: snapshot.type, to: current.type };
    hasChanges = true;
  }

  if (isTextualBlock(current) && isTextualBlock(snapshot)) {
    const currentText = getVisibleTextFromRuns(current.charRuns);
    const snapshotText = getVisibleTextFromRuns(snapshot.charRuns);

    if (currentText !== snapshotText) {
      changes.textChanged = { from: snapshotText, to: currentText };
      hasChanges = true;
    }
  }

  const propsChanged: Array<{ field: string; from: unknown; to: unknown }> = [];

  if (current.type === snapshot.type) {
    for (const fieldName of getBlockFieldNames(current.type)) {
      if (fieldName === "type") continue;
      const currentVal = (current as unknown as Record<string, unknown>)[
        fieldName
      ];
      const snapshotVal = (snapshot as unknown as Record<string, unknown>)[
        fieldName
      ];
      if (currentVal !== snapshotVal) {
        propsChanged.push({
          field: fieldName,
          from: snapshotVal,
          to: currentVal,
        });
      }
    }
  }

  if (propsChanged.length > 0) {
    changes.propsChanged = propsChanged;
    hasChanges = true;
  }

  return hasChanges ? changes : null;
}

// =============================================================================
// Restore Operations Generator
// =============================================================================

/**
 * Context needed to generate operations from blocks.
 */
export interface OpsContext {
  /** Page ID for operations */
  pageId: string;
  /** Peer ID for char runs */
  peerId: string;
  /** Function to generate unique IDs */
  nextId: () => string;
  /** Function to get current HLC */
  getClock: () => HLC;
  /**
   * When set, the first non-deleted block reuses this block ID and its
   * block_insert op is skipped (the block already exists in the DB).
   * Used when writing draft content into a newly-created page whose init
   * block was already persisted by createPage().
   */
  existingFirstBlockId?: string;
}

/**
 * Convert blocks into CRDT insert operations.
 * Used by both import (writeBlocks) and snapshot restore flows.
 */
export function blocksToOps(blocks: Block[], ctx: OpsContext): Operation[] {
  const ops: Operation[] = [];
  const { pageId, peerId, nextId, getClock } = ctx;

  let lastInsertedBlockId: string | null = null;
  let isFirstBlock = true;

  for (const block of blocks) {
    if (block.deleted) continue;

    // For the first block, reuse the existing init block ID if provided so we
    // don't duplicate the block_insert that createPage() already persisted.
    const useExisting = isFirstBlock && !!ctx.existingFirstBlockId;
    const newBlockId = useExisting
      ? ctx.existingFirstBlockId!
      : `b-${nextId()}`;
    isFirstBlock = false;

    // The existing init block was persisted as heading1. Morph its type when
    // needed; otherwise emit a fresh block_insert.
    if (!useExisting) {
      const insertOp: BlockInsert = {
        op: "block_insert",
        id: nextId(),
        clock: getClock(),
        pageId,
        afterBlockId: lastInsertedBlockId,
        blockId: newBlockId,
        blockType: block.type,
      };
      ops.push(insertOp);
    } else if (block.type !== "heading1") {
      ops.push({
        op: "block_set",
        id: nextId(),
        clock: getClock(),
        pageId,
        blockId: newBlockId,
        field: "type",
        value: block.type,
      } as BlockSet);
    }

    if (isTextualBlock(block)) {
      const visibleOldChars: Array<{ id: string; char: string }> = [];
      for (const { id, char } of iterateVisibleChars(block.charRuns)) {
        visibleOldChars.push({ id, char });
      }

      const newCharIds: string[] = [];
      const oldToNewCharIdMap = new Map<string, string>();

      for (let i = 0; i < visibleOldChars.length; i++) {
        const newId = nextId();
        newCharIds.push(newId);
        oldToNewCharIdMap.set(visibleOldChars[i].id, newId);
      }

      const newFormats: FormatSpan[] = block.formats
        .map((f) => {
          const newStartId = oldToNewCharIdMap.get(f.startCharId);
          const newEndId = oldToNewCharIdMap.get(f.endCharId);
          if (newStartId && newEndId) {
            return {
              ...f,
              startCharId: newStartId,
              endCharId: newEndId,
              clock: getClock(),
            };
          }
          return null;
        })
        .filter((f): f is FormatSpan => f !== null);

      if (visibleOldChars.length > 0) {
        const text = visibleOldChars.map((c) => c.char).join("");
        const firstCharId = newCharIds[0];
        const startCounter = parseInt(firstCharId.split(":")[1], 10);

        const charRun: CharRun = {
          peerId,
          startCounter,
          text,
        };

        const textInsertOp: TextInsert = {
          op: "text_insert",
          id: nextId(),
          clock: getClock(),
          pageId,
          blockId: newBlockId,
          afterCharId: null,
          charRuns: [charRun],
        };
        ops.push(textInsertOp);
      }

      for (const format of newFormats) {
        const startIdx = newCharIds.findIndex(
          (id) => id === format.startCharId,
        );
        const endIdx = newCharIds.findIndex((id) => id === format.endCharId);
        if (startIdx !== -1 && endIdx !== -1) {
          const charIds = newCharIds.slice(startIdx, endIdx + 1);
          const formatOp: FormatSet = {
            op: "format_set",
            id: nextId(),
            clock: getClock(),
            pageId,
            blockId: newBlockId,
            charIds,
            format: format.format,
            value:
              format.format.type === "link" ? format.format.url || true : true,
          };
          ops.push(formatOp);
        }
      }
    }

    const descriptor = getBlockDescriptor(block.type);
    const defaultBlock = descriptor.defaults(newBlockId, lastInsertedBlockId);
    for (const fieldName of getBlockFieldNames(block.type)) {
      if (fieldName === "type") continue;
      const currentVal = (block as unknown as Record<string, unknown>)[
        fieldName
      ];
      const defaultVal = (defaultBlock as unknown as Record<string, unknown>)[
        fieldName
      ];
      if (currentVal === defaultVal) continue;
      ops.push({
        op: "block_set",
        id: nextId(),
        clock: getClock(),
        pageId,
        blockId: newBlockId,
        field: fieldName,
        value: currentVal,
      } as BlockSet);
    }

    lastInsertedBlockId = newBlockId;
  }

  return ops;
}

/**
 * Context needed to generate restore operations.
 */
export interface RestoreContext extends OpsContext {
  /** Current visible blocks */
  currentBlocks: readonly Block[];
  /** Blocks to restore to */
  newBlocks: Block[];
}

/**
 * Generate operations to restore from snapshot.
 * Deletes all current blocks and inserts all new blocks with their content.
 */
export function generateRestoreOperations(ctx: RestoreContext): Operation[] {
  const ops: Operation[] = [];
  const { currentBlocks, newBlocks, nextId, getClock, pageId } = ctx;

  // Step 1: Delete all current visible blocks
  for (const block of currentBlocks) {
    if (block.deleted) continue;
    const deleteOp: BlockDelete = {
      op: "block_delete",
      id: nextId(),
      clock: getClock(),
      pageId,
      blockId: block.id,
    };
    ops.push(deleteOp);
  }

  // Step 2: Insert all new blocks
  ops.push(...blocksToOps(newBlocks, ctx));

  return ops;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if two pages are identical (no differences).
 */
export function arePagesEqual(
  currentBlocks: Block[],
  snapshotBlocks: Block[],
): boolean {
  const diff = diffPageWithSnapshot(currentBlocks, snapshotBlocks);
  return (
    diff.stats.added === 0 &&
    diff.stats.removed === 0 &&
    diff.stats.modified === 0
  );
}

/**
 * Get a human-readable summary of differences.
 */
export function getDiffSummary(diff: PageDiff): string {
  const parts: string[] = [];

  if (diff.stats.added > 0) {
    parts.push(`${diff.stats.added} block(s) added`);
  }
  if (diff.stats.removed > 0) {
    parts.push(`${diff.stats.removed} block(s) removed`);
  }
  if (diff.stats.modified > 0) {
    parts.push(`${diff.stats.modified} block(s) modified`);
  }

  if (parts.length === 0) {
    return "No changes";
  }

  return parts.join(", ");
}

/**
 * Get detailed change description for a single block diff.
 */
export function getBlockDiffDescription(blockDiff: BlockDiff): string {
  switch (blockDiff.type) {
    case "added":
      return `Added ${blockDiff.current?.type || "block"}`;
    case "removed":
      return `Removed ${blockDiff.snapshot?.type || "block"}`;
    case "modified": {
      const changes: string[] = [];
      if (blockDiff.changes?.typeChanged) {
        changes.push(
          `type: ${blockDiff.changes.typeChanged.from} → ${blockDiff.changes.typeChanged.to}`,
        );
      }
      if (blockDiff.changes?.textChanged) {
        changes.push("text content changed");
      }
      if (blockDiff.changes?.propsChanged) {
        for (const prop of blockDiff.changes.propsChanged) {
          changes.push(
            `${prop.field}: ${String(prop.from)} → ${String(prop.to)}`,
          );
        }
      }
      return `Modified: ${changes.join(", ")}`;
    }
    case "unchanged":
      return "No changes";
    default:
      return "Unknown";
  }
}
