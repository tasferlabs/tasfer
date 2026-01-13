/**
 * CRDT Sync Engine
 *
 * Public API for the operation-log CRDT system.
 * Provides methods for emitting operations, applying remote operations,
 * and subscribing to state changes.
 */

import type { Char, Page, TextFormat } from "@/deserializer/loadPage";
import { COMPACTION_GRACE_PERIOD_MS } from "../constants";
import { createHLC, receiveHLC, tickHLC } from "./hlc";
import { createIdGenerator, generateBlockId, generatePeerId } from "./id";
import { appendOp, createOpLog, getOpsSince, mergeOps } from "./oplog";
import { findCharIdAtPosition, getCharIdsInRange } from "./reducer";
import type {
  BlockDelete,
  BlockInsert,
  BlockProps,
  BlockSet,
  BlockType,
  FormatSet,
  HLC,
  Operation,
  OpLog,
  TextDelete,
  TextInsert,
  VersionVector,
} from "./types";

// ==========================================================================
// Global CRDT Context Functions
// ==========================================================================

/**
 * Global state for CRDT context.
 * These are initialized per-page and used throughout the editor.
 */
let globalPageId: string | null = null;
let globalIdGen: (() => string) | null = null;
let globalHLC: HLC | null = null;

/**
 * Initialize the global CRDT context.
 * Call this when creating/loading a page to set up the global functions.
 *
 * @param pageId - The page ID
 * @param peerId - Optional peer ID (generated if not provided)
 */
export function setCRDTContext(pageId: string, peerId?: string): void {
  const actualPeerId = peerId ?? generatePeerId();
  globalPageId = pageId;
  globalIdGen = createIdGenerator(actualPeerId);
  globalHLC = createHLC(actualPeerId);
}

/**
 * Get the current page ID.
 * @throws Error if context is not initialized
 */
export function getPageId(): string {
  if (globalPageId === null) {
    throw new Error("CRDT context not initialized. Call setCRDTContext() first.");
  }
  return globalPageId;
}

/**
 * Generate the next unique ID.
 * @throws Error if context is not initialized
 */
export function nextId(): string {
  if (globalIdGen === null) {
    throw new Error("CRDT context not initialized. Call setCRDTContext() first.");
  }
  return globalIdGen();
}

/**
 * Get the current clock and tick it forward.
 * Returns a new HLC that is guaranteed to be greater than the current one.
 * @throws Error if context is not initialized
 */
export function getClock(): HLC {
  if (globalHLC === null) {
    throw new Error("CRDT context not initialized. Call setCRDTContext() first.");
  }
  globalHLC = tickHLC(globalHLC);
  return { ...globalHLC };
}

/**
 * Get the current peer ID from the HLC.
 * @throws Error if context is not initialized
 */
export function getPeerId(): string {
  if (globalHLC === null) {
    throw new Error("CRDT context not initialized. Call setCRDTContext() first.");
  }
  return globalHLC.peerId;
}

// Re-export types for consumers
export type {
  BlockDelete,
  BlockInsert,
  BlockProps,
  BlockSet,
  BlockType,
  FormatSet,
  HLC,
  Operation,
  TextDelete,
  TextInsert,
  VersionVector,
} from "./types";

// Re-export utilities
export { compareHLC, deserializeHLC, serializeHLC } from "./hlc";
export { deserializeVV, serializeVV } from "./oplog";
export {
  cleanSnapshotForSave,
  findCharIdAtPosition,
  getCharIdsInRange,
  getVisibleBlocks,
  getVisibleText,
} from "./reducer";

// Re-export awareness
export {
  AwarenessManager,
  createAwarenessManager,
  getColorForPeer,
  positionToAwarenessCursor,
  selectionToAwarenessSelection,
  awarenessCursorToPosition,
  awarenessSelectionToSelection,
} from "./awareness";
export type {
  AwarenessConfig,
  AwarenessCursor,
  AwarenessSelection,
  AwarenessState,
  AwarenessUser,
  LocalAwarenessState,
} from "./awareness";

type StateChangeListener = (state: Page) => void;

