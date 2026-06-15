/**
 * Editor **input actions** — the IME-composition, paste, and image-resize-drag
 * actions the event handlers used to inline, lifted into named, dispatchable
 * {@link StateAction}s. Sibling to `keyboard-actions.ts` (cursor/selection
 * moves) and `edit-actions.ts` (key-driven content edits); this file holds the
 * actions driven by composition, clipboard, and pointer-drag events.
 *
 * A state action is the low-level action shape: its default behavior is a
 * pure `(state) => { state, ops }` transform (see `action-bus.ts`), which is
 * exactly the currency the event pipeline already trades in. Handlers dispatch
 * these via `state.actionBus.dispatchState(...)`, so hosts/plugins can observe
 * or override them, and the engine's logic lives in one named place instead of
 * being scattered across the input event handlers.
 *
 * Several of these actions need data that only lives on the DOM event or the
 * pointer (the composed string, the extracted clipboard data, the pointer
 * coordinates, the resolved drag handle). That data is computed in the event
 * handler and threaded in via the payload, so the action stays a pure
 * transform over {@link EditorState}. The handlers also keep their guards
 * (focus / readonly / locked / composition) — a action assumes it is allowed
 * to run.
 */

import { stateAction } from "../action-bus";
import { imageCache, invalidateBlockCache } from "../rendering/renderer";
import type { Block } from "../serlization/loadPage";
import type {
  EditorState,
  ImageDragState,
  ViewportState,
} from "../state-types";
import { getEditorStyles } from "../styles";
import type { Operation } from "../sync/sync";
import { deleteSelectedText, getSelectionRange, insertText } from "./actions";
import { pasteFromClipboardEvent } from "./clipboard";

// ─── Composition (IME) ───────────────────────────────────────────────────────

/** Payload for the composition start/end actions — the event's current data. */
interface CompositionTextPayload {
  /** `event.data` for the composition event (empty string when null). */
  data: string;
}

/**
 * Begin an IME composition: delete any active (non-collapsed) selection just as
 * normal typing would, then record the composition state (caret start position
 * and the initial composed text). Emits the CRDT text/format ops from the
 * selection delete (none when there is no selection to delete).
 *
 * The caller passes the composition event's `data`; the focus / readonly /
 * locked / no-cursor guards stay in the handler.
 */
export const COMPOSITION_START = stateAction<CompositionTextPayload>(
  "composition-start",
  (state, { data }) => {
    const ops: Operation[] = [];

    // When composition starts, save the current cursor position
    if (!state.document.cursor) return { state, ops };

    // Delete any selected text first (like normal typing would)
    if (state.document.selection && !state.document.selection.isCollapsed) {
      const range = getSelectionRange(state);
      if (range) {
        const result = deleteSelectedText(state);
        state = result.state;
        ops.push(...result.ops);
      }
    }

    // Store the starting position for composition
    if (!state.document.cursor) return { state, ops };
    const startPosition = state.document.cursor.position;

    return {
      state: {
        ...state,
        ui: {
          ...state.ui,
          composition: {
            isComposing: true,
            text: data,
            startPosition,
            cursorOffset: data.length,
          },
        },
      },
      ops,
    };
  },
);

/** Payload for {@link COMPOSITION_UPDATE} — the new composed text. */
interface CompositionUpdatePayload {
  /** `event.data` for the composition update (empty string when null). */
  data: string;
}

/**
 * Track an in-progress IME composition without inserting anything — the actual
 * text lands on composition end. Keeps the caret active (non-blinking) and
 * advances the in-composition cursor offset: if the offset was at the end of the
 * old text, it follows to the end of the new text; otherwise it stays where the
 * user put it (via arrow keys), clamped to the new length. Pure — emits no ops.
 *
 * Assumes `state.ui.composition` is already set; the handler routes a missing
 * composition back through {@link COMPOSITION_START}.
 */
