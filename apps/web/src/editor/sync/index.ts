/**
 * CRDT Sync Engine
 *
 * Public API for the operation-log CRDT system.
 * Provides methods for emitting operations, applying remote operations,
 * and subscribing to state changes.
 */

import type { Char, TextFormat } from "@/deserializer/loadPage";
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
  PageState,
  TextDelete,
  TextInsert,
  VersionVector,
} from "./types";

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
  PageState,
  TextDelete,
  TextInsert,
  VersionVector,
} from "./types";

// Re-export utilities
export { compareHLC, deserializeHLC, serializeHLC } from "./hlc";
export { deserializeVV, serializeVV } from "./oplog";
export {
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

type StateChangeListener = (state: PageState) => void;

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
  getState(): PageState {
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
    const currentChecked = (block && 'checked' in block) ? block.checked : false;

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
