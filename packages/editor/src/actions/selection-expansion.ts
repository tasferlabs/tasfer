/**
 * Expand / shrink selection — the "smart select" pair code editors bind to
 * ⌃⇧⌘→ / ⌃⇧⌘← (Shift+Alt+→ / ← elsewhere).
 *
 * Expand grows the selection one rung of a ladder per press. The engine's own
 * ladder is word → whole block → whole document. A node with a structure of its
 * own (an equation's nesting, a code block's brackets, a table's cells) claims
 * {@link EXPAND_SELECTION_STEP} to put its own rungs in front, and leaves the
 * step unclaimed once its block is fully selected so the engine's next rung
 * takes over.
 *
 * Shrink walks back down the exact rungs Expand climbed. That history lives in
 * this editor's UI state — never in a module — and is only trusted while
 * nothing else has touched the selection or the page since the last Expand: a
 * click, an arrow, typing, or a remote edit all make Shrink a no-op until the
 * next Expand starts a fresh ladder.
 */

import { stateAction } from "../action-bus";
import { getBlockTextContent } from "../node-shared";
import {
  isNodeSelection,
  moveCursorToPosition,
  startSelection,
  updateSelectionFocus,
} from "../selection";
import type {
  EditorState,
  Position,
  SelectionExpansionHistory,
  SelectionSnapshot,
  SelectionState,
} from "../state-types";
import { updateMode } from "../state-utils";
import { contentPointsEqual } from "../structured-selection";
import { findBlockIndex } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { findWordEnd, findWordStart, isWordCharAt } from "../word-chars";
import { selectAll } from "./actions";

/**
 * A half-open `[from, to)` span of offsets in one piece of text.
 *
 * @group Selection
 */
export interface SelectionRungRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Pick the next, wider selection for Expand Selection: the smallest of
 * `candidates` that contains `current` and is larger than it. Returns `null`
 * when none is wider. List every range your node could select around the caret
 * (word, brackets, line, …), in any order.
 *
 * @group Selection
 */
export function nextEnclosingRange(
  candidates: readonly SelectionRungRange[],
  current: SelectionRungRange,
): SelectionRungRange | null {
  let best: SelectionRungRange | null = null;
  for (const range of candidates) {
    if (range.from > current.from || range.to < current.to) continue;
    if (range.from === current.from && range.to === current.to) continue;
    if (!best || range.to - range.from < best.to - best.from) best = range;
  }
  return best;
}

/**
 * Select the text from `from` to `to` (`to` not included) in the block at
 * `blockIndex`, with the caret at `to`. Returns the new state. Use it from a
 * node whose content is plain text, like a code block, to apply an Expand
 * Selection step.
 *
 * @group Selection
 */
export function selectFlatRange(
  state: EditorState,
  blockIndex: number,
  from: number,
  to: number,
): EditorState {
  const start: Position = { blockIndex, textIndex: from };
  const end: Position = { blockIndex, textIndex: to };
  let next = moveCursorToPosition(state, blockIndex, to);
  next = startSelection(next, start);
  next = updateSelectionFocus(next, end);
  return updateMode(next, "edit");
}

/** Hold a block whole: its text for prose, a node selection otherwise. */
function selectWholeBlock(state: EditorState, blockIndex: number): EditorState {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return state;
  if (isTextualBlock(block)) {
    return selectFlatRange(
      state,
      blockIndex,
      0,
      getBlockTextContent(block).length,
    );
  }
  const at: Position = { blockIndex, textIndex: 0 };
  const next = moveCursorToPosition(state, blockIndex, 0);
  return updateMode(
    {
      ...next,
      document: {
        ...next.document,
        selection: {
          anchor: at,
          focus: at,
          isForward: true,
          isCollapsed: false,
          lastUpdate: Date.now(),
        },
      },
    },
    "edit",
  );
}

/** The word around `[from, to)` in `text`, when the span sits inside one. */
function wordAround(
  text: string,
  from: number,
  to: number,
): SelectionRungRange | null {
  const seed =
    from < text.length && isWordCharAt(text, from)
      ? from
      : from > 0 && isWordCharAt(text, from - 1)
        ? from - 1
        : -1;
  if (seed < 0) return null;
  const range = {
    from: findWordStart(text, seed),
    to: findWordEnd(text, seed),
  };
  return range.from <= from && range.to >= to && range.to > range.from
    ? range
    : null;
}

function samePosition(a: Position, b: Position): boolean {
  return a.blockIndex === b.blockIndex && a.textIndex === b.textIndex;
}

/** The engine's own ladder: word → whole block → whole document. */
export function expandSelectionByDefault(state: EditorState): EditorState {
  const { cursor, selection, contentSelection } = state.document;

  // Nested content no node claimed a rung for: hold its block whole.
  if (contentSelection) {
    const blockIndex = findBlockIndex(
      state.document.page,
      contentSelection.focus.blockId,
    );
    return blockIndex < 0 ? state : selectWholeBlock(state, blockIndex);
  }

  const range = flatRange(selection, cursor?.position);
  if (range) {
    const block = state.document.page.blocks[range.blockIndex];
    if (block && !block.deleted && isTextualBlock(block)) {
      const text = getBlockTextContent(block);
      const candidates: SelectionRungRange[] = [{ from: 0, to: text.length }];
      const word = wordAround(text, range.from, range.to);
      if (word) candidates.push(word);
      const next = nextEnclosingRange(candidates, range);
      if (next) {
        return selectFlatRange(state, range.blockIndex, next.from, next.to);
      }
    }
  }

  const all = selectAll(state);
  const before = state.document.selection;
  const after = all.document.selection;
  // Already the whole document: the ladder has nowhere left to go.
  if (
    before &&
    after &&
    samePosition(before.anchor, after.anchor) &&
    samePosition(before.focus, after.focus)
  ) {
    return state;
  }
  return all;
}