export const COMPOSITION_UPDATE = stateAction<CompositionUpdatePayload>(
  "composition-update",
  (state, { data }) => {
    if (!state.ui.composition) return { state, ops: [] };

    const newText = data;
    const oldText = state.ui.composition.text;
    const oldOffset = state.ui.composition.cursorOffset;
    // If cursor was at the end of the old text, keep it at the end of the new
    // text; otherwise preserve the user's explicit cursor position (from arrow
    // keys), clamped to new length.
    const cursorOffset =
      oldOffset >= oldText.length
        ? newText.length
        : Math.min(oldOffset, newText.length);

    return {
      state: {
        ...state,
        document: {
          ...state.document,
          // Keep cursor active (not blinking) during composition updates
          cursor: state.document.cursor
            ? {
                ...state.document.cursor,
                lastUpdate: Date.now(),
              }
            : null,
        },
        ui: {
          ...state.ui,
          composition: {
            ...state.ui.composition,
            text: newText,
            cursorOffset,
          },
        },
      },
      ops: [],
    };
  },
);

/**
 * Finish an IME composition: insert the final composed text at the caret and
 * clear the composition state. Emits the CRDT text/format ops from the insert
 * (none when there is nothing composed). The handler keeps the scroll-to-cursor
 * follow-up after committing, since that touches the viewport, not the state.
 *
 * The caller passes the composition event's `data`.
 */
export const COMPOSITION_END = stateAction<CompositionTextPayload>(
  "composition-end",
  (state, { data }) => {
    const ops: Operation[] = [];

    // Insert the final composed text
    if (data && state.document.cursor) {
      const result = insertText(state, data);
      state = result.state;
      ops.push(...result.ops);
    }

    // Clear composition state
    return {
      state: {
        ...state,
        ui: {
          ...state.ui,
          composition: null,
        },
      },
      ops,
    };
  },
);

// ─── Paste ───────────────────────────────────────────────────────────────────

/**
 * Payload for {@link PASTE} — the event plus its pre-extracted clipboard data.
 * `pasteFromClipboardEvent` is run **once**, in the handler (see
 * {@link runPaste}), so the handler can also keep the `pastedImageBlockIndex`
 * the paste surfaces. The resulting `{ state, ops }` is threaded back in via
 * `precomputed` so the action relays it to observers/overrides without pasting
 * a second time (a second paste would mint new blocks / blob URLs).
 */
interface PastePayload {
  event: ClipboardEvent;
  clipboardData?: { html: string; text: string; imageFile: File | null } | null;
  /** The already-run paste result, threaded in by the handler. */
  precomputed: { state: EditorState; ops: Operation[] };
}

/**
 * Insert clipboard content at the caret (Ctrl/Cmd+V) — HTML → image file →
 * plain-text fallback, emitting the resulting CRDT ops. The actual paste is run
 * by the handler via {@link runPaste} (so it can recover the
 * `pastedImageBlockIndex` a {@link StateResult} can't carry); this action just
 * relays that pre-computed result, so observers/overrides see PASTE without the
 * paste running twice. A no-op (input state, no ops) when the paste yielded
 * nothing. The visibleBlocks refresh and scroll-to-cursor stay in the handler.
 */
export const PASTE = stateAction<PastePayload>(
  "paste",
  (_state, { precomputed }) => precomputed,
);

/**
 * Run the clipboard paste once and return the `{ state, ops }` plus the
 * `pastedImageBlockIndex` the host needs (the part a {@link StateResult} can't
 * carry). The handler calls this, then dispatches {@link PASTE} with the
 * `{ state, ops }` as `precomputed`.
 */
export function runPaste(
  state: EditorState,
  event: ClipboardEvent,
  clipboardData?: { html: string; text: string; imageFile: File | null } | null,
): { state: EditorState; ops: Operation[]; pastedImageBlockIndex?: number } {
  const result = pasteFromClipboardEvent(state, event, clipboardData);
  if (!result) {
    return { state, ops: [] };
  }
  return {
    state: result.state,
    ops: result.ops,
    pastedImageBlockIndex: result.pastedImageBlockIndex,
  };
}

// ─── Image-resize drag ───────────────────────────────────────────────────────

/**
 * Begin an image-resize drag: record the resolved drag descriptor in
 * `ui.imageDrag`. The hit test (which handle was grabbed) and the start
 * dimensions depend on the pointer position and rendered geometry, so the
 * handler resolves them and passes the finished {@link ImageDragState} as the
 * payload — keeping the action a pure state set. Pure UI change, no ops.
 */
export const START_IMAGE_DRAG = stateAction<{ imageDrag: ImageDragState }>(
  "start-image-drag",
  (state, { imageDrag }) => ({
    state: {
      ...state,
      ui: {
        ...state.ui,
        imageDrag,
      },
    },
    ops: [],
  }),
);

