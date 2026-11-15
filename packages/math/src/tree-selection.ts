/**
 * Bridges editor-core structured selections, the math tree editor's CRDT
 * carets, and @tasfer/tex's identity-keyed layout positions.
 *
 * None of these conversions persist a LaTeX offset. Pointer hit-testing enters
 * through identity-keyed MathDocument geometry directly; source offsets remain
 * only as a compatibility bridge for old flat cursors and interchange APIs.
 */

import { structuredToMathDocument } from "./structured";
// Every layout here must be the host one the block paints with: without its
// text fallback, letters the math fonts lack (Arabic, Hebrew, CJK in `\text{…}`)
// are zero-width and have no caret stops, so a source offset inside them would
// resolve to the wrong place (select-all and double-click lost the Arabic word).
import { layoutMathDocumentHost as layoutMathDocument } from "./tex-host";
import {
  type MathTreeCaret,
  type MathTreeEditResult,
  type MathTreeMotion,
  moveMathTreeCaret,
} from "./tree-edit";
import type {
  ContentPoint,
  ContentSelection,
} from "@tasfer/editor/structured-selection";
import {
  findCharInRuns,
  getVisibleOffsetAfterChar,
  getVisibleTextFromRuns,
} from "@tasfer/editor/sync/char-runs";
import {
  getStructuredChildren,
  type StructuredDocument,
} from "@tasfer/editor/sync/structured-content";
import {
  type MathDocument,
  type MathDocumentCaretPosition,
  mathDocumentCaretStop,
  mathDocumentCaretVertical,
  type MathDocumentLayout,
  printMathDocument,
  resolveSelectionRange,
  unitAfter,
  unitBefore,
} from "@tasfer/tex";

/**
 * The offset in the LaTeX source one visible item to the left or right of
 * `sourceOffset`. It skips the hidden space LaTeX needs after a command, as in
 * `\pi r`. Returns `null` at the edge of the formula.
 */
export function mathUnitBoundaryOffset(
  source: string,
  sourceOffset: number,
  direction: "left" | "right",
): number | null {
  let cursor = Math.max(0, Math.min(sourceOffset, source.length));
  for (;;) {
    const unit =
      direction === "left"
        ? unitBefore(source, cursor)
        : unitAfter(source, cursor);
    if (unit) return direction === "left" ? unit.start : unit.end;
    if (direction === "left") {
      if (cursor === 0 || !/\s/u.test(source[cursor - 1])) return null;
      cursor -= 1;
    } else {
      if (cursor === source.length || !/\s/u.test(source[cursor])) return null;
      cursor += 1;
    }
  }
}

/**
 * Turn an editor selection point into a math caret. Returns `null` when the
 * point is not in this formula or not at a spot the math editor can edit.
 *
 * @group Caret and selection
 */
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

/**
 * Turn a math caret back into a collapsed editor selection in block `blockId`.
 * Returns `null` when the text or character the caret points at no longer
 * exists.
 *
 * @group Caret and selection
 */
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
 * Move the caret to the nearest editable spot above or below it, like the Up
 * and Down arrows. For example, from a numerator down into the denominator.
 * Pass `layout` to reuse one you already have. Returns `null` when there is
 * nothing in that direction.
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

/**
 * Turn an editor selection point into a caret position in the `@tasfer/tex`
 * layout. Returns `null` when the point is not in this formula, or when what it
 * points at is gone or is not editable text.
 */
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

/**
 * The reverse of {@link contentPointToMathDocumentPosition}: turn a
 * `@tasfer/tex` layout position into an editor selection point in block
 * `blockId`. Returns `null` when the position does not exist in the document.
 */
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
 * The editable math caret closest to an offset in the formula's LaTeX source.
 * Returns `null` when no caret can be found.
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

/**
 * The offset in the formula's LaTeX source for this selection point. It changes
 * as the formula is edited, so do not store it. Returns `null` when the point
 * is not in the formula.
 *
 * @group Caret and selection
 */
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

/**
 * The `from` and `to` offsets in the LaTeX source that a selection covers, for
 * drawing the highlight. Returns `null` when the selection is collapsed or not
 * in this formula.
 */
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
 * Extend a selection to a new focus caret, like Shift+arrow does. The selection
 * never covers only part of a construct. If both ends are in the same slot,
 * such as one matrix cell, it stays as is. If the focus moves into another
 * slot, it takes in that whole construct. An anchor inside a construct widens
 * to cover that construct too.
 *
 * `travel` is the direction the focus moved, so moving back can drop a
 * construct again. A widened result keeps the original ends in `unsnapped` for
 * that. If the selection cannot be widened, you get the plain extension.
 * Returns `null` only when the focus caret is invalid.
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
  const snapped = snapMathSelectionPoints(
    document,
    plain,
    anchorOffset,
    focusOffset,
    travel,
  );
  return snapped
    ? {
        ...snapped,
        unsnapped: { anchor: plain.anchor, focus: plain.focus },
      }
    : plain;
}

/**
 * Widen a selection so it never covers only part of a construct. A focus inside
 * a construct the anchor is not in takes the whole construct. The editor
 * applies this to every selection: drags, Shift+click and API calls.
 * Shift+arrows use {@link extendMathTreeContentSelection} instead. Returns
 * `undefined` when the selection needs no change, is collapsed, or cannot be
 * widened.
 */
// Shift+arrows pre-snap with their true direction of travel, which this
// anchor-away bias cannot know, so "select less" can drop a construct; their
// output is already clean when it arrives here.
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
  return { ...selection, anchor, focus };
}

