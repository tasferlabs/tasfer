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
 * An identity-bearing caret stop in one structured node text field.
 *
 * `afterCharId` is the character immediately before the caret (`null` is field
 * start). The CRDT identity keeps the stop stable when another peer inserts
 * before it. `affinity` disambiguates visually equivalent visual boundaries.
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
 * A caret stop between children in one named parent slot.
 *
 * `afterNodeId: null` is the start of the slot. Keeping this address structural
 * lets an empty row/slot own a caret without inventing a text node.
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
 * An anchor/focus range inside one structured attachment.
 *
 * Extensions decide which cross-node ranges they can edit losslessly. Core
 * only requires both endpoints to belong to the same block and attachment; it
 * must not discard a valid range merely because its endpoints use different
 * node-local address shapes.
 */
export interface ContentSelection {
  readonly anchor: ContentPoint;
  readonly focus: ContentPoint;
  /** Interaction timestamp used by caret blink/landing animation. */
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

/** Exact value equality for one nested point. */
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

/** Exact value equality for one structural gap point. */
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

/** Exact value equality for a nested selection (anchor direction included). */
export function contentSelectionsEqual(
  left: ContentSelection | null | undefined,
  right: ContentSelection | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    contentPointsEqual(left.anchor, right.anchor) &&
    contentPointsEqual(left.focus, right.focus) &&
    left.lastUpdate === right.lastUpdate
  );
}

/** A range is collapsed when both endpoints occupy the same logical gap. */
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
 * Resolve and clamp one point against the current materialized page.
 *
 * Missing/deleted blocks, attachments, nodes, ancestors, or text fields return
 * `null`. A selected descendant of a tombstoned parent is therefore cleaned up
 * even though the descendant's own tombstone remains unset. If the anchor
 * character was tombstoned, the point deterministically falls back to the
 * nearest preceding visible character; inserts elsewhere never rebase it.
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

/** Resolve a stable nested text point to its current visible UTF-16 offset. */
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
 * Resolve a structural gap against the current materialized page.
 *
 * A live parent and non-empty slot name are required. A tombstoned predecessor
 * falls back to the nearest preceding visible sibling. A missing identity or a
 * node moved to another slot invalidates the point rather than jumping it.
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
 * Normalize an anchor/focus range. Both endpoints must remain in one block and
 * attachment. The owning extension is responsible for ordering the points and
 * for explicitly rejecting structural ranges it cannot edit losslessly.
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
  return anchor === selection.anchor && focus === selection.focus
    ? selection
    : { ...selection, anchor, focus };
}

/** Make a detached plain-data copy suitable for snapshots or presence payloads. */
export function cloneContentSelection(
  selection: ContentSelection | null | undefined,
): ContentSelection | null {
  return selection
    ? {
        ...selection,
        anchor: { ...selection.anchor },
        focus: { ...selection.focus },
      }
    : null;
}

/** Capture a detached nested selection for undo or a presence snapshot. */
export function captureContentSelection(
  state: EditorState,
): ContentSelection | null {
  return cloneContentSelection(state.document.contentSelection);
}

/** Restore a captured selection, dropping it safely if its content is gone. */
export function restoreContentSelection(
  state: EditorState,
  selection: ContentSelection | null,
): EditorState {
  return updateContentSelection(state, cloneContentSelection(selection));
}

/**
 * Revalidate the active nested selection after a page replacement/edit.
 * Returns the original state when no cleanup or clamping is needed.
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
 * Set or clear the nested selection. Entering structured content clears the
 * ordinary block cursor/range so the editor never exposes two active carets.
 */
export function updateContentSelection(
  state: EditorState,
  selection: ContentSelection | null,
): EditorState {
  let contentSelection = normalizeContentSelection(
    state.document.page,
    selection,
  );
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
    }
  }
  if (
    contentSelectionsEqual(state.document.contentSelection, contentSelection) &&
    (!contentSelection || (!state.document.cursor && !state.document.selection))
  ) {
    return state;
  }
  return {
    ...state,
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
