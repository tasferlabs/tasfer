/** Generic authoring seam for marks that own structured attachments. */

import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { type MarkRunData, resolveMarkRuns } from "../mark-runs";
import {
  moveCursorToPosition,
  startSelection,
  updateCursor,
  updateSelection,
  updateSelectionFocus,
} from "../selection";
import type { Block, Mark, Page } from "../serlization/loadPage";
import type {
  ContentEdit,
  CRDTbinding,
  EditorState,
  Operation,
  Position,
} from "../state-types";
import {
  type ContentPoint,
  updateContentSelection,
} from "../structured-selection";
import { findBlock, findBlockIndex } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "../sync/crdt-utils";
import { applyOp } from "../sync/reducer";
import type { DataSchema } from "../sync/schema";
import {
  adoptAttachmentsFromPage,
  canonicalizeStructuredDocument,
  type StructuredContentMap,
  type StructuredDocument,
} from "../sync/structured-content";

export interface CreateFeatureMarkResult {
  readonly newPage: Page;
  readonly ops: readonly Operation[];
  readonly format: Mark;
  /** Flat start of the resulting mark, including any adjacent absorbed runs. */
  readonly startIndex: number;
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
 *
 * `only` restricts the clone to the listed content ids — a block split moves
 * just the attachments whose runs leave the block, while a whole-block merge
 * omits it and clones everything.
 */
export function cloneStructuredBlockContent(
  source: Block,
  targetBlockId: string,
  binding: CRDTbinding,
  schema: DataSchema,
  only?: ReadonlySet<string>,
): ClonedStructuredBlockContent | undefined {
  const sourceContent = source.structuredContent;
  if (!sourceContent || Object.keys(sourceContent).length === 0) {
    return { structuredContent: {}, clonedContentIds: {}, ops: [] };
  }

  const structuredContent: Record<string, StructuredDocument> = {};
  const clonedContentIds: Record<string, string> = {};
  const ops: ContentEdit[] = [];
  for (const sourceContentId of Object.keys(sourceContent).sort()) {
    if (only && !only.has(sourceContentId)) continue;
    const document = canonicalizeStructuredDocument(
      sourceContent[sourceContentId],
    );
    const cloned = schema.cloneStructuredContent({
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
 * A copy of `block` with the attachments its structured marks reference but no
 * longer carry adopted back from the rest of the page (tombstoned donors
 * included) — the write-side counterpart of the reducer's mark_set heal. A
 * merge or split cloning this block then re-addresses a previously dangling
 * reference into a proper target-scoped clone instead of fossilizing it.
 */
export function withAdoptedMarkAttachments<T extends Block>(
  block: T,
  page: Page,
  schema: DataSchema,
): T {
  if (!isTextualBlock(block)) return block;
  const references = block.formats.flatMap((span) =>
    schema.structuredMarkReferences(span.format.type, {
      mark: span.format,
      attachments: block.structuredContent,
    }),
  );
  if (references.length === 0) return block;
  const adopted = adoptAttachmentsFromPage(page, block, references);
  if (!adopted) return block;
  return {
    ...block,
    structuredContent: { ...(block.structuredContent ?? {}), ...adopted },
  };
}

/**
 * Whether every attachment `block`'s marks reference AND `block` actually owns
 * received a target-scoped clone.
 *
 * The re-addressing step downstream falls back to the source mark verbatim when
 * a feature declines to rewrite it, which is right for a plain mark but writes
 * an unsatisfiable reference into the log for a structured one — the attachment
 * stays on the source block, which the same transaction tombstones. Callers
 * check this first and take their existing refusal branch instead.
 *
 * A reference the source does not own either is already broken: no clone could
 * repair it, so it must not block the edit.
 */
export function structuredMarkClonesComplete(
  block: Block,
  clonedContentIds: Readonly<Record<string, string>>,
  schema: DataSchema,
): boolean {
  if (!isTextualBlock(block)) return true;
  const attachments = block.structuredContent;
  if (!attachments || Object.keys(attachments).length === 0) return true;
  return block.formats.every((span) =>
    schema
      .structuredMarkReferences(span.format.type, {
        mark: span.format,
        attachments,
      })
      .every((contentId) => !attachments[contentId] || clonedContentIds[contentId]),
  );
}

/**
 * Resolve structured inline marks without importing any concrete feature.
 *
 * A mark whose spec registers a structured facet is the authority signal: the
 * covered block character is only an anchor placeholder and generic flat
 * mutations must not edit the run's content — even when the referenced
 * attachment is broken (the run then renders a placeholder but stays atomic).
 */
export function resolveStructuredMarkRanges(
  block: Block,
  schema: DataSchema,
): ResolvedStructuredMarkRange[] {
  if (!isTextualBlock(block)) return [];
  return resolveMarkRuns(block).flatMap((run) =>
    schema.structuredMark(run.name) === undefined
      ? []
      : [
          {
            markType: run.name,
            startIndex: run.startIndex,
            endIndex: run.endIndex,
          },
        ],
  );
}

/**
 * Content ids referenced by mark runs lying wholly at/after `textIndex` — the
 * attachments a block split at `textIndex` must move along with the trailing
 * text (as clones; see {@link cloneStructuredBlockContent}).
 */
export function structuredMarkContentIdsFrom(
  block: Block,
  textIndex: number,
  schema: DataSchema,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!isTextualBlock(block)) return ids;
  const attachments = block.structuredContent;
  if (!attachments || Object.keys(attachments).length === 0) return ids;
  for (const run of resolveMarkRuns(block)) {
    if (run.startIndex < textIndex) continue;
    for (const contentId of schema.structuredMarkReferences(run.name, {
      mark: {
        type: run.name,
        ...(Object.keys(run.attrs).length > 0 ? { attrs: run.attrs } : {}),
      },
      attachments,
    })) {
      if (attachments[contentId]) ids.add(contentId);
    }
  }
  return ids;
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

/**
 * The source text a new structured mark of `markType` should own for
 * `[startIndex, endIndex)`.
 *
 * Characters outside any structured run are taken literally. A run of the SAME
 * mark type lying wholly inside the range is ABSORBED rather than copied: its
 * flat projection is a content-free anchor char, so it expands to the source
 * its attachment resolves to (a legacy run with no resolvable attachment falls
 * back to its own characters, which are its source). That makes "select a
 * formula plus the text after it → mark as math" produce one formula over the
 * whole thing instead of a chip whose source is a placeholder glyph.
 *
 * Returns undefined when the range clips a projection or covers a structured
 * run of a DIFFERENT type — neither has a meaningful flattened source, so
 * callers keep their conservative no-op.
 */
export function structuredMarkSourceForRange(
  block: Block,
  startIndex: number,
  endIndex: number,
  markType: string,
  schema: DataSchema,
): string | undefined {
  if (!isTextualBlock(block)) return undefined;
  const text = getVisibleTextFromRuns(block.charRuns).slice(
    startIndex,
    endIndex,
  );
  const covered = structuredRunsInRange(block, startIndex, endIndex, schema);
  if (covered === undefined) return undefined;
  if (covered.some((run) => run.name !== markType)) return undefined;
  if (covered.length === 0) return text;

  const attachments = block.structuredContent ?? {};
  let source = "";
  let cursor = startIndex;
  const append = (fragment: string) => {
    source = schema.joinStructuredMarkSources(markType, source, fragment);
  };
  for (const run of covered) {
    append(text.slice(cursor - startIndex, run.startIndex - startIndex));
    append(
      schema.resolveStructuredMark(run.name, {
        mark: {
          type: run.name,
          ...(Object.keys(run.attrs).length > 0 ? { attrs: run.attrs } : {}),
        },
        attachments,
      }) ?? run.text,
    );
    cursor = run.endIndex;
  }
  append(text.slice(cursor - startIndex));
  return source;
}

/** Expand a new structured mark over resolvable same-type runs it touches. */
function includeAdjacentStructuredRuns(
  block: Block,
  startIndex: number,
  endIndex: number,
  markType: string,
  schema: DataSchema,
): { startIndex: number; endIndex: number } {
  if (!isTextualBlock(block)) return { startIndex, endIndex };
  const attachments = block.structuredContent;
  const runs = resolveMarkRuns(block)
    .filter((run) => run.name === markType)
    .sort((left, right) => left.startIndex - right.startIndex);
  let start = startIndex;
  let end = endIndex;
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of runs) {
      if (run.endIndex !== start && run.startIndex !== end) continue;
      const source = schema.resolveStructuredMark(markType, {
        mark: {
          type: markType,
          ...(Object.keys(run.attrs).length > 0 ? { attrs: run.attrs } : {}),
        },
        attachments,
      });
      if (source === undefined && run.text === STRUCTURED_MARK_ANCHOR_CHAR) {
        continue;
      }
      if (run.endIndex === start) start = run.startIndex;
      if (run.startIndex === end) end = run.endIndex;
      changed = true;
    }
  }
  return { startIndex: start, endIndex: end };
}

/**
 * Structured runs `[startIndex, endIndex)` wholly contains, in flat order, or
 * undefined when the range cuts through one. A half-covered projection is not
 * a unit any generic text path may flatten or delete.
 */
function structuredRunsInRange(
  block: Block,
  startIndex: number,
  endIndex: number,
  schema: DataSchema,
): MarkRunData[] | undefined {
  if (!isTextualBlock(block)) return [];
  const structured = resolveMarkRuns(block).filter(
    (run) =>
      schema.structuredMark(run.name) !== undefined &&
      startIndex < run.endIndex &&
      endIndex > run.startIndex,
  );
  if (
    structured.some(
      (run) => run.startIndex < startIndex || run.endIndex > endIndex,
    )
  ) {
    return undefined;
  }
  return structured.sort((left, right) => left.startIndex - right.startIndex);
}

/**
 * Whether marking `[startIndex, endIndex)` as `markType` would absorb existing
 * projections into a bigger one, rather than re-wrap a single existing mark.
 *
 * Re-wrapping one whole projection in its own mark type is the toggle/unwrap
 * gesture and stays a no-op here; swallowing a projection together with
 * anything else — surrounding text, or a second projection — is a genuine
 * "make all of this one formula" request that {@link createFeatureMarkInRange}
 * can serve through {@link structuredMarkSourceForRange}.
 */
export function rangeAbsorbsStructuredMarks(
  block: Block,
  startIndex: number,
  endIndex: number,
  markType: string,
  schema: DataSchema,
): boolean {
  if (endIndex <= startIndex) return false;
  if (schema.structuredMark(markType) === undefined) return false;
  const covered = structuredRunsInRange(block, startIndex, endIndex, schema);
  if (covered === undefined || covered.length === 0) return false;
  if (covered.some((run) => run.name !== markType)) return false;
  const soleRun =
    covered.length === 1 &&
    covered[0].startIndex === startIndex &&
    covered[0].endIndex === endIndex;
  return !soleRun;
}

/**
 * {@link rangeAbsorbsStructuredMarks} for the current flat selection.
 *
 * Single-block only: the structured create path replaces one flat range with
 * one anchor char, so a selection spanning blocks has no single formula to
 * become and keeps the conservative no-op.
 */
export function selectionAbsorbsStructuredMarks(
  state: EditorState,
  markType: string,
): boolean {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) return false;
  const [start, end] = orderedPositions(selection.anchor, selection.focus);
  if (start.blockIndex !== end.blockIndex) return false;
  const block = state.document.page.blocks[start.blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return false;
  return rangeAbsorbsStructuredMarks(
    block,
    start.textIndex,
    end.textIndex,
    markType,
    state.schema,
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

/**
 * The replacement-mark run whose structured attachment owns `point`, resolved
 * through the generic references facet (the core names no mark type). Returns
 * the run's flat projection bounds, or `null` when the point's block/content
 * no longer resolves — e.g. the attachment belongs to a whole-block node
 * rather than an inline mark.
 */
export function structuredMarkRunForContentPoint(
  state: EditorState,
  point: ContentPoint,
): { blockIndex: number; startIndex: number; endIndex: number } | null {
  const blockIndex = findBlockIndex(state.document.page, point.blockId);
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return null;
  const attachments = block.structuredContent;
  for (const run of resolveMarkRuns(block)) {
    const references = state.schema.structuredMarkReferences(run.name, {
      mark: {
        type: run.name,
        ...(Object.keys(run.attrs).length > 0 ? { attrs: run.attrs } : {}),
      },
      attachments,
    });
    if (references.includes(point.contentId)) {
      return { blockIndex, startIndex: run.startIndex, endIndex: run.endIndex };
    }
  }
  return null;
}

/**
 * Degrade the active nested selection to a FLAT selection so a gesture can
 * continue into the host text — the text↔structured-mark crossing for drags
 * and Shift+Click. Interior nested stops have no flat counterpart (the run is
 * a single anchor character), so the mark is covered whole: the anchor lands on the run edge
 * facing away from `target`, and the focus extends to `target` through the
 * ordinary construct-snapping path. Returns `null` when the nested selection
 * doesn't belong to an inline mark run (e.g. a block-level attachment).
 */
export function extendSelectionOutOfStructuredMark(
  state: EditorState,
  target: Position,
): EditorState | null {
  const content = state.document.contentSelection;
  if (!content) return null;
  const run = structuredMarkRunForContentPoint(state, content.anchor);
  if (!run) return null;
  const targetIsBefore =
    target.blockIndex < run.blockIndex ||
    (target.blockIndex === run.blockIndex &&
      target.textIndex <= run.startIndex);
  const anchor: Position = {
    blockIndex: run.blockIndex,
    textIndex: targetIsBefore ? run.endIndex : run.startIndex,
  };
  let next = updateContentSelection(state, null);
  next = startSelection(updateCursor(next, anchor), anchor);
  return updateSelectionFocus(next, target);
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

/**
 * Attachment cleanup for deleting `[startIndex, endIndex)` from `block`.
 *
 * A structured mark wholly inside the deleted range dies with its characters:
 * its span stops resolving once every covered char is tombstoned. Deleting the
 * chars alone would strand the attachments it references as unreachable
 * structured content, so the same transaction deletes those documents. An
 * attachment still referenced by a run outside the range is kept, and runs
 * merely clipped by the range keep everything — callers expand clipped edges
 * to whole projections before deleting.
 */
export function structuredMarkAttachmentCleanupOps(
  block: Block,
  startIndex: number,
  endIndex: number,
  binding: CRDTbinding,
  schema: DataSchema,
): ContentEdit[] {
  if (endIndex <= startIndex || !isTextualBlock(block)) return [];
  const attachments = block.structuredContent;
  if (!attachments || Object.keys(attachments).length === 0) return [];

  const references = (run: {
    readonly name: string;
    readonly attrs: Record<string, unknown>;
  }): readonly string[] =>
    schema.structuredMarkReferences(run.name, {
      mark: {
        type: run.name,
        ...(Object.keys(run.attrs).length > 0 ? { attrs: run.attrs } : {}),
      },
      attachments,
    });

  const dying = new Set<string>();
  const surviving = new Set<string>();
  for (const run of resolveMarkRuns(block)) {
    const wholeRunDies =
      run.startIndex >= startIndex && run.endIndex <= endIndex;
    for (const contentId of references(run)) {
      (wholeRunDies ? dying : surviving).add(contentId);
    }
  }

  const ops: ContentEdit[] = [];
  for (const contentId of [...dying].sort()) {
    if (surviving.has(contentId) || !attachments[contentId]) continue;
    ops.push({
      op: "content_edit",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      blockId: block.id,
      contentId,
      edit: { kind: "document_delete" },
    });
  }
  return ops;
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
 * The core dispatches by schema facet and never imports the feature. For a
 * structured mark the covered text becomes the new attachment's source and
 * the flat range is REPLACED by one {@link STRUCTURED_MARK_ANCHOR_CHAR}
 * carrying the mark — the attachment is the only content authority, so no
 * source text remains in block characters. A mark type without a structured
 * facet keeps plain char marking. Callers must use this only at a new-mark
 * boundary; extending/reapplying an existing mark must preserve that mark's
 * persisted attrs instead of allocating another attachment.
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
    return { newPage: page, ops: [], format: requested, startIndex };
  }
  if (schema.structuredMark(requested.type) !== undefined) {
    ({ startIndex, endIndex } = includeAdjacentStructuredRuns(
      block,
      startIndex,
      endIndex,
      requested.type,
      schema,
    ));
  }
  // For a structured mark, projections of the same type inside the range are
  // absorbed into the new source instead of contributing their content-free
  // anchor char; the attachments they leave behind are deleted below, in this
  // transaction. A plain mark keeps the literal flat slice.
  const text =
    schema.structuredMark(requested.type) === undefined
      ? getVisibleTextFromRuns(block.charRuns).slice(startIndex, endIndex)
      : structuredMarkSourceForRange(
          block,
          startIndex,
          endIndex,
          requested.type,
          schema,
        );
  if (text === undefined || text.length === 0) {
    return { newPage: page, ops: [], format: requested, startIndex };
  }

  const created = schema.createStructuredMark(requested.type, {
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

  if (!created) {
    const marked = markCharsInRange(
      nextPage,
      blockId,
      startIndex,
      endIndex,
      requested,
      true,
      binding,
    );
    nextPage = marked.newPage;
    ops.push(marked.op);
    return { newPage: nextPage, ops, format: requested, startIndex };
  }

  // Any projection the new source absorbed is about to lose its anchor char,
  // so its attachment dies with it — same transaction, or the block keeps
  // unreachable structured content.
  for (const cleanup of structuredMarkAttachmentCleanupOps(
    block,
    startIndex,
    endIndex,
    binding,
    schema,
  )) {
    nextPage = applyOp(nextPage, cleanup, schema);
    ops.push(cleanup);
  }

  // Replace the captured range with the mark's single anchor char. The anchor
  // is inserted AFTER the range before the range is deleted, so it can never
  // be adopted between a neighbouring span's boundary identities once the old
  // chars become tombstones (the same CRDT footing block splits use).
  const inserted = insertCharsAtPosition(
    nextPage,
    blockId,
    endIndex,
    STRUCTURED_MARK_ANCHOR_CHAR,
    binding,
  );
  nextPage = inserted.newPage;
  ops.push(inserted.op);
  const removed = deleteCharsInRange(
    nextPage,
    blockId,
    startIndex,
    endIndex,
    binding,
  );
  nextPage = removed.newPage;
  ops.push(removed.op);
  const marked = markCharsInRange(
    nextPage,
    blockId,
    startIndex,
    startIndex + 1,
    created.mark,
    true,
    binding,
  );
  nextPage = marked.newPage;
  ops.push(marked.op);
  return { newPage: nextPage, ops, format: created.mark, startIndex };
}
