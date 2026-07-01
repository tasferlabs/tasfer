/**
 * CRDT Reducer
 *
 * Applies operations to state and rebuilds state from operations.
 * This is the core of the CRDT engine - all state changes flow through here.
 */

import { getBaseDataSchema } from "../baseDataSchema";
import type { NodeRegistry } from "../rendering/nodes/Node";
import {
  type Block,
  type Char,
  type MarkSpan,
  type Page,
} from "../serlization/loadPage";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  BlockType,
  MarkSet,
  Operation,
  TextDelete,
  TextInsert,
  ViewWindow,
} from "../state-types";
import { findBlock, findBlockIndex } from "./block-lookup";
import {
  canHaveFormats,
  isStyleField,
  isTextualBlock,
  readBlockStyle,
  styleKeyOf,
} from "./block-registry";
import {
  charRunsToChars,
  deleteFromRuns,
  getCharIdAtVisiblePosition,
  getVisibleTextFromRuns,
  insertIntoRuns,
  isCharIdInRange,
  iterateAllChars,
  iterateVisibleChars,
} from "./char-runs";
import { sortBlocksByOrder } from "./crdt-utils";
import { compareHLC } from "./hlc";
import type { DataSchema } from "./schema";

/**
 * Create an empty page state.
 */
export function createEmptyPageState(pageId: string): Page {
  return {
    id: pageId,
    title: "",
    blocks: [],
  };
}

export function createEmptyBlock(
  id: string,
  orderKey: string,
  type: string,
  schema: DataSchema = getBaseDataSchema(),
): Block | undefined {
  // Materialization is gated by REGISTRATION only (createDefaultBlock returns
  // undefined for a type the schema doesn't know) — NEVER by the authoring
  // allow-list (schema.isBlockAllowed). The allow-list is an authoring-time
  // constraint enforced at actions/paste; the reducer must stay agnostic to it or
  // two peers with different allow-lists would materialize the same op-log
  // differently and diverge. A restricted peer still RENDERS a disallowed-but-
  // registered type that arrives via sync. Do not add an allow-list check here.
  return schema.createDefaultBlock(type, id, orderKey);
}

/**
 * Apply a text insert operation.
 *
 * Inserts characters after the specified character ID. If any chars in
 * `op.charRuns` already exist as tombstones, un-tombstones them rather than
 * inserting duplicates — that path supports undo restoring deleted chars.
 */
function applyTextInsert(state: Page, op: TextInsert): Page {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];

  if (!block || block.deleted || !isTextualBlock(block)) {
    return state;
  }

  const chars = charRunsToChars(op.charRuns);

  const existingCharIds = new Set<string>();
  for (const run of block.charRuns || []) {
    for (let i = 0; i < run.text.length; i++) {
      existingCharIds.add(`${run.peerId}:${run.startCounter + i}`);
    }
  }

  const charsToRestore = chars.filter((c) => existingCharIds.has(c.id));
  const charsToInsert = chars.filter((c) => !existingCharIds.has(c.id));

  let newCharRuns = block.charRuns || [];

  if (charsToRestore.length > 0) {
    const charIdsToRestore = new Set(charsToRestore.map((c) => c.id));
    newCharRuns = newCharRuns.map((run) => {
      let modified = false;
      const newMask = run.deletedMask ? [...run.deletedMask] : undefined;

      for (let i = 0; i < run.text.length; i++) {
        const charId = `${run.peerId}:${run.startCounter + i}`;
        if (charIdsToRestore.has(charId) && newMask) {
          const byteIndex = Math.floor(i / 8);
          const bitIndex = i % 8;
          if (
            byteIndex < newMask.length &&
            (newMask[byteIndex] & (1 << bitIndex)) !== 0
          ) {
            newMask[byteIndex] &= ~(1 << bitIndex);
            modified = true;
          }
        }
      }

      if (modified) {
        const hasAnyDeleted = newMask?.some((byte) => byte !== 0);
        return { ...run, deletedMask: hasAnyDeleted ? newMask : undefined };
      }
      return run;
    });
  }

  if (charsToInsert.length > 0) {
    newCharRuns = insertIntoRuns(newCharRuns, op.afterCharId, charsToInsert);
  }

  const updatedBlock = { ...block, charRuns: newCharRuns };
  const newBlocks = [...state.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return { ...state, blocks: newBlocks };
}

