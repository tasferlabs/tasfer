/**
 * CRDT Sync Engine
 *
 * Public API for the operation-log CRDT system.
 * Provides methods for emitting operations, applying remote operations,
 * and subscribing to state changes.
 */

import type { Block, Char, CharRun, Mark, Page } from "../serlization/loadPage";
import type { CRDTbinding } from "../state-types";
import type {
  BlockDelete,
  BlockInsert,
  BlockProps,
  BlockSet,
  BlockType,
  HLC,
  MarkSet,
  Operation,
  OpLog,
  TextDelete,
  TextInsert,
  VersionVector,
} from "../state-types";
import { BLOCK_REGISTRY, isTextualBlock } from "./block-registry";
import { getCharIdsInRangeFromRuns } from "./char-runs";
import { compareHLC, createHLC, receiveHLC, tickHLC } from "./hlc";
import {
  createIdGenerator,
  extractCounter,
  extractPeerId,
  generateBlockId,
  generatePeerId,
} from "./id";
import { appendOp, createOpLog, getOpsSince, mergeOps } from "./oplog";
import { findCharIdAtPosition } from "./reducer";

// ==========================================================================
// CRDT Context (per editor instance)
// ==========================================================================

/**
 * Create a CRDT context for a single editor instance.
 *
 * Encapsulates the id generator + Hybrid Logical Clock + page id that used to
 * live in module-level globals. Each editor instance owns its own binding, so
 * multiple editors (e.g. a readonly snapshot preview alongside the main editor)
 * can coexist on the same page without clobbering each other's id/clock state.
 *
 * The returned object holds its `hlc`/`idGen` in a closure and mutates them in
 * place — the methods are not bound to `this`, so they can be passed as bare
 * references (e.g. into snapshot-diff's `OpsContext`).
 *
 * @param pageId - The page ID
 * @param peerId - Optional peer ID (generated if not provided)
 */
export function createCRDTbinding(
  pageId: string,
  peerId?: string,
): CRDTbinding {
  const actualPeerId = peerId ?? generatePeerId();
  const idGen = createIdGenerator(actualPeerId);
  let hlc = createHLC(actualPeerId);

  return {
    pageId,
    nextId(): string {
      return idGen();
    },
    getClock(): HLC {
      hlc = tickHLC(hlc);
      return { ...hlc };
    },
    getPeerId(): string {
      return hlc.peerId;
    },
    advanceClock(remoteClock: HLC): void {
      hlc = receiveHLC(hlc, remoteClock);
    },
    advanceIdCounter(n: number): void {
      idGen.advance(n);
    },
  };
}

/**
 * Scan a page's blocks for the highest id-counter value present anywhere —
 * block ids and char-run counters. The page-level counterpart of
 * `maxOpIdCounter`, for documents loaded as blocks (parsed markdown,
 * snapshots) rather than as an op log. Used to advance the local idGen past
 * every counter in the loaded document so the RGA sibling tie-break
 * (counter-first, see `compareIds`) deterministically places new local
 * blocks/chars adjacent to their anchor instead of after pre-existing
 * siblings.
 */
