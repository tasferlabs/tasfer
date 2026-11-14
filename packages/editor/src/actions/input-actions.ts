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
import {
  captureReopenedWord,
  planRecomposition,
  type ReopenedWord,
  reopenedWordFor,
  reopenedWordIn,
} from "../composition";
import { moveCursorToPosition } from "../selection";
import type { CompositionState, EditorState } from "../state-types";
import { isTextualBlock } from "../sync/block-registry";
import { getVisiblePositionOfChar } from "../sync/char-runs";
import type { Operation } from "../sync/sync";
import {
  deleteSelectedText,
  deleteSelectionThroughOwner,
  getSelectionRange,
  insertText,
} from "./actions";
import { pasteFromClipboardEvent } from "./clipboard";
import { selectionIntersectsStructuredMark } from "./structured-marks";

// ─── Composition (IME) ───────────────────────────────────────────────────────

/** Payload for the composition start/end actions — the event's current data. */
interface CompositionTextPayload {
  /** `event.data` for the composition event (empty string when null). */
  data: string;
  /**
   * Visible characters directly before the caret that the composition replaces
   * (an IME that reopened an already-typed word; see
   * {@link CompositionState.replaces}). Omitted or 0 for a normal composition.
   */
  replaces?: number;
}

/**
 * Start an IME composition, the typing used by input methods and phone
 * keyboards. Selected text is deleted first, like normal typing, unless a
 * feature such as a formula handles the input itself. Then the editor remembers
 * where the composition starts. That deletion is the only document edit.
 *
 * Pass the composition event's `data`. This action does not check focus or
 * read-only mode. The editor checks those before it dispatches.
 */
export const COMPOSITION_START = stateAction<CompositionTextPayload>(
  "composition-start",
  (state, { data, replaces }) => {
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
      !state.schema.ownsInput("before-insert", state, data)
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
            ...reopenedWord(state, clampReplaces(state, replaces)),
          },
        },
      },
      ops,
    };
  },
);

// A recomposition can only replace flat text before the caret in its own block.
function clampReplaces(state: EditorState, replaces: number | undefined) {
  const cursor = state.document.cursor;
  if (!replaces || replaces < 0 || !cursor) return 0;
  return Math.min(replaces, cursor.position.textIndex);
}

// The `replaces` count plus the word it covers right now, pinned to its
// characters' ids (see `CompositionState.reopened`).
function reopenedWord(
  state: EditorState,
  replaces: number,
): Pick<CompositionState, "replaces" | "reopened"> {
  const reopened = captureReopenedWord(state, replaces);
  return { replaces: reopened ? replaces : 0, reopened };
}

/** Payload for {@link COMPOSITION_UPDATE} — the new composed text. */
interface CompositionUpdatePayload {
  /** `event.data` for the composition update (empty string when null). */
  data: string;
  /**
   * Replaced characters before the caret, once known (see
   * {@link CompositionTextPayload.replaces}). Omitted keeps the current value.
   */
  replaces?: number;
}

/**
 * Track the text while an IME composition is in progress. Nothing is inserted
 * yet. The text lands on {@link COMPOSITION_END}. The caret stops blinking. If
 * the caret was at the end of the composed text, it moves to the new end.
 * Otherwise it stays where the user put it with the arrow keys. It does not
 * change the document. Without an active composition (see
 * {@link COMPOSITION_START}) it does nothing.
 */
export const COMPOSITION_UPDATE = stateAction<CompositionUpdatePayload>(
  "composition-update",
  (state, { data, replaces }) => {
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
            // The same count keeps the pinned word, compared unclamped: a
            // peer who deleted the word pulled the caret back over it.
            ...(replaces === undefined ||
            replaces === (state.ui.composition.replaces ?? 0) ||
            clampReplaces(state, replaces) ===
              (state.ui.composition.replaces ?? 0)
              ? {}
              : reopenedWord(state, clampReplaces(state, replaces))),
          },
        },
      },
      ops: [],
    };
  },
);

/**
 * Finish an IME composition: insert the final text at the caret and clear the
 * composition. When the keyboard reopened a word before the caret (`replaces` >
 * 0), the new text replaces those characters instead of adding to them. An
 * empty final text then deletes them. With no final text and no reopened word,
 * it only clears the composition. Pass the composition event's `data`.
 */
// The handler keeps the scroll-to-cursor follow-up after committing, since that
// touches the viewport, not the state.
export const COMPOSITION_END = stateAction<CompositionTextPayload>(
  "composition-end",
  (state, { data, replaces }) => {
    const word = reopenedWordFor(
      state,
      replaces ?? state.ui.composition?.replaces ?? 0,
    );
    const result = word
      ? commitRecomposition(state, data, word)
      : data && (state.document.cursor || state.document.contentSelection)
        ? insertText(state, data)
        : { state, ops: [] };

    // Clear composition state
    return {
      state: {
        ...result.state,
        ui: {
          ...result.state.ui,
          composition: null,
        },
      },
      ops: result.ops,
    };
  },
);

