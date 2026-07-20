/**
 * Bridges editor-core structured selections, the math tree editor's CRDT
 * carets, and @tasfer/tex's identity-keyed layout positions.
 *
 * None of these conversions persist a LaTeX offset. Pointer hit-testing enters
 * through identity-keyed MathDocument geometry directly; source offsets remain
 * only as a compatibility bridge for old flat cursors and interchange APIs.
 */

import type { ContentPoint, ContentSelection } from "../structured-selection";
import { findCharInRuns, getVisibleOffsetAfterChar } from "../sync/char-runs";
import {
  getStructuredChildren,
  type StructuredDocument,
} from "../sync/structured-content";
import { structuredToMathDocument } from "./structured";
import type { MathTreeCaret } from "./tree-edit";
import {
  layoutMathDocument,
  type MathDocument,
  type MathDocumentCaretPosition,
  mathDocumentCaretStop,
  mathDocumentCaretVertical,
  type MathDocumentLayout,
  printMathDocument,
  resolveSelectionRange,
} from "@tasfer/tex";

/** Convert a generic collapsed selection endpoint to the math editor currency. */
export function contentPointToMathTreeCaret(
  document: StructuredDocument,
  point: ContentPoint,
): MathTreeCaret | null {
  if (point.contentId !== document.rootId) return null;
  if (point.kind === "gap") {
    const parent = document.nodes[point.parentId];
    if (!parent || parent.deleted || parent.type !== "row") return null;
    if (point.slot !== "children") return null;
    return {
      kind: "row",
      rowId: point.parentId,
      afterNodeId: point.afterNodeId,
    };
  }

  if (point.field !== "text") return null;
  const node = document.nodes[point.nodeId];
  const rowId = node?.placement.parentId;
  if (
    !node ||
    node.deleted ||
    (node.type !== "raw-text" && node.type !== "text") ||
    !rowId ||
    node.placement.slot !== "children"
  ) {
    return null;
  }
  return {
    kind: "text",
    rowId,
    nodeId: node.id,
    field: "text",
    afterCharId: point.afterCharId,
  };
}

/** Convert the pure math editor's result back to a generic core selection. */
export function mathTreeCaretToContentSelection(
  blockId: string,
  contentId: string,
  document: StructuredDocument,
  caret: MathTreeCaret,
  lastUpdate = Date.now(),
): ContentSelection | null {
  let point: ContentPoint;
  if (caret.kind === "row") {
    point = {
      kind: "gap",
      blockId,
      contentId,
      parentId: caret.rowId,
      slot: "children",
      afterNodeId: caret.afterNodeId,
      affinity: "forward",
    };
  } else {
    const node = document.nodes[caret.nodeId];
    if (
      !node ||
      node.deleted ||
      (node.type !== "raw-text" && node.type !== "text")
    ) {
      return null;
    }
    if (
      caret.afterCharId &&
      !findCharInRuns([...(node.textFields.text ?? [])], caret.afterCharId)
    ) {
      return null;
    }
    point = {
      kind: "text",
      blockId,
      contentId,
      nodeId: caret.nodeId,
      field: "text",
      afterCharId: caret.afterCharId,
      affinity: "forward",
    };
  }
  return { anchor: point, focus: point, lastUpdate };
}

/**
 * Move an identity-bearing tree caret to the visually nearest editable stop on
 * the row above/below it. Layout/source offsets are transient geometry only;
 * the returned editor caret remains addressed entirely by CRDT identities.
 */
export function moveMathTreeCaretVertically(
  document: StructuredDocument,
  caret: MathTreeCaret,
  direction: "up" | "down",
  layout?: MathDocumentLayout,
): MathTreeCaret | null {
  const selection = mathTreeCaretToContentSelection(
    "math-layout-host",
    document.rootId,
    document,
    caret,
  );
  const position = selection
    ? contentPointToMathDocumentPosition(document, selection.focus)
    : null;
  const math = structuredToMathDocument(document);
  if (!position || !math) return null;
  const resolvedLayout = layout ?? layoutMathDocument(math);
  const target = mathDocumentCaretVertical(resolvedLayout, position, direction);
  if (!target) return null;

  const positions = [...target.positions].sort((left, right) =>
    left.kind === right.kind ? 0 : left.kind === "field" ? -1 : 1,
  );
  for (const candidate of positions) {
    const point = mathDocumentPositionToContentPoint(
      "math-layout-host",
      document.rootId,
      document,
      candidate,
    );
    if (!point) continue;
    const editable = contentPointToMathTreeCaret(document, point);
    if (editable) return editable;
  }
  return null;
}

