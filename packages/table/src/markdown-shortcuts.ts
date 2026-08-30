/**
 * Markdown auto-format inside a cell: typing `**bold**` leaves bold text.
 *
 * The engine runs these shortcuts over flat block text. A cell has none — its
 * characters live in the table's structured attachment — so the transform is
 * re-expressed here as {@link StructuredEdit}s against the cell's text field,
 * exactly the ones a `Ctrl+B` in that cell would emit. The *vocabulary* is not
 * re-expressed: {@link INLINE_MARKDOWN_PATTERNS} is imported from the engine so
 * `**` cannot come to mean one thing in a paragraph and another in a cell.
 *
 * It is opt-in (`tableExtension({ markdownShortcuts: true })`) because a cell is
 * one line of a grid, and a host that expects `*` to stay `*` in a data table —
 * a column of glob patterns, a column of C pointers — is not wrong to.
 *
 * Backspace (and the first undo) takes the wrap back and leaves the literal
 * syntax standing, which is the only way to type `*text*` in a cell once the
 * shortcuts are on. That armed record rides in the engine's own revert slot as
 * a feature-owned payload; this module both writes and reads it.
 */

import { type Claimed, commitTableEdits, tableTargetForBlock } from "./context";
import { cellRuns } from "./selection";
import { cellRunsFromText } from "./structured";
import {
  INLINE_MARKDOWN_PATTERNS,
  isInlineMarkdownDelimiter,
} from "@tasfer/editor/actions/actions";
import type { EditorState } from "@tasfer/editor/state-types";
import {
  getCharIdsInRangeFromRuns,
  getVisibleTextFromRuns,
} from "@tasfer/editor/sync/char-runs";
import type {
  StructuredDocument,
  StructuredEdit,
} from "@tasfer/editor/sync/structured-content";

export { isInlineMarkdownDelimiter };

/** Identifies this feature's records in the engine's shared revert slot. */
export const TABLE_MARKDOWN_RULE = "table.cell.markdown";

/** Everything needed to put one wrapped cell back the way it was typed. */
export interface CellWrapRevert {
  readonly blockId: string;
  readonly cellId: string;
  readonly markType: string;
  /** The delimiter that wrapped the text (`**`, `` ` ``, …). */
  readonly marker: string;
  /** Visible offset of the wrapped text in the cell. */
  readonly start: number;
  readonly innerLen: number;
}

/** A recognized wrap: the edits that apply it, and how to take it back. */
export interface CellWrap {
  readonly edits: readonly StructuredEdit[];
  /** Where the caret lands once the delimiters are gone. */
  readonly offset: number;
  readonly revert: Omit<CellWrapRevert, "blockId">;
}

/** The visible character ids of `[from, to)` in one cell's text field. */
function charIdsIn(
  document: StructuredDocument,
  cellId: string,
  from: number,
  to: number,
): readonly string[] {
  return getCharIdsInRangeFromRuns(cellRuns(document, cellId), from, to);
}

/** The id of the visible character immediately before `offset`, or null. */
function charIdBefore(
  document: StructuredDocument,
  cellId: string,
  offset: number,
): string | null {
  if (offset <= 0) return null;
  return charIdsIn(document, cellId, offset - 1, offset)[0] ?? null;
}

/**
 * The wrap the text ending at `offset` completes, or `undefined`.
 *
 * `document` must already carry the keystroke that closed the delimiter — the
 * edits address characters by CRDT id, and the closing marker's id only exists
 * once it has been inserted.
 */
