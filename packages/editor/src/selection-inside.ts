/**
 * A text selection that starts or ends in the middle of an inline mark run (a
 * formula).
 *
 * The flat text holds a formula as one character, so a flat range can only
 * take it whole or leave it out. `SelectionState.inside` keeps the stop inside
 * the formula for either end; this module turns those stops into the part of
 * each formula the selection really takes, and keeps the flat range honest
 * around them:
 *
 * - the selected part is only PART of the formula → the flat range covers the
 *   formula's character and the part is reported here;
 * - the part is the whole formula, or nothing of it → the flat range says so
 *   by itself (covers the character, or stops before it) and nothing is
 *   reported, so code that knows nothing of `inside` still reads the truth.
 *
 * Which of the three holds is the formula's own call, through the schema's
 * `contentEdgeRange` facet; core names no mark type.
 */

import type { ContentEdgeRange } from "./feature-facets";
import { resolveMarkRuns } from "./mark-runs";
import type {
  EditorState,
  Position,
  SelectionInside,
  SelectionState,
} from "./state-types";
import type { ContentPoint, ContentSelection } from "./structured-selection";
import { findBlockIndex } from "./sync/block-lookup";
import { isTextualBlock } from "./sync/block-registry";

/** The flat projection of one inline mark run. */
export interface InlineRunRange {
  readonly blockIndex: number;
  readonly startIndex: number;
  readonly endIndex: number;
}

/**
 * The replacement-mark run whose structured attachment owns `point`, resolved
 * through the generic references facet (the core names no mark type). Returns
 * the run's flat projection bounds, or `null` when the point's block/content
 * no longer resolves — e.g. the attachment belongs to a whole-block node
 * rather than an inline mark.
 */
export function structuredMarkRunForContentPoint(
  state: EditorState,
  point: ContentPoint,
): InlineRunRange | null {
  const blockIndex = findBlockIndex(state.document.page, point.blockId);
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return null;
  const attachments = block.structuredContent;
  for (const run of resolveMarkRuns(block)) {
    const references = state.schema.structuredMarkReferences(run.name, {
      mark: {
        type: run.name,
        ...(Object.keys(run.attrs).length > 0 ? { attrs: run.attrs } : {}),
      },
      attachments,
    });
    if (references.includes(point.contentId)) {
      return { blockIndex, startIndex: run.startIndex, endIndex: run.endIndex };
    }
  }
  return null;
}

/**
 * The part of the formula holding `point` that lies between the point and one
 * of the formula's edges, with the formula's flat run. Null when the point no
 * longer sits in an inline run, or its kind is only ever taken whole.
 */
export function insideEdgeRange(
  state: EditorState,
  point: ContentPoint,
  edge: "start" | "end",
): { run: InlineRunRange; range: ContentEdgeRange } | null {
  const run = structuredMarkRunForContentPoint(state, point);
  if (!run) return null;
  const block = state.document.page.blocks[run.blockIndex];
  const document = block?.structuredContent?.[point.contentId];
  if (!block || !document) return null;
  const range = state.schema.contentEdgeRange({
    document,
    blockId: block.id,
    contentId: point.contentId,
    point,
    edge,
  });
  return range ? { run, range } : null;
}

/** Whether `position` lies at or before the start of `run`. */
function isBeforeRun(position: Position, run: InlineRunRange): boolean {
  return (
    position.blockIndex < run.blockIndex ||
    (position.blockIndex === run.blockIndex &&
      position.textIndex <= run.startIndex)
  );
}

/** Whether `position` lies at or after the end of `run`. */
function isAfterRun(position: Position, run: InlineRunRange): boolean {
  return (
    position.blockIndex > run.blockIndex ||
    (position.blockIndex === run.blockIndex &&
      position.textIndex >= run.endIndex)
  );
}

/**
 * Where the flat end of a selection belongs when that end really stops at
 * `point` inside a formula and the other end is at `other`, outside it.
 *
 * The part of the formula between the stop and the edge facing `other` is what
 * the selection takes. When that is some or all of the formula, the flat end
 * sits on the formula's far edge so the range covers its character; when it is
 * nothing, on the near edge so the range leaves the formula out. Null when the
 * stop no longer resolves or its kind has no say (the caller keeps its own
 * rule).
 */
export function flatEndForInside(
  state: EditorState,
  point: ContentPoint,
  other: Position,
): Position | null {
  const run = structuredMarkRunForContentPoint(state, point);
  if (!run) return null;
  const before = isBeforeRun(other, run);
  const resolved = insideEdgeRange(state, point, before ? "start" : "end");
  if (!resolved) return null;
  const near = before ? run.startIndex : run.endIndex;
  const far = before ? run.endIndex : run.startIndex;
  return {
    blockIndex: run.blockIndex,
    textIndex: resolved.range.covers === "none" ? near : far,
  };
}

