/** Generic authoring seam for marks that own structured attachments. */

import { resolveMarkRuns } from "../inline-math-spans";
import { moveCursorToPosition, updateSelection } from "../selection";
import type { Block, Mark, Page } from "../serlization/loadPage";
import type {
  ContentEdit,
  CRDTbinding,
  EditorState,
  Operation,
  Position,
} from "../state-types";
import { findBlock } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { markCharsInRange } from "../sync/crdt-utils";
import { applyOp } from "../sync/reducer";
import type { DataSchema } from "../sync/schema";
import {
  canonicalizeStructuredDocument,
  type StructuredContentMap,
  type StructuredDocument,
} from "../sync/structured-content";

export interface CreateFeatureMarkResult {
  readonly newPage: Page;
  readonly ops: readonly Operation[];
  readonly format: Mark;
}

/** One flat compatibility range whose installed feature resolves a tree source. */
export interface ResolvedStructuredMarkRange {
  readonly markType: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface ClonedStructuredBlockContent {
  readonly structuredContent: StructuredContentMap;
  readonly clonedContentIds: Readonly<Record<string, string>>;
  readonly ops: readonly ContentEdit[];
}

/**
 * Clone every attachment owned by `source` into a newly-created block.
 *
 * Attachments are block-scoped, so copying compatibility characters and mark
 * attrs alone would leave the new block pointing back into the old one. Each
 * document-kind adapter re-addresses its own identities; core only envelopes
 * the resulting initializers and exposes the source→target id map so covering
 * marks can rewrite their references through the corresponding mark facet.
 * Returning `undefined` is deliberate when a kind has no lossless clone seam.
 */
export function cloneStructuredBlockContent(
  source: Block,
  targetBlockId: string,
  binding: CRDTbinding,
  schema: DataSchema,
): ClonedStructuredBlockContent | undefined {
  const sourceContent = source.structuredContent;
  if (!sourceContent || Object.keys(sourceContent).length === 0) {
    return { structuredContent: {}, clonedContentIds: {}, ops: [] };
  }

  const structuredContent: Record<string, StructuredDocument> = {};
  const clonedContentIds: Record<string, string> = {};
  const ops: ContentEdit[] = [];
  for (const sourceContentId of Object.keys(sourceContent).sort()) {
    const document = canonicalizeStructuredDocument(
      sourceContent[sourceContentId],
    );
    const cloned = schema.features.cloneStructuredContent({
      document,
      sourceBlockId: source.id,
      targetBlockId,
      sourceContentId,
      identities: binding,
    });
    if (!cloned || cloned.document.rootId !== cloned.contentId) {
      return undefined;
    }
    clonedContentIds[sourceContentId] = cloned.contentId;
    structuredContent[cloned.contentId] = cloned.document;
    ops.push({
      op: "content_edit",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      blockId: targetBlockId,
      contentId: cloned.contentId,
      edit: { kind: "document_init", document: cloned.document },
    });
  }
  return { structuredContent, clonedContentIds, ops };
}

/**
 * Resolve attached inline marks without importing any concrete feature.
 *
 * A non-undefined source from the schema facet is the authority signal: the
 * covered block characters are only a compatibility projection and generic
 * flat mutations must not edit them independently.
 */
export function resolveStructuredMarkRanges(
  block: Block,
  schema: DataSchema,
): ResolvedStructuredMarkRange[] {
  if (!isTextualBlock(block)) return [];
  const attachments = block.structuredContent;
  return resolveMarkRuns(block).flatMap((run) => {
    const source = schema.features.resolveStructuredMark(run.name, {
      mark: {
        type: run.name,
        ...(Object.keys(run.attrs).length > 0 ? { attrs: run.attrs } : {}),
      },
      compatibilityText: run.text,
      attachments,
    });
    return source === undefined
      ? []
      : [
          {
            markType: run.name,
            startIndex: run.startIndex,
            endIndex: run.endIndex,
          },
        ];
  });
}

/** Whether `[startIndex, endIndex)` overlaps an authoritative mark projection. */
export function rangeIntersectsStructuredMark(
  block: Block,
  startIndex: number,
  endIndex: number,
  schema: DataSchema,
  markType?: string,
): boolean {
  if (endIndex <= startIndex) return false;
  return resolveStructuredMarkRanges(block, schema).some(
    (run) =>
      (markType === undefined || run.markType === markType) &&
      startIndex < run.endIndex &&
      endIndex > run.startIndex,
  );
}

/** Whether the current non-collapsed flat selection crosses tree authority. */
export function selectionIntersectsStructuredMark(
  state: EditorState,
  markType?: string,
): boolean {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) return false;
  const [start, end] = orderedPositions(selection.anchor, selection.focus);

