/**
 * Document positions — the `DocPoint`/`DocRange`/`DocNode` vocabulary shared by
 * the write surface ({@link ChangeApi}) and the read API, plus the **pure**
 * resolvers that turn them into the concrete coordinates the CRDT helpers need.
 *
 * Everything here is a plain function of an immutable {@link EditorState} (never
 * editor-instance state), so it composes inside a queued change/state-action as
 * the working state threads forward — and is unit-testable without mounting a
 * canvas. The `Editor` methods are thin delegations onto these.
 */

import { getFormatsAtPosition, getSelectionRange } from "./actions/actions";
import { getBlockTextContent, getBlockTextLength } from "./node-shared";
import {
  moveCursorToPosition,
  updateCursor,
  updateSelection,
} from "./selection";
import type { Block } from "./serlization/loadPage";
import type { EditorState } from "./state-types";
import { isTextualBlock } from "./sync/block-registry";
import { allCharsHaveFormat } from "./sync/crdt-utils";

/**
 * A single addressable point in the document — the optional target every
 * {@link ChangeApi} method accepts, and the currency the read API returns.
 *
 * - **relative** anchors resolve against the live state: `"caret"` (the current
 *   caret), `"start"` / `"end"` (document start/end), and a block edge
 *   `{ block, side }`.
 * - **absolute** `{ block, offset }` is stable across concurrent edits — the
 *   block id is a CRDT identity and `offset` is local to that block's text
 *   (clamped to its length; defaults to 0).
 */
export type DocPoint =
  | "caret"
  | "start"
  | "end"
  | { block: string; offset?: number }
  | { block: string; side: "before" | "after" };

/**
 * A span in the document. Defaults to the live selection wherever a method
 * accepts it. A bare {@link DocPoint} is a collapsed range at that point;
 * `{ from, to }` is an explicit range (must resolve to a single block for the
 * inline methods). Cross-block explicit ranges resolve to a no-op.
 */
export type DocRange =
  | "selection"
  | DocPoint
  | { from: DocPoint; to: DocPoint };

/**
 * Plain-data view of a block returned by the read API — never the internal
 * block/node. `text` is the visible text (empty for non-textual blocks); `attrs`
 * is the block's own type-specific fields (url, level, checked, …).
 */
export interface DocNode {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly attrs: Record<string, unknown>;
}

/** A {@link DocPoint} resolved to concrete coordinates. */
export interface ResolvedPoint {
  blockIndex: number;
  blockId: string;
  offset: number;
}

/** A {@link DocRange} resolved to a single-block span. */
export interface ResolvedRange {
  blockIndex: number;
  blockId: string;
  start: number;
  end: number;
}

// Resolve a DocPoint to concrete { blockIndex, blockId, offset }, or null when
// it can't be located (no caret, empty doc, unknown/tombstoned block id).
export function resolvePoint(
  s: EditorState,
  p: DocPoint,
): ResolvedPoint | null {
  const blocks = s.document.page.blocks;
  if (p === "caret") {
    const pos = s.document.cursor?.position;
    const b = pos ? blocks[pos.blockIndex] : undefined;
    if (!pos || !b || b.deleted) return null;
    return { blockIndex: pos.blockIndex, blockId: b.id, offset: pos.textIndex };
  }
  if (p === "start") {
    const i = blocks.findIndex((b) => !b.deleted);
    return i < 0 ? null : { blockIndex: i, blockId: blocks[i].id, offset: 0 };
  }
  if (p === "end") {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (!blocks[i].deleted)
        return {
          blockIndex: i,
          blockId: blocks[i].id,
          offset: getBlockTextLength(blocks[i]),
        };
    }
    return null;
  }
  const blockIndex = blocks.findIndex((b) => b.id === p.block);
  const b = blocks[blockIndex];
  if (!b || b.deleted) return null;
  if ("side" in p) {
    return {
      blockIndex,
      blockId: b.id,
      offset: p.side === "before" ? 0 : getBlockTextLength(b),
    };
  }
  const len = getBlockTextLength(b);
  return {
    blockIndex,
    blockId: b.id,
    offset: Math.max(0, Math.min(p.offset ?? 0, len)),
  };
}