/** One formula a text selection takes only part of. */
export interface SelectionInsidePart {
  /** Which end of the selection stops inside the formula. */
  readonly end: "anchor" | "focus";
  /** Whether that end is where the selection starts or ends, in document order. */
  readonly side: "start" | "end";
  /** The formula's flat run; the selection's flat range covers it. */
  readonly run: InlineRunRange;
  /** The selected part of the formula: `anchor` at the stop, `focus` at its edge. */
  readonly selection: ContentSelection;
}

/**
 * The formulas at the ends of the flat selection that it takes only part of.
 *
 * Empty for a plain selection, and for a stop that no longer matches the flat
 * range (the formula is gone, the range moved off it, or the part turned out
 * to be all or nothing of the formula) — then the flat range alone is true.
 */
export function selectionInsideParts(
  state: EditorState,
  selection: SelectionState | null = state.document.selection,
): readonly SelectionInsidePart[] {
  const inside = selection?.inside;
  if (!selection || !inside || selection.isCollapsed) return NO_PARTS;
  // Painting asks once per block per frame, and the answer costs a formula
  // layout. Selections and pages are immutable, so the last answer for this
  // selection holds for as long as the page it was read against.
  const known = partsBySelection.get(selection);
  if (
    known &&
    known.page === state.document.page &&
    known.schema === state.schema
  ) {
    return known.parts;
  }
  const parts = resolveInsideParts(state, selection, inside);
  partsBySelection.set(selection, {
    page: state.document.page,
    schema: state.schema,
    parts,
  });
  return parts;
}

const NO_PARTS: readonly SelectionInsidePart[] = [];

/** Memo of {@link selectionInsideParts}, keyed by the immutable selection. */
const partsBySelection = new WeakMap<
  SelectionState,
  {
    readonly page: EditorState["document"]["page"];
    readonly schema: EditorState["schema"];
    readonly parts: readonly SelectionInsidePart[];
  }
>();

function resolveInsideParts(
  state: EditorState,
  selection: SelectionState,
  inside: SelectionInside,
): readonly SelectionInsidePart[] {
  const parts: SelectionInsidePart[] = [];
  for (const end of ["anchor", "focus"] as const) {
    const point = inside[end];
    if (!point) continue;
    const startsHere = (end === "anchor") === selection.isForward;
    const resolved = insideEdgeRange(
      state,
      point,
      startsHere ? "end" : "start",
    );
    if (!resolved || resolved.range.covers !== "part") continue;
    const { run } = resolved;
    const here = selection[end];
    const other = selection[end === "anchor" ? "focus" : "anchor"];
    const far = startsHere ? run.startIndex : run.endIndex;
    if (here.blockIndex !== run.blockIndex || here.textIndex !== far) continue;
    // The rest of the selection lies at or beyond the formula's other edge.
    if (!(startsHere ? isAfterRun(other, run) : isBeforeRun(other, run))) {
      continue;
    }
    parts.push({
      end,
      side: startsHere ? "start" : "end",
      run,
      selection: resolved.range.selection,
    });
  }
  return parts;
}

/**
 * The flat range of a selection without the formulas it takes only part of —
 * the plain text (and whole formulas) between them. Null when nothing is left,
 * i.e. the selection is those parts alone.
 */
export function flatRangeOutsideParts(
  selection: SelectionState,
  parts: readonly SelectionInsidePart[],
): { anchor: Position; focus: Position; isForward: boolean } | null {
  let { anchor, focus } = selection;
  for (const part of parts) {
    const edge: Position = {
      blockIndex: part.run.blockIndex,
      textIndex:
        part.side === "start" ? part.run.endIndex : part.run.startIndex,
    };
    if (part.end === "anchor") anchor = edge;
    else focus = edge;
  }
  if (
    anchor.blockIndex === focus.blockIndex &&
    anchor.textIndex === focus.textIndex
  ) {
    return null;
  }
  return { anchor, focus, isForward: selection.isForward };
}

/** Whether the flat selection takes only part of a formula at either end. */
export function selectionHasInsidePart(state: EditorState): boolean {
  return selectionInsideParts(state).length > 0;
}

/** `inside` with one end replaced; `undefined` once neither end is set. */
export function withInsideEnd(
  inside: SelectionInside | null | undefined,
  end: "anchor" | "focus",
  point: ContentPoint | null,
): SelectionInside | undefined {
  const next = { ...inside };
  if (point) next[end] = point;
  else delete next[end];
  return next.anchor || next.focus ? next : undefined;
}
