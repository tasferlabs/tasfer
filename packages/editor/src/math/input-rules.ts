/**
 * Live authoring rules owned by the optional math feature.
 *
 * The editor core treats `$` as ordinary text. Installing these rules opts one
 * schema into the familiar authoring shortcuts without teaching the generic
 * input pipeline about a `math` block or mark type.
 */

import type { FeatureInputRule } from "../feature-facets";
import { resolveMarkRuns } from "../inline-math-spans";
import type { BlockSet, EditorState, Operation } from "../state-types";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { deleteCharsInRange, markCharsInRange } from "../sync/crdt-utils";
import { applyOp } from "../sync/reducer";
import {
  inlineMathAttachedProjectionGuard,
  inlineMathTreeInputRule,
} from "./inline-tree-state";
import { mathTreeInputRule, mathTreeMigrationInputRule } from "./tree-state";

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

    // Match the former paragraph-prefix transaction exactly: one delete for
    // both marker chars, followed by one type morph. The reducer supplies the
    // math descriptor's defaults and drops formats deterministically.
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
    const page = applyOp(deleted.newPage, morph, state.schema);
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
      ops: [deleted.op, morph] satisfies Operation[],
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
    const innerLength = match[1].length;
    let page = state.document.page;
    const ops: Operation[] = [];

    // Delete the closing marker before the opener so the opener's index stays
    // stable, then mark precisely the surviving source range.
    const close = deleteCharsInRange(
      page,
      block.id,
      textIndex - 1,
      textIndex,
      state.CRDTbinding,
    );
    page = close.newPage;
    ops.push(close.op);

    const open = deleteCharsInRange(
      page,
      block.id,
      matchStart,
      matchStart + 1,
      state.CRDTbinding,
    );
    page = open.newPage;
    ops.push(open.op);

    const marked = markCharsInRange(
      page,
      block.id,
      matchStart,
      matchStart + innerLength,
      { type: "math" },
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
      matchStart + innerLength,
    );
    return { state: next, ops, handled: true };
  },
};

/** Compatibility authoring rules that keep display equations in char runs. */
export const mathInputRules = [
  mathTreeInputRule,
  inlineMathAttachedProjectionGuard,
  displayDollarRule,
  inlineDollarRule,
] as const satisfies readonly [
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
];

/** Tree-authoritative display editing plus the existing math shortcuts. */
export const mathTreeInputRules = [
  mathTreeMigrationInputRule,
  ...mathInputRules,
] as const satisfies readonly [
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
];

/** Tree-authoritative display and inline math for explicit/custom schemas. */
export const mathInlineTreeInputRules = [
  inlineMathTreeInputRule,
  ...mathTreeInputRules,
] as const satisfies readonly [
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
  FeatureInputRule,
];
