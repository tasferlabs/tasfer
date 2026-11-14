/**
 * Selection addresses for text fields inside generic structured attachments.
 *
 * These deliberately sit beside, rather than inside, `DocPoint`: a document
 * caret addresses flat block text while a content caret addresses an
 * extension-owned tree. Keeping the currencies separate prevents installing a
 * structured-content feature from changing the normal editor selection API.
 */

import type { Page } from "./serlization/loadPage";
import type { EditorState } from "./state-types";
import { findBlock } from "./sync/block-lookup";
import {
  findCharInRuns,
  getVisibleOffsetAfterChar,
  iterateAllChars,
} from "./sync/char-runs";
import {
  getStructuredChildren,
  type StructuredDocument,
  type StructuredNode,
} from "./sync/structured-content";

/** Which side of a boundary owns a nested caret. */
export type ContentSelectionAffinity = "backward" | "forward";

/**
 * A caret spot in one text field of a structured node, like a part of a
 * formula.
 *
 * `afterCharId` is the id of the character just before the caret. `null` means
 * the start of the field. It points at a character, not a number, so the caret
 * stays in place when someone else types earlier in the field. `affinity` says
 * which side owns the caret when two spots look the same on screen.
 */
export interface ContentTextPoint {
  readonly kind: "text";
  readonly blockId: string;
  readonly contentId: string;
  readonly nodeId: string;
  readonly field: string;
  readonly afterCharId: string | null;
  readonly affinity: ContentSelectionAffinity;
}

/**
 * A caret spot between the children of one parent node, in one named slot.
 *
 * `afterNodeId` is the child just before the caret. `null` means the start of
 * the slot. This lets an empty slot, like an empty row, hold a caret.
 */
export interface ContentGapPoint {
  readonly kind: "gap";
  readonly blockId: string;
  readonly contentId: string;
  readonly parentId: string;
  readonly slot: string;
  readonly afterNodeId: string | null;
  readonly affinity: ContentSelectionAffinity;
}

/** One supported caret stop inside a structured attachment. */
export type ContentPoint = ContentTextPoint | ContentGapPoint;

/**
 * A selected range inside one piece of structured content, like a formula. It
 * runs from `anchor` (where it started) to `focus` (where it ends).
 *
 * Both ends must be in the same block and the same structured content. The two
 * ends can be different point kinds. The extension that owns the content
 * decides which ranges it can edit.
 */
// Core must not discard a valid range merely because its endpoints use
// different node-local address shapes.
export interface ContentSelection {
  readonly anchor: ContentPoint;
  readonly focus: ContentPoint;
  /**
   * The unit picked by a double or triple click. While you keep dragging, the
   * whole unit stays selected and the range grows from its far edge. This
   * matches word and line selection in normal text.
   */
  readonly initialBoundary?: {
    readonly start: ContentPoint;
    readonly end: ContentPoint;
  };
  /**
   * The ends where the user placed them, before the extension widened the
   * range. Used only while a selection gesture is still going.
   *
   * An extension may grow a range to cover whole pieces. Keeping the original
   * ends lets Shift+Arrow in the other direction shrink the range again,
   * instead of starting over from the widened edge.
   */
  readonly unsnapped?: {
    readonly anchor: ContentPoint;
    readonly focus: ContentPoint;
  };
  /**
   * When the selection last changed, as a `Date.now()` time in milliseconds.
   * The caret blink and landing animation use it.
   */
  readonly lastUpdate?: number;
}

/** Whether two points address the same nested text field. */
export function isSameContentTextField(
  left: ContentTextPoint,
  right: ContentTextPoint,
): boolean {
  return (
    left.blockId === right.blockId &&
    left.contentId === right.contentId &&
    left.nodeId === right.nodeId &&
    left.field === right.field
  );
}

/**
 * Exact value equality for one nested point.
 */
export function contentTextPointsEqual(
  left: ContentTextPoint,
  right: ContentTextPoint,
): boolean {
  return (
    isSameContentTextField(left, right) &&
    left.afterCharId === right.afterCharId &&
    left.affinity === right.affinity
  );
}

/** Whether two structural gaps belong to the same named child slot. */
export function isSameContentGapSlot(
  left: ContentGapPoint,
  right: ContentGapPoint,
): boolean {
  return (
    left.blockId === right.blockId &&
    left.contentId === right.contentId &&
    left.parentId === right.parentId &&
    left.slot === right.slot
  );
}