/**
 * SyncEngine manages the CRDT state for a single page.
 *
 * @example
 * const engine = new SyncEngine("page-123");
 *
 * // Subscribe to state changes
 * engine.onStateChange((state) => {
 *   render(state);
 * });
 *
 * // Emit local operations
 * const blockInsert = engine.createBlockInsert(null, "paragraph");
 * const textInsert = engine.createTextInsert(blockInsert.blockId, null, [
 *   { id: engine.nextId(), char: "H" },
 *   { id: engine.nextId(), char: "i" },
 * ]);
 * engine.emit([blockInsert, textInsert]);
 *
 * // Apply remote operations
 * engine.apply(remoteOps);
 */
export class SyncEngine {
  private opLog: OpLog;
  private hlc: ReturnType<typeof createHLC>;
  private peerId: string;
  private idGen: () => string;
  private listeners: Set<StateChangeListener> = new Set();

  /**
   * Create a new SyncEngine for a page.
   *
   * @param pageId - Unique identifier for the page
   * @param peerId - Optional peer ID (generated if not provided)
   */
  constructor(pageId: string, peerId?: string) {
    this.peerId = peerId ?? generatePeerId();
    this.hlc = createHLC(this.peerId);
    this.idGen = createIdGenerator(this.peerId);
    this.opLog = createOpLog(pageId);
  }

  /**
   * Get the peer ID for this engine.
   */
  getPeerId(): string {
    return this.peerId;
  }

  /**
   * Get the page ID.
   */
  getPageId(): string {
    return this.opLog.pageId;
  }

  /**
   * Generate the next unique ID.
   */
  nextId(): string {
    return this.idGen();
  }

  /**
   * Load saved operations into the engine.
   * This initializes the opLog and version vector from persisted state.
   * Use this when loading a page that was previously edited.
   *
   * @param ops - Previously saved operations to load
   */
  loadOperations(ops: Operation[]): void {
    for (const op of ops) {
      this.opLog = appendOp(this.opLog, op);
      // Update HLC to be at least as recent as loaded operations
      this.hlc = receiveHLC(this.hlc, op.clock);
    }
  }

  /**
   * Emit local operations.
   * Operations are added to the log. Listeners are NOT notified because
   * local operations are applied directly to EditorState for immediate feedback.
   * Use apply() for remote operations which need to update the UI.
   *
   * @param ops - Operations to emit
   */
  emit(ops: Operation[]): void {
    for (const op of ops) {
      this.opLog = appendOp(this.opLog, op);
    }
    // Don't notify listeners for local ops - EditorState is already updated
  }

  /**
   * Apply remote operations.
   * Operations are merged into the log and listeners are notified.
   *
   * @param ops - Remote operations to apply
   */
  apply(ops: Operation[]): void {
    // Update local HLC based on received operations
    for (const op of ops) {
      this.hlc = receiveHLC(this.hlc, op.clock);
    }

    this.opLog = mergeOps(this.opLog, ops);
    this.notifyListeners();
  }

  /**
   * Get the current computed state.
   */
  getState(): Page {
    return this.opLog.state;
  }

  /**
   * Get all operations in the log.
   */
  getOperations(): Operation[] {
    return this.opLog.operations;
  }

  /**
   * Get operations that a peer is missing.
   *
   * @param peerVV - Peer's version vector
   * @returns Operations the peer needs
   */
  getOpsSince(peerVV: VersionVector): Operation[] {
    return getOpsSince(this.opLog, peerVV);
  }

  /**
   * Get operations after a specific HLC clock.
   * Used for delta sync - only send operations not yet in the snapshot.
   *
   * @param clock - HLC clock to compare against (null returns all operations)
   * @returns Operations with clock greater than the given clock
   */
  getOperationsAfterClock(clock: HLC | null): Operation[] {
    if (!clock) {
      return this.opLog.operations;
    }

    return this.opLog.operations.filter((op) => {
      // Operation is after clock if:
      // 1. wall > clock.wall, OR
      // 2. wall == clock.wall AND logical > clock.logical, OR
      // 3. wall == clock.wall AND logical == clock.logical AND peerId > clock.peerId
      return (
        op.clock.wall > clock.wall ||
        (op.clock.wall === clock.wall && op.clock.logical > clock.logical) ||
        (op.clock.wall === clock.wall &&
          op.clock.logical === clock.logical &&
          op.clock.peerId > clock.peerId)
      );
    });
  }