/**
 * Commit a recomposition: the keyboard reopened `word` before the caret and
 * now commits `data` in its place.
 *
 * Only the part that differs is replaced. The characters the old word and the
 * new one share at the start and end stay as they are, so they keep their
 * formatting, their CRDT ids (and with them comments, links and remote
 * carets), and a word committed unchanged emits no ops at all. The caret ends
 * after the whole word, as the keyboard expects.
 *
 * The edit is planned by character id (see `planRecomposition`), not by
 * counting back from the caret, so a peer's edit to the word while it was
 * open is merged, not overwritten: their typed letters stay, letters they
 * deleted stay deleted, and the result is the same whichever edit lands first.
 *
 * When a delete touches a structured mark (an inline math chip, a mention) or
 * an edit is refused, nothing is edited: keeping the old word is safer than
 * cutting into the chip or leaving the word half-replaced.
 *
 * Nor is anything edited when the caret is no longer in the word's block (a
 * peer deleted it and the caret was moved out): the word is gone, as a word a
 * peer deletes inside the block is, and the new letters must not land in
 * whatever block holds the caret now.
 */
function commitRecomposition(
  state: EditorState,
  data: string,
  word: ReopenedWord,
): { state: EditorState; ops: Operation[] } {
  const keep = { state, ops: [] as Operation[] };
  const caret = state.document.cursor?.position;
  if (!caret) return keep;
  const blockIndex = caret.blockIndex;
  const block = state.document.page.blocks[blockIndex];
  if (!block || !isTextualBlock(block) || !reopenedWordIn(word, block.id)) {
    return keep;
  }

  const plan = planRecomposition(block.charRuns, word, data);
  if (!plan.deletes.length && !plan.inserted) return keep;

  const ops: Operation[] = [];
  let next = state;
  // Each step must go through; any refusal keeps the old word whole.
  const step = (from: number, to: number, text: string): boolean => {
    const position = (textIndex: number) => ({ blockIndex, textIndex });
    const target: EditorState =
      from === to
        ? moveCursorToPosition(next, blockIndex, from, true)
        : {
            ...next,
            document: {
              ...next.document,
              selection: {
                anchor: position(from),
                focus: position(to),
                isForward: true,
                isCollapsed: false,
                lastUpdate: Date.now(),
              },
            },
          };
    if (from !== to && selectionIntersectsStructuredMark(target)) return false;
    const result = text
      ? insertText(target, text)
      : deleteSelectionThroughOwner(target);
    const selection = result.state.document.selection;
    if (
      result.ops.length === 0 ||
      !result.state.document.cursor ||
      (selection && !selection.isCollapsed)
    ) {
      return false;
    }
    next = result.state;
    ops.push(...result.ops);
    return true;
  };

  // Back to front, so earlier offsets stay valid; the new middle last, at
  // `insertAt`, which no delete precedes.
  const [first, ...rest] = plan.deletes;
  for (const range of [...rest].reverse()) {
    if (!step(range.from, range.to, "")) return keep;
  }
  if (first && plan.overwritesFirst) {
    if (!step(first.from, first.to, plan.inserted)) return keep;
  } else {
    if (first && !step(first.from, first.to, "")) return keep;
    if (plan.inserted && !step(plan.insertAt, plan.insertAt, plan.inserted)) {
      return keep;
    }
  }

  // The caret ends after the whole word: after its kept end, else after the
  // new middle (where the last step left it).
  const nextBlock = next.document.page.blocks[blockIndex];
  const runs =
    nextBlock && isTextualBlock(nextBlock) ? nextBlock.charRuns : undefined;
  const lastKept = Math.max(
    -1,
    ...plan.suffixIds.map((id) => getVisiblePositionOfChar(runs, id)),
  );
  return {
    state:
      lastKept >= 0
        ? moveCursorToPosition(next, blockIndex, lastKept + 1, true)
        : next,
    ops,
  };
}

// ─── Clipboard (copy / cut / paste) ──────────────────────────────────────────

/**
 * Fired after the editor copies the selection to the clipboard (Ctrl/Cmd+C).
 * The copy has already happened when this runs, so a handler cannot stop or
 * replace it. Use it to react to a copy, for example for analytics or a native
 * app's own clipboard. It fires only when the editor has focus and something is
 * selected. It does not change the document. Like {@link OPEN_LINK}, it is a
 * plain {@link action}.
 */
// The clipboard write must stay synchronous inside the ClipboardEvent, in
// copyHandler (entries/editor.ts).
export const COPY = action("copy");

/**
 * Delete the selection as part of a cut (Ctrl/Cmd+X). The editor writes the
 * selection to the clipboard first, then dispatches this action to delete it.
 * So handlers can watch or override the delete, but not the clipboard write.
 */
// The clipboard write is synchronous in cutHandler (entries/editor.ts); the
// default deletes through deleteSelectionThroughOwner.
export const CUT = stateAction("cut", (state) => {
  const result = deleteSelectionThroughOwner(state);
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
 * Paste clipboard content at the caret (Ctrl/Cmd+V). The editor tries HTML
 * first, then an image file, then plain text.
 *
 * The editor runs the paste once, before it dispatches this action, and passes
 * the result as `precomputed`. The default handler just applies that result, so
 * the paste never runs twice. Handlers can watch or override the paste here.
 * When the clipboard gave nothing to paste, the state stays the same.
 */
// runPaste runs the paste so the handler can keep pastedImageBlockIndex, which
// a StateResult cannot carry. The visibleBlocks refresh and scroll-to-cursor
// stay in the handler.
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