/**
 * Exact value equality for one structural gap point.
 */
export function contentGapPointsEqual(
  left: ContentGapPoint,
  right: ContentGapPoint,
): boolean {
  return (
    isSameContentGapSlot(left, right) &&
    left.afterNodeId === right.afterNodeId &&
    left.affinity === right.affinity
  );
}

/** Exact value equality for either nested point kind. */
export function contentPointsEqual(
  left: ContentPoint,
  right: ContentPoint,
): boolean {
  if (left.kind === "text" && right.kind === "text") {
    return contentTextPointsEqual(left, right);
  }
  if (left.kind === "gap" && right.kind === "gap") {
    return contentGapPointsEqual(left, right);
  }
  return false;
}

/**
 * Whether two nested selections are exactly the same. It compares every field:
 * the direction, `unsnapped`, `initialBoundary` and `lastUpdate`. So the same
 * range with a different `lastUpdate` time is not equal.
 */
export function contentSelectionsEqual(
  left: ContentSelection | null | undefined,
  right: ContentSelection | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    contentPointsEqual(left.anchor, right.anchor) &&
    contentPointsEqual(left.focus, right.focus) &&
    contentSelectionEndpointsEqual(left.unsnapped, right.unsnapped) &&
    contentSelectionBoundaryEqual(
      left.initialBoundary,
      right.initialBoundary,
    ) &&
    left.lastUpdate === right.lastUpdate
  );
}

function contentSelectionEndpointsEqual(
  left: ContentSelection["unsnapped"],
  right: ContentSelection["unsnapped"],
): boolean {
  if (left === right) return true;
  return !!(
    left &&
    right &&
    contentPointsEqual(left.anchor, right.anchor) &&
    contentPointsEqual(left.focus, right.focus)
  );
}

function contentSelectionBoundaryEqual(
  left: ContentSelection["initialBoundary"],
  right: ContentSelection["initialBoundary"],
): boolean {
  if (left === right) return true;
  return !!(
    left &&
    right &&
    contentPointsEqual(left.start, right.start) &&
    contentPointsEqual(left.end, right.end)
  );
}

/**
 * Whether the range is just a caret, with both ends at the same spot in the
 * same text field or slot. `affinity` is ignored. A text end and a gap end
 * never count as the same spot.
 */
export function isContentSelectionCollapsed(
  selection: ContentSelection,
): boolean {
  const { anchor, focus } = selection;
  if (anchor.kind === "text" && focus.kind === "text") {
    return (
      isSameContentTextField(anchor, focus) &&
      anchor.afterCharId === focus.afterCharId
    );
  }
  if (anchor.kind === "gap" && focus.kind === "gap") {
    return (
      isSameContentGapSlot(anchor, focus) &&
      anchor.afterNodeId === focus.afterNodeId
    );
  }
  return false;
}

/**
 * Checks one text point against the current page.
 *
 * Returns `null` when the point is malformed, or when its block, structured
 * content, node, a parent of that node, or text field is gone. It also returns
 * `null` when the character before the caret is not in the field. If that
 * character was deleted, the caret moves back to the nearest character still
 * there, or to the start of the field. Text typed elsewhere never moves it.
 * Returns the same object when nothing changed.
 */
export function normalizeContentTextPoint(
  page: Page,
  point: ContentTextPoint,
): ContentTextPoint | null {
  if (point.kind !== "text") return null;
  if (!isNonEmptyString(point.blockId)) return null;
  if (!isNonEmptyString(point.contentId)) return null;
  if (!isNonEmptyString(point.nodeId)) return null;
  if (!isNonEmptyString(point.field)) return null;
  if (point.afterCharId !== null && !isNonEmptyString(point.afterCharId)) {
    return null;
  }
  if (point.affinity !== "backward" && point.affinity !== "forward") {
    return null;
  }

  const block = findBlock(page, point.blockId);
  if (!block || block.deleted) return null;
  const document = block.structuredContent?.[point.contentId];
  if (!document || document.rootId !== point.contentId) return null;
  const node = document.nodes[point.nodeId];
  if (!node || !isVisibleStructuredNode(document, node)) return null;
  if (!Object.prototype.hasOwnProperty.call(node.textFields, point.field)) {
    return null;
  }

  if (point.afterCharId === null) return point;
  const runs = [...node.textFields[point.field]];
  const anchor = findCharInRuns(runs, point.afterCharId);
  if (!anchor) return null;
  if (!anchor.deleted) return point;

  let previousVisibleId: string | null = null;
  for (const entry of iterateAllChars(runs)) {
    if (entry.id === point.afterCharId) break;
    if (!entry.deleted) previousVisibleId = entry.id;
  }
  return { ...point, afterCharId: previousVisibleId };
}