  /**
   * Get the latest HLC clock from operations.
   * Used to update snapshotClock after saving.
   *
   * @returns The latest HLC clock or null if no operations
   */
  getLatestClock(): HLC | null {
    if (this.opLog.operations.length === 0) {
      return null;
    }

    let latest = this.opLog.operations[0].clock;
    for (const op of this.opLog.operations) {
      if (
        op.clock.wall > latest.wall ||
        (op.clock.wall === latest.wall && op.clock.logical > latest.logical) ||
        (op.clock.wall === latest.wall &&
          op.clock.logical === latest.logical &&
          op.clock.peerId > latest.peerId)
      ) {
        latest = op.clock;
      }
    }
    return { ...latest };
  }

  /**
   * Compact the operation log by removing operations that are already saved.
   * Call this after successfully saving to the server to free memory.
   *
   * Operations are only removed if:
   * 1. They are <= snapshotClock (already saved in snapshot)
   * 2. They are older than COMPACTION_GRACE_PERIOD_MS
   *
   * The grace period prevents a race condition where a late-joining peer
   * loads an older snapshot from the server but can't get recent ops from
   * existing peers because they've already been compacted.
   * See docs/crdt-compaction.md for detailed explanation.
   *
   * @param snapshotClock - Clock of the saved snapshot. Operations <= this clock may be removed.
   * @returns Number of operations removed
   */
  compactOperations(snapshotClock: HLC): number {
    const beforeCount = this.opLog.operations.length;
    const now = Date.now();

    // Keep operations that are either:
    // 1. After the snapshot clock (not yet saved)
    // 2. Within the grace period (might be needed by late-joining peers)
    this.opLog.operations = this.opLog.operations.filter((op) => {
      // Keep ops within grace period regardless of clock
      if (now - op.clock.wall < COMPACTION_GRACE_PERIOD_MS) {
        return true;
      }

      // Keep ops after snapshot clock
      return (
        op.clock.wall > snapshotClock.wall ||
        (op.clock.wall === snapshotClock.wall &&
          op.clock.logical > snapshotClock.logical) ||
        (op.clock.wall === snapshotClock.wall &&
          op.clock.logical === snapshotClock.logical &&
          op.clock.peerId > snapshotClock.peerId)
      );
    });

    const removed = beforeCount - this.opLog.operations.length;
    if (removed > 0) {
      console.log(
        `[SyncEngine] Compacted ${removed} operations (${this.opLog.operations.length} remaining)`
      );
    }
    return removed;
  }

  /**
   * Get the current version vector.
   */
  getVersionVector(): VersionVector {
    return this.opLog.versionVector;
  }

