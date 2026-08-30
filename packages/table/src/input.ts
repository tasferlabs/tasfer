/**
 * Editing inside a table cell: typing, deleting, and what Enter does.
 *
 * A table block has no flat text, so none of the engine's ordinary text edits
 * can land in one. Typing is claimed through the schema's input-rule seam
 * (`owns` — the read-only ownership query every mutation surface consults,
 * including paste and IME), and the key-driven deletes are claimed on the
 * action bus. Both emit generic `content_edit` operations against the cell's
 * text field, so a table edit syncs, undoes and merges exactly like any other
 * structured content.
 *
 * A host can additionally opt cells into the engine's inline markdown shortcuts
 * (`**bold**` and friends) — see {@link TableInputOptions} and
 * `./markdown-shortcuts`.
 */

import {
  activeTableContext,
  type Claimed,
  commitTableEdits,
  selectTableBlock,
  type TableContext,
} from "./context";
import {
  armCellWrapRevert,
  armedCellWrap,
  type CellWrapRevert,
  detectCellMarkdown,
  isInlineMarkdownDelimiter,
  revertCellWrap,
} from "./markdown-shortcuts";
import { registerTableMarkActions } from "./marks";
import {
  cellAt,
  cellLength,
  cellPosition,
  cellRuns,
  type TableCaret,
  tableCellIds,
} from "./selection";
import { cellRunsFromText } from "./structured";
import type { ActionBus } from "@tasfer/editor/action-bus";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_TO_LINE_END,
  DELETE_TO_LINE_START,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  REVERT_INPUT_RULE,
  SPLIT_BLOCK,
} from "@tasfer/editor/actions/edit-actions";
import {
  nextCodePointEnd,
  prevCodePointStart,
} from "@tasfer/editor/code-points";
import type { FeatureInputRule } from "@tasfer/editor/feature-facets";
import type { EditorState } from "@tasfer/editor/state-types";
import {
  getCharIdsInRangeFromRuns,
  getVisibleTextFromRuns,
} from "@tasfer/editor/sync/char-runs";
import {
  applyStructuredEdits,
  type StructuredEdit,
} from "@tasfer/editor/sync/structured-content";
import {
  findWordDeleteBoundaryLeft,
  findWordDeleteBoundaryRight,
} from "@tasfer/editor/word-chars";

/** Delete edits clearing every cell a selection covers, plus the landing caret. */
function clearRange(
  context: TableContext,
): { edits: StructuredEdit[]; caret: TableCaret } | undefined {
  const { document, caret, anchor } = context;
  if (anchor.cellId === caret.cellId) {
    const from = Math.min(anchor.offset, caret.offset);
    const to = Math.max(anchor.offset, caret.offset);
    if (from === to) return undefined;
    const charIds = getCharIdsInRangeFromRuns(
      cellRuns(document, caret.cellId),
      from,
      to,
    );
    if (charIds.length === 0) return undefined;
    return {
      edits: [
        { kind: "text_delete", nodeId: caret.cellId, field: "text", charIds },
      ],
      caret: { cellId: caret.cellId, offset: from },
    };
  }

  // A range spanning cells clears each covered cell whole. A grid has no
  // meaningful "half a cell then half another": the covered cells ARE the
  // selection, which is also the unit the selection band paints.
  const order = tableCellIds(document);
  const from = order.indexOf(anchor.cellId);
  const to = order.indexOf(caret.cellId);
  if (from < 0 || to < 0) return undefined;
  const edits: StructuredEdit[] = [];
  for (let at = Math.min(from, to); at <= Math.max(from, to); at++) {
    const cellId = order[at];
    const charIds = getCharIdsInRangeFromRuns(
      cellRuns(document, cellId),
      0,
      cellLength(document, cellId),
    );
    if (charIds.length > 0) {
      edits.push({
        kind: "text_delete",
        nodeId: cellId,
        field: "text",
        charIds,
      });
    }
  }
  return { edits, caret: { cellId: order[Math.min(from, to)], offset: 0 } };
}