/** Convert a generic point to @tasfer/tex's stable layout address. */
export function contentPointToMathDocumentPosition(
  document: StructuredDocument,
  point: ContentPoint,
): MathDocumentCaretPosition | null {
  if (point.contentId !== document.rootId) return null;
  if (point.kind === "gap") {
    if (point.slot !== "children") return null;
    const children = getStructuredChildren(
      document,
      point.parentId,
      point.slot,
    );
    const offset =
      point.afterNodeId === null
        ? 0
        : children.findIndex((child) => child.id === point.afterNodeId) + 1;
    if (point.afterNodeId !== null && offset === 0) return null;
    return { kind: "row", rowId: point.parentId, offset };
  }

  if (
    point.field !== "text" &&
    point.field !== "latex" &&
    point.field !== "name"
  ) {
    return null;
  }
  const node = document.nodes[point.nodeId];
  const rowId = node?.placement.parentId;
  if (!node || node.deleted || !rowId) return null;
  const offset = getVisibleOffsetAfterChar(
    [...(node.textFields[point.field] ?? [])],
    point.afterCharId,
  );
  if (offset === null) return null;
  return {
    kind: "field",
    rowId,
    nodeId: point.nodeId,
    field: point.field,
    offset,
  };
}

/** Convert an identity-keyed layout stop to a generic core point. */
export function mathDocumentPositionToContentPoint(
  blockId: string,
  contentId: string,
  document: StructuredDocument,
  position: MathDocumentCaretPosition,
): ContentPoint | null {
  if (position.kind === "row") {
    const children = getStructuredChildren(
      document,
      position.rowId,
      "children",
    );
    if (position.offset < 0 || position.offset > children.length) return null;
    return {
      kind: "gap",
      blockId,
      contentId,
      parentId: position.rowId,
      slot: "children",
      afterNodeId: children[position.offset - 1]?.id ?? null,
      affinity: "forward",
    };
  }

  const node = document.nodes[position.nodeId];
  if (!node || node.deleted || !node.textFields[position.field]) return null;
  const runs = [...node.textFields[position.field]];
  let afterCharId: string | null = null;
  let visibleOffset = 0;
  for (const run of runs) {
    for (let offset = 0; offset < run.text.length; offset++) {
      const byte = run.deletedMask?.[Math.floor(offset / 8)] ?? 0;
      if ((byte & (1 << (offset % 8))) !== 0) continue;
      if (visibleOffset === position.offset) break;
      afterCharId = `${run.peerId}:${run.startCounter + offset}`;
      visibleOffset += 1;
    }
    if (visibleOffset === position.offset) break;
  }
  if (visibleOffset !== position.offset) return null;
  return {
    kind: "text",
    blockId,
    contentId,
    nodeId: position.nodeId,
    field: position.field,
    afterCharId,
    affinity: "forward",
  };
}

/**
 * Resolve a transient canonical-source caret to the nearest position supported
 * by the tree editor (row gaps and character-editable leaf fields).
 */
