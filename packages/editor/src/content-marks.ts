/**
 * Marks over prose kept inside structured content (text in a table cell).
 *
 * A block's own text reads and writes marks through flat offsets. Prose a node
 * keeps in a structured attachment has none, so a link under a cell caret was
 * invisible to `query.marks` and `setMark` could not reach it. Both go through
 * here instead, over the fields the attachment's kind declares as prose (its
 * `textFields` adapter) — core's own storage, so no node type is named.
 */

import { joinTouchingMarkRuns, resolveMarkRunsFromChars } from "./mark-runs";
import type { CharRun, Mark } from "./serlization/loadPage";
import type { EditorState } from "./state-types";
import {
  type ContentSelection,
  type ContentTextPoint,
  isSameContentTextField,
  resolveContentTextPointOffset,
} from "./structured-selection";
import { findBlock } from "./sync/block-lookup";
import {
  getCharIdAtVisiblePosition,
  getCharIdsInRangeFromRuns,
  getVisibleTextFromRuns,
  iterateAllChars,
} from "./sync/char-runs";
import {
  getStructuredMarks,
  type StructuredEdit,
} from "./sync/structured-content";

/** One mark run inside a prose field, as `query.marks` reports it. */
export interface ContentMarkRun {
  readonly name: string;
  readonly attrs: Record<string, unknown>;
  readonly blockId: string;
  /** Visible offsets into the field; `to` is after the run's last character. */
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** The run's extent, addressed by stable identities — a `setMark` range. */
  readonly selection: ContentSelection;
}

interface ProseField {
  readonly blockId: string;
  readonly contentId: string;
  readonly nodeId: string;
  readonly field: string;
  readonly runs: CharRun[];
  readonly start: number;
  readonly end: number;
}

/**
 * The prose field a nested range lies in, with its ordered offsets, or `null`
 * when the ends are not text points in one declared prose field.
 */
function proseFieldOf(
  s: EditorState,
  selection: ContentSelection,
): ProseField | null {
  const { anchor, focus } = selection;
  if (anchor.kind !== "text" || focus.kind !== "text") return null;
  if (!isSameContentTextField(anchor, focus)) return null;
  const block = findBlock(s.document.page, focus.blockId);
  const document = block?.structuredContent?.[focus.contentId];
  if (!block || block.deleted || !document) return null;
  const isProse = s.schema
    .structuredTextFields(document)
    .some((ref) => ref.nodeId === focus.nodeId && ref.field === focus.field);
  if (!isProse) return null;
  const node = document.nodes[focus.nodeId];
  const runs = node?.textFields[focus.field];
  if (!node || node.deleted || !runs) return null;
  const a = resolveContentTextPointOffset(s.document.page, anchor);
  const b = resolveContentTextPointOffset(s.document.page, focus);
  if (a === null || b === null) return null;
  return {
    blockId: block.id,
    contentId: focus.contentId,
    nodeId: focus.nodeId,
    field: focus.field,
    runs: [...runs],
    start: Math.min(a, b),
    end: Math.max(a, b),
  };
}

function pointAt(
  field: ProseField,
  offset: number,
  affinity: ContentTextPoint["affinity"],
): ContentTextPoint {
  return {
    kind: "text",
    blockId: field.blockId,
    contentId: field.contentId,
    nodeId: field.nodeId,
    field: field.field,
    afterCharId: getCharIdAtVisiblePosition(field.runs, offset),
    affinity,
  };
}

/**
 * The mark runs at a nested caret (`from <= offset < to`) or intersecting a
 * nested range, with touching runs of one mark joined the way flat reads join
 * them. `[]` outside declared prose.
 */
export function contentMarkRuns(
  s: EditorState,
  selection: ContentSelection,
): ContentMarkRun[] {
  const field = proseFieldOf(s, selection);
  if (!field) return [];
  const block = findBlock(s.document.page, field.blockId)!;
  const document = block.structuredContent![field.contentId];
  const runs = joinTouchingMarkRuns(
    resolveMarkRunsFromChars(
      iterateAllChars(field.runs),
      getStructuredMarks(document, field.nodeId, field.field),
    ),
    getVisibleTextFromRuns(field.runs),
    (name) => !s.schema.structuredMark(name) && !s.marks.get(name)?.replacement,
  );
  const collapsed = field.start === field.end;
  return runs
    .filter((run) =>
      collapsed
        ? field.start >= run.startIndex && field.start < run.endIndex
        : run.startIndex < field.end && run.endIndex > field.start,
    )
    .map((run) => ({
      name: run.name,
      attrs: run.attrs,
      blockId: field.blockId,
      from: run.startIndex,
      to: run.endIndex,
      text: run.text,
      selection: {
        anchor: pointAt(field, run.startIndex, "backward"),
        focus: pointAt(field, run.endIndex, "forward"),
      },
    }));
}

/**
 * The structured edit applying (`active`) or clearing `mark` over a nested
 * range, or `null` when it cannot: a collapsed range, ends outside one declared
 * prose field, a disallowed mark, or a structured mark (inline math), whose
 * content lives in an attachment a cell has no route to create.
 */
export function contentMarkEdit(
  s: EditorState,
  selection: ContentSelection,
  mark: Mark,
  active: boolean,
): { blockId: string; contentId: string; edit: StructuredEdit } | null {
  if (!s.schema.isMarkAllowed(mark.type)) return null;
  if (s.schema.structuredMark(mark.type)) return null;
  const field = proseFieldOf(s, selection);
  if (!field || field.start === field.end) return null;
  const charIds = getCharIdsInRangeFromRuns(field.runs, field.start, field.end);
  if (charIds.length === 0) return null;
  return {
    blockId: field.blockId,
    contentId: field.contentId,
    edit: {
      kind: "mark_set",
      nodeId: field.nodeId,
      field: field.field,
      charIds,
      mark,
      value: active,
    },
  };
}
