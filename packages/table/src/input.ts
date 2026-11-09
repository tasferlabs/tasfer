/**
 * Editing inside a table cell: typing, deleting, and what Enter does.
 *
 * A cell's text is edited by the paragraph's own code. Each handler here hands
 * the cell to `runFieldAsParagraph` (`@tasfer/editor/text-field-paragraph`),
 * which runs the engine's flat-text action — `insertText`, Backspace, a word
 * delete, the markdown take-back — on the cell as if it were a lone paragraph
 * and commits the result as `content_edit` operations against the cell's text
 * field. A cell therefore types, deletes, formats and auto-formats exactly as
 * a paragraph does, with no second copy of those rules to drift.
 *
 * What stays here is what a grid has and a paragraph does not:
 *
 *   - a range across cells clears the covered cells whole;
 *   - the cell's edges are walls — Backspace never merges two cells, and at the
 *     very start of the grid it holds the table whole instead;
 *   - Enter moves down a row (growing one at the bottom), Shift+Enter leaves.
 *
 * Typing is claimed through the schema's input-rule seam (`owns` — the
 * read-only ownership query every mutation surface consults, including paste
 * and IME), and the key-driven edits on the action bus.
 *
 * A host can turn the inline markdown shortcuts (`**bold**` and friends) on
 * for cells — see {@link TableInputOptions}.
 */

import { insertRow } from "./commands";
import {
  activeTableContext,
  type Claimed,
  claimRun,
  commitTableEdits,
  runInCell,
  selectTableBlock,
  type TableContext,
} from "./context";
import { registerTableMarkActions } from "./marks";
import {
  cellAt,
  cellLength,
  cellPosition,
  cellRuns,
  coveredCellIds,
  type TableCaret,
  tableCellIds,
} from "./selection";
import { CELL_NODE, CELL_TEXT_FIELD } from "./structured";
import type { ActionBus, StateAction } from "@tasfer/editor/action-bus";
import { deleteSelectedText, insertText } from "@tasfer/editor/actions/actions";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_TO_LINE_END,
  DELETE_TO_LINE_START,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  EXIT_BLOCK,
  insertParagraphBeside,
  REVERT_INPUT_RULE,
  SPLIT_BLOCK,
} from "@tasfer/editor/actions/edit-actions";
import type {
  FeatureInputOptions,
  FeatureInputRule,
} from "@tasfer/editor/feature-facets";
import { inheritedMarksInText } from "@tasfer/editor/mark-edge";
import type { Mark, MarkSpan } from "@tasfer/editor/serlization/loadPage";
import type { EditorState } from "@tasfer/editor/state-types";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { getCharIdsInRangeFromRuns } from "@tasfer/editor/sync/char-runs";
import {
  allCharsHaveFormat,
  getFormatsAtCharPosition,
} from "@tasfer/editor/sync/crdt-utils";
import {
  getStructuredMarks,
  type StructuredDocument,
  type StructuredEdit,
} from "@tasfer/editor/sync/structured-content";
import { armedFieldRevert } from "@tasfer/editor/text-field-paragraph";

/** Delete edits clearing every cell a selection covers, plus the landing caret. */
export function clearRange(
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
        {
          kind: "text_delete",
          nodeId: caret.cellId,
          field: CELL_TEXT_FIELD,
          charIds,
        },
      ],
      caret: { cellId: caret.cellId, offset: from },
    };
  }

  // A range spanning cells clears each covered cell whole. A grid has no
  // meaningful "half a cell then half another": the covered cells ARE the
  // selection, which is also the unit the selection band paints.
  const covered = coveredCellIds(document, anchor, caret);
  if (covered.length === 0) return undefined;
  return {
    edits: covered.flatMap((cellId) => clearCellEdits(document, cellId)),
    caret: { cellId: covered[0], offset: 0 },
  };
}