export function mathTreeCaretFromSourceOffset(
  blockId: string,
  contentId: string,
  math: MathDocument,
  document: StructuredDocument,
  sourceOffset: number,
  layout: MathDocumentLayout = layoutMathDocument(math),
): MathTreeCaret | null {
  const stops = [...layout.caretStops].sort(
    (left, right) =>
      Math.abs(left.sourceOffset - sourceOffset) -
        Math.abs(right.sourceOffset - sourceOffset) ||
      left.sourceOffset - right.sourceOffset,
  );
  for (const stop of stops) {
    // Prefer an editable field at a shared visual boundary, then its row gap.
    const positions = [...stop.positions].sort((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "field" ? -1 : 1,
    );
    for (const position of positions) {
      const point = mathDocumentPositionToContentPoint(
        blockId,
        contentId,
        document,
        position,
      );
      if (!point) continue;
      const caret = contentPointToMathTreeCaret(document, point);
      if (caret) return caret;
    }
  }
  return null;
}

/** Current canonical-source bridge offset for one stable content point. */
export function mathSourceOffsetFromContentPoint(
  document: StructuredDocument,
  point: ContentPoint,
): number | null {
  const math = structuredToMathDocument(document);
  const position = contentPointToMathDocumentPosition(document, point);
  if (!math || !position) return null;
  return (
    mathDocumentCaretStop(layoutMathDocument(math), position)?.sourceOffset ??
    null
  );
}

/** Resolve a nested range to transient canonical-source offsets for painting. */
export function mathSourceRangeFromContentSelection(
  document: StructuredDocument,
  selection: ContentSelection,
  layout?: MathDocumentLayout,
): { readonly from: number; readonly to: number } | null {
  if (
    selection.anchor.contentId !== document.rootId ||
    selection.focus.contentId !== document.rootId
  ) {
    return null;
  }
  const math = structuredToMathDocument(document);
  if (!math) return null;
  const resolvedLayout = layout ?? layoutMathDocument(math);
  const anchorPosition = contentPointToMathDocumentPosition(
    document,
    selection.anchor,
  );
  const focusPosition = contentPointToMathDocumentPosition(
    document,
    selection.focus,
  );
  if (!anchorPosition || !focusPosition) return null;
  const anchor = mathDocumentCaretStop(resolvedLayout, anchorPosition);
  const focus = mathDocumentCaretStop(resolvedLayout, focusPosition);
  if (!anchor || !focus || anchor.sourceOffset === focus.sourceOffset) {
    return null;
  }
  return {
    from: Math.min(anchor.sourceOffset, focus.sourceOffset),
    to: Math.max(anchor.sourceOffset, focus.sourceOffset),
  };
}

/**
 * Extend a nested selection to a new focus caret without ever partially
 * covering a construct. Both endpoints are bridged to canonical source offsets
 * and snapped by tex's level-aware range rules: a selection whose endpoints
 * share a slot (one cell, one numerator) is left exactly as it is, while a
 * focus that crossed into a different slot takes that construct whole — and
 * the anchor, if it sits inside a construct of its own, widens outward to
 * cover it. `travel` is the focus's direction of movement, which decides
 * whether the construct it entered is taken in or dropped ("select less").
 * Falls back to the unsnapped extension when a bridge offset cannot be
 * resolved, and returns null only when the focus caret itself is invalid.
 */
export function extendMathTreeContentSelection(
  blockId: string,
  contentId: string,
  document: StructuredDocument,
  anchor: ContentPoint,
  focusCaret: MathTreeCaret,
  travel: "start" | "end",
): ContentSelection | null {
  const target = mathTreeCaretToContentSelection(
    blockId,
    contentId,
    document,
    focusCaret,
  );
  if (!target) return null;
  const plain: ContentSelection = {
    anchor,
    focus: target.focus,
    lastUpdate: target.lastUpdate,
  };
  const anchorOffset = mathSourceOffsetFromContentPoint(document, anchor);
  const focusOffset = mathSourceOffsetFromContentPoint(document, target.focus);
  if (anchorOffset === null || focusOffset === null) return plain;
  return (
    snapMathSelectionPoints(
      document,
      plain,
      anchorOffset,
      focusOffset,
      travel,
    ) ?? plain
  );
}

/**
 * Snap a nested math range so it never partially covers a construct, biased
 * away from the anchor: a focus resting inside a construct the anchor is not
 * in takes it whole. This is the gesture-agnostic rule the selection-resolver
 * facet applies to every committed range (drags, shift+click, the public
 * API). Shift+arrows pre-snap in {@link extendMathTreeContentSelection} with
 * their true direction of travel — which this bias cannot know — so "select
 * less" can drop a construct; their output is already clean when it arrives
 * here. Returns undefined when the range needs no adjustment (or cannot be
 * bridged to source offsets).
 */
export function snapMathContentSelection(
  document: StructuredDocument,
  selection: ContentSelection,
): ContentSelection | undefined {
  const anchorOffset = mathSourceOffsetFromContentPoint(
    document,
    selection.anchor,
  );
  const focusOffset = mathSourceOffsetFromContentPoint(
    document,
    selection.focus,
  );
  if (
    anchorOffset === null ||
    focusOffset === null ||
    anchorOffset === focusOffset
  ) {
    return undefined;
  }
  return snapMathSelectionPoints(
    document,
    selection,
    anchorOffset,
    focusOffset,
    focusOffset > anchorOffset ? "end" : "start",
  );
}

/** Bridge both endpoints to source offsets, snap, and rebuild stable points. */
function snapMathSelectionPoints(
  document: StructuredDocument,
  selection: ContentSelection,
  anchorOffset: number,
  focusOffset: number,
  travel: "start" | "end",
): ContentSelection | undefined {
  const math = structuredToMathDocument(document);
  if (!math) return undefined;
  const snapped = resolveSelectionRange(
    printMathDocument(math),
    anchorOffset,
    focusOffset,
    travel,
  );
  if (snapped.anchor === anchorOffset && snapped.focus === focusOffset) {
    return undefined;
  }
  // Snapped offsets land on construct edges, which are caret stops in the
  // shared row, so the round-trip through the bridge is exact. Endpoints the
  // snap left alone keep their original stable identities.
  const { blockId, contentId } = selection.anchor;
  const anchor =
    snapped.anchor === anchorOffset
      ? selection.anchor
      : mathContentSelectionFromSourceOffset(
          blockId,
          contentId,
          document,
          snapped.anchor,
        )?.focus;
  const focus =
    snapped.focus === focusOffset
      ? selection.focus
      : mathContentSelectionFromSourceOffset(
          blockId,
          contentId,
          document,
          snapped.focus,
        )?.focus;
  if (!anchor || !focus) return undefined;
  return { anchor, focus, lastUpdate: selection.lastUpdate };
}

/** Promote a transient source offset to a collapsed stable content selection. */
export function mathContentSelectionFromSourceOffset(
  blockId: string,
  contentId: string,
  document: StructuredDocument,
  sourceOffset: number,
  lastUpdate = Date.now(),
): ContentSelection | null {
  const math = structuredToMathDocument(document);
  if (!math) return null;
  const caret = mathTreeCaretFromSourceOffset(
    blockId,
    contentId,
    math,
    document,
    sourceOffset,
  );
  return caret
    ? mathTreeCaretToContentSelection(
        blockId,
        contentId,
        document,
        caret,
        lastUpdate,
      )
    : null;
}
