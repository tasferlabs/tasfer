/**
 * The table under the caret — resolved once, for every surface that edits one.
 *
 * Navigation (`./actions`), typing (`./input`) and the structural commands
 * (`./commands`) all begin the same way: find the block the nested caret is in,
 * confirm it is a table, and translate the caret into cell addresses. They also
 * all end the same way, turning a batch of {@link StructuredEdit}s into
 * `content_edit` operations and re-parking the caret. Both halves live here so
 * the three cannot drift on what "the active table" means.
 */

import {
  cellRuns,
  type TableCaret,
  tableCaretFromContentPoint,
  tableCaretToContentSelection,
  tableCellIds,
} from "./selection";
import { CELL_TEXT_FIELD, getTableDocument } from "./structured";
import type { StateResult } from "@tasfer/editor/action-bus";
import { resolveMarkRunsFromChars } from "@tasfer/editor/mark-runs";
import { clearSelection, moveCursorToPosition } from "@tasfer/editor/selection";
import type { Block, Page } from "@tasfer/editor/serlization/loadPage";
import type {
  ContentEdit,
  EditorState,
  Operation,
  Position,
} from "@tasfer/editor/state-types";
import {
  type ContentSelection,
  updateContentSelection,
} from "@tasfer/editor/structured-selection";
import { iterateAllChars } from "@tasfer/editor/sync/char-runs";
import { applyOp } from "@tasfer/editor/sync/reducer";
import type { DataSchema } from "@tasfer/editor/sync/schema";
import type {
  StructuredContentMap,
  StructuredDocument,
  StructuredEdit,
} from "@tasfer/editor/sync/structured-content";
import {
  type FieldRange,
  type FieldRun,
  runFieldAsParagraph,
  type TextFieldAddress,
} from "@tasfer/editor/text-field-paragraph";

/** A claimed handler result: state changed (or deliberately did not), plus ops. */
export type Claimed = StateResult & { readonly handled: true };

/** The table the nested caret currently addresses, and where in it. */
export interface TableContext {
  readonly block: Block;
  readonly blockIndex: number;
  readonly document: StructuredDocument;
  /** The moving end of the selection. */
  readonly caret: TableCaret;
  /** The fixed end; equal to {@link caret} when the selection is collapsed. */
  readonly anchor: TableCaret;
  /**
   * The selection inside a cell's formula, when the caret is in one — the
   * formula's own tree, which the paragraph code edits (see {@link runInCell}).
   * {@link caret} and {@link anchor} then both sit on the formula's start in
   * its cell, which is where the grid's own moves start from.
   */
  readonly content?: ContentSelection;
}

/**
 * A table a command acts on, without assuming the caret is in it.
 *
 * {@link activeTableContext} is the caret's answer to "which table", and it is
 * the right one for typing and for the structural menu, which are both anchored
 * to the cell the caret sits in. An on-canvas control is anchored to the
 * POINTER instead — the edge "add" strips act on the table under the mouse,
 * which may be a different table, or one no caret is in at all. Both resolve to
 * this, so a command written against it does not care which way in was used.
 */
export type TableTarget = Pick<
  TableContext,
  "block" | "blockIndex" | "document"
> & {
  /** Where the caret is, when it is in this table at all. */
  readonly caret?: TableCaret;
};

/** The table attached to `blockId`, or `undefined` when that block is not one. */
export function tableTargetForBlock(
  state: EditorState,
  blockId: string,
): TableTarget | undefined {
  const blockIndex = state.document.page.blocks.findIndex(
    (candidate) => candidate.id === blockId,
  );
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || (block.type as string) !== "table") {
    return undefined;
  }
  const document = getTableDocument(block);
  if (!document) return undefined;
  // The caret is carried when it happens to be in this same table, so a
  // pointer-driven command with no explicit target still falls back to it.
  const active = activeTableContext(state);
  const caret = active?.block.id === blockId ? active.caret : undefined;
  return { block, blockIndex, document, caret };
}

/**
 * Resolve the active table, or `undefined` when the caret is elsewhere.
 *
 * An anchor that is not a text point (a gap between nodes, which a table never
 * produces) collapses onto the focus rather than failing the whole lookup — the
 * caret is still unambiguously inside a cell.
 */