/**
 * Returns where a text point sits in its field's visible text right now, in
 * UTF-16 units. Returns `null` when the point's content is gone.
 */
export function resolveContentTextPointOffset(
  page: Page,
  point: ContentTextPoint,
): number | null {
  const normalized = normalizeContentTextPoint(page, point);
  if (!normalized) return null;
  const block = findBlock(page, normalized.blockId);
  const document = block?.structuredContent?.[normalized.contentId];
  const runs = document?.nodes[normalized.nodeId]?.textFields[normalized.field];
  return getVisibleOffsetAfterChar(
    runs ? [...runs] : undefined,
    normalized.afterCharId,
  );
}

/**
 * Checks one gap point against the current page.
 *
 * Returns `null` when the point is malformed, the slot name is empty, or its
 * block, structured content or parent node is gone. It also returns `null` when
 * the child before the caret is not in that slot, for example because it moved
 * to another slot. If that child was deleted, the caret moves back to the
 * nearest child still there, or to the start of the slot. Returns the same
 * object when nothing changed.
 */
export function normalizeContentGapPoint(
  page: Page,
  point: ContentGapPoint,
): ContentGapPoint | null {
  if (point.kind !== "gap") return null;
  if (!isNonEmptyString(point.blockId)) return null;
  if (!isNonEmptyString(point.contentId)) return null;
  if (!isNonEmptyString(point.parentId)) return null;
  if (!isNonEmptyString(point.slot)) return null;
  if (point.afterNodeId !== null && !isNonEmptyString(point.afterNodeId)) {
    return null;
  }
  if (point.affinity !== "backward" && point.affinity !== "forward") {
    return null;
  }

  const block = findBlock(page, point.blockId);
  if (!block || block.deleted) return null;
  const document = block.structuredContent?.[point.contentId];
  if (!document || document.rootId !== point.contentId) return null;
  const parent = document.nodes[point.parentId];
  if (!parent || !isVisibleStructuredNode(document, parent)) return null;

  if (point.afterNodeId === null) return point;
  const children = getStructuredChildren(document, parent.id, point.slot, {
    includeDeleted: true,
  });
  const index = children.findIndex((child) => child.id === point.afterNodeId);
  if (index < 0) return null;
  if (!children[index].deleted) return point;

  let afterNodeId: string | null = null;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (!children[cursor].deleted) {
      afterNodeId = children[cursor].id;
      break;
    }
  }
  return { ...point, afterNodeId };
}

/** Normalize either supported nested point kind. */
export function normalizeContentPoint(
  page: Page,
  point: ContentPoint,
): ContentPoint | null {
  if (point.kind === "text") return normalizeContentTextPoint(page, point);
  if (point.kind === "gap") return normalizeContentGapPoint(page, point);
  return null;
}

/**
 * Checks a range against the current page.
 *
 * Returns `null` when `selection` is `null` or `undefined`, when either end is
 * gone, or when the two ends are not in the same block and the same structured
 * content. `unsnapped` and `initialBoundary` are dropped when they no longer
 * fit. Returns the same object when nothing changed.
 *
 * It does not put the ends in order or check that the range can be edited. The
 * extension that owns the content does that.
 */