export function maxPageIdCounter(blocks: readonly Block[]): number {
  let max = 0;
  for (const block of blocks) {
    const bc = extractCounter(block.id);
    if (bc > max) max = bc;
    if (isTextualBlock(block)) {
      for (const run of block.charRuns ?? []) {
        const lastCounter = run.startCounter + run.text.length - 1;
        if (lastCounter > max) max = lastCounter;
      }
    }
  }
  return max;
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
  HLC,
  MarkSet,
  Operation,
  TextDelete,
  TextInsert,
  VersionVector,
} from "../state-types";

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
  binding: CRDTbinding,
): BlockSet {
  return {
    op: "block_set",
    id: binding.nextId(),
    clock: binding.getClock(),
    pageId: binding.pageId,
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
  getVisibleBlocks,
  getVisibleTextFromBlock,
} from "./reducer";

// Re-export awareness
export type {
  AwarenessCursor,
  AwarenessSelection,
  AwarenessState,
  AwarenessUser,
} from "./awareness";
export {
  awarenessCursorToPosition,
  awarenessSelectionToSelection,
  getColorForPeer,
  positionToAwarenessCursor,
  selectionToAwarenessSelection,
} from "./awareness";

type StateChangeListener = (state: Page) => void;

/**
 * Sync engine for a single page's operation log.
 *
 * Created with `createSyncEngine(binding)`. The engine owns the op log and
 * version vector, but NOT the clock/id state — that lives on the
 * `CRDTbinding` it is given, which is the single per-instance source of
 * ids, HLC and peer identity, shared with the editor that emits operations.
 */
export interface SyncEngine {
  /** The peer ID stamped on operations (from the shared binding). */
  getPeerId(): string;
  /** The page ID this engine logs operations for. */
  getPageId(): string;
  /** Generate the next unique ID (delegates to the shared binding). */
  nextId(): string;
  /**
   * Load saved operations into the engine.
   * Initializes the opLog and version vector from persisted state, and
   * advances the shared binding's clock/id-counter past everything loaded so
   * new local ops out-order and out-counter historical ones.
   */
  loadOperations(ops: Operation[]): void;
  /**
   * Emit local operations. Operations are added to the log. Listeners are
   * NOT notified because local operations are applied directly to
   * EditorState for immediate feedback. Use apply() for remote operations.
   */
  emit(ops: Operation[]): void;
  /**
   * Apply remote operations. Operations are merged into the log, the shared
   * binding's clock/id-counter are advanced past them, and listeners are
   * notified.
   */
  apply(ops: Operation[]): void;
  /** Get the current computed state. */
  getState(): Page;
  /** Get all operations in the log. */
  getOperations(): Operation[];
  /** Get operations that a peer (identified by its version vector) is missing. */
  getOpsSince(peerVV: VersionVector): Operation[];
  /**
   * Get operations after a specific HLC clock (null returns all operations).
   * Used for delta sync - only send operations not yet in the snapshot.
   */
  getOperationsAfterClock(clock: HLC | null): Operation[];
  /** Get the latest HLC clock from operations, or null if no operations. */
  getLatestClock(): HLC | null;
  /**
   * Compact the operation log by removing operations <= snapshotClock
   * (already saved in a snapshot). Returns the number of operations removed.
   */
  compactOperations(snapshotClock: HLC): number;
  /** Get the current version vector. */
  getVersionVector(): VersionVector;
  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(callback: StateChangeListener): () => void;

  // Operation creators — id/clock/pageId are stamped from the shared binding.
  createTextInsert(
    blockId: string,
    afterCharId: string | null,
    charRuns: CharRun[],
  ): TextInsert;
  createTextDelete(blockId: string, charIds: string[]): TextDelete;
  createFormatSet(
    blockId: string,
    charIds: string[],
    format: Mark,
    value: boolean | string,
  ): MarkSet;
  createBlockInsert(
    afterBlockId: string | null,
    blockType: BlockType,
    initialProps?: BlockProps,
  ): BlockInsert;
  createBlockDelete(blockId: string): BlockDelete;
  createBlockSet(blockId: string, field: string, value: unknown): BlockSet;

  // Convenience methods (position/range based).
  /** Insert text at a visible position in a block (char IDs auto-generated). */
  insertText(blockId: string, position: number, text: string): TextInsert;
  /** Delete text in a visible range [startIndex, endIndex) within a block. */
  deleteText(blockId: string, startIndex: number, endIndex: number): TextDelete;
  /** Format text in a visible range [startIndex, endIndex) within a block. */
  formatText(
    blockId: string,
    startIndex: number,
    endIndex: number,
    format: Mark,
    value: boolean | string,
  ): MarkSet;
  /** Insert a new paragraph block after the given block (null = beginning). */
  insertParagraph(afterBlockId: string | null): BlockInsert;
  /** Change a block's type. */
  changeBlockType(blockId: string, newType: BlockType): BlockSet;
  /** Toggle a todo item's checked state. */
  toggleTodo(blockId: string): BlockSet;
  /** Set a list item's indent level (clamped to >= 0). */
  setIndent(blockId: string, indent: number): BlockSet;
}

/**
 * Create a sync engine that manages the CRDT op log for a single page.
 *
 * The engine does not own any clock/id/peer state of its own — it stamps and
 * advances the `CRDTbinding` it is given. Pass the SAME binding the editor
 * instance uses (see `mountEditor`'s `crdtBinding` option) so the editor and
 * the sync engine share one id/clock source: applying remote ops here
 * automatically keeps locally-emitted editor ops causally ahead, with no
 * manual clock mirroring by the host.
 *
 * @example
 * const binding = createCRDTbinding("page-123", peerId);
 * const engine = createSyncEngine(binding);
 *
 * // Subscribe to state changes
 * engine.onStateChange((state) => {
 *   render(state);
 * });
 *
 * // Emit local operations
 * const blockInsert = engine.createBlockInsert(null, "paragraph");
 * engine.emit([blockInsert]);
 *
 * // Apply remote operations
 * engine.apply(remoteOps);
 */
export function createSyncEngine(binding: CRDTbinding): SyncEngine {
  let opLog: OpLog = createOpLog(binding.pageId);
  const listeners = new Set<StateChangeListener>();

  function getState(): Page {
    return opLog.state;
  }

  function notifyListeners(): void {
    const state = getState();
    for (const listener of listeners) {
      listener(state);
    }
  }

  /** Create the base operation fields, stamped from the shared binding. */
  function createBaseOp(): { id: string; clock: HLC; pageId: string } {
    return {
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
    };
  }

  /**
   * Advance the shared binding past a batch of loaded/remote ops so future
   * local ops respect causality: the HLC must out-order every op we've seen
   * (mergeOps full-rebuild sorts by HLC) and the id-counter must out-counter
   * every id we've seen (RGA sibling sort compares by counter — see
   * maxOpIdCounter).
   */
  function advanceBindingPast(ops: Operation[]): void {
    for (const op of ops) {
      binding.advanceClock(op.clock);
    }
    binding.advanceIdCounter(maxOpIdCounter(ops));
  }

  /**
   * Convert Char[] to CharRun[] for storage.
   * Handles chars from multiple peers by splitting into separate runs.
   */
  function charsToCharRuns(chars: Char[]): CharRun[] {
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
            createCharRunFromDeleted(
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
        createCharRunFromDeleted(
          currentPeerId,
          currentStartCounter,
          currentText,
          currentDeleted,
        ),
      );
    }

    return runs;
  }

  /** Helper to create CharRun with optional deletedMask */
  function createCharRunFromDeleted(
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

  function createTextInsert(
    blockId: string,
    afterCharId: string | null,
    charRuns: CharRun[],
  ): TextInsert {
    return {
      ...createBaseOp(),
      op: "text_insert",
      blockId,
      afterCharId,
      charRuns,
    };
  }

  function createTextDelete(blockId: string, charIds: string[]): TextDelete {
    return {
      ...createBaseOp(),
      op: "text_delete",
      blockId,
      charIds,
    };
  }

  function createFormatSet(
    blockId: string,
    charIds: string[],
    format: Mark,
    value: boolean | string,
  ): MarkSet {
    return {
      ...createBaseOp(),
      op: "mark_set",
      blockId,
      charIds,
      format,
      value,
    };
  }

  function createBlockInsert(
    afterBlockId: string | null,
    blockType: BlockType,
    initialProps?: BlockProps,
  ): BlockInsert {
    return {
      ...createBaseOp(),
      op: "block_insert",
      afterBlockId,
      blockId: generateBlockId(binding.nextId),
      blockType,
      initialProps,
    };
  }

  function createBlockDelete(blockId: string): BlockDelete {
    return {
      ...createBaseOp(),
      op: "block_delete",
      blockId,
    };
  }

  function createBlockSetOp(
    blockId: string,
    field: string,
    value: unknown,
  ): BlockSet {
    return {
      ...createBaseOp(),
      op: "block_set",
      blockId,
      field,
      value,
    };
  }

  return {
    getPeerId(): string {
      return binding.getPeerId();
    },

    getPageId(): string {
      return binding.pageId;
    },

    nextId(): string {
      return binding.nextId();
    },

    loadOperations(ops: Operation[]): void {
      for (const op of ops) {
        opLog = appendOp(opLog, op);
      }
      advanceBindingPast(ops);
    },

    emit(ops: Operation[]): void {
      for (const op of ops) {
        opLog = appendOp(opLog, op);
      }
      // Don't notify listeners for local ops - EditorState is already updated
    },

    apply(ops: Operation[]): void {
      advanceBindingPast(ops);
      opLog = mergeOps(opLog, ops);
      notifyListeners();
    },

    getState,

    getOperations(): Operation[] {
      return opLog.operations;
    },

    getOpsSince(peerVV: VersionVector): Operation[] {
      return getOpsSince(opLog, peerVV);
    },

    getOperationsAfterClock(clock: HLC | null): Operation[] {
      if (!clock) {
        return opLog.operations;
      }

      return opLog.operations.filter((op) => compareHLC(op.clock, clock) > 0);
    },

    getLatestClock(): HLC | null {
      if (opLog.operations.length === 0) {
        return null;
      }

      let latest = opLog.operations[0].clock;
      for (const op of opLog.operations) {
        if (compareHLC(op.clock, latest) > 0) {
          latest = op.clock;
        }
      }
      return { ...latest };
    },

    compactOperations(snapshotClock: HLC): number {
      const beforeCount = opLog.operations.length;

      // Keep only operations after the snapshot clock (not yet saved)
      opLog.operations = opLog.operations.filter(
        (op) => compareHLC(op.clock, snapshotClock) > 0,
      );

      const removed = beforeCount - opLog.operations.length;
      if (removed > 0) {
        console.log(
          `[SyncEngine] Compacted ${removed} operations (${opLog.operations.length} remaining)`,
        );
      }
      return removed;
    },

    getVersionVector(): VersionVector {
      return opLog.versionVector;
    },

    onStateChange(callback: StateChangeListener): () => void {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    createTextInsert,
    createTextDelete,
    createFormatSet,
    createBlockInsert,
    createBlockDelete,
    createBlockSet: createBlockSetOp,

    insertText(blockId: string, position: number, text: string): TextInsert {
      const block = getState().blocks.find((b) => b.id === blockId);
      const afterCharId = block ? findCharIdAtPosition(block, position) : null;

      const chars: Char[] = Array.from(text).map((char) => ({
        id: binding.nextId(),
        char,
      }));

      const charRuns = charsToCharRuns(chars);
      return createTextInsert(blockId, afterCharId, charRuns);
    },

    deleteText(
      blockId: string,
      startIndex: number,
      endIndex: number,
    ): TextDelete {
      const block = getState().blocks.find((b) => b.id === blockId);
      const charIds =
        block && isTextualBlock(block)
          ? getCharIdsInRangeFromRuns(block.charRuns, startIndex, endIndex)
          : [];

      return createTextDelete(blockId, charIds);
    },

    formatText(
      blockId: string,
      startIndex: number,
      endIndex: number,
      format: Mark,
      value: boolean | string,
    ): MarkSet {
      const block = getState().blocks.find((b) => b.id === blockId);
      const charIds =
        block && isTextualBlock(block)
          ? getCharIdsInRangeFromRuns(block.charRuns, startIndex, endIndex)
          : [];

      return createFormatSet(blockId, charIds, format, value);
    },

    insertParagraph(afterBlockId: string | null): BlockInsert {
      return createBlockInsert(afterBlockId, "paragraph");
    },

    changeBlockType(blockId: string, newType: BlockType): BlockSet {
      return createBlockSetOp(blockId, "type", newType);
    },

    toggleTodo(blockId: string): BlockSet {
      const block = getState().blocks.find((b) => b.id === blockId);
      const currentChecked =
        block && "checked" in block ? block.checked : false;

      return createBlockSetOp(blockId, "checked", !currentChecked);
    },

    setIndent(blockId: string, indent: number): BlockSet {
      return createBlockSetOp(blockId, "indent", Math.max(0, indent));
    },
  };
}