export function activeTableContext(
  state: EditorState,
): TableContext | undefined {
  const selection = state.document.contentSelection;
  const focus = selection?.focus;
  if (!selection || !focus) return undefined;
  const blockIndex = state.document.page.blocks.findIndex(
    (candidate) => candidate.id === focus.blockId,
  );
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || (block.type as string) !== "table") {
    return undefined;
  }
  const document = getTableDocument(block);
  if (!document) return undefined;
  if (document.rootId !== focus.contentId) {
    // Not the grid's own document: a caret inside one of its cells' formulas.
    if (selection.anchor.contentId !== focus.contentId) return undefined;
    const at = cellHoldingAttachment(
      state.schema,
      block,
      document,
      focus.contentId,
    );
    return at
      ? {
          block,
          blockIndex,
          document,
          caret: at,
          anchor: at,
          content: selection,
        }
      : undefined;
  }
  if (focus.kind !== "text") return undefined;
  const caret = tableCaretFromContentPoint(document, focus);
  if (!caret) return undefined;
  const anchor =
    selection.anchor.kind === "text"
      ? (tableCaretFromContentPoint(document, selection.anchor) ?? caret)
      : caret;
  return { block, blockIndex, document, caret, anchor };
}

/**
 * The cell whose text holds the structured mark (an inline formula) pointing at
 * attachment `contentId` on the table block, at the mark's start.
 */
export function cellHoldingAttachment(
  schema: DataSchema,
  block: Block,
  document: StructuredDocument,
  contentId: string,
): TableCaret | undefined {
  for (const cellId of tableCellIds(document)) {
    const spans = document.nodes[cellId]?.markFields?.[CELL_TEXT_FIELD];
    if (!spans?.length) continue;
    const runs = cellRuns(document, cellId) ?? [];
    for (const run of resolveMarkRunsFromChars(iterateAllChars(runs), spans)) {
      if (!schema.structuredMark(run.name)) continue;
      const references = schema.structuredMarkReferences(run.name, {
        mark: { type: run.name, attrs: run.attrs },
        attachments: block.structuredContent,
      });
      if (references.includes(contentId)) {
        return { cellId, offset: run.startIndex };
      }
    }
  }
  return undefined;
}

/** One `content_edit` operation carrying `edit` against a table's attachment. */
export function tableContentEdit(
  state: EditorState,
  blockId: string,
  contentId: string,
  edit: StructuredEdit,
): ContentEdit {
  return {
    op: "content_edit",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId,
    contentId,
    edit,
  };
}

/**
 * Apply `edits` to the page as operations, then park the caret at `caret`.
 *
 * Every table mutation goes through here, so a structural command and a typed
 * character reach the CRDT by exactly the same route — which is what makes them
 * merge, undo and sync alike. A `caret` of `undefined` leaves the selection
 * where it is (the edits did not move it).
 *
 * `attachments` are new documents for the table block to hold beside the
 * table's own — what a pasted cell formula points at. They are written first,
 * so no mark ever references an attachment the log has not created yet, and
 * an undo (which replays in reverse) removes the mark before its attachment.
 */
export function commitTableEdits(
  state: EditorState,
  context: Pick<TableContext, "block" | "document">,
  edits: readonly StructuredEdit[],
  caret: TableCaret | undefined,
  attachments?: StructuredContentMap,
): Claimed {
  let page = state.document.page;
  const ops: Operation[] = [];
  for (const contentId of Object.keys(attachments ?? {}).sort()) {
    const operation: ContentEdit = {
      op: "content_edit",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: context.block.id,
      contentId,
      edit: { kind: "document_init", document: attachments![contentId] },
    };
    page = applyOp(page, operation, state.schema);
    ops.push(operation);
  }
  for (const edit of edits) {
    const operation = tableContentEdit(
      state,
      context.block.id,
      context.document.rootId,
      edit,
    );
    page = applyOp(page, operation, state.schema);
    ops.push(operation);
  }

  const block = page.blocks.find(
    (candidate) => candidate.id === context.block.id,
  );
  const document = block ? getTableDocument(block) : undefined;
  if (!block || !document) return { state, ops, handled: true };
  // The grid's own geometry changed with its content, so the memoized layout is
  // stale — a wider cell, or one column more, re-fits every other column.
  block.cachedLayout = undefined;

  let next: EditorState = { ...state, document: { ...state.document, page } };
  if (!caret) return { state: next, ops, handled: true };
  const selection = tableCaretToContentSelection(
    document,
    context.block.id,
    caret,
  );
  if (selection) {
    next = updateContentSelection(clearSelection(next), {
      ...selection,
      lastUpdate: Date.now(),
    });
  }
  return { state: next, ops, handled: true };
}