  /**
   * Subscribe to state changes.
   *
   * @param callback - Function called when state changes
   * @returns Unsubscribe function
   */
  onStateChange(callback: StateChangeListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Notify all listeners of state change.
   */
  private notifyListeners(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  /**
   * Create the base operation fields.
   */
  private createBaseOp(): { id: string; clock: HLC; pageId: string } {
    this.hlc = tickHLC(this.hlc);
    return {
      id: this.idGen(),
      clock: { ...this.hlc },
      pageId: this.opLog.pageId,
    };
  }

  // ==========================================================================
  // Operation Creators
  // ==========================================================================

  /**
   * Create a text insert operation.
   *
   * @param blockId - Block to insert into
   * @param afterCharId - Insert after this char ID (null = beginning)
   * @param chars - Characters to insert with IDs
   */
  createTextInsert(
    blockId: string,
    afterCharId: string | null,
    chars: Char[]
  ): TextInsert {
    return {
      ...this.createBaseOp(),
      op: "text_insert",
      blockId,
      afterCharId,
      chars,
    };
  }

  /**
   * Create a text delete operation.
   *
   * @param blockId - Block to delete from
   * @param charIds - Character IDs to delete
   */
  createTextDelete(blockId: string, charIds: string[]): TextDelete {
    return {
      ...this.createBaseOp(),
      op: "text_delete",
      blockId,
      charIds,
    };
  }

  /**
   * Create a format set operation.
   *
   * @param blockId - Block containing the characters
   * @param charIds - Character IDs to format
   * @param format - Format type
   * @param value - Format value
   */
  createFormatSet(
    blockId: string,
    charIds: string[],
    format: TextFormat,
    value: boolean | string
  ): FormatSet {
    return {
      ...this.createBaseOp(),
      op: "format_set",
      blockId,
      charIds,
      format,
      value,
    };
  }

  /**
   * Create a block insert operation.
   *
   * @param afterBlockId - Insert after this block (null = beginning)
   * @param blockType - Type of block to create
   * @param initialProps - Optional initial properties
   * @returns The operation (blockId is available on the returned object)
   */
  createBlockInsert(
    afterBlockId: string | null,
    blockType: BlockType,
    initialProps?: BlockProps
  ): BlockInsert {
    return {
      ...this.createBaseOp(),
      op: "block_insert",
      afterBlockId,
      blockId: generateBlockId(this.idGen),
      blockType,
      initialProps,
    };
  }

  /**
   * Create a block delete operation.
   *
   * @param blockId - Block to delete
   */
  createBlockDelete(blockId: string): BlockDelete {
    return {
      ...this.createBaseOp(),
      op: "block_delete",
      blockId,
    };
  }

  /**
   * Create a block set operation.
   *
   * @param blockId - Block to update
   * @param field - Property field name
   * @param value - New value
   */
  createBlockSet(blockId: string, field: string, value: unknown): BlockSet {
    return {
      ...this.createBaseOp(),
      op: "block_set",
      blockId,
      field,
      value,
    };
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  /**
   * Insert text at a position in a block.
   * Convenience method that creates char IDs automatically.
   *
   * @param blockId - Block to insert into
   * @param position - Visible text position (0-based)
   * @param text - Text to insert
   * @returns The text insert operation
   */
  insertText(blockId: string, position: number, text: string): TextInsert {
    const block = this.getState().blocks.find((b) => b.id === blockId);
    const afterCharId = block ? findCharIdAtPosition(block, position) : null;

    const chars: Char[] = Array.from(text).map((char) => ({
      id: this.nextId(),
      char,
    }));

    return this.createTextInsert(blockId, afterCharId, chars);
  }

  /**
   * Delete text in a range within a block.
   *
   * @param blockId - Block to delete from
   * @param startIndex - Start of range (inclusive)
   * @param endIndex - End of range (exclusive)
   * @returns The text delete operation
   */
  deleteText(
    blockId: string,
    startIndex: number,
    endIndex: number
  ): TextDelete {
    const block = this.getState().blocks.find((b) => b.id === blockId);
    const charIds = block ? getCharIdsInRange(block, startIndex, endIndex) : [];

    return this.createTextDelete(blockId, charIds);
  }

  /**
   * Format text in a range within a block.
   *
   * @param blockId - Block containing the text
   * @param startIndex - Start of range (inclusive)
   * @param endIndex - End of range (exclusive)
   * @param format - Format type
   * @param value - Format value
   * @returns The format set operation
   */
  formatText(
    blockId: string,
    startIndex: number,
    endIndex: number,
    format: TextFormat,
    value: boolean | string
  ): FormatSet {
    const block = this.getState().blocks.find((b) => b.id === blockId);
    const charIds = block ? getCharIdsInRange(block, startIndex, endIndex) : [];

    return this.createFormatSet(blockId, charIds, format, value);
  }

  /**
   * Insert a new paragraph block.
   *
   * @param afterBlockId - Insert after this block (null = beginning)
   * @returns The block insert operation
   */
  insertParagraph(afterBlockId: string | null): BlockInsert {
    return this.createBlockInsert(afterBlockId, "paragraph");
  }

  /**
   * Change a block's type.
   *
   * @param blockId - Block to change
   * @param newType - New block type
   * @returns The block set operation
   */
  changeBlockType(blockId: string, newType: BlockType): BlockSet {
    return this.createBlockSet(blockId, "type", newType);
  }

  /**
   * Toggle a todo item's checked state.
   *
   * @param blockId - Todo block to toggle
   * @returns The block set operation
   */
  toggleTodo(blockId: string): BlockSet {
    const block = this.getState().blocks.find((b) => b.id === blockId);
    const currentChecked = block && "checked" in block ? block.checked : false;

    return this.createBlockSet(blockId, "checked", !currentChecked);
  }

  /**
   * Set a list item's indent level.
   *
   * @param blockId - List block to indent
   * @param indent - New indent level
   * @returns The block set operation
   */
  setIndent(blockId: string, indent: number): BlockSet {
    return this.createBlockSet(blockId, "indent", Math.max(0, indent));
  }
}