/** The edit deleting every visible character of one cell (none when empty). */
function clearCellEdits(
  document: StructuredDocument,
  cellId: string,
): StructuredEdit[] {
  const charIds = getCharIdsInRangeFromRuns(
    cellRuns(document, cellId) ?? [],
    0,
    cellLength(document, cellId),
  );
  return charIds.length > 0
    ? [{ kind: "text_delete", nodeId: cellId, field: CELL_TEXT_FIELD, charIds }]
    : [];
}

/**
 * The flat marks on the first character a selection covers, or `undefined`
 * for a bare caret — what text pasted over the selection takes.
 */
export function firstSelectedMarks(
  state: EditorState,
  context: TableContext,
): Mark[] | undefined {
  const { document, caret, anchor } = context;
  let cellId: string;
  let from: number;
  if (anchor.cellId === caret.cellId) {
    if (anchor.offset === caret.offset) return undefined;
    cellId = caret.cellId;
    from = Math.min(anchor.offset, caret.offset);
  } else {
    // A range across cells clears them whole and types into the first one.
    const first = coveredCellIds(document, anchor, caret)[0];
    if (first === undefined) return undefined;
    cellId = first;
    from = 0;
  }
  if (from >= cellLength(document, cellId)) return [];
  return inheritedMarksInText(
    state,
    cellRuns(document, cellId) ?? [],
    getStructuredMarks(document, cellId, CELL_TEXT_FIELD) as MarkSpan[],
    from + 1,
  );
}

/**
 * The `mark_set` edits giving pasted characters exactly `wanted`: `charIds`
 * are the visible characters starting at `caret`, in order. A paste calls this
 * once per run of equally-formatted characters.
 *
 * Inside a run the new text already sits within its span; only an edge needs
 * the mark set on it. And a span whose end is anchored to a deleted character
 * still reaches past the visible run, so text landing on the outer side of
 * that edge would come out marked though the caret says it is outside — those
 * marks are cleared from it.
 */
export function insertedMarkEdits(
  state: EditorState,
  typed: StructuredDocument,
  caret: TableCaret,
  charIds: readonly string[],
  wanted: readonly Mark[],
): StructuredEdit[] {
  if (charIds.length === 0) return [];
  const runs = cellRuns(typed, caret.cellId) ?? [];
  const spans = getStructuredMarks(
    typed,
    caret.cellId,
    CELL_TEXT_FIELD,
  ) as MarkSpan[];
  const from = caret.offset;
  const to = from + charIds.length;
  const edits: StructuredEdit[] = [];
  for (const mark of wanted) {
    if (state.schema.structuredMark(mark.type)) continue;
    if (allCharsHaveFormat(runs, spans, from, to, mark.type)) continue;
    edits.push({
      kind: "mark_set",
      nodeId: caret.cellId,
      field: CELL_TEXT_FIELD,
      charIds: [...charIds],
      mark,
      value: true,
    });
  }
  const extra = new Set<string>();
  for (let at = from + 1; at <= to; at++) {
    for (const mark of getFormatsAtCharPosition(runs, spans, at)) {
      if (state.schema.structuredMark(mark.type)) continue;
      if (wanted.some((keep) => keep.type === mark.type)) continue;
      extra.add(mark.type);
    }
  }
  for (const type of extra) {
    edits.push({
      kind: "mark_set",
      nodeId: caret.cellId,
      field: CELL_TEXT_FIELD,
      charIds: [...charIds],
      mark: { type },
      value: false,
    });
  }
  return edits;
}

/** The id of the visible character immediately before `offset`, or null. */
export function charIdBefore(
  runs: ReturnType<typeof cellRuns>,
  offset: number,
): string | null {
  if (!runs || offset <= 0) return null;
  const ids = getCharIdsInRangeFromRuns(runs, offset - 1, offset);
  return ids[0] ?? null;
}

/**
 * Insert `input` at the caret, replacing any selected range first — the
 * paragraph's `insertText`, run on the cell.
 *
 * A range across cells is the grid's: every covered cell but the first is
 * cleared, and the input then replaces the first cell's whole text, which is
 * the paragraph's "type over a selection" from there on (it takes the marks of
 * the first character it replaces).
 */