/** Payload for {@link UPDATE_IMAGE_DRAG} — the live pointer + viewport. */
interface UpdateImageDragPayload {
  viewport: ViewportState;
  canvasX: number;
  canvasY: number;
}

/**
 * Recompute the dragged image's dimensions from the current pointer position,
 * applying the resize math (handle direction, full-width snapping, aspect-ratio
 * height capping) and writing the new width/height/objectFit onto the block.
 * Pure block-dimension update — no ops; the final `block_set`s are emitted by
 * {@link END_IMAGE_DRAG} when the drag releases. No-op when no drag is active or
 * the target block is gone / not an image.
 */
export const UPDATE_IMAGE_DRAG = stateAction<UpdateImageDragPayload>(
  "update-image-drag",
  (state, { viewport, canvasX, canvasY }) => {
    if (!state.ui.imageDrag) {
      return { state, ops: [] };
    }

    const {
      blockIndex,
      handle,
      startX,
      startY,
      startWidth,
      startHeight,
      startObjectFit,
    } = state.ui.imageDrag;
    const block = state.document.page.blocks[blockIndex];
    if (!block || block.deleted) return { state, ops: [] };

    if (block.type !== "image") {
      return { state, ops: [] };
    }

    const styles = getEditorStyles(state);
    const deltaX = canvasX - startX;
    const deltaY = canvasY - startY;
    const maxWidth =
      viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
    const snapThreshold = 20; // pixels to snap to padding

    let newWidth: number | "full" = startWidth;
    let newHeight = startHeight;
    let newObjectFit: "cover" | "contain" = startObjectFit;

    if (handle === "left" || handle === "right") {
      // Horizontal resize
      const widthDelta = handle === "left" ? -deltaX * 2 : deltaX * 2; // multiply by 2 because we resize from center
      const { minWidth: constraintMinWidth } = styles.imageResize.constraints;

      if (startWidth === "full") {
        // Start from full width
        const currentWidth = viewport.width;
        newWidth = Math.max(constraintMinWidth, currentWidth + widthDelta);

        // Check if we should snap to padding (transitioning to contained)
        if (Math.abs(newWidth - maxWidth) < snapThreshold) {
          newWidth = maxWidth;
          newObjectFit = "contain";
        } else if (newWidth < maxWidth - snapThreshold) {
          // Definitely in contain mode
          newObjectFit = "contain";
        } else if (newWidth > maxWidth) {
          // If width exceeds document width (maxWidth), stay in cover mode
          newWidth = "full";
          newObjectFit = "cover";
        } else if (newWidth >= viewport.width - 10) {
          // Snap back to full if close
          newWidth = "full";
          newObjectFit = "cover";
        }
      } else {
        // Already in custom width mode
        newWidth = Math.max(
          constraintMinWidth,
          Math.min(viewport.width, (startWidth as number) + widthDelta),
        );

        // Check if we should snap back to full width
        if (newWidth >= viewport.width - snapThreshold) {
          newWidth = "full";
          newObjectFit = "cover";
        } else if (
          newWidth >= maxWidth - snapThreshold &&
          newWidth <= maxWidth + snapThreshold
        ) {
          // Snap to padding width
          newWidth = maxWidth;
          newObjectFit = "contain";
        } else if (newWidth > maxWidth) {
          // If width exceeds document width (maxWidth), convert to cover
          newWidth = "full";
          newObjectFit = "cover";
        } else {
          // Remain in contain mode
          newObjectFit = "contain";
        }
      }

      // In contain mode, calculate height based on image aspect ratio to avoid jumps
      // Apply minWidth constraint to prevent over-resizing of wide images
      if (
        newObjectFit === "contain" &&
        typeof newWidth === "number" &&
        block.url
      ) {
        const cachedImage = imageCache.get(block.url);
        if (cachedImage && cachedImage.complete) {
          const imgAspectRatio =
            cachedImage.naturalWidth / cachedImage.naturalHeight;

          // Ensure width doesn't go below minimum (already enforced above, but keep for clarity)
          newWidth = Math.max(newWidth, constraintMinWidth);

          // Calculate height based on width and aspect ratio
          newHeight = newWidth / imgAspectRatio;
        }
      }
    } else if (handle === "bottom" && startObjectFit === "cover") {
      // Vertical resize (only in cover mode)
      // In cover mode, we enforce minimum height
      const { minHeight: constraintMinHeight } = styles.imageResize.constraints;
      const calculatedHeight = Math.max(
        constraintMinHeight,
        startHeight + deltaY,
      );

      // Cap height based on image aspect ratio to prevent over-resizing
      if (block.url) {
        const cachedImage = imageCache.get(block.url);
        if (cachedImage && cachedImage.complete) {
          const imgAspectRatio =
            cachedImage.naturalWidth / cachedImage.naturalHeight;

          // Calculate the current container width
          const containerWidth =
            typeof startWidth === "number" ? startWidth : viewport.width;

          // For portrait images (tall), cap the height so it doesn't exceed the image's natural ratio
          // This prevents excessive cropping when the image is resized too tall
          const maxHeightForRatio = containerWidth / imgAspectRatio;

          // Cap the height at the image's natural ratio relative to container width
          newHeight = Math.min(calculatedHeight, maxHeightForRatio);

          // Ensure we don't go below minimum height
          newHeight = Math.max(newHeight, constraintMinHeight);
        } else {
          newHeight = calculatedHeight;
        }
      } else {
        newHeight = calculatedHeight;
      }
    }

    // Update the block with new dimensions
    const updatedBlock: Block = {
      ...block,
      width: newWidth,
      height: newHeight,
      objectFit: newObjectFit,
    };

    // Invalidate the block height cache since dimensions changed
    invalidateBlockCache(updatedBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = updatedBlock;

    return {
      state: {
        ...state,
        document: {
          ...state.document,
          page: { ...state.document.page, blocks: newBlocks },
        },
      },
      ops: [],
    };
  },
);

/**
 * Finish an image-resize drag: clear `ui.imageDrag` and emit a `block_set` op
 * for each dimension (width / height / objectFit) that actually changed since
 * the drag began.
 *
 * The `!== undefined` guards are load-bearing — a defensive resize-math edge
 * case could leave a dimension unset, and emitting `value: undefined`
 * serializes to a value-less `block_set` that `applyBlockSet`/`validateField`
 * reject on every peer, silently desyncing the local image. They are preserved
 * exactly (see `__fuzz__/image-resize-undefined.test.ts`).
 */
export const END_IMAGE_DRAG = stateAction("end-image-drag", (state) => {
  if (!state.ui.imageDrag) {
    return { state, ops: [] };
  }

  const ops: Operation[] = [];
  const { blockIndex, startWidth, startHeight, startObjectFit } =
    state.ui.imageDrag;
  const block = state.document.page.blocks[blockIndex];

  if (block && block.type === "image") {
    const blockId = block.id;

    // Create operations only for fields that changed during the drag.
    // Compare final values with original values from when drag started.
    // Guard against `undefined`: a defensive resize math edge case could leave
    // a dimension unset, and emitting `value: undefined` serializes to a
    // value-less block_set that `applyBlockSet`/`validateField` reject on every
    // peer — leaving the local editor's image silently desynced (it reflows to
    // its default size, jumping the content below it). Never emit such an op.
    if (block.width !== startWidth && block.width !== undefined) {
      ops.push({
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId,
        field: "width",
        value: block.width,
      });
    }

    if (block.height !== startHeight && block.height !== undefined) {
      ops.push({
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId,
        field: "height",
        value: block.height,
      });
    }

    if (block.objectFit !== startObjectFit && block.objectFit !== undefined) {
      ops.push({
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId,
        field: "objectFit",
        value: block.objectFit,
      });
    }
  }

  return {
    state: {
      ...state,
      ui: {
        ...state.ui,
        imageDrag: null,
      },
    },
    ops,
  };
});

/**
 * Cancel an image-resize drag (e.g. pointer cancel) without recording undo:
 * clear `ui.imageDrag` and emit no ops. The in-progress dimension changes
 * {@link UPDATE_IMAGE_DRAG} wrote stay on the block but were never committed as
 * ops, mirroring the previous behavior. No-op when no drag is active.
 */
export const CANCEL_IMAGE_DRAG = stateAction("cancel-image-drag", (state) => {
  if (!state.ui.imageDrag) {
    return { state, ops: [] };
  }

  return {
    state: {
      ...state,
      ui: {
        ...state.ui,
        imageDrag: null,
      },
    },
    ops: [],
  };
});