  // A same-point non-collapsed selection denotes an atomic/node selection.
  // Conservatively claim it when that point lies on a structured mark.
  if (
    start.blockIndex === end.blockIndex &&
    start.textIndex === end.textIndex
  ) {
    const block = state.document.page.blocks[start.blockIndex];
    return !!(
      block &&
      !block.deleted &&
      resolveStructuredMarkRanges(block, state.schema).some(
        (run) =>
          (markType === undefined || run.markType === markType) &&
          start.textIndex >= run.startIndex &&
          start.textIndex <= run.endIndex,
      )
    );
  }

  for (
    let blockIndex = start.blockIndex;
    blockIndex <= end.blockIndex;
    blockIndex++
  ) {
    const block = state.document.page.blocks[blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) continue;
    const from = blockIndex === start.blockIndex ? start.textIndex : 0;
    const to =
      blockIndex === end.blockIndex ? end.textIndex : Number.POSITIVE_INFINITY;
    if (
      rangeIntersectsStructuredMark(block, from, to, state.schema, markType)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a flat range cuts through, rather than wholly contains, a structured
 * mark projection. Whole projections are safe atomic units; partial projections
 * must be expanded or claimed before generic text code can mutate them.
 */
export function selectionPartiallyIntersectsStructuredMark(
  state: EditorState,
  markType?: string,
): boolean {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) return false;
  const [start, end] = orderedPositions(selection.anchor, selection.focus);

  for (
    let blockIndex = start.blockIndex;
    blockIndex <= end.blockIndex;
    blockIndex++
  ) {
    const block = state.document.page.blocks[blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) continue;
    const from = blockIndex === start.blockIndex ? start.textIndex : 0;
    const to =
      blockIndex === end.blockIndex ? end.textIndex : Number.POSITIVE_INFINITY;
    for (const run of resolveStructuredMarkRanges(block, state.schema)) {
      if (markType !== undefined && run.markType !== markType) continue;
      const intersects =
        from === to
          ? from > run.startIndex && from < run.endIndex
          : from < run.endIndex && to > run.startIndex;
      if (intersects && (from > run.startIndex || to < run.endIndex)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Expand flat selection edges to whole structured-mark projections.
 *
 * This is the mixed prose/tree selection bridge: the editor keeps its ordinary
 * flat range API, while a formula touched at either edge behaves as one atomic
 * inline unit. Interior projections are already wholly selected. Direction is
 * preserved so Shift+Arrow and drag selection keep the expected focus edge.
 */
export function expandSelectionAroundStructuredMarks(
  state: EditorState,
  markType?: string,
): EditorState {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) return state;
  const [orderedStart, orderedEnd] = orderedPositions(
    selection.anchor,
    selection.focus,
  );
  let start = orderedStart;
  let end = orderedEnd;

  const startBlock = state.document.page.blocks[start.blockIndex];
  if (startBlock && !startBlock.deleted && isTextualBlock(startBlock)) {
    for (const run of resolveStructuredMarkRanges(startBlock, state.schema)) {
      if (markType !== undefined && run.markType !== markType) continue;
      if (start.textIndex > run.startIndex && start.textIndex < run.endIndex) {
        start = { ...start, textIndex: run.startIndex };
      }
    }
  }

  const endBlock = state.document.page.blocks[end.blockIndex];
  if (endBlock && !endBlock.deleted && isTextualBlock(endBlock)) {
    for (const run of resolveStructuredMarkRanges(endBlock, state.schema)) {
      if (markType !== undefined && run.markType !== markType) continue;
      if (end.textIndex > run.startIndex && end.textIndex < run.endIndex) {
        end = { ...end, textIndex: run.endIndex };
      }
    }
  }

  if (
    start.blockIndex === orderedStart.blockIndex &&
    start.textIndex === orderedStart.textIndex &&
    end.blockIndex === orderedEnd.blockIndex &&
    end.textIndex === orderedEnd.textIndex
  ) {
    return state;
  }

  const anchor = selection.isForward ? start : end;
  const focus = selection.isForward ? end : start;
  return updateSelection(
    moveCursorToPosition(state, focus.blockIndex, focus.textIndex),
    { anchor, focus },
  );
}

/** Whether flat typing would land inside (not merely beside) tree authority. */
export function cursorInsideStructuredMark(
  state: EditorState,
  markType?: string,
): boolean {
  // The cursor tracks a flat selection's focus for rendering/navigation. It is
  // not an independent insertion point while that selection is non-collapsed.
  if (state.document.selection && !state.document.selection.isCollapsed) {
    return false;
  }
  const position = state.document.cursor?.position;
  if (!position) return false;
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted) return false;
  return resolveStructuredMarkRanges(block, state.schema).some(
    (run) =>
      (markType === undefined || run.markType === markType) &&
      position.textIndex > run.startIndex &&
      position.textIndex < run.endIndex,
  );
}

/** Whether one flat Backspace/Delete unit would touch a tree-owned projection. */
export function flatDeleteTouchesStructuredMark(
  state: EditorState,
  direction: "backward" | "forward",
  markType?: string,
): boolean {
  if (selectionIntersectsStructuredMark(state, markType)) return true;
  const position = state.document.cursor?.position;
  if (!position) return false;
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted) return false;
  const from =
    direction === "backward"
      ? Math.max(0, position.textIndex - 1)
      : position.textIndex;
  const to =
    direction === "backward" ? position.textIndex : position.textIndex + 1;
  return rangeIntersectsStructuredMark(block, from, to, state.schema, markType);
}

function orderedPositions(
  left: Position,
  right: Position,
): [Position, Position] {
  return left.blockIndex < right.blockIndex ||
    (left.blockIndex === right.blockIndex && left.textIndex <= right.textIndex)
    ? [left, right]
    : [right, left];
}

/**
 * Create a genuinely new mark and any feature-owned attachments atomically.
 *
 * The core dispatches by schema facet and never imports the feature. Callers
 * must use this only at a new-mark boundary; extending/reapplying an existing
 * mark must preserve that mark's persisted attrs instead of allocating another
 * attachment. A caller that activates this seam must also route every later
 * edit/delete for the mark to its structured document (or keep the mark atomic
 * and read-only). Generic flat-character editing intentionally does not invoke
 * this helper: attaching a tree and then editing only its compatibility source
 * would make rendering/export silently stale.
 */
export function createFeatureMarkInRange(
  page: Page,
  blockId: string,
  startIndex: number,
  endIndex: number,
  requested: Mark,
  binding: CRDTbinding,
  schema: DataSchema,
): CreateFeatureMarkResult {
  const block = findBlock(page, blockId);
  if (
    !block ||
    block.deleted ||
    !isTextualBlock(block) ||
    startIndex < 0 ||
    endIndex <= startIndex
  ) {
    return { newPage: page, ops: [], format: requested };
  }
  const text = getVisibleTextFromRuns(block.charRuns).slice(
    startIndex,
    endIndex,
  );
  if (text.length === 0) {
    return { newPage: page, ops: [], format: requested };
  }

  const created = schema.features.createStructuredMark(requested.type, {
    mark: requested,
    text,
    identities: binding,
  });
  if (created && created.mark.type !== requested.type) {
    throw new Error(
      `Structured mark facet for "${requested.type}" returned type "${created.mark.type}"`,
    );
  }

  let nextPage = page;
  const ops: Operation[] = [];
  const seenContentIds = new Set<string>();
  for (const attachment of created?.attachments ?? []) {
    if (
      attachment.contentId.length === 0 ||
      seenContentIds.has(attachment.contentId)
    ) {
      throw new Error(
        `Structured mark facet for "${requested.type}" returned an invalid attachment id`,
      );
    }
    seenContentIds.add(attachment.contentId);
    const op: ContentEdit = {
      op: "content_edit",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      blockId,
      contentId: attachment.contentId,
      edit: attachment.edit,
    };
    const applied = applyOp(nextPage, op, schema);
    if (applied === nextPage) {
      throw new Error(
        `Structured mark facet for "${requested.type}" returned an attachment rejected by the document`,
      );
    }
    nextPage = applied;
    ops.push(op);
  }

  const marked = markCharsInRange(
    nextPage,
    blockId,
    startIndex,
    endIndex,
    created?.mark ?? requested,
    true,
    binding,
  );
  nextPage = marked.newPage;
  ops.push(marked.op);
  return {
    newPage: nextPage,
    ops,
    format: created?.mark ?? requested,
  };
}
