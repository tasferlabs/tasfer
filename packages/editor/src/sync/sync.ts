/**
 * CRDT Sync Engine
 *
 * Public API for the operation-log CRDT system.
 * Provides methods for emitting operations, applying remote operations,
 * and subscribing to state changes.
 */

import { BLOCK_REGISTRY } from "./block-registry";
import { compareHLC, createHLC, receiveHLC, tickHLC } from "./hlc";
import {
  createIdGenerator,
  extractCounter,
  extractPeerId,
  generateBlockId,
  generatePeerId,
  type IdGenerator,
} from "./id";
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
import type { Char, CharRun, Page, TextFormat } from "@/deserializer/loadPage";

// ==========================================================================
// Global CRDT Context Functions
// ==========================================================================

/**
 * Global state for CRDT context.
 * These are initialized per-page and used throughout the editor.
 */
let globalPageId: string | null = null;
let globalIdGen: IdGenerator | null = null;
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
    throw new Error(
      "CRDT context not initialized. Call setCRDTContext() first.",
    );
  }
  return globalPageId;
}

/**
 * Generate the next unique ID.
 * @throws Error if context is not initialized
 */
export function nextId(): string {
  if (globalIdGen === null) {
    throw new Error(
      "CRDT context not initialized. Call setCRDTContext() first.",
    );
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
    throw new Error(
      "CRDT context not initialized. Call setCRDTContext() first.",
    );
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
    throw new Error(
      "CRDT context not initialized. Call setCRDTContext() first.",
    );
  }
  return globalHLC.peerId;
}

/**
 * Advance the global HLC to be at least as recent as a remote clock.
 * Call this after loading persisted operations so that new operations
 * get HLC values higher than all historical ops. Without this,
 * mergeOps (full rebuild) would sort session ops before historical ops,
 * breaking causality.
 */
export function advanceGlobalClock(remoteClock: HLC): void {
  if (globalHLC === null) return;
  globalHLC = receiveHLC(globalHLC, remoteClock);
}

/**
 * Bump the global id-counter so the next id we generate has counter > `n`.
 * Required for RGA sibling tie-breaks across sessions — see IdGenerator.advance.
 */
export function advanceGlobalIdCounter(n: number): void {
  if (globalIdGen === null) return;
  globalIdGen.advance(n);
}

/**
 * Scan ops for the highest id-counter value present anywhere — op ids,
 * inserted-block ids, inserted-char starting counters (and their full run
 * length). Used to advance our local idGen past every counter we've seen
 * so RGA sibling sorts place new local ids after pre-existing siblings.
 */