/** Insert `input` at the caret, replacing any selected range first. */
function insertIntoCell(
  state: EditorState,
  context: TableContext,
  input: string,
  markdownShortcuts: boolean,
): Claimed {
  const cleared = clearRange(context);
  const edits: StructuredEdit[] = cleared ? [...cleared.edits] : [];
  const caret = cleared?.caret ?? context.caret;
  if (input.length === 0) return commitTableEdits(state, context, edits, caret);

  // Re-read the runs after the deletion so the insert anchors to what survives:
  // the character before the caret may have just been tombstoned.
  const document =
    edits.length > 0
      ? applyStructuredEdits(context.document, edits)
      : context.document;
  const runs = cellRuns(document, caret.cellId);
  if (!runs) return commitTableEdits(state, context, edits, caret);
  const afterCharId = charIdBefore(runs, caret.offset);

  const charRuns = cellRunsFromText(input, state.CRDTbinding);
  edits.push({
    kind: "text_insert",
    nodeId: caret.cellId,
    field: "text",
    afterCharId,
    charRuns,
  });

  // Marks toggled at a collapsed caret are pending until something is typed —
  // "Ctrl+B, then type" in a cell has to come out bold the way it does in a
  // paragraph. The engine already holds that intent; this applies it to the
  // characters just inserted.
  const pending =
    state.ui.activeMarksMode.type === "explicit"
      ? state.ui.activeMarksMode.formats
      : [];
  if (pending.length > 0) {
    const insertedIds = charRuns.flatMap((run) =>
      Array.from(
        { length: run.text.length },
        (_unused, at) => `${run.peerId}:${run.startCounter + at}`,
      ),
    );
    for (const mark of pending) {
      edits.push({
        kind: "mark_set",
        nodeId: caret.cellId,
        field: "text",
        charIds: insertedIds,
        mark,
        value: true,
      });
    }
  }

  let landing: TableCaret = {
    cellId: caret.cellId,
    offset: caret.offset + input.length,
  };

  // Markdown auto-format, when the host asked for it and this keystroke could
  // close a wrap. Detection runs against the document the edits above produce,
  // because the closing delimiter it matches on only has a character id once it
  // has been inserted; the wrap's own edits then ride in the same batch, so one
  // keystroke stays one transaction to undo, sync and merge.
  let wrapped: CellWrapRevert | undefined;
  if (markdownShortcuts && isInlineMarkdownDelimiter(input)) {
    const typed = applyStructuredEdits(context.document, edits);
    const wrap = detectCellMarkdown(
      state,
      typed,
      landing.cellId,
      landing.offset,
    );
    if (wrap) {
      edits.push(...wrap.edits);
      landing = { cellId: landing.cellId, offset: wrap.offset };
      wrapped = { ...wrap.revert, blockId: context.block.id };
    }
  }

  const committed = commitTableEdits(state, context, edits, landing);
  return wrapped ? armCellWrapRevert(committed, wrapped) : committed;
}

/** The id of the visible character immediately before `offset`, or null. */
function charIdBefore(
  runs: ReturnType<typeof cellRuns>,
  offset: number,
): string | null {
  if (!runs || offset <= 0) return null;
  const ids = getCharIdsInRangeFromRuns(runs, offset - 1, offset);
  return ids[0] ?? null;
}

/** What a host can turn on in the cell-input rule. */
export interface TableInputOptions {
  /**
   * Run the engine's inline markdown shortcuts inside cells, so `**bold**`,
   * `*italic*`, `~~strike~~` and `` `code` `` auto-format as they are typed.
   *
   * Off by default: a cell is one line of a grid, and a table of glob patterns
   * or shell snippets wants `*` and `` ` `` to stay literal. Turning it on also
   * gives Backspace (and the first undo) the engine's take-it-back behavior,
   * which is what keeps the literal syntax typable.
   */
  readonly markdownShortcuts?: boolean;
}

/**
 * Live authoring rule: the caret is in a table cell, so this feature — not the
 * engine's flat text path — owns whatever is being inserted.
 *
 * The id is fixed across every configuration: installing two of these would be
 * two rules claiming the same caret, and reusing the id makes the second
 * replace the first the way the facet list documents.
 */
export function createTableInputRule(
  options: TableInputOptions = {},
): FeatureInputRule {
  const markdownShortcuts = options.markdownShortcuts === true;
  return {
    id: "table.cell.input",
    phase: "before-insert",
    priority: 1_000,
    owns: ({ state }) => activeTableContext(state) !== undefined,
    apply: ({ state, input }) => {
      const context = activeTableContext(state);
      return context
        ? insertIntoCell(state, context, input, markdownShortcuts)
        : undefined;
    },
  };
}

/** The cell-input rule with every option left at its default. */
export const tableInputRule: FeatureInputRule = createTableInputRule();