export function detectCellMarkdown(
  state: EditorState,
  document: StructuredDocument,
  cellId: string,
  offset: number,
): CellWrap | undefined {
  const runs = cellRuns(document, cellId);
  if (!runs) return undefined;
  const text = getVisibleTextFromRuns(runs).slice(0, offset);

  for (const { regex, markerLen, format } of INLINE_MARKDOWN_PATTERNS) {
    // Skip a mark the schema forbids authoring, leaving the delimiters literal
    // — the same standing-down the flat path does (no-op when unrestricted).
    if (!state.schema.isMarkAllowed(format.type)) continue;
    const match = text.match(regex);
    if (!match) continue;
    const start = offset - match[0].length;
    const innerLen = match[1].length;
    const innerStart = start + markerLen;
    const inner = charIdsIn(
      document,
      cellId,
      innerStart,
      innerStart + innerLen,
    );
    if (inner.length === 0) continue;

    return {
      // Deleting by character id, so the two markers do not shift each other's
      // range and the marked run keeps the ids it was found under.
      edits: [
        {
          kind: "text_delete",
          nodeId: cellId,
          field: "text",
          charIds: [
            ...charIdsIn(document, cellId, offset - markerLen, offset),
            ...charIdsIn(document, cellId, start, start + markerLen),
          ],
        },
        {
          kind: "mark_set",
          nodeId: cellId,
          field: "text",
          charIds: inner,
          mark: format,
          value: true,
        },
      ],
      offset: start + innerLen,
      revert: {
        cellId,
        markType: format.type,
        marker: match[0].slice(0, markerLen),
        start,
        innerLen,
      },
    };
  }
  return undefined;
}

/** Arm `revert` in the engine's revert slot on an already-committed result. */
export function armCellWrapRevert(
  result: Claimed,
  revert: CellWrapRevert,
): Claimed {
  return {
    ...result,
    state: {
      ...result.state,
      ui: {
        ...result.state.ui,
        revertibleInputRule: {
          kind: "feature",
          ruleId: TABLE_MARKDOWN_RULE,
          data: revert,
        },
      },
    },
  };
}

/** The armed cell wrap, when the slot holds one of ours. */
export function armedCellWrap(state: EditorState): CellWrapRevert | undefined {
  const record = state.ui.revertibleInputRule;
  if (!record || record.kind !== "feature") return undefined;
  if (record.ruleId !== TABLE_MARKDOWN_RULE) return undefined;
  return record.data as CellWrapRevert;
}

/**
 * Undo one cell wrap, putting the delimiters the user typed back.
 *
 * A forward edit, not an inverse replay — same bargain the engine's flat revert
 * strikes: the undo stack groups a whole event drain, so the wrap's operations
 * are not separable there, and re-inserting the syntax merges against whatever
 * peers did in the meantime like any other edit.
 */
export function revertCellWrap(
  state: EditorState,
  revert: CellWrapRevert,
): Claimed | undefined {
  const target = tableTargetForBlock(state, revert.blockId);
  if (!target) return undefined;
  const { document } = target;
  const { cellId, start, innerLen, marker } = revert;
  const inner = charIdsIn(document, cellId, start, start + innerLen);
  if (inner.length !== innerLen) return undefined;

  const runsFor = (text: string) => cellRunsFromText(text, state.CRDTbinding);
  const result = commitTableEdits(
    state,
    target,
    [
      {
        kind: "mark_set",
        nodeId: cellId,
        field: "text",
        charIds: inner,
        mark: { type: revert.markType },
        value: false,
      },
      // Both anchors are characters the other insert does not touch, so the
      // closing marker does not have to go first the way an index-addressed
      // insert would.
      {
        kind: "text_insert",
        nodeId: cellId,
        field: "text",
        afterCharId: inner[innerLen - 1],
        charRuns: runsFor(marker),
      },
      {
        kind: "text_insert",
        nodeId: cellId,
        field: "text",
        afterCharId: charIdBefore(document, cellId, start),
        charRuns: runsFor(marker),
      },
    ],
    { cellId, offset: start + innerLen + marker.length * 2 },
  );
  // The syntax is literal again and must stay that way: nothing re-runs the
  // rule (detection only fires on a typed delimiter), but the slot itself has
  // to be released so the next Backspace deletes.
  return {
    ...result,
    state: {
      ...result.state,
      ui: { ...result.state.ui, revertibleInputRule: null },
    },
  };
}
