/**
 * Snapshot Diff and Restore Utilities
 *
 * Functions for comparing current page state with a snapshot and generating
 * operations to restore the page to a specific snapshot state.
 */

import type { Block, CharRun, MarkSpan } from "../serlization/loadPage";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  ContentEdit,
  HLC,
  MarkSet,
  Operation,
  TextInsert,
} from "../state-types";
import {
  getBlockDescriptor,
  getBlockFieldNames,
  isTextualBlock,
  readBlockStyle,
  styleField,
} from "./block-registry";
import { getVisibleTextFromRuns, iterateVisibleChars } from "./char-runs";
import { generateKeyBetween } from "./fractional-index";
import type { DataSchema } from "./schema";
import { canonicalizeStructuredDocument } from "./structured-content";
import type { IdentityAllocator } from "@shared/identity";

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

function hasTextStorage(
  block: Block,
  schema?: DataSchema,
): block is Block & { charRuns: CharRun[]; formats: MarkSpan[] } {
  return (
    (schema ? schema.isTextual(block.type) : isTextualBlock(block)) &&
    "charRuns" in block &&
    Array.isArray(block.charRuns) &&
    "formats" in block &&
    Array.isArray(block.formats)
  );
}

function fieldNames(schema: DataSchema | undefined, type: string) {
  return schema?.getFieldNames(type) ?? getBlockFieldNames(type);
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
  schema?: DataSchema,
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
      const changes = diffBlocks(currentBlock, snapshotBlock, schema);
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
function diffBlocks(
  current: Block,
  snapshot: Block,
  schema?: DataSchema,
): BlockChanges | null {
  const changes: BlockChanges = {};
  let hasChanges = false;

  if (current.type !== snapshot.type) {
    changes.typeChanged = { from: snapshot.type, to: current.type };
    hasChanges = true;
  }

  if (hasTextStorage(current, schema) && hasTextStorage(snapshot, schema)) {
    const currentText = getVisibleTextFromRuns(current.charRuns);
    const snapshotText = getVisibleTextFromRuns(snapshot.charRuns);

    if (currentText !== snapshotText) {
      changes.textChanged = { from: snapshotText, to: currentText };
      hasChanges = true;
    }
  }

  const propsChanged: Array<{ field: string; from: unknown; to: unknown }> = [];

  if (current.type === snapshot.type) {
    for (const fieldName of fieldNames(schema, current.type)) {
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

    // Per-block style is an open bag (not a descriptor field), so diff it by key.
    const curStyle = readBlockStyle(current);
    const snapStyle = readBlockStyle(snapshot);
    for (const key of new Set([
      ...Object.keys(curStyle),
      ...Object.keys(snapStyle),
    ])) {
      if (curStyle[key] !== snapStyle[key]) {
        propsChanged.push({
          field: styleField(key),
          from: snapStyle[key],
          to: curStyle[key],
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
export interface OpsContext extends IdentityAllocator {
  /** Page ID for operations */
  pageId: string;
  /** Peer ID for char runs */
  peerId: string;
  /** Function to get current HLC */
  getClock: () => HLC;
  /** Schema that owns block defaults/fields. Defaults to the base schema. */
  schema?: DataSchema;
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
  const schema = ctx.schema;

  // Running fractional-index key — each block chains after the previous one,
  // so the emitted sequence preserves the input order.
  let prevOrderKey: string | null = null;
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

    const orderKey = generateKeyBetween(prevOrderKey, null);

    // The existing init block was persisted as heading1. Morph its type when
    // needed; otherwise emit a fresh block_insert. Either way, set its order
    // key so the reused init block sits at the head of the restored sequence.
    if (!useExisting) {
      const insertOp: BlockInsert = {
        op: "block_insert",
        id: nextId(),
        clock: getClock(),
        pageId,
        orderKey,
        blockId: newBlockId,
        blockType: block.type,
      };
      ops.push(insertOp);
    } else {
      if (block.type !== "heading1") {
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
      ops.push({
        op: "block_set",
        id: nextId(),
        clock: getClock(),
        pageId,
        blockId: newBlockId,
        field: "orderKey",
        value: orderKey,
      } as BlockSet);
    }

    // Clone each attachment exactly once before rewriting any covering marks.
    // The resulting source→target map is the only cross-facet contract: core
    // knows neither which mark attr holds a reference nor how a document kind
    // rekeys its own root/internal identities.
    const clonedContentIds: Record<string, string> = {};
    const clonedStructuredContent: Array<{
      readonly contentId: string;
      readonly document: ReturnType<typeof canonicalizeStructuredDocument>;
    }> = [];
    const targetContentIds = new Set<string>();
    for (const contentId of Object.keys(block.structuredContent ?? {}).sort()) {
      const sourceDocument = canonicalizeStructuredDocument(
        block.structuredContent![contentId],
      );
      const cloned =
        newBlockId !== block.id
          ? schema?.cloneStructuredContent({
              document: sourceDocument,
              sourceBlockId: block.id,
              targetBlockId: newBlockId,
              sourceContentId: contentId,
              identities: { nextId },
            })
          : undefined;
      const targetContentId = cloned?.contentId ?? contentId;
      const targetDocument = canonicalizeStructuredDocument(
        cloned?.document ?? sourceDocument,
      );
      if (targetDocument.rootId !== targetContentId) {
        throw new Error(
          `Structured clone for "${contentId}" returned a mismatched root id`,
        );
      }
      if (targetContentIds.has(targetContentId)) {
        throw new Error(
          `Structured clone returned duplicate content id "${targetContentId}"`,
        );
      }
      targetContentIds.add(targetContentId);
      clonedContentIds[contentId] = targetContentId;
      clonedStructuredContent.push({
        contentId: targetContentId,
        document: targetDocument,
      });
    }

    if (hasTextStorage(block, schema)) {
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

      const newFormats: MarkSpan[] = block.formats
        .map((f) => {
          const newStartId = oldToNewCharIdMap.get(f.startCharId);
          const newEndId = oldToNewCharIdMap.get(f.endCharId);
          if (newStartId && newEndId) {
            const clonedMark =
              newBlockId !== block.id
                ? schema?.cloneStructuredMark(f.format.type, {
                    mark: f.format,
                    sourceBlockId: block.id,
                    targetBlockId: newBlockId,
                    attachments: block.structuredContent,
                    clonedContentIds,
                  })
                : undefined;
            if (clonedMark && clonedMark.type !== f.format.type) {
              throw new Error(
                `Structured mark clone for "${f.format.type}" returned type "${clonedMark.type}"`,
              );
            }
            return {
              ...f,
              startCharId: newStartId,
              endCharId: newEndId,
              format: clonedMark ?? f.format,
              clock: getClock(),
            };
          }
          return null;
        })
        .filter((f): f is MarkSpan => f !== null);

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
          const formatOp: MarkSet = {
            op: "mark_set",
            id: nextId(),
            clock: getClock(),
            pageId,
            blockId: newBlockId,
            charIds,
            format: format.format,
            value: true,
          };
          ops.push(formatOp);
        }
      }
    }

    // Registered fields are diffed against this schema's defaults. An unknown
    // block still degrades safely to its block_insert, preserving the existing
    // forward-compatible behavior for peers missing an extension.
    const descriptor =
      schema?.getDescriptor(block.type) ?? getBlockDescriptor(block.type);
    const defaultBlock = descriptor?.defaults(newBlockId, orderKey);
    if (defaultBlock) {
      for (const fieldName of fieldNames(schema, block.type)) {
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
    }

    // Per-block style is type-agnostic (it rides on every block, custom or
    // built-in), so fan it out independently of the descriptor-field loop above
    // — one `style.<key>` op per overridden property. `null` is a cleared
    // override and carries nothing to restore.
    for (const [key, value] of Object.entries(readBlockStyle(block))) {
      if (value === null) continue;
      ops.push({
        op: "block_set",
        id: nextId(),
        clock: getClock(),
        pageId,
        blockId: newBlockId,
        field: styleField(key),
        value,
      } as BlockSet);
    }

    for (const attachment of clonedStructuredContent) {
      ops.push({
        op: "content_edit",
        id: nextId(),
        clock: getClock(),
        pageId,
        blockId: newBlockId,
        contentId: attachment.contentId,
        edit: {
          kind: "document_init",
          document: attachment.document,
        },
      } as ContentEdit);
    }

    prevOrderKey = orderKey;
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
  schema?: DataSchema,
): boolean {
  const diff = diffPageWithSnapshot(currentBlocks, snapshotBlocks, schema);
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