/**
 * The current flat selection as a range inside one block, or null when it
 * spans blocks, holds a block whole, or there is no caret.
 */
function flatRange(
  selection: SelectionState | null,
  caret: Position | undefined,
): (SelectionRungRange & { readonly blockIndex: number }) | null {
  if (!selection || selection.isCollapsed) {
    return caret
      ? {
          blockIndex: caret.blockIndex,
          from: caret.textIndex,
          to: caret.textIndex,
        }
      : null;
  }
  if (isNodeSelection(selection)) return null;
  if (selection.anchor.blockIndex !== selection.focus.blockIndex) return null;
  return {
    blockIndex: selection.anchor.blockIndex,
    from: Math.min(selection.anchor.textIndex, selection.focus.textIndex),
    to: Math.max(selection.anchor.textIndex, selection.focus.textIndex),
  };
}

/**
 * One Expand Selection step: make the selection one size wider. Handle it to
 * give a node its own steps, such as brackets or table cells. Return nothing
 * when the caret is not in your block, or when your block is already selected
 * whole. The editor then takes its own next step.
 *
 * ```ts
 * bus.registerState(EXPAND_SELECTION_STEP, (state) => {
 *   // `ranges`, `current` and `blockIndex` come from your node.
 *   const next = nextEnclosingRange(ranges, current);
 *   if (!next) return;
 *   const selected = selectFlatRange(state, blockIndex, next.from, next.to);
 *   return { state: selected, ops: [], handled: true };
 * });
 * ```
 *
 * @group Built-in actions
 */
export const EXPAND_SELECTION_STEP = stateAction(
  "expand-selection-step",
  (state) => ({ state: expandSelectionByDefault(state), ops: [] }),
);

function snapshot(state: EditorState): SelectionSnapshot {
  return {
    cursor: state.document.cursor,
    selection: state.document.selection,
    contentSelection: state.document.contentSelection,
    mode: state.ui.mode,
  };
}

/** Whether `state` still shows exactly the selection `snap` captured. */
function showsSnapshot(state: EditorState, snap: SelectionSnapshot): boolean {
  const { cursor, selection, contentSelection } = state.document;
  if (!!contentSelection !== !!snap.contentSelection) return false;
  if (contentSelection && snap.contentSelection) {
    return (
      contentPointsEqual(
        contentSelection.anchor,
        snap.contentSelection.anchor,
      ) &&
      contentPointsEqual(contentSelection.focus, snap.contentSelection.focus)
    );
  }
  const live = selection && !selection.isCollapsed ? selection : null;
  const held =
    snap.selection && !snap.selection.isCollapsed ? snap.selection : null;
  if (live || held) {
    return (
      !!live &&
      !!held &&
      samePosition(live.anchor, held.anchor) &&
      samePosition(live.focus, held.focus)
    );
  }
  if (!cursor || !snap.cursor) return cursor === snap.cursor;
  return samePosition(cursor.position, snap.cursor.position);
}

/** The ladder history, if the selection is still the last rung Expand left. */
function liveHistory(state: EditorState): SelectionExpansionHistory | null {
  const history = state.ui.selectionExpansion;
  if (!history) return null;
  if (history.page !== state.document.page) return null;
  return showsSnapshot(state, history.current) ? history : null;
}

function withHistory(
  state: EditorState,
  history: SelectionExpansionHistory | null,
): EditorState {
  return { ...state, ui: { ...state.ui, selectionExpansion: history } };
}

/**
 * Grow the selection one step (⌃⇧⌘→ on Apple, Shift+Alt+→ elsewhere). The
 * editor's own steps are word, whole block, then whole document. A node can add
 * its own steps through {@link EXPAND_SELECTION_STEP}. Each step is remembered,
 * so {@link SHRINK_SELECTION} can go back. It does not change the document.
 *
 * The shortcut follows the physical arrow, not the text direction: → always
 * grows and ← always shrinks, in right-to-left text too.
 *
 * @group Built-in actions
 */
export const EXPAND_SELECTION = stateAction("expand-selection", (state) => {
  const history = liveHistory(state);
  const before = snapshot(state);
  const stepped = state.actionBus.dispatchState(EXPAND_SELECTION_STEP, state);
  if (showsSnapshot(stepped.state, before)) {
    // Top of the ladder: keep the history so Shrink still walks back down.
    return { state, ops: [] };
  }
  return {
    state: withHistory(stepped.state, {
      page: stepped.state.document.page,
      current: snapshot(stepped.state),
      previous: [...(history?.previous ?? []), before],
    }),
    ops: stepped.ops,
  };
});

/**
 * Step back to the selection the last {@link EXPAND_SELECTION} grew from. A
 * no-op once the ladder is back at its start, or when anything else has moved
 * the selection or changed the page since. Pure selection change, no ops.
 *
 * @group Built-in actions
 */
export const SHRINK_SELECTION = stateAction("shrink-selection", (state) => {
  const history = liveHistory(state);
  const target = history?.previous.at(-1);
  if (!history || !target) return { state, ops: [] };
  const restored = updateMode(
    {
      ...state,
      document: {
        ...state.document,
        cursor: target.cursor,
        selection: target.selection,
        contentSelection: target.contentSelection,
      },
    },
    target.mode,
  );
  const previous = history.previous.slice(0, -1);
  return {
    state: withHistory(
      restored,
      previous.length > 0
        ? { page: history.page, current: target, previous }
        : null,
    ),
    ops: [],
  };
});