// Resolve a DocRange to a single-block span, or null when it spans blocks /
// can't be resolved (the caller decides the fallback).
export function resolveInlineRange(
  s: EditorState,
  range: DocRange | undefined,
): ResolvedRange | null {
  if (range === undefined || range === "selection") {
    const sel = getSelectionRange(s);
    if (sel) {
      if (sel.start.blockIndex !== sel.end.blockIndex) return null;
      const b = s.document.page.blocks[sel.start.blockIndex];
      if (!b || b.deleted) return null;
      return {
        blockIndex: sel.start.blockIndex,
        blockId: b.id,
        start: sel.start.textIndex,
        end: sel.end.textIndex,
      };
    }
    const caret = resolvePoint(s, "caret");
    return caret
      ? {
          blockIndex: caret.blockIndex,
          blockId: caret.blockId,
          start: caret.offset,
          end: caret.offset,
        }
      : null;
  }
  if (typeof range === "object" && "from" in range) {
    const a = resolvePoint(s, range.from);
    const b = resolvePoint(s, range.to);
    if (!a || !b || a.blockId !== b.blockId) return null;
    return {
      blockIndex: a.blockIndex,
      blockId: a.blockId,
      start: Math.min(a.offset, b.offset),
      end: Math.max(a.offset, b.offset),
    };
  }
  const p = resolvePoint(s, range);
  return p
    ? {
        blockIndex: p.blockIndex,
        blockId: p.blockId,
        start: p.offset,
        end: p.offset,
      }
    : null;
}

// Resolve a block-level target to a block index (default: the caret block).
export function resolveBlockIndex(
  s: EditorState,
  at: DocPoint | undefined,
): number {
  const p = resolvePoint(s, at ?? "caret");
  return p ? p.blockIndex : -1;
}

// Place a caret (collapsed target) or selection (span) for `select`.
export function selectTarget(s: EditorState, target: DocRange): EditorState {
  if (typeof target === "object" && "from" in target) {
    const a = resolvePoint(s, target.from);
    const b = resolvePoint(s, target.to);
    if (!a || !b) return s;
    const collapsed = a.blockIndex === b.blockIndex && a.offset === b.offset;
    if (collapsed) return moveCursorToPosition(s, a.blockIndex, a.offset);
    // `updateSelection` derives isForward/isCollapsed from anchor/focus.
    const focus = { blockIndex: b.blockIndex, textIndex: b.offset };
    return updateSelection(updateCursor(s, focus), {
      anchor: { blockIndex: a.blockIndex, textIndex: a.offset },
      focus,
      initialBoundary: null,
    });
  }
  if (target === "selection") return s;
  const p = resolvePoint(s, target);
  return p ? moveCursorToPosition(s, p.blockIndex, p.offset) : s;
}

// Plain-data projection of a block — the read API never hands out the internal
// block. `attrs` is the block's own type-specific fields (everything but the
// structural id/type/text/linked-list plumbing).
export function toDocNode(block: Block): DocNode {
  const reserved = new Set([
    "id",
    "type",
    "charRuns",
    "formats",
    "afterId",
    "deleted",
  ]);
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block)) {
    if (!reserved.has(k) && v !== undefined) attrs[k] = v;
  }
  return {
    id: block.id,
    type: block.type,
    text: getBlockTextContent(block),
    attrs,
  };
}

// The current selection as a DocRange (a bare point for a caret), or null.
export function docSelection(s: EditorState): DocRange | null {
  const sel = getSelectionRange(s);
  if (sel) {
    const from = s.document.page.blocks[sel.start.blockIndex];
    const to = s.document.page.blocks[sel.end.blockIndex];
    if (!from || !to) return null;
    return {
      from: { block: from.id, offset: sel.start.textIndex },
      to: { block: to.id, offset: sel.end.textIndex },
    };
  }
  const caret = resolvePoint(s, "caret");
  return caret ? { block: caret.blockId, offset: caret.offset } : null;
}

// The inline marks that apply to text typed at the caret — explicit toggled
// formats, or those inherited from the character before it.
export function activeCaretMarks(s: EditorState): Set<string> {
  const result = new Set<string>();
  const mode = s.ui.activeMarksMode;
  if (mode.type === "explicit") {
    for (const f of mode.formats) result.add(f.type);
    return result;
  }
  const cursor = s.document.cursor;
  if (!cursor) return result;
  const block = s.document.page.blocks[cursor.position.blockIndex];
  if (!block || block.deleted) return result;
  const formats = getFormatsAtPosition(block, cursor.position.textIndex);
  if (formats) for (const f of formats) result.add(f.type);
  return result;
}

// Inline marks active over a range (default: selection). Collapsed → caret
// semantics; a span → marks every char in it carries.
export function docMarks(
  s: EditorState,
  range: DocRange | undefined,
): Set<string> {
  const r = resolveInlineRange(s, range);
  if (!r) return new Set<string>();
  if (r.start === r.end) return activeCaretMarks(s);
  const block = s.document.page.blocks[r.blockIndex];
  const result = new Set<string>();
  if (!block || block.deleted || !isTextualBlock(block)) return result;
  for (const mark of s.marks.markList()) {
    if (
      allCharsHaveFormat(
        block.charRuns,
        block.formats,
        r.start,
        r.end,
        mark.type,
      )
    )
      result.add(mark.type);
  }
  return result;
}