/**
 * Apply a text delete operation.
 * Marks characters as deleted (tombstone).
 */
function applyTextDelete(state: Page, op: TextDelete): Page {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];

  // Skip operations on deleted blocks or blocks without text content
  if (!block || block.deleted || !isTextualBlock(block)) {
    return state;
  }

  // Delete chars from runs
  const newCharRuns = deleteFromRuns(block.charRuns, op.charIds);

  const updatedBlock: Block = {
    ...block,
    charRuns: newCharRuns,
  };

  const newBlocks = [...state.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a format set operation.
 *
 * When op.value === false, splits any same-type spans that overlap the
 * affected range so that only the parts outside the selection remain.
 *
 * When op.value !== false, drops any same-type spans overlapping the new
 * range and appends a fresh span for it.
 *
 * The local-emit path in crdt-helpers::markCharsInRange uses the same
 * algorithm — they must stay in sync, otherwise the locally-rendered state
 * diverges from what remote peers compute from the same op.
 */
function applyFormatSet(state: Page, op: MarkSet): Page {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];

  if (!block || block.deleted || !isTextualBlock(block)) {
    return state;
  }

  if (op.charIds.length === 0) {
    return state;
  }

  let newFormats: MarkSpan[];

  if (op.value === false) {
    newFormats = [];
    const selectionSet = new Set(op.charIds);

    for (const span of block.formats) {
      if (span.format.type !== op.format.type) {
        newFormats.push(span);
        continue;
      }

      const overlaps = op.charIds.some((charId) =>
        isCharIdInRange(
          block.charRuns,
          charId,
          span.startCharId,
          span.endCharId,
        ),
      );
      if (!overlaps) {
        newFormats.push(span);
        continue;
      }

      // Resolve the span's surviving (visible) chars tolerantly, by document
      // order: a span endpoint can be tombstoned (e.g. the chip's leading char
      // was deleted) while its interior survives. Anchoring on the exact boundary
      // id over *visible* chars would never see a tombstoned endpoint, so the
      // walk would collect nothing and drop the whole span on the floor — turning
      // a partial un-format into a total one (an inline-math chip losing its mark
      // and rendering as raw source). Matching `resolveMarkRuns`, key off ordinals
      // computed over ALL chars so a deleted endpoint still bounds the run.
      const ordinal = new Map<string, number>();
      const visibleIds: string[] = [];
      let ord = 0;
      for (const { id, deleted } of iterateAllChars(block.charRuns)) {
        ordinal.set(id, ord++);
        if (!deleted) visibleIds.push(id);
      }
      const startOrd = ordinal.get(span.startCharId);
      const endOrd = ordinal.get(span.endCharId);
      if (startOrd === undefined || endOrd === undefined) {
        // Both anchors gone entirely — can't resolve the run; keep it untouched
        // rather than dropping data. (Unreachable when the overlap check above
        // passed, since that walks the same all-chars list.)
        newFormats.push(span);
        continue;
      }
      const spanCharIds = visibleIds.filter((id) => {
        const o = ordinal.get(id)!;
        return o >= startOrd && o <= endOrd;
      });

      let runStart: string | null = null;
      let runEnd: string | null = null;
      for (const charId of spanCharIds) {
        if (!selectionSet.has(charId)) {
          if (runStart === null) runStart = charId;
          runEnd = charId;
        } else if (runStart !== null && runEnd !== null) {
          newFormats.push({
            startCharId: runStart,
            endCharId: runEnd,
            format: span.format,
            clock: span.clock,
          });
          runStart = null;
          runEnd = null;
        }
      }
      if (runStart !== null && runEnd !== null) {
        newFormats.push({
          startCharId: runStart,
          endCharId: runEnd,
          format: span.format,
          clock: span.clock,
        });
      }
    }
  } else {
    const alreadyApplied = block.formats.some(
      (span) =>
        span.clock.counter === op.clock.counter &&
        span.clock.peerId === op.clock.peerId,
    );
    if (alreadyApplied) {
      return state;
    }

    // Document-order ordinals over ALL chars (tombstones included), so a span
    // whose endpoint was tombstoned still bounds a range — matching the
    // op.value === false branch and `resolveMarkRuns`.
    const ordinal = new Map<string, number>();
    let ord = 0;
    for (const { id } of iterateAllChars(block.charRuns)) {
      ordinal.set(id, ord++);
    }

    // The op's own range, as ordinals. charIds is a contiguous document-order
    // run, but min/max defends against any ordering.
    let startId = op.charIds[0];
    let endId = op.charIds[op.charIds.length - 1];
    let startOrd = ordinal.get(startId);
    let endOrd = ordinal.get(endId);
    if (startOrd === undefined || endOrd === undefined) {
      // Op targets chars absent from this block — nothing coherent to set.
      return state;
    }
    if (startOrd > endOrd) {
      [startOrd, endOrd] = [endOrd, startOrd];
      [startId, endId] = [endId, startId];
    }

    // Fold each overlapping same-type span INTO the new range (union) rather
    // than dropping it: a mark that already covered chars outside the op's
    // range must keep covering them. Replacing the span with just the op's
    // range silently shrinks coverage — e.g. after an inline-math chip is split
    // across a block boundary (Enter) and the blocks are rejoined (Backspace),
    // re-marking the second half would otherwise strip the mark from the first
    // half, leaving it to render as raw LaTeX source.
    const kept: MarkSpan[] = [];
    for (const span of block.formats) {
      if (span.format.type !== op.format.type) {
        kept.push(span);
        continue;
      }
      const sOrd = ordinal.get(span.startCharId);
      const eOrd = ordinal.get(span.endCharId);
      if (sOrd === undefined || eOrd === undefined) {
        kept.push(span);
        continue;
      }
      // Ranges intersect in document order (using the new range as it grows, so
      // a chain of overlapping spans coalesces into one).
      const overlaps = sOrd <= endOrd && eOrd >= startOrd;
      if (!overlaps) {
        kept.push(span);
        continue;
      }
      if (sOrd < startOrd) {
        startOrd = sOrd;
        startId = span.startCharId;
      }
      if (eOrd > endOrd) {
        endOrd = eOrd;
        endId = span.endCharId;
      }
    }

    const newSpan: MarkSpan = {
      startCharId: startId,
      endCharId: endId,
      format: op.format,
      clock: op.clock,
    };
    newFormats = [...kept, newSpan];
  }

  const updatedBlock: Block = {
    ...block,
    formats: newFormats,
  };

  const newBlocks = [...state.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a block insert operation.
 *
 * The new block carries an absolute fractional-index `orderKey`; the array is
 * re-sorted by `(orderKey, id)` so local-emit, remote apply, and rebuild all
 * converge on the same block order regardless of arrival sequence.
 */
function applyBlockInsert(
  state: Page,
  op: BlockInsert,
  schema: DataSchema,
): Page {
  const existingBlock = findBlock(state, op.blockId);
  if (existingBlock) {
    if (existingBlock.deleted) {
      const blockIndex = findBlockIndex(state, op.blockId);
      const restoredBlock = { ...existingBlock, deleted: false };
      const newBlocks = [...state.blocks];
      newBlocks[blockIndex] = restoredBlock;
      return { ...state, blocks: newBlocks };
    }
    return state;
  }

  const baseBlock = createEmptyBlock(
    op.blockId,
    op.orderKey,
    op.blockType,
    schema,
  );
  // Unknown block type (a peer registered a type we haven't): keep the op in
  // the log (it stays known via the version vector) but don't materialize a
  // block we can't model. A later schema upgrade re-deriving from the log will
  // pick it up.
  if (!baseBlock) return state;
  const newBlock = op.initialProps
    ? { ...baseBlock, ...op.initialProps }
    : baseBlock;

  const newBlocks = sortBlocksByOrder([...state.blocks, newBlock]);

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a block delete operation.
 * Marks the block as deleted (tombstone).
 */
function applyBlockDelete(state: Page, op: BlockDelete): Page {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];
  if (!block) {
    return state;
  }

  // Note: We don't check block.deleted here because block_delete can be idempotent
  const updatedBlock: Block = {
    ...block,
    deleted: true,
  };

  const newBlocks = [...state.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a block set operation.
 * Updates a block property using Last-Writer-Wins.
 */
function applyBlockSet(state: Page, op: BlockSet, schema: DataSchema): Page {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];
  if (!block || block.deleted) {
    return state;
  }

  // A value-less block_set (e.g. an op emitted with `value: undefined`, which
  // serializes to a missing key) carries no information and must never mutate
  // state. The per-field validators already reject `undefined`, but make the
  // contract explicit here so a malformed op is a no-op regardless of how a
  // field validates — it must converge identically on every peer.
  if (op.value === undefined) {
    return state;
  }

  // `orderKey` is a structural, type-agnostic field (a block move), not part of
  // any node's schema, so it bypasses `validateField`. Setting it re-sorts the
  // document; an LWW write by HLC, like any other block property.
  if (op.field === "orderKey") {
    if (typeof op.value !== "string") return state;
    const reordered = [...state.blocks];
    reordered[blockIndex] = { ...block, orderKey: op.value };
    return { ...state, blocks: sortBlocksByOrder(reordered) };
  }

  if (!schema.validateField(block.type, op.field, op.value)) {
    return state;
  }

  if (op.field === "type") {
    const newType = op.value as BlockType;
    const newBlock = createEmptyBlock(
      block.id,
      block.orderKey ?? "",
      newType,
      schema,
    );
    if (!newBlock) return state;

    const updatedBlock: Block =
      schema.canMorphTo(block.type, newType) &&
      isTextualBlock(block) &&
      isTextualBlock(newBlock)
        ? {
            ...newBlock,
            charRuns: block.charRuns,
            // Marks only carry over when the target type can hold them. Morphing
            // a formatted paragraph into math or code (hasFormats: false) must
            // drop the spans — the originating peer's convert action already does
            // (`canHaveFormats(type) ? formats : []`), so preserving them here
            // would diverge: that peer sees no marks, remote peers keep them.
            formats: canHaveFormats(newType) ? block.formats : [],
            // The morph changes the block type (e.g. paragraph → heading), so the
            // old layout cache is invalid for the new type — let it recompute.
          }
        : newBlock;

    const newBlocks = [...state.blocks];
    newBlocks[blockIndex] = updatedBlock;

    return {
      ...state,
      blocks: newBlocks,
    };
  }

  // A `style.<key>` field sets one property inside the block's `style` bag (an
  // independent LWW register per key) rather than a top-level field. Dropping
  // the layout cache here covers the remote path: the spread carries the old
  // block's `cachedLayout`, but a style change (font size/line height) can
  // change measured height.
  const updatedBlock: Block = isStyleField(op.field)
    ? ({
        ...block,
        style: { ...readBlockStyle(block), [styleKeyOf(op.field)]: op.value },
        cachedLayout: undefined,
      } as Block)
    : ({
        ...block,
        [op.field]: op.value,
      } as Block);

  const newBlocks = [...state.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a single operation to the state.
 */
export function applyOp(
  state: Page,
  op: Operation,
  schema: DataSchema = getBaseDataSchema(),
): Page {
  switch (op.op) {
    case "text_insert":
      return applyTextInsert(state, op);
    case "text_delete":
      return applyTextDelete(state, op);
    case "mark_set":
      return applyFormatSet(state, op);
    case "block_insert":
      return applyBlockInsert(state, op, schema);
    case "block_delete":
      return applyBlockDelete(state, op);
    case "block_set":
      return applyBlockSet(state, op, schema);
    default:
      // Unknown operation type
      return state;
  }
}

/**
 * Apply a batch of operations sequentially. `schema` controls how unknown
 * block types and field validations are handled; it defaults to the built-in
 * set so the many internal callers that only ever touch built-ins are
 * unaffected.
 */
export function applyOps(
  state: Page,
  ops: Operation[],
  schema: DataSchema = getBaseDataSchema(),
): Page {
  let result = state;
  for (const op of ops) {
    result = applyOp(result, op, schema);
  }
  return result;
}

/**
 * Rebuild state from scratch by applying all operations.
 * Operations are sorted by HLC before applying.
 *
 * @param pageId - Page ID for the new state
 * @param ops - All operations to apply
 * @returns Computed page state
 */
export function rebuildState(
  pageId: string,
  ops: Operation[],
  schema: DataSchema = getBaseDataSchema(),
): Page {
  // Sort operations by HLC
  const sorted = [...ops].sort((a, b) => compareHLC(a.clock, b.clock));

  // Track which char IDs have been inserted so far, so we can detect
  // text_delete ops that reference chars not yet inserted (due to HLC
  // ordering not matching causal order when clocks weren't advanced).
  const insertedCharIds = new Set<string>();
  const deferredOps: Operation[] = [];

  // Apply operations in order
  let state = createEmptyPageState(pageId);

  for (const op of sorted) {
    // Track inserted char IDs
    if (op.op === "text_insert") {
      for (const run of op.charRuns) {
        for (let i = 0; i < run.text.length; i++) {
          insertedCharIds.add(`${run.peerId}:${run.startCounter + i}`);
        }
      }
    }

    // Defer text_delete if any referenced chars haven't been inserted yet
    if (
      op.op === "text_delete" &&
      !op.charIds.every((id) => insertedCharIds.has(id))
    ) {
      deferredOps.push(op);
      continue;
    }

    state = applyOp(state, op, schema);
  }

  // Apply deferred deletes — the chars they reference should now exist
  for (const op of deferredOps) {
    state = applyOp(state, op, schema);
  }

  return state;
}

/**
 * Get visible text content from a block (excluding deleted chars).
 */
export function getVisibleTextFromBlock(block: Block): string {
  // Image and Line blocks don't have text content
  if (!isTextualBlock(block)) {
    return "";
  }

  return getVisibleTextFromRuns(block.charRuns);
}

/**
 * Get visible blocks from state (excluding deleted blocks).
 * Each block includes its originalIndex in the full blocks array.
 */
export function getVisibleBlocks(
  state: Page,
  window?: ViewWindow,
): (Block & { originalIndex: number })[] {
  let visible: (Block & { originalIndex: number })[];
  if (window) {
    // Windowed editor (e.g. a TitleEditor sharing a Doc with a PageEditor). The
    // block instances are shared across every editor on the doc, and the loop
    // below MUTATES them (neighbour stamps, cache clear) — so a windowed editor
    // must work on private shallow copies, or two editors' derivations would
    // clobber each other's `prevType`/`nextType`/`cachedLayout`. `originalIndex`
    // is the block's true index in the full doc array, so ops still target the
    // right block even though the visible list is filtered.
    const included = window.select(state.blocks);
    visible = [];
    for (let i = 0; i < state.blocks.length; i++) {
      const b = state.blocks[i];
      if (b.deleted || !included.has(i)) continue;
      visible.push(Object.assign({ ...b } as Block, { originalIndex: i }));
    }
  } else {
    // Full-document editor: the common path. Stamp `originalIndex` in place on
    // the shared blocks so `visibleBlocks[i] === page.blocks[originalIndex]` and
    // the per-instance layout cache persists across renders.
    visible = state.blocks
      .map((b, i) => Object.assign(b, { originalIndex: i }))
      .filter((b) => !b.deleted);
  }
  // Stamp each block with its adjacent visible block types — a transient render
  // hint nodes read for neighbour-aware layout (see BlockRuntimeState). When a
  // block's join context changes, clear its memoized layout so any height/inset
  // derived from the hint is recomputed and the height index re-measures.
  // Steady-state text edits never touch neighbour types, so this never thrashes.
  for (let i = 0; i < visible.length; i++) {
    const block = visible[i];
    const prevType = i > 0 ? visible[i - 1].type : undefined;
    const nextType = i < visible.length - 1 ? visible[i + 1].type : undefined;
    if (block.prevType !== prevType || block.nextType !== nextType) {
      block.prevType = prevType;
      block.nextType = nextType;
      block.cachedLayout = undefined;
    }
  }
  return visible;
}

/**
 * Returns blocks for saving. Tombstones (deleted blocks/chars) are preserved
 * to support offline sync - peers need tombstone info to properly merge.
 * Pruning of old tombstones can be done separately.
 *
 * The ephemeral render cache (`cachedLayout`) is stripped: it is a large,
 * per-canvas-width measured-layout object — invalid across sessions/screen sizes
 * and far too heavy to persist.
 */
export function cleanSnapshotForSave(blocks: Block[]): Block[] {
  // Drop the transient render hints (`cachedLayout` and the neighbour-type
  // stamps) — all are derived from the live view and recomputed on load.
  return blocks.map(
    ({ cachedLayout: _l, prevType: _p, nextType: _n, ...rest }) =>
      rest as Block,
  );
}

// Helper functions to find next/previous visible block
export function findNextVisibleBlockIndex(
  blocks: Block[],
  startIndex: number,
): number | null {
  for (let i = startIndex + 1; i < blocks.length; i++) {
    if (!blocks[i].deleted) {
      return i;
    }
  }
  return null;
}

export function findPreviousVisibleBlockIndex(
  blocks: Block[],
  startIndex: number,
): number | null {
  for (let i = startIndex - 1; i >= 0; i--) {
    if (!blocks[i].deleted) {
      return i;
    }
  }
  return null;
}

/**
 * Whether the card block at `index` visually joins the previous/next block into
 * one continuous surface. Two adjacent blocks join when their nodes declare the
 * same {@link Node.joinGroup} — the built-in card blocks (code, math, quote)
 * share one group, so any two stacked cards tile together. Card-style nodes use
 * this to square off the shared corner so abutting backgrounds meet instead of
 * showing a rounded notch at the seam. A block whose node declares no group
 * never joins. Tombstoned blocks between two members are skipped, so a deleted
 * block never breaks a run.
 */
export function cardJoinFlags(
  nodes: NodeRegistry,
  blocks: Block[],
  index: number,
): { joinTop: boolean; joinBottom: boolean } {
  const group = nodes.get(blocks[index].type)?.joinGroup;
  if (group === undefined) return { joinTop: false, joinBottom: false };
  const sameGroup = (i: number | null): boolean =>
    i !== null && nodes.get(blocks[i].type)?.joinGroup === group;
  return {
    joinTop: sameGroup(findPreviousVisibleBlockIndex(blocks, index)),
    joinBottom: sameGroup(findNextVisibleBlockIndex(blocks, index)),
  };
}

/**
 * Find character by index in visible characters.
 * Returns the character info and its location in the runs.
 */
export function findCharByVisibleIndex(
  block: Block,
  visibleIndex: number,
): { char: Char; runIndex: number; offset: number } | null {
  // Image and Line blocks don't have text content
  if (!isTextualBlock(block)) {
    return null;
  }

  let visibleCount = 0;

  for (const { id, char, runIndex, offset } of iterateVisibleChars(
    block.charRuns,
  )) {
    if (visibleCount === visibleIndex) {
      return {
        char: { id, char },
        runIndex,
        offset,
      };
    }
    visibleCount++;
  }

  return null;
}

/**
 * Find the character ID at a given visible text position.
 * Returns null if position is at the beginning.
 */
export function findCharIdAtPosition(
  block: Block,
  position: number,
): string | null {
  if (!isTextualBlock(block)) {
    return null;
  }

  return getCharIdAtVisiblePosition(block.charRuns, position);
}