export function maxOpIdCounter(ops: readonly Operation[]): number {
  let max = 0;
  for (const op of ops) {
    const c = extractCounter(op.id);
    if (c > max) max = c;
    if (op.op === "block_insert") {
      const bc = extractCounter(op.blockId);
      if (bc > max) max = bc;
    } else if (op.op === "text_insert") {
      for (const run of op.charRuns) {
        const lastCounter = run.startCounter + run.text.length - 1;
        if (lastCounter > max) max = lastCounter;
      }
    }
  }
  return max;
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

// =============================================================================
// Typed BlockSet builder
// =============================================================================

/**
 * Compile-time map of block type → settable fields and their value types.
 *
 * Mirrors the runtime BLOCK_REGISTRY but expresses the field shapes at the
 * type level so that `createBlockSet` can refuse, at compile time, ops that
 * target a field that doesn't exist on a block type or carry a wrongly-typed
 * value. The wire shape itself stays `field: string, value: unknown` — this
 * is purely a guard at construction sites that know the block's static type.
 *
 * The KEYS of each entry are checked against BLOCK_REGISTRY at compile time
 * by `_BlockFieldsOfMatchesRegistry` below. The VALUE TYPES still need
 * manual sync with the descriptor's `validate` predicates — adding a new
 * field requires touching both the registry and this map; the assertion
 * catches the field-name half of that. (Encoding value types in the
 * registry would require lifting them into FieldDescriptor's generics; not
 * done because the validate functions already enforce them at runtime.)
 */
export interface BlockFieldsOf {
  paragraph: {};
  heading1: {};
  heading2: {};
  heading3: {};
  bullet_list: { indent: number };
  numbered_list: { indent: number };
  todo_list: { indent: number; checked: boolean };
  image: {
    url: string;
    alt?: string;
    width?: number | "full";
    height?: number;
    objectFit?: "cover" | "contain";
  };
  line: {};
  math: { latex: string; displayMode: boolean };
}

// =============================================================================
// Compile-time check: BlockFieldsOf keys === BLOCK_REGISTRY field keys
// =============================================================================
//
// If a block-type's field set drifts between BlockFieldsOf (compile-time)
// and BLOCK_REGISTRY (runtime), one of the symbols below collapses to
// `never` and surfaces as a "Type 'true' is not assignable to type 'never'"
// error at the `_assertBlockFieldsOfMatchesRegistry` declaration.

/** Field keys registered on a block type (excluding "type", which is always valid). */
type _RegistryFieldKeys<T extends BlockType> = Exclude<
  keyof (typeof BLOCK_REGISTRY)[T]["fields"] & string,
  "type"
>;

/** Field keys declared in BlockFieldsOf for a block type. */
type _BlockFieldsOfKeys<T extends BlockType> = keyof BlockFieldsOf[T] & string;

/** `true` iff A and B are mutually assignable as constraints. */
type _Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Per-block-type key-set equality assertion. */
type _BlockFieldsOfMatchesRegistry = {
  [T in BlockType]: _Equal<_RegistryFieldKeys<T>, _BlockFieldsOfKeys<T>>;
};

// Force the assertion to evaluate. If any block-type's key sets diverge,
// the corresponding entry becomes `never` and this declaration fails.
const _assertBlockFieldsOfMatchesRegistry: _BlockFieldsOfMatchesRegistry = {
  paragraph: true,
  heading1: true,
  heading2: true,
  heading3: true,
  bullet_list: true,
  numbered_list: true,
  todo_list: true,
  image: true,
  line: true,
  math: true,
};
void _assertBlockFieldsOfMatchesRegistry;

/**
 * Field name allowed on a BlockSet for block type T.
 *
 * Includes "type" (always valid) plus all registered fields for that block
 * type.
 */
export type BlockSetField<T extends BlockType> =
  | "type"
  | (keyof BlockFieldsOf[T] & string);

/**
 * Value type for a given (block type, field) pair.
 *
 * - "type" accepts any BlockType.
 * - Other fields are looked up in BlockFieldsOf.
 */
export type BlockSetValue<
  T extends BlockType,
  F extends BlockSetField<T>,
> = F extends "type"
  ? BlockType
  : F extends keyof BlockFieldsOf[T]
    ? BlockFieldsOf[T][F]
    : never;

/**
 * Construct a typed BlockSet op.
 *
 * Use this at emit sites that know the block's static type. The wire shape
 * is identical to the untyped form (field: string, value: unknown) so this
 * is a compile-time-only guard — no runtime cost.
 *
 * Example:
 *   createBlockSet<"todo_list", "checked">(blockId, "checked", true)
 *   createBlockSet<"math", "latex">(blockId, "latex", "x^2")
 *
 * Use the untyped form on `BlockSet`'s wire shape when the type isn't known
 * statically (e.g. when forwarding ops from a peer).
 */
export function createBlockSet<T extends BlockType, F extends BlockSetField<T>>(
  blockId: string,
  field: F,
  value: BlockSetValue<T, F>,
): BlockSet {
  return {
    op: "block_set",
    id: nextId(),
    clock: getClock(),
    pageId: getPageId(),
    blockId,
    field,
    value,
  };
}

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
export type {
  AwarenessConfig,
  AwarenessCursor,
  AwarenessSelection,
  AwarenessState,
  AwarenessUser,
  LocalAwarenessState,
} from "./awareness";
export {
  awarenessCursorToPosition,
  AwarenessManager,
  awarenessSelectionToSelection,
  createAwarenessManager,
  getColorForPeer,
  positionToAwarenessCursor,
  selectionToAwarenessSelection,
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
  private idGen: IdGenerator;
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
    // Advance idGen past every id-counter seen in the loaded ops so the
    // next block/char we emit out-counters every pre-existing sibling
    // (RGA sibling sort compares by counter — see maxOpIdCounter).
    this.idGen.advance(maxOpIdCounter(ops));
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
    // Mirror the HLC bump for the id-counter so future local ops out-counter
    // every remote id we've now seen (RGA sibling tie-break invariant).
    this.idGen.advance(maxOpIdCounter(ops));

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

    return this.opLog.operations.filter(
      (op) => compareHLC(op.clock, clock) > 0,
    );
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
      if (compareHLC(op.clock, latest) > 0) {
        latest = op.clock;
      }
    }
    return { ...latest };
  }

  /**
   * Compact the operation log by removing operations that are already saved.
   * Call this after successfully saving to the server to free memory.
   *
   * Operations are removed if they are <= snapshotClock (already saved in snapshot).
   * Late-joining peers will load from the snapshot, so they don't need these ops.
   *
   * @param snapshotClock - Clock of the saved snapshot. Operations <= this clock will be removed.
   * @returns Number of operations removed
   */
  compactOperations(snapshotClock: HLC): number {
    const beforeCount = this.opLog.operations.length;

    // Keep only operations after the snapshot clock (not yet saved)
    this.opLog.operations = this.opLog.operations.filter(
      (op) => compareHLC(op.clock, snapshotClock) > 0,
    );

    const removed = beforeCount - this.opLog.operations.length;
    if (removed > 0) {
      console.log(
        `[SyncEngine] Compacted ${removed} operations (${this.opLog.operations.length} remaining)`,
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
   * @param charRuns - Character runs to insert
   */
  createTextInsert(
    blockId: string,
    afterCharId: string | null,
    charRuns: CharRun[],
  ): TextInsert {
    return {
      ...this.createBaseOp(),
      op: "text_insert",
      blockId,
      afterCharId,
      charRuns,
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
    value: boolean | string,
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
    initialProps?: BlockProps,
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
   * Convert Char[] to CharRun[] for storage.
   * Handles chars from multiple peers by splitting into separate runs.
   */
  private charsToCharRuns(chars: Char[]): CharRun[] {
    if (chars.length === 0) return [];

    const runs: CharRun[] = [];
    let currentPeerId = extractPeerId(chars[0].id);
    let currentStartCounter = extractCounter(chars[0].id);
    let currentText = "";
    let currentDeleted: boolean[] = [];

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      const peerId = extractPeerId(char.id);
      const counter = extractCounter(char.id);

      // Check if continues current run (same peer, consecutive counter)
      if (
        peerId === currentPeerId &&
        counter === currentStartCounter + currentText.length
      ) {
        currentText += char.char;
        currentDeleted.push(char.deleted ?? false);
      } else {
        // Finish current run
        if (currentText.length > 0) {
          runs.push(
            this.createCharRunFromDeleted(
              currentPeerId,
              currentStartCounter,
              currentText,
              currentDeleted,
            ),
          );
        }

        // Start new run
        currentPeerId = peerId;
        currentStartCounter = counter;
        currentText = char.char;
        currentDeleted = [char.deleted ?? false];
      }
    }

    // Finish last run
    if (currentText.length > 0) {
      runs.push(
        this.createCharRunFromDeleted(
          currentPeerId,
          currentStartCounter,
          currentText,
          currentDeleted,
        ),
      );
    }

    return runs;
  }

  /**
   * Helper to create CharRun with optional deletedMask
   */
  private createCharRunFromDeleted(
    peerId: string,
    startCounter: number,
    text: string,
    deleted: boolean[],
  ): CharRun {
    const hasDeleted = deleted.some((d) => d);

    if (!hasDeleted) {
      return { peerId, startCounter, text };
    }

    // Create deletedMask bitmap
    const deletedMask: number[] = new Array(Math.ceil(deleted.length / 8)).fill(
      0,
    );
    deleted.forEach((isDeleted, i) => {
      if (isDeleted) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = i % 8;
        deletedMask[byteIndex] |= 1 << bitIndex;
      }
    });

    return { peerId, startCounter, text, deletedMask };
  }

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

    const charRuns = this.charsToCharRuns(chars);
    return this.createTextInsert(blockId, afterCharId, charRuns);
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
    endIndex: number,
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
    value: boolean | string,
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