export function normalizeContentSelection(
  page: Page,
  selection: ContentSelection | null | undefined,
): ContentSelection | null {
  if (!selection) return null;
  const anchor = normalizeContentPoint(page, selection.anchor);
  const focus = normalizeContentPoint(page, selection.focus);
  if (!anchor || !focus || !areCompatibleContentPoints(anchor, focus)) {
    return null;
  }
  const unsnappedAnchor = selection.unsnapped
    ? normalizeContentPoint(page, selection.unsnapped.anchor)
    : null;
  const unsnappedFocus = selection.unsnapped
    ? normalizeContentPoint(page, selection.unsnapped.focus)
    : null;
  const unsnapped =
    unsnappedAnchor &&
    unsnappedFocus &&
    areCompatibleContentPoints(unsnappedAnchor, unsnappedFocus) &&
    areCompatibleContentPoints(anchor, unsnappedAnchor)
      ? { anchor: unsnappedAnchor, focus: unsnappedFocus }
      : undefined;
  const initialStart = selection.initialBoundary
    ? normalizeContentPoint(page, selection.initialBoundary.start)
    : null;
  const initialEnd = selection.initialBoundary
    ? normalizeContentPoint(page, selection.initialBoundary.end)
    : null;
  const initialBoundary =
    initialStart &&
    initialEnd &&
    areCompatibleContentPoints(initialStart, initialEnd) &&
    areCompatibleContentPoints(anchor, initialStart)
      ? { start: initialStart, end: initialEnd }
      : undefined;
  if (
    anchor === selection.anchor &&
    focus === selection.focus &&
    ((!selection.unsnapped && !unsnapped) ||
      (selection.unsnapped &&
        unsnapped?.anchor === selection.unsnapped.anchor &&
        unsnapped.focus === selection.unsnapped.focus)) &&
    ((!selection.initialBoundary && !initialBoundary) ||
      (selection.initialBoundary &&
        initialBoundary?.start === selection.initialBoundary.start &&
        initialBoundary.end === selection.initialBoundary.end))
  ) {
    return selection;
  }
  const {
    unsnapped: _discardedUnsnapped,
    initialBoundary: _discardedBoundary,
    ...rest
  } = selection;
  return {
    ...rest,
    anchor,
    focus,
    ...(unsnapped ? { unsnapped } : {}),
    ...(initialBoundary ? { initialBoundary } : {}),
  };
}

/**
 * Returns a copy of the selection that shares no objects with the original.
 * Returns `null` for `null` or `undefined`. Use it to save a selection or send
 * it to other people.
 */
export function cloneContentSelection(
  selection: ContentSelection | null | undefined,
): ContentSelection | null {
  return selection
    ? {
        ...selection,
        anchor: { ...selection.anchor },
        focus: { ...selection.focus },
        ...(selection.unsnapped
          ? {
              unsnapped: {
                anchor: { ...selection.unsnapped.anchor },
                focus: { ...selection.unsnapped.focus },
              },
            }
          : {}),
        ...(selection.initialBoundary
          ? {
              initialBoundary: {
                start: { ...selection.initialBoundary.start },
                end: { ...selection.initialBoundary.end },
              },
            }
          : {}),
      }
    : null;
}

/**
 * Returns a copy of the current nested selection, or `null` when there is none.
 * Use it to save the selection for undo, or to show it to other people.
 */
export function captureContentSelection(
  state: EditorState,
): ContentSelection | null {
  return cloneContentSelection(state.document.contentSelection);
}

/**
 * Restore a captured selection, dropping it safely if its content is gone.
 */
export function restoreContentSelection(
  state: EditorState,
  selection: ContentSelection | null,
): EditorState {
  return updateContentSelection(state, cloneContentSelection(selection));
}

/**
 * Checks the nested selection against the current page, for example after an
 * edit. If its content is gone, the selection is cleared. If a character or
 * child it points at was deleted, the caret moves back to the nearest one still
 * there. Returns the same state when nothing needs fixing.
 */
export function reconcileContentSelectionState(
  state: EditorState,
): EditorState {
  const current = state.document.contentSelection;
  if (!current) return state;
  const contentSelection = normalizeContentSelection(
    state.document.page,
    current,
  );
  if (contentSelection === current) return state;
  return {
    ...state,
    document: { ...state.document, contentSelection },
  };
}

/**
 * Sets the nested selection, or clears it with `null`. A selection whose
 * content is gone becomes `null`.
 *
 * The extension that owns the content may widen a range, for example so part of
 * a formula piece is never selected on its own. Setting a nested selection
 * clears the normal cursor and selection, so there is only ever one caret.
 * Clearing it with `null` leaves the normal cursor as it is. Returns the same
 * state when nothing changed.
 */