/**
 * A collapsed editor selection at an offset in the formula's LaTeX source. It
 * lands on the nearest editable spot. Returns `null` when none is found.
 *
 * @group Caret and selection
 */
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

/** Stops nearer than this many pixels count as the same caret position. */
const SAME_SPOT_PX = 0.5;

/**
 * Horizontal arrow movement that follows what is on screen when right-to-left
 * text (Arabic, Hebrew) sits inside a `\text{…}` group.
 *
 * The formula flows left to right, but the letters of such a word run right to
 * left, so the tree's logical step (one letter forward/back in the text) moves
 * the caret the opposite way on screen and jumps across the word when entering
 * it. Here ← always moves the caret left and → right: inside the group it walks
 * to the next letter boundary on that side, and at the group's edge it steps
 * out beside it. Everything else (Latin or CJK text, symbols, constructs) keeps
 * the ordinary logical movement.
 */
export function moveMathTreeCaretVisually(
  document: StructuredDocument,
  caret: MathTreeCaret,
  motion: MathTreeMotion,
): MathTreeEditResult {
  if (motion === "arrow-left" || motion === "arrow-right") {
    const step = rtlTextArrowStep(
      document,
      caret,
      motion === "arrow-left" ? "left" : "right",
    );
    if (step && !step.sameSpot) {
      return { handled: true, edits: [], caret: step.caret };
    }
    // Leaving the group lands on a spot the caret already shows at (the
    // group's edge), so keep going one more step from there instead of
    // spending a key press on no visible movement.
    if (step) return moveMathTreeCaret(document, step.caret, motion);
  }
  return moveMathTreeCaret(document, caret, motion);
}

function rtlTextArrowStep(
  document: StructuredDocument,
  caret: MathTreeCaret,
  direction: "left" | "right",
): { readonly caret: MathTreeCaret; readonly sameSpot: boolean } | null {
  const math = structuredToMathDocument(document);
  if (!math) return null;
  const position = mathTreeCaretPosition(document, caret);
  if (!position) return null;
  // The `\text` group involved: the one holding the caret, or the one the
  // ordinary step would enter from beside it.
  let textNodeId: string;
  let inside: boolean;
  if (caret.kind === "text" && document.nodes[caret.nodeId]?.type === "text") {
    textNodeId = caret.nodeId;
    inside = true;
  } else {
    const logical = moveMathTreeCaret(
      document,
      caret,
      direction === "left" ? "arrow-left" : "arrow-right",
    );
    if (!logical.handled || logical.caret.kind !== "text") return null;
    textNodeId = logical.caret.nodeId;
    inside = false;
  }
  const node = document.nodes[textNodeId];
  const rowId = node?.placement.parentId;
  if (!node || node.deleted || node.type !== "text" || !rowId) return null;

  const layout = layoutMathDocument(math);
  const current = mathDocumentCaretStop(layout, position);
  if (!current) return null;
  const length = getVisibleTextFromRuns([
    ...(node.textFields.text ?? []),
  ]).length;
  const letters: { offset: number; x: number }[] = [];
  for (let offset = 0; offset <= length; offset++) {
    const stop = mathDocumentCaretStop(layout, {
      kind: "field",
      rowId,
      nodeId: textNodeId,
      field: "text",
      offset,
    });
    if (!stop) return null;
    letters.push({ offset, x: stop.x });
  }
  // Only right-to-left letters need this: somewhere a later letter boundary
  // shows to the LEFT of an earlier one.
  const reversed = letters.some(
    (letter, i) => i > 0 && letter.x < letters[i - 1].x - SAME_SPOT_PX,
  );
  if (!reversed) return null;

  // The nearest letter boundary on the requested side of the caret.
  let target: { offset: number; x: number } | null = null;
  for (const letter of letters) {
    const ahead =
      direction === "left"
        ? letter.x < current.x - SAME_SPOT_PX
        : letter.x > current.x + SAME_SPOT_PX;
    if (!ahead) continue;
    if (
      !target ||
      (direction === "left" ? letter.x > target.x : letter.x < target.x)
    ) {
      target = letter;
    }
  }
  if (target) {
    const point = mathDocumentPositionToContentPoint(
      "math-layout-host",
      document.rootId,
      document,
      {
        kind: "field",
        rowId,
        nodeId: textNodeId,
        field: "text",
        offset: target.offset,
      },
    );
    const next = point ? contentPointToMathTreeCaret(document, point) : null;
    return next ? { caret: next, sameSpot: false } : null;
  }
  if (!inside) return null;

  // Past the group's edge: the gap beside it on that side. The formula flows
  // left to right, so the gap on the left is the one before the group.
  const siblings = getStructuredChildren(document, rowId, "children");
  const index = siblings.findIndex((child) => child.id === textNodeId);
  if (index < 0) return null;
  const gap = direction === "left" ? index : index + 1;
  const gapStop = mathDocumentCaretStop(layout, {
    kind: "row",
    rowId,
    offset: gap,
  });
  return {
    caret: {
      kind: "row",
      rowId,
      afterNodeId: siblings[gap - 1]?.id ?? null,
    },
    sameSpot: !gapStop || Math.abs(gapStop.x - current.x) <= SAME_SPOT_PX,
  };
}

/** The stable layout address of a tree caret. */
function mathTreeCaretPosition(
  document: StructuredDocument,
  caret: MathTreeCaret,
): MathDocumentCaretPosition | null {
  const point = mathTreeCaretToContentSelection(
    "math-layout-host",
    document.rootId,
    document,
    caret,
  )?.focus;
  return point ? contentPointToMathDocumentPosition(document, point) : null;
}
