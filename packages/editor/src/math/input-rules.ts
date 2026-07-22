/**
 * Live authoring rules owned by the optional math feature.
 *
 * The editor core treats `$` as ordinary text. Installing these rules opts one
 * schema into the familiar authoring shortcuts without teaching the generic
 * input pipeline about a `math` block or mark type.
 */

import {
  type FeatureInputRule,
  STRUCTURED_MARK_ANCHOR_CHAR,
} from "../feature-facets";
import { resolveMarkRuns } from "../inline-math-spans";
import type {
  BlockSet,
  ContentEdit,
  EditorState,
  Operation,
} from "../state-types";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "../sync/crdt-utils";
import { applyOp } from "../sync/reducer";
import { createStructuredMathMarkAttachment } from "./inline-structured";
import { inlineMathTreeInputRule } from "./inline-tree-state";
import { mathContentIdForBlock, parseMathDocumentInit } from "./structured";
import { mathTreeInputRule } from "./tree-state";

const INLINE_MATH = /\$([^$\n]+)\$$/;

function blockAtCursor(state: EditorState) {
  const cursor = state.document.cursor;
  if (!cursor) return undefined;
  const block = state.document.page.blocks[cursor.position.blockIndex];
  return block && !block.deleted ? block : undefined;
}

/** Whether core markdown authoring is disabled for this block type. */
function isPreformatted(state: EditorState, type: string): boolean {
  return state.schema.getDescriptor(type)?.capabilities.preformatted === true;
}

/** Update the already-validated caret without importing the canvas selection stack. */
function placeCaret(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
): EditorState {
  return {
    ...state,
    ui: state.ui.caretScratch ? { ...state.ui, caretScratch: null } : state.ui,
    document: {
      ...state.document,
      cursor: {
        position: { blockIndex, textIndex },
        // Core already placed the caret after the raw insert immediately before
        // this phase. Reuse that timestamp so the rule stays deterministic and
        // only corrects the post-transform offset.
        lastUpdate: state.document.cursor?.lastUpdate ?? 0,
      },
    },
  };
}

const displayDollarRule: FeatureInputRule = {
  id: "math.input.display-dollar-pair",
  phase: "after-insert",
  priority: 100,
  apply: ({ state }) => {
    if (!state.schema.isBlockAllowed("math")) return undefined;

    const cursor = state.document.cursor;
    const block = blockAtCursor(state);
    if (
      !cursor ||
      !block ||
      !isTextualBlock(block) ||
      isPreformatted(state, block.type) ||
      getVisibleTextFromRuns(block.charRuns) !== "$$"
    ) {
      return undefined;
    }

    // One delete for both marker chars, one type morph, then the eager empty
    // authority document — a display block's content lives only in its tree.
    const deleted = deleteCharsInRange(
      state.document.page,
      block.id,
      0,
      2,
      state.CRDTbinding,
    );
    const morph: BlockSet = {
      op: "block_set",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: block.id,
      field: "type",
      value: "math",
    };
    let page = applyOp(deleted.newPage, morph, state.schema);
    const contentId = mathContentIdForBlock(block.id);
    const init: ContentEdit = {
      op: "content_edit",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: block.id,
      contentId,
      edit: parseMathDocumentInit("", {
        contentId,
        identityAllocator: state.CRDTbinding,
      }),
    };
    page = applyOp(page, init, state.schema);
    const blockIndex = page.blocks.findIndex(
      (candidate) => candidate.id === block.id,
    );
    if (blockIndex < 0) return undefined;

    page.blocks[blockIndex].cachedLayout = undefined;
    const next = placeCaret(
      { ...state, document: { ...state.document, page } },
      blockIndex,
      0,
    );
    return {
      state: next,
      ops: [deleted.op, morph, init] satisfies Operation[],
      handled: true,
    };
  },
};

const inlineDollarRule: FeatureInputRule = {
  id: "math.input.inline-dollar-pair",
  phase: "after-insert",
  priority: 90,
  apply: ({ state, input }) => {
    // The legacy shortcut was deliberately keystroke-only: paste/IME commits
    // containing a complete `$…$` source remain literal until parsed/imported.
    if (input !== "$" || !state.schema.isMarkAllowed("math")) {
      return undefined;
    }

    const cursor = state.document.cursor;
    const block = blockAtCursor(state);
    if (
      !cursor ||
      !block ||
      !isTextualBlock(block) ||
      isPreformatted(state, block.type)
    ) {
      return undefined;
    }

    const textIndex = cursor.position.textIndex;
    const fullText = getVisibleTextFromRuns(block.charRuns);

    // A `$` typed inside an existing math mark is escaped by MathMark's input
    // transform and explicitly suppresses markdown. At this point that inserted
    // glyph belongs to the existing run, so retain it as formula source rather
    // than treating it as a closing delimiter.
    if (
      resolveMarkRuns(block).some(
        (run) =>
          run.name === "math" &&
          textIndex - 1 >= run.startIndex &&
          textIndex - 1 < run.endIndex,
      )
    ) {
      return undefined;
    }

    const match = fullText.slice(0, textIndex).match(INLINE_MATH);
    if (!match) return undefined;

    const matchStart = textIndex - match[0].length;
    const latex = match[1];
    let page = state.document.page;
    const ops: Operation[] = [];

    // The typed `$…$` source becomes the chip's eager attachment; the flat
    // text is replaced by the mark's single anchor char. The anchor is
    // inserted after the match before the match is deleted (the block-split
    // CRDT footing), then marked with the attachment-carrying format.
    const created = createStructuredMathMarkAttachment(
      latex,
      state.CRDTbinding,
    );
    const init: ContentEdit = {
      op: "content_edit",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: block.id,
      contentId: created.contentId,
      edit: created.init,
    };
    page = applyOp(page, init, state.schema);
    ops.push(init);

    const inserted = insertCharsAtPosition(
      page,
      block.id,
      textIndex,
      STRUCTURED_MARK_ANCHOR_CHAR,
      state.CRDTbinding,
    );
    page = inserted.newPage;
    ops.push(inserted.op);

    const removed = deleteCharsInRange(
      page,
      block.id,
      matchStart,
      textIndex,
      state.CRDTbinding,
    );
    page = removed.newPage;
    ops.push(removed.op);

    const marked = markCharsInRange(
      page,
      block.id,
      matchStart,
      matchStart + 1,
      created.format,
      true,
      state.CRDTbinding,
    );
    page = marked.newPage;
    ops.push(marked.op);

    const blockIndex = page.blocks.findIndex(
      (candidate) => candidate.id === block.id,
    );
    if (blockIndex < 0) return undefined;
    page.blocks[blockIndex].cachedLayout = undefined;
    const next = placeCaret(
      { ...state, document: { ...state.document, page } },
      blockIndex,
      matchStart + 1,
    );
    return { state: next, ops, handled: true };
  },
};

/** Structured math tree editing plus the math authoring shortcuts. */
export const mathInputRules = [
  inlineMathTreeInputRule,
  mathTreeInputRule,
  displayDollarRule,
  inlineDollarRule,
] as const satisfies readonly [
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
];
