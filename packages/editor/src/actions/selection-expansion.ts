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
import { findWordEnd, findWordStart, isWordChar } from "../word-chars";
import { selectAll } from "./actions";

/** A half-open `[from, to)` span of offsets in one piece of text. */
export interface SelectionRungRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The smallest of `candidates` that strictly contains `current` — the next
 * rung of an expand ladder — or null when none is wider. A node lists every
 * range it would ever select around the caret (word, bracket, line, …) in any
 * order; this picks the one to take next.
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
 * Select `[from, to)` inside one flat block, focus at the end — the shape
 * every keyboard rung lands in. Exported so a node whose content is flat text
 * (a code block) can place its rungs the same way.
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
    from < text.length && isWordChar(text[from])
      ? from
      : from > 0 && isWordChar(text[from - 1])
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
 * One rung wider than the current selection. Claim it (priority above the
 * default) to give a node its own ladder; return nothing once the node's block
 * is already held whole, so the engine's next rung follows.
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
 * Grow the selection one rung (see {@link EXPAND_SELECTION_STEP}) and remember
 * where it came from, so {@link SHRINK_SELECTION} can step back. Pure
 * selection change, no ops.
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