function insertIntoCell(
  state: EditorState,
  context: TableContext,
  input: string,
  options: FeatureInputOptions,
): Claimed {
  const type = (paragraph: EditorState) =>
    insertText(paragraph, input, options);
  if (context.anchor.cellId === context.caret.cellId) {
    // An IME commit over a range. A paragraph takes the range out when the
    // session STARTS and types the commit at the bare caret left behind; a
    // nested range instead stands until the commit, so a cancelled session
    // never costs the selected text. Both of the paragraph's steps run here,
    // at the commit, so the text lands — and takes its marks — exactly as in
    // a paragraph.
    const composing =
      state.ui.composition !== null &&
      context.anchor.offset !== context.caret.offset;
    return claimRun(
      state,
      runInCell(
        state,
        context,
        composing
          ? (paragraph) => {
              const cleared = deleteSelectedText(paragraph);
              const typed = type(cleared.state);
              return {
                state: typed.state,
                ops: [...cleared.ops, ...typed.ops],
              };
            }
          : type,
      ),
    );
  }

  const covered = coveredCellIds(
    context.document,
    context.anchor,
    context.caret,
  );
  const [first, ...rest] = covered;
  if (first === undefined) return { state, ops: [], handled: true };
  const cleared = commitTableEdits(
    state,
    context,
    rest.flatMap((cellId) => clearCellEdits(context.document, cellId)),
    { cellId: first, offset: 0 },
  );
  // Typing over a range that crosses cells replaces it, never wraps it: a
  // typed `(` or `*` would otherwise wrap the first cell's whole text, which
  // the user never selected as one piece.
  const run = runInCell(
    cleared.state,
    context,
    (paragraph) =>
      insertText(paragraph, input, { ...options, wrapSelection: false }),
    {
      anchor: 0,
      focus: cellLength(context.document, first),
    },
    first,
  );
  // All or nothing: a refused first cell drops the other cells' clears too, so
  // the keystroke never half-applies. `cleared` is a new state whose ops were
  // never returned, so answering with the original state discards it.
  if (run.kind === "refused") return { state, ops: [], handled: true };
  return {
    state: run.state,
    ops: [...cleared.ops, ...run.ops],
    handled: true,
  };
}