/** A cell's text, addressed the way the paragraph code borrows it. */
export function cellField(
  context: Pick<TableContext, "block" | "document">,
  cellId: string,
): TextFieldAddress {
  return {
    blockId: context.block.id,
    contentId: context.document.rootId,
    nodeId: cellId,
    field: CELL_TEXT_FIELD,
  };
}

/**
 * Run a paragraph action on a cell — by default the one the selection is in,
 * over the selection's range there. The caller keeps a range across cells for
 * itself: that is the grid's to handle, not a paragraph's.
 *
 * This is how every in-cell text behaviour is implemented: the engine's own
 * flat-text action, run on the cell (see `@tasfer/editor/text-field-paragraph`).
 */
export function runInCell(
  state: EditorState,
  context: Pick<
    TableContext,
    "block" | "document" | "caret" | "anchor" | "content"
  >,
  action: (paragraph: EditorState) => StateResult,
  range: FieldRange = {
    anchor: context.anchor.offset,
    focus: context.caret.offset,
    ...(context.content ? { content: context.content } : {}),
  },
  cellId: string = context.caret.cellId,
): FieldRun {
  return runFieldAsParagraph(state, cellField(context, cellId), range, action);
}

/**
 * A paragraph run as a claimed result. A refused run — the paragraph code
 * reached for something a cell cannot hold — stays claimed and changes
 * nothing, so the key never falls through to flat-text handling either.
 */
export function claimRun(state: EditorState, run: FieldRun): Claimed {
  return run.kind === "applied"
    ? { state: run.state, ops: run.ops, handled: true }
    : { state, ops: [], handled: true };
}

/**
 * Hold the table whole: leave the cell and select the block itself.
 *
 * The step that makes a table deletable from the inside. A block equation does
 * the same thing at its leading edge, and for the same reason — a destructive
 * key inside a container should first show you what it is about to take.
 *
 * A "node selection" is not a flag but core's sentinel: a non-collapsed flat
 * selection whose ends are the same position. The order matters. The nested
 * caret is cleared FIRST, because while it is set `activeTableContext` still
 * resolves and the table's own handlers would claim the follow-up key into a
 * no-op; the flat cursor is then placed, because core resolves the sentinel
 * only when a cursor exists. No operations — holding a block mutates nothing.
 */
export function selectTableBlock(
  state: EditorState,
  context: Pick<TableContext, "blockIndex">,
): Claimed {
  const position: Position = { blockIndex: context.blockIndex, textIndex: 0 };
  let next = updateContentSelection(state, null);
  next = moveCursorToPosition(next, context.blockIndex, 0);
  next = {
    ...next,
    document: {
      ...next.document,
      selection: {
        anchor: position,
        focus: position,
        isForward: true,
        isCollapsed: false,
        lastUpdate: Date.now(),
      },
    },
  };
  return { state: next, ops: [], handled: true };
}

/**
 * Replace a table's attachment locally, emitting no operations.
 *
 * Used only by the column-resize drag, which repaints on every pointer move but
 * must not write an operation per frame — the same bargain the image-resize
 * drag strikes, which updates the block live and emits its `block_set`s on
 * release. A remote edit arriving mid-drag therefore folds into a document that
 * already carries the uncommitted width; the release's own operation then states
 * the final width outright, so every peer still converges on it.
 */
export function withTableDocument(
  state: EditorState,
  blockId: string,
  document: StructuredDocument,
): EditorState {
  const blocks = state.document.page.blocks;
  const at = blocks.findIndex((candidate) => candidate.id === blockId);
  const block = blocks[at];
  if (!block) return state;
  const contentId = document.rootId;
  const next: Block = {
    ...block,
    structuredContent: { ...block.structuredContent, [contentId]: document },
  };
  // A fresh block object would otherwise inherit the previous width's layout.
  next.cachedLayout = undefined;
  const page: Page = {
    ...state.document.page,
    blocks: [...blocks.slice(0, at), next, ...blocks.slice(at + 1)],
  };
  return { ...state, document: { ...state.document, page } };
}