/** Register the key-driven cell edits on one editor instance's bus. */
export function registerTableInputActions(bus: ActionBus): void {
  const remove =
    (direction: "backward" | "forward") =>
    (state: EditorState): Claimed | undefined => {
      const context = activeTableContext(state);
      if (!context) return undefined;

      const cleared = clearRange(context);
      if (cleared) {
        return commitTableEdits(state, context, cleared.edits, cleared.caret);
      }

      const { document, caret } = context;
      const text = getVisibleTextFromRuns(cellRuns(document, caret.cellId));
      const from =
        direction === "backward"
          ? prevCodePointStart(text, caret.offset)
          : caret.offset;
      const to =
        direction === "backward"
          ? caret.offset
          : nextCodePointEnd(text, caret.offset);
      const charIds =
        to > from
          ? getCharIdsInRangeFromRuns(
              cellRuns(document, caret.cellId),
              from,
              to,
            )
          : [];
      if (charIds.length === 0) {
        // Backspace at the very start of the grid escalates to holding the
        // table whole, so a second press deletes it — the block equation's
        // gesture, and the only keyboard route out of a table that has one.
        // Everywhere else the key stays claimed and inert: a table's cells are
        // a grid, not a text stream, so Backspace must never merge two of them.
        if (
          direction === "backward" &&
          caret.offset === 0 &&
          !state.ui.composition &&
          context.anchor.cellId === caret.cellId &&
          context.anchor.offset === caret.offset &&
          tableCellIds(document)[0] === caret.cellId
        ) {
          return selectTableBlock(state, context);
        }
        return { state, ops: [], handled: true };
      }
      return commitTableEdits(
        state,
        context,
        [
          {
            kind: "text_delete",
            nodeId: caret.cellId,
            field: "text",
            charIds,
          },
        ],
        { cellId: caret.cellId, offset: from },
      );
    };
  registerTableMarkActions(bus, activeTableContext);

  // Take back a cell's markdown auto-format, ahead of the engine's own handler
  // — which stands down on a feature-owned record. Backspace and the first undo
  // both arrive here (see `keysEvents`), and returning nothing when no cell wrap
  // is armed lets them fall through to deleting and undoing as usual.
  bus.registerState(
    REVERT_INPUT_RULE,
    (state) => {
      const armed = armedCellWrap(state);
      return armed ? revertCellWrap(state, armed) : undefined;
    },
    100,
  );

  bus.registerState(DELETE_BACKWARD, remove("backward"), 100);
  bus.registerState(DELETE_FORWARD, remove("forward"), 100);

  // The word- and line-wise deletes every other text surface answers to: ⌥⌫
  // and ⌥⌦ (Ctrl+⌫ / Ctrl+⌦ off Apple) for a word, ⌘⌫ and ⌘⌦ — plus ⌃K — for
  // the rest of the line. The engine's own handlers address flat block text and
  // stand down on a table block, so without these the chords reached a cell and
  // silently did nothing, while the matching MOVES (⌥←, ⌘←, …) already worked.
  //
  // A cell holds one line, so the line edges are the cell's own edges — the
  // same span `MOVE_TO_LINE_START`/`_END` travel to.
  const removeTo =
    (reach: (text: string, offset: number) => number) =>
    (state: EditorState): Claimed | undefined => {
      const context = activeTableContext(state);
      if (!context) return undefined;

      const cleared = clearRange(context);
      if (cleared) {
        return commitTableEdits(state, context, cleared.edits, cleared.caret);
      }

      const { document, caret } = context;
      const runs = cellRuns(document, caret.cellId);
      const target = reach(getVisibleTextFromRuns(runs), caret.offset);
      const from = Math.min(target, caret.offset);
      const to = Math.max(target, caret.offset);
      const charIds =
        to > from ? getCharIdsInRangeFromRuns(runs, from, to) : [];
      // Nothing in reach means the caret already sits at that edge of the cell.
      // The key stays claimed and inert rather than carrying on into the
      // neighbour: a word delete must no more merge two cells than Backspace
      // does. Holding the table whole stays plain Backspace's gesture — a
      // modified delete never escalates, exactly as it never merges blocks in
      // prose.
      if (charIds.length === 0) return { state, ops: [], handled: true };
      return commitTableEdits(
        state,
        context,
        [{ kind: "text_delete", nodeId: caret.cellId, field: "text", charIds }],
        { cellId: caret.cellId, offset: from },
      );
    };

  // The boundary walk is the engine's own, so a word breaks in the same places
  // inside a cell as in the paragraph above it — including the scripts whose
  // word shape is not spaces (CJK, vocalized Arabic).
  bus.registerState(
    DELETE_WORD_BACKWARD,
    removeTo(findWordDeleteBoundaryLeft),
    100,
  );
  bus.registerState(
    DELETE_WORD_FORWARD,
    removeTo(findWordDeleteBoundaryRight),
    100,
  );
  bus.registerState(
    DELETE_TO_LINE_START,
    removeTo(() => 0),
    100,
  );
  bus.registerState(
    DELETE_TO_LINE_END,
    removeTo((text) => text.length),
    100,
  );

  // A GFM cell holds one line, so Enter cannot split it. It moves to the cell
  // below in the same column instead — the spreadsheet convention, and the one
  // motion the key already suggests. On the last row it is claimed and does
  // nothing rather than splitting the table's block.
  bus.registerState(
    SPLIT_BLOCK,
    (state) => {
      const context = activeTableContext(state);
      if (!context) return undefined;
      const at = cellPosition(context.document, context.caret.cellId);
      const below = at && cellAt(context.document, at.row + 1, at.column);
      if (!below) return { state, ops: [], handled: true };
      return commitTableEdits(state, context, [], { cellId: below, offset: 0 });
    },
    100,
  );
}
