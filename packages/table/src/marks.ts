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
 * Plain marks only. A mark whose content lives in an attachment (inline math)
 * is refused — see {@link toggleTableMark}.
 */

import { type Claimed, commitTableEdits, type TableContext } from "./context";
import { cellLength, cellRuns, tableCellIds } from "./selection";
import type { ActionBus } from "@tasfer/editor/action-bus";
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
  const order = tableCellIds(document);
  const first = order.indexOf(anchor.cellId);
  const last = order.indexOf(caret.cellId);
  if (first < 0 || last < 0) return [];
  const spans: CellSpan[] = [];
  for (let at = Math.min(first, last); at <= Math.max(first, last); at++) {
    spans.push({
      cellId: order[at],
      from: 0,
      to: cellLength(document, order[at]),
    });
  }
  return spans;
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
 * A collapsed caret sets the engine's explicit pending-mark mode rather than
 * writing an edit — there is nothing to mark yet. The next typed character
 * picks it up (see `insertIntoCell`), which is what makes "Ctrl+B, then type"
 * behave in a cell the way it does in a paragraph.
 *
 * A *structured* mark (inline math) is refused outright. Its content does not
 * live in the characters it covers: it belongs to a separate attachment, and
 * the covered text collapses to one anchor character holding the mark's place.
 * A cell has no route to either — nothing creates the attachment, and cell
 * source is parsed without a schema, so the syntax is not read back. Writing
 * the bare `mark_set` this function otherwise emits would produce a mark with
 * no formula behind it, which serializes to syntax that reloads as literal
 * text. Refusing here closes every route at once — the context menu, the
 * mobile drawer, a keybinding, the public `setMark` — rather than each caller
 * separately.
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

  const spans = coveredSpans(context);
  const collapsed = spans.every((span) => span.from === span.to);
  if (collapsed) {
    const mode = state.ui.activeMarksMode;
    const pending =
      mode.type === "explicit"
        ? mode.formats.filter((format) => format.type !== name)
        : [];
    const wasPending =
      mode.type === "explicit" &&
      mode.formats.some((format) => format.type === name);
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
