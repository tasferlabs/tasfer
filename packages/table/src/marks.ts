/**
 * Inline formatting inside a cell.
 *
 * A cell's text has always been able to CARRY marks — the field has its own
 * mark ranges, layout and paint resolve them, and Markdown round-trips them.
 * What was missing was any way to produce one: the generic toggle resolves a
 * flat selection range, a table has none, and so Ctrl/Cmd+B in a cell did
 * nothing at all.
 *
 * This is the producer. It claims the engine's single {@link TOGGLE_MARK}
 * action, so the keyboard, the mobile toolbar and the desktop Format menu all
 * arrive here by the same route, and emits the same `mark_set` structured edit
 * the Markdown importer already writes — the cell ends up in exactly the state
 * an imported `**bold**` cell would.
 *
 * Inside one cell the toggle is the paragraph's own, run on the cell (see
 * `runInCell`). Only a range across cells is decided here: every covered cell
 * is marked whole, the way deleting such a range clears them whole.
 *
 * Plain marks only. Toggling on a mark whose content lives in an attachment
 * (inline math) is refused — see {@link toggleTableMark}.
 */

import {
  type Claimed,
  claimRun,
  commitTableEdits,
  runInCell,
  type TableContext,
} from "./context";
import { cellLength, cellRuns, coveredCellIds } from "./selection";
import type { ActionBus } from "@tasfer/editor/action-bus";
import { inheritedMarksInText } from "@tasfer/editor/mark-edge";
import { TOGGLE_MARK } from "@tasfer/editor/rendering/marks";
import type { Mark, MarkSpan } from "@tasfer/editor/serlization/loadPage";
import type { EditorState } from "@tasfer/editor/state-types";
import { getCharIdsInRangeFromRuns } from "@tasfer/editor/sync/char-runs";
import { allCharsHaveFormat } from "@tasfer/editor/sync/crdt-utils";
import {
  getStructuredMarks,
  type StructuredDocument,
  type StructuredEdit,
} from "@tasfer/editor/sync/structured-content";

/** The `[from, to)` span a selection covers in one cell, or the whole cell. */
interface CellSpan {
  readonly cellId: string;
  readonly from: number;
  readonly to: number;
}

/**
 * The cells a selection covers, and how much of each.
 *
 * Within one cell that is the selected span; across cells it is every covered
 * cell WHOLE — the same rule deleting a multi-cell range follows, because a
 * grid has no meaningful "half a cell then half another".
 */
function coveredSpans(context: TableContext): CellSpan[] {
  const { document, caret, anchor } = context;
  if (anchor.cellId === caret.cellId) {
    const from = Math.min(anchor.offset, caret.offset);
    const to = Math.max(anchor.offset, caret.offset);
    return [{ cellId: caret.cellId, from, to }];
  }
  return coveredCellIds(document, anchor, caret).map((cellId) => ({
    cellId,
    from: 0,
    to: cellLength(document, cellId),
  }));
}

/**
 * Whether every character the selection covers already carries `name`.
 *
 * Decides the toggle's direction, and matches how prose behaves: a partially
 * bold selection bolds the rest rather than clearing what is already bold.
 */
function spansAllHaveMark(
  document: StructuredDocument,
  spans: readonly CellSpan[],
  name: string,
): boolean {
  let sawText = false;
  for (const span of spans) {
    if (span.from === span.to) continue;
    sawText = true;
    const marks = getStructuredMarks(
      document,
      span.cellId,
      "text",
    ) as MarkSpan[];
    if (
      !allCharsHaveFormat(
        cellRuns(document, span.cellId),
        marks,
        span.from,
        span.to,
        name,
      )
    ) {
      return false;
    }
  }
  return sawText;
}