/** What a host can turn on in the cell-input rule. */
export interface TableInputOptions {
  /**
   * Run the engine's inline markdown shortcuts inside cells, so `**bold**`,
   * `*italic*`, `~~strike~~` and `` `code` `` auto-format as they are typed,
   * and a typed delimiter wraps a selection in its mark — exactly as in a
   * paragraph, Backspace (and the first undo) taking the format back.
   *
   * Off by default: a cell is one line of a grid, and a table of glob patterns
   * or shell snippets wants `*` and `` ` `` to stay literal.
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
    apply: ({ state, input, options: typing }) => {
      const context = activeTableContext(state);
      return context
        ? insertIntoCell(state, context, input, {
            ...typing,
            inlineMarkdown:
              markdownShortcuts && typing?.inlineMarkdown !== false,
          })
        : undefined;
    },
  };
}

/** The cell-input rule with every option left at its default. */
export const tableInputRule: FeatureInputRule = createTableInputRule();

/** Register the key-driven cell edits on one editor instance's bus. */
export function registerTableInputActions(bus: ActionBus): void {
  /**
   * A delete key in a cell: the paragraph's own handler for `action`, run on
   * the cell. What a paragraph would do past its edge — merge into the block
   * beside it — a cell never does: the paragraph code runs as a lone block, so
   * at the cell's edge it finds nothing to merge with and the key stays put.
   */
  const remove =
    (action: StateAction<void>) =>
    (state: EditorState): Claimed | undefined => {
      const context = activeTableContext(state);
      if (!context) return undefined;

      if (context.anchor.cellId !== context.caret.cellId) {
        const cleared = clearRange(context);
        return cleared
          ? commitTableEdits(state, context, cleared.edits, cleared.caret)
          : { state, ops: [], handled: true };
      }

      const run = runInCell(state, context, (paragraph) =>
        paragraph.actionBus.dispatchState(action, paragraph),
      );
      // Backspace at the very start of the grid escalates to holding the table
      // whole, so a second press deletes it — the block equation's gesture,
      // and the only keyboard route out of a table that has one. Everywhere
      // else the cell's edge is a wall: a table's cells are a grid, not a text
      // stream, so a delete must never merge two of them.
      if (
        action === DELETE_BACKWARD &&
        !context.content &&
        run.kind === "applied" &&
        !run.edited &&
        !run.moved &&
        context.caret.offset === 0 &&
        context.anchor.offset === 0 &&
        !state.ui.composition &&
        tableCellIds(context.document)[0] === context.caret.cellId
      ) {
        return selectTableBlock(state, context);
      }
      return claimRun(state, run);
    };
  registerTableMarkActions(bus, activeTableContext);

  // Take back a cell's markdown auto-format, ahead of the engine's own handler
  // — which stands down on a feature-owned record. Backspace and the first
  // undo both arrive here (see `keysEvents`); the paragraph's own revert runs
  // on the cell. With nothing armed for this cell, the key falls through to
  // deleting and undoing as usual.
  bus.registerState(
    REVERT_INPUT_RULE,
    (state) => {
      const armed = armedFieldRevert(state);
      const context = armed && activeTableContext(state);
      if (
        !armed ||
        !context ||
        armed.blockId !== context.block.id ||
        armed.contentId !== context.document.rootId ||
        armed.nodeId !== context.caret.cellId
      ) {
        return undefined;
      }
      return claimRun(
        state,
        runInCell(state, context, (paragraph) =>
          paragraph.actionBus.dispatchState(REVERT_INPUT_RULE, paragraph),
        ),
      );
    },
    100,
  );

  // Every delete chord a paragraph answers to: ⌫ and ⌦; ⌥⌫ / ⌥⌦ (Ctrl+⌫ /
  // Ctrl+⌦ off Apple) for a word; ⌘⌫ / ⌘⌦ and ⌃K for the rest of the line.
  for (const action of [
    DELETE_BACKWARD,
    DELETE_FORWARD,
    DELETE_WORD_BACKWARD,
    DELETE_WORD_FORWARD,
    DELETE_TO_LINE_START,
    DELETE_TO_LINE_END,
  ]) {
    bus.registerState(action, remove(action), 100);
  }

  // Enter / Shift+Enter in a cell (policy: dev-docs/enter-key.md). A GFM cell
  // holds one line, so Enter cannot split it. It moves to the cell below in the
  // same column instead — the spreadsheet convention — and on the last row it
  // grows the table by a row and lands in that column of it. Shift+Enter
  // leaves the table for a paragraph below.
  bus.registerState(
    SPLIT_BLOCK,
    (state) => {
      const context = activeTableContext(state);
      if (!context) return undefined;
      const at = cellPosition(context.document, context.caret.cellId);
      if (!at) return { state, ops: [], handled: true };
      const below = cellAt(context.document, at.row + 1, at.column);
      if (below) {
        return commitTableEdits(state, context, [], {
          cellId: below,
          offset: 0,
        });
      }
      const grown = insertRow(
        context.document,
        state.CRDTbinding,
        at.row,
        "after",
      );
      if (!grown) return { state, ops: [], handled: true };
      const rowCells = grown.edits.filter(
        (edit) => edit.kind === "node_insert" && edit.node.type === CELL_NODE,
      );
      const landing = rowCells[at.column] ?? rowCells[0];
      const cellId =
        landing?.kind === "node_insert" ? landing.node.id : grown.caret?.cellId;
      if (!cellId) return { state, ops: [], handled: true };
      return commitTableEdits(state, context, grown.edits, {
        cellId,
        offset: 0,
      });
    },
    100,
  );
  bus.registerState(
    EXIT_BLOCK,
    (state) => {
      const context = activeTableContext(state);
      if (!context) return undefined;
      const exited = insertParagraphBeside(
        updateContentSelection(state, null),
        context.blockIndex,
        "after",
        "new",
      );
      return exited
        ? { ...exited, handled: true }
        : { state, ops: [], handled: true };
    },
    100,
  );
}
