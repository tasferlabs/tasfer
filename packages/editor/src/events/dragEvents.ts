/**
 * HTML5 drag-and-drop of text.
 *
 * The gesture is the platform's, not the editor's. The browser decides when a
 * press becomes a drag, paints the drag image, draws the copy/move cursor,
 * applies the OS modifier conventions, and carries the content on a
 * `DataTransfer` — which is why text dragged out of the editor lands in any
 * other application, and text dragged in from one arrives here. This module is
 * only the editor's side of that contract: what to put on the transfer, where a
 * drop would land, and what to read back off it.
 *
 * A canvas is not draggable by default, and making it permanently draggable
 * would turn every press-and-sweep into a drag instead of a selection. So the
 * `draggable` flag is raised for the span of one press — the press that lands
 * on selected text (`pressArmsTextDrag` in `mouseEvents.ts`, answered
 * synchronously in the DOM handler, since the browser resolves the gesture
 * before the next frame) and dropped again when that press ends. Hovering the
 * selection only advertises it, through the grab cursor.
 *
 * Where the platform has no HTML5 drag-and-drop (`supportsHtml5Drag` — touch
 * engines never fire `drag*` for a finger, and their real text-drag gestures
 * belong to the native text views), the feature is absent rather than
 * reimplemented: no listeners, no draggable canvas, no grab cursor.
 */