/** The `mark_set` edits applying (or clearing) `mark` across `spans`. */
function markEdits(
  document: StructuredDocument,
  spans: readonly CellSpan[],
  mark: Mark,
  value: boolean,
): StructuredEdit[] {
  const edits: StructuredEdit[] = [];
  for (const span of spans) {
    if (span.from === span.to) continue;
    const charIds = getCharIdsInRangeFromRuns(
      cellRuns(document, span.cellId),
      span.from,
      span.to,
    );
    if (charIds.length === 0) continue;
    edits.push({
      kind: "mark_set",
      nodeId: span.cellId,
      field: "text",
      charIds,
      mark,
      value,
    });
  }
  return edits;
}

/**
 * Toggle `name` over whatever the table selection covers.
 *
 * Within one cell this is the paragraph's toggle: a bare caret arms the mark
 * for what is typed next, a range is marked or unmarked as a paragraph's is.
 * Across cells, a range of empty cells arms the mark the same way, and any
 * other range marks every covered cell whole — unless all of it already
 * carries the mark, which clears it.
 *
 * A *structured* mark (inline math) is refused outright. Its content does not
 * live in the characters it covers: it belongs to a separate attachment, and
 * the covered text collapses to one anchor character holding the mark's place.
 * A cell CAN hold one — Markdown import and paste write the attachment beside
 * the table's document on the block — but toggling one on here would emit a
 * bare `mark_set` with no formula behind it. Refusing here closes every route
 * at once — the context menu, the mobile drawer, a keybinding, the public
 * `setMark` — rather than each caller separately.
 */
export function toggleTableMark(
  state: EditorState,
  context: TableContext,
  name: string,
): Claimed | undefined {
  if (!state.schema.isMarkAllowed(name)) return undefined;
  if (state.schema.structuredMark(name)) return undefined;
  const definition = state.marks.get(name);
  if (definition?.togglable !== true) return undefined;

  // Inside one cell the toggle is the paragraph's own, run on the cell — the
  // pending mark at a bare caret, the side of a mark edge, partial ranges.
  if (context.anchor.cellId === context.caret.cellId) {
    return claimRun(
      state,
      runInCell(state, context, (paragraph) =>
        paragraph.actionBus.dispatchState(TOGGLE_MARK, paragraph, { name }),
      ),
    );
  }

  const spans = coveredSpans(context);
  const collapsed = spans.every((span) => span.from === span.to);
  if (collapsed) {
    // Start from what typing here would take: the explicit set, or the marks
    // of the text behind the caret — so Ctrl+B at the end of a bold run turns
    // bold off for what comes next, as it does in a paragraph.
    const mode = state.ui.activeMarksMode;
    const current =
      mode.type === "explicit"
        ? mode.formats
        : inheritedMarksInText(
            state,
            cellRuns(context.document, context.caret.cellId) ?? [],
            getStructuredMarks(
              context.document,
              context.caret.cellId,
              "text",
            ) as MarkSpan[],
            context.caret.offset,
          );
    const pending = current.filter((format) => format.type !== name);
    const wasPending = current.some((format) => format.type === name);
    return {
      state: {
        ...state,
        ui: {
          ...state.ui,
          activeMarksMode: {
            type: "explicit",
            formats: wasPending ? pending : [...pending, { type: name }],
          },
        },
      },
      ops: [],
      handled: true,
    };
  }

  const value = !spansAllHaveMark(context.document, spans, name);
  const edits = markEdits(context.document, spans, { type: name }, value);
  if (edits.length === 0) return { state, ops: [], handled: true };
  // The caret stays where it is: formatting a selection must not collapse it.
  return commitTableEdits(state, context, edits, undefined);
}

/** Register the cell mark toggles on one editor instance's bus. */
export function registerTableMarkActions(
  bus: ActionBus,
  activeContext: (state: EditorState) => TableContext | undefined,
): void {
  bus.registerState(
    TOGGLE_MARK,
    (state, { name }) => {
      const context = activeContext(state);
      return context ? toggleTableMark(state, context, name) : undefined;
    },
    100,
  );
}