export function updateContentSelection(
  state: EditorState,
  selection: ContentSelection | null,
): EditorState {
  let contentSelection = normalizeContentSelection(
    state.document.page,
    selection,
  );
  let unsnapped =
    contentSelection?.unsnapped ??
    (contentSelection
      ? { anchor: contentSelection.anchor, focus: contentSelection.focus }
      : undefined);
  // Every non-collapsed range passes through the owning feature's resolver
  // facet, so a range lands with the feature's structural discipline no matter
  // which gesture produced it — a drag, shift+click, keyboard extension, or
  // the public API. (Math, for example, never half-covers a construct.)
  if (
    contentSelection &&
    !contentPointsEqual(contentSelection.anchor, contentSelection.focus)
  ) {
    const block = findBlock(
      state.document.page,
      contentSelection.anchor.blockId,
    );
    const document =
      block?.structuredContent?.[contentSelection.anchor.contentId];
    const resolved = document
      ? state.schema.resolveContentSelection(document, contentSelection)
      : undefined;
    if (resolved) {
      contentSelection = normalizeContentSelection(
        state.document.page,
        resolved,
      );
      unsnapped = contentSelection?.unsnapped ?? unsnapped;
    }
  }
  if (contentSelection && unsnapped) {
    const widened =
      !contentPointsEqual(contentSelection.anchor, unsnapped.anchor) ||
      !contentPointsEqual(contentSelection.focus, unsnapped.focus);
    const { unsnapped: _discarded, ...rest } = contentSelection;
    contentSelection = widened ? { ...rest, unsnapped } : rest;
  }
  if (
    contentSelectionsEqual(state.document.contentSelection, contentSelection) &&
    (!contentSelection || (!state.document.cursor && !state.document.selection))
  ) {
    return state;
  }
  // A markdown auto-format is revertible only while the caret sits where the
  // transform left it, and a nested caret moves through here rather than
  // through `updateCursor` — without this, arrowing to the next cell would
  // leave a stale wrap armed for the Backspace after it.
  let ui = state.ui.revertibleInputRule
    ? { ...state.ui, revertibleInputRule: null }
    : state.ui;
  // A Ctrl+B toggle, or the side of a mark edge, belongs to the caret spot it
  // was set at — the same as a flat caret move clears it. Otherwise the side
  // chosen at one edge would follow the caret into other text.
  const previousFocus = state.document.contentSelection?.focus;
  if (
    ui.activeMarksMode.type === "explicit" &&
    contentSelection &&
    (!previousFocus ||
      !contentPointsEqual(previousFocus, contentSelection.focus))
  ) {
    ui = { ...ui, activeMarksMode: { type: "inherit" } };
  }
  return {
    ...state,
    ui,
    document: {
      ...state.document,
      cursor: contentSelection ? null : state.document.cursor,
      selection: contentSelection ? null : state.document.selection,
      contentSelection,
    },
  };
}

function isVisibleStructuredNode(
  document: StructuredDocument,
  node: StructuredNode,
): boolean {
  if (node.deleted) return false;
  if (node.id === document.rootId) return node.placement.parentId === null;

  const seen = new Set<string>([node.id]);
  let parentId = node.placement.parentId;
  while (parentId !== null) {
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const parent = document.nodes[parentId];
    if (!parent || parent.deleted) return false;
    if (parent.id === document.rootId) {
      return parent.placement.parentId === null;
    }
    parentId = parent.placement.parentId;
  }
  return false;
}

function areCompatibleContentPoints(
  anchor: ContentPoint,
  focus: ContentPoint,
): boolean {
  return (
    anchor.blockId === focus.blockId && anchor.contentId === focus.contentId
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The nested range to highlight. Normally the range itself; while a touch
 * handle crosses a piece the range takes whole (a √ in a formula — see
 * `HandleCrossing`), the range only up to the piece's near edge, since the
 * crossing fill draws the rest up to the finger.
 */
export function shownContentSelection(
  state: EditorState,
): ContentSelection | null {
  const selection = state.document.contentSelection;
  const crossing = state.ui.selectionHandleDrag?.crossing;
  if (!selection || !crossing?.counted) return selection;
  if (crossing.near.blockId !== selection.focus.blockId) return selection;
  return { ...selection, focus: crossing.near };
}
