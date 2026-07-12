/**
 * Editor **input actions** — the IME-composition and clipboard (paste / copy /
 * cut) actions the event handlers used to inline, lifted into named,
 * dispatchable {@link StateAction}s (copy is a plain {@link action} signal — it
 * produces no state/ops). Sibling to `keyboard-actions.ts` (cursor/selection
 * moves) and `edit-actions.ts` (key-driven content edits); this file holds the
 * actions driven by composition and clipboard events.
 *
 * (The image-resize-handle drag actions, formerly here, now live with the node
 * they act on — see `nodes/ImageNode.ts` → `*_IMAGE_HANDLE_DRAG`.)
 *
 * A state action is the low-level action shape: its default behavior is a
 * pure `(state) => { state, ops }` transform (see `action-bus.ts`), which is
 * exactly the currency the event pipeline already trades in. Handlers dispatch
 * these via `state.actionBus.dispatchState(...)`, so hosts/plugins can observe
 * or override them, and the engine's logic lives in one named place instead of
 * being scattered across the input event handlers.
 *
 * Several of these actions need data that only lives on the DOM event (the
 * composed string, the extracted clipboard data). That data is computed in the
 * event handler and threaded in via the payload, so the action stays a pure
 * transform over {@link EditorState}. The handlers also keep their guards
 * (focus / readonly / suspended / composition) — a action assumes it is allowed
 * to run.
 */

import { action, stateAction } from "../action-bus";
import type { EditorState } from "../state-types";
import type { Operation } from "../sync/sync";
import { deleteSelectedText, getSelectionRange, insertText } from "./actions";
import { pasteFromClipboardEvent } from "./clipboard";
import { selectionIntersectsStructuredMark } from "./structured-marks";

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
 * suspended / no-cursor guards stay in the handler.
 */
export const COMPOSITION_START = stateAction<CompositionTextPayload>(
  "composition-start",
  (state, { data }) => {
    const ops: Operation[] = [];

    // A composition may start in either flat block text or an extension-owned
    // structured document. Structured ranges stay intact until compositionend,
    // where the feature's normal insert rule replaces them atomically. Deleting
    // them here would make a cancelled IME session destructive.
    if (!state.document.cursor && !state.document.contentSelection) {
      return { state, ops };
    }

    // Delete any selected text first (like normal typing would)
    if (
      state.document.selection &&
      !state.document.selection.isCollapsed &&
      !selectionIntersectsStructuredMark(state) &&
      !state.schema.features.ownsInput("before-insert", state, data)
    ) {
      const range = getSelectionRange(state);
      if (range) {
        const result = deleteSelectedText(state);
        state = result.state;
        ops.push(...result.ops);
      }
    }

    // Store the stable starting point for composition. `insertText` still uses
    // the live selection on commit, so concurrent structured edits can be
    // reconciled before the final string lands.
    const startPosition = state.document.cursor
      ? state.document.cursor.position
      : { ...state.document.contentSelection!.focus };

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
          // Keep the active caret (flat or structured) from blinking during
          // composition updates.
          cursor: state.document.cursor
            ? {
                ...state.document.cursor,
                lastUpdate: Date.now(),
              }
            : null,
          contentSelection: state.document.contentSelection
            ? {
                ...state.document.contentSelection,
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
    if (data && (state.document.cursor || state.document.contentSelection)) {
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

// ─── Clipboard (copy / cut / paste) ──────────────────────────────────────────

/**
 * Copy the current selection to the system clipboard (Ctrl/Cmd+C). Copy
 * produces no state/ops — it only builds a clipboard payload, written
 * synchronously in the handler (`copyHandler` in `entries/editor.ts`) — so this
 * is a plain {@link action} signal hosts can observe (e.g. analytics) or
 * override (a native shell routing the copy through its own clipboard bridge),
 * mirroring {@link OPEN_LINK}.
 */
export const COPY = action("copy");

/**
 * Cut the current selection to the system clipboard (Ctrl/Cmd+X). The clipboard
 * write is synchronous in the handler (`cutHandler` in `entries/editor.ts`);
 * this action is the document side — it deletes the selection, wrapping the pure
 * `deleteSelectedText` transform and emitting the resulting delete ops, so the
 * deletion is observable/overridable.
 */
export const CUT = stateAction("cut", (state) => {
  const result =
    state.document.contentSelection ||
    (state.document.selection &&
      !state.document.selection.isCollapsed &&
      state.schema.features.ownsInput("before-insert", state, ""))
      ? insertText(state, "")
      : deleteSelectedText(state);
  return { state: result.state, ops: result.ops };
});

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