import { getSelectionRange } from "../actions/actions";
import type { ClipboardPayload } from "../actions/clipboard";
import { buildClipboardPayload } from "../actions/clipboard";
import { type DragRange, positionWithinRange } from "../actions/drag-actions";
import { isApplePlatform } from "../platform";
import {
  getContentSelectionFromViewport,
  getTextPositionFromViewport,
} from "../selection";
import type {
  EditorState,
  TextDropTarget,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import { contentPointsEqual } from "../structured-selection";
import { findBlockIndex } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { canDragSelection } from "./mouseEvents";

/**
 * Private flavor stamped on every drag this editor starts. Its *value* is never
 * read — `DataTransfer` only exposes the type list (not the data) during
 * `dragover`, so this exists purely so a drag can be recognised as Tasfer text
 * while it is still in flight, before any drop has happened.
 */
export const TASFER_TEXT_DRAG_TYPE = "application/x-tasfer-text-drag";

/** The subset of `DragEvent`/`DataTransfer` this module needs. */
export interface DragTransfer {
  readonly types: readonly string[];
  effectAllowed: string;
  dropEffect: string;
  setData(format: string, data: string): void;
  getData(format: string): string;
  setDragImage?(image: Element, x: number, y: number): void;
}

/**
 * Load the current selection onto a starting drag. Returns the range that went
 * on it (to be remembered until `dragend`), or `null` when there is nothing
 * draggable — in which case the caller must cancel the drag.
 *
 * The flavors are the clipboard's: the same marker-carrying HTML a copy writes,
 * so a Tasfer-to-Tasfer drop rebuilds marks, block types and math exactly, and
 * the plain-text flavor still lands sensibly in any other application.
 */
export function loadTextDrag(
  state: EditorState,
  transfer: DragTransfer,
): DragRange | null {
  if (!canDragSelection(state)) return null;
  const range = getSelectionRange(state);
  if (!range) return null;
  const payload = buildClipboardPayload(state);
  if (!payload) return null;

  transfer.setData("text/plain", payload.plainText);
  transfer.setData("text/html", payload.html);
  transfer.setData(TASFER_TEXT_DRAG_TYPE, "1");
  // Both are on offer; the browser picks per the OS modifier and reports the
  // outcome back on `dragend`.
  transfer.effectAllowed = "copyMove";

  return range;
}

/**
 * Whether a drag passing over the editor carries text it can accept. File drags
 * are somebody else's (the host imports dropped images and documents), so they
 * are declined here and left to bubble — as is anything at all while the
 * document is not editable, so the browser shows a no-drop cursor rather than
 * promising a drop that would be silently ignored.
 */
export function isTextDrag(
  transfer: DragTransfer | null,
  state: EditorState,
): boolean {
  if (!transfer) return false;
  if (state.ui.mode === "readonly" || state.ui.mode === "suspended") {
    return false;
  }
  const types = Array.from(transfer.types);
  if (types.includes("Files")) return false;
  return (
    types.includes(TASFER_TEXT_DRAG_TYPE) ||
    types.includes("text/html") ||
    types.includes("text/plain")
  );
}

/**
 * Where a drag passing over this editor came from. Only a Tasfer drag can be a
 * *move*: some editor on the page owns the original and will remove it (this
 * one in its own drop, another in its `dragend`). Text from any other
 * application is copied — reaching into its source is not ours to do.
 */
export function dragOrigin(
  transfer: DragTransfer | null,
  isOwnDrag: boolean,
): "self" | "tasfer" | "external" {
  if (isOwnDrag) return "self";
  const types = transfer ? Array.from(transfer.types) : [];
  return types.includes(TASFER_TEXT_DRAG_TYPE) ? "tasfer" : "external";
}

/**
 * The effect a drop here should have, told to the browser on every `dragover`
 * so it paints the right cursor and reports the right outcome on `dragend`.
 * The copy modifier follows the platform — Option on Apple, Ctrl elsewhere —
 * matching what every native text field does.
 */
export function dropEffectFor(
  origin: "self" | "tasfer" | "external",
  modifiers: { readonly altKey: boolean; readonly ctrlKey: boolean },
): "copy" | "move" {
  if (origin === "external") return "copy";
  const copyHeld = isApplePlatform() ? modifiers.altKey : modifiers.ctrlKey;
  return copyHeld ? "copy" : "move";
}

/**
 * Where a drop at a canvas point would insert, or `null` when there is nowhere
 * to put it — off the text, on a block that has no caret to offer, or inside the
 * range being carried, which has nowhere to move to. A `null` target paints no
 * insertion caret, so an invalid drop reads as invalid before the pointer is
 * released.
 *
 * A block with no flat text of its own (a table) is asked where inside itself
 * the drop goes, because the flat walk has no offset to give there and answers
 * with the block's own index and zero. Dropped at that, the text was removed
 * from its source and inserted into text the block does not have — it simply
 * disappeared. When the block's node claims no caret either (an image, a
 * horizontal rule, a table the pointer missed the cells of) the drop is refused
 * rather than committed somewhere invisible.
 *
 * The flat walk is asked FIRST wherever it can answer, so a paragraph carrying
 * an inline chip (a math formula) still takes the drop as prose beside the chip
 * rather than as characters typed into the formula. A click descends into the
 * chip because a caret is a precise gesture; a drop lands wherever the dragged
 * text happened to be let go.
 */
export function dropTargetAt(
  state: EditorState,
  viewport: ViewportState,
  canvasX: number,
  canvasY: number,
  visibility: VisibleBlockRange | undefined,
  source: DragRange | null,
): TextDropTarget | null {
  if (state.ui.mode === "readonly" || state.ui.mode === "suspended") {
    return null;
  }

  const position = getTextPositionFromViewport(
    canvasX,
    canvasY,
    state,
    viewport,
    undefined,
    visibility,
  );
  if (!position) return null;
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted) return null;

  if (isTextualBlock(block)) {
    return source && positionWithinRange(position, source.start, source.end)
      ? null
      : { kind: "text", position };
  }

  // The block itself is being carried away, so whatever is inside it goes too:
  // there is nothing left to drop into.
  if (
    source &&
    position.blockIndex >= source.start.blockIndex &&
    position.blockIndex <= source.end.blockIndex
  ) {
    return null;
  }
  const nested = getContentSelectionFromViewport(
    canvasX,
    canvasY,
    state,
    viewport,
    "mouse",
    undefined,
    visibility,
  );
  // A drop lands at one caret, never over a range — the hit-test's focus is it.
  if (
    !nested ||
    findBlockIndex(state.document.page, nested.focus.blockId) < 0
  ) {
    return null;
  }
  return {
    kind: "content",
    selection: { anchor: nested.focus, focus: nested.focus },
  };
}

/**
 * Whether two resolved drop targets address the same caret. `dragover` fires
 * continuously, and each pass resolves a fresh target object; comparing by value
 * is what keeps a pointer resting in one spot from repainting every event.
 */
export function sameDropTarget(
  left: TextDropTarget | null,
  right: TextDropTarget | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "text" && right.kind === "text") {
    return (
      left.position.blockIndex === right.position.blockIndex &&
      left.position.textIndex === right.position.textIndex
    );
  }
  if (left.kind === "content" && right.kind === "content") {
    return contentPointsEqual(left.selection.focus, right.selection.focus);
  }
  return false;
}

/**
 * Read the dropped content back into the flavors the paste parser understands.
 * Must be called synchronously inside the `drop` handler — a `DataTransfer` is
 * neutered the moment the event returns. Returns `null` when the drag carried
 * no text at all.
 */
export function readTextDrop(
  transfer: DragTransfer | null,
): ClipboardPayload | null {
  if (!transfer) return null;
  const html = transfer.getData("text/html");
  const plainText = transfer.getData("text/plain");
  if (!html && !plainText) return null;
  return { plainText, html, markdown: plainText };
}
