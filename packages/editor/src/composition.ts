import type { Block, CharRun } from "./serlization/loadPage";
import type { CompositionState, EditorState, Position } from "./state-types";
import type { ContentPoint } from "./structured-selection";
import { isTextualBlock } from "./sync/block-registry";
import {
  getVisibleOffsetAfterChar,
  getVisiblePositionOfChar,
  iterateVisibleChars,
} from "./sync/char-runs";

// Composition (IME) State Management

export function startComposition(
  state: EditorState,
  text: string,
  startPosition: Position | ContentPoint,
): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        isComposing: true,
        text,
        startPosition,
        cursorOffset: text.length,
      },
    },
  };
}

export function updateComposition(
  state: EditorState,
  text: string,
): EditorState {
  if (!state.ui.composition) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        ...state.ui.composition,
        text,
        cursorOffset: Math.min(state.ui.composition.cursorOffset, text.length),
      },
    },
  };
}

export function endComposition(state: EditorState): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: null,
    },
  };
}

/**
 * How many UTF-16 units `a` and `b` share at the start and, after that, at the
 * end — never splitting a surrogate pair, never overlapping. A recomposition
 * (a keyboard that reopened the word before the caret) only replaces what lies
 * between: the commit edits it and the preview draws it, so both agree on which
 * characters keep their own formatting.
 */
export function sharedEnds(a: string, b: string) {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  if (prefix > 0 && (isLowSurrogate(a, prefix) || isLowSurrogate(b, prefix))) {
    prefix--;
  }
  let suffix = 0;
  while (
    suffix < max - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (
    suffix > 0 &&
    (isLowSurrogate(a, a.length - suffix) ||
      isLowSurrogate(b, b.length - suffix))
  ) {
    suffix--;
  }
  return { prefix, suffix };
}

function isLowSurrogate(text: string, index: number) {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The word a keyboard reopened, pinned to its characters (see `CompositionState.reopened`). */
export type ReopenedWord = NonNullable<CompositionState["reopened"]>;

/**
 * The `replaces` characters before the caret right now, pinned to their ids,
 * with the id of the character before them (null at the block start). Undefined
 * when there is nothing to pin (no flat caret, `replaces` 0).
 */
export function captureReopenedWord(
  state: EditorState,
  replaces: number,
): ReopenedWord | undefined {
  const caret = state.document.cursor?.position;
  const block = caret ? state.document.page.blocks[caret.blockIndex] : null;
  if (replaces <= 0 || !caret || !block || !isTextualBlock(block)) {
    return undefined;
  }
  const start = caret.textIndex - replaces;
  const visible = [...iterateVisibleChars(block.charRuns)];
  const chars = visible.slice(start, caret.textIndex);
  return {
    blockId: block.id,
    text: chars.map((c) => c.char).join(""),
    charIds: chars.map((c) => c.id),
    beforeId: start > 0 ? (visible[start - 1]?.id ?? null) : null,
  };
}

/**
 * The reopened word a composition of `replaces` characters edits: the one
 * pinned when the keyboard reopened it while the count still agrees, else the
 * word before the caret now (a count first known at compositionend).
 *
 * `replaces` is the keyboard's count, not clamped to the caret: a peer who
 * deleted the open word pulls the caret back over it (see `remapPosition`), so
 * a clamped count would no longer match the pinned word, and the characters
 * before the caret now — the peer's, not the word — would be replaced.
 */
export function reopenedWordFor(
  state: EditorState,
  replaces: number,
): ReopenedWord | undefined {
  if (replaces <= 0) return undefined;
  const pinned = state.ui.composition?.reopened;
  if (pinned && pinned.charIds.length === replaces) return pinned;
  const caret = state.document.cursor?.position;
  return captureReopenedWord(state, Math.min(replaces, caret?.textIndex ?? 0));
}

/**
 * Whether a reopened word lives in `blockId`. The caret leaves the word's
 * block only when something else moved it there (a peer deleted the block);
 * the word's ids are then unknown to the caret's block, and a plan against it
 * would land the new letters at that block's start.
 */
export function reopenedWordIn(
  word: ReopenedWord | undefined,
  blockId: string | undefined,
): word is ReopenedWord {
  return !!word && word.blockId === blockId;
}

/**
 * Where the caret of an open composition sits when nothing of it is drawn (a
 * recomposition the keyboard emptied, or a reopened word a peer deleted): where
 * the reopened word began, right after the character before it (found by id,
 * so a peer's edit does not throw it off), else `replaces` back from the caret.
 * A word in another block than `block` is not drawn there: the caret stays.
 */
export function undrawnCompositionCaret(
  composition: CompositionState,
  block: Block | undefined,
  caretIndex: number,
): number {
  const word = composition.reopened;
  if (word && !reopenedWordIn(word, block?.id)) return caretIndex;
  const runs = block && isTextualBlock(block) ? block.charRuns : undefined;
  const start = word ? getVisibleOffsetAfterChar(runs, word.beforeId) : null;
  return start ?? caretIndex - Math.min(composition.replaces ?? 0, caretIndex);
}

/**
 * What committing `data` over a reopened word does to the block as it is now,
 * in visible offsets of the current text. The commit (COMPOSITION_END) and the
 * preview (`getContentWithComposition`) both follow it, so they always agree.
 *
 * It is the keyboard's own change, by character id: the letters the old and
 * new word share at the start and end stay; the ones in between are deleted —
 * those still there; a peer may have deleted some — and the new middle goes
 * where they were, right after the character that preceded them. A peer's
 * characters typed inside the word are not the keyboard's, so they stay. This
 * is what the edit would have done had it landed before the peer's, so the
 * result is the same whichever reaches a replica first.
 */
export interface RecompositionPlan {
  /** Visible ranges to delete, ascending and disjoint. */
  readonly deletes: readonly { readonly from: number; readonly to: number }[];
  /** Where the new middle goes (before any delete is applied). */
  readonly insertAt: number;
  /** The new middle of the word. */
  readonly inserted: string;
  /**
   * The new middle types over the first delete (it starts at `insertAt`), so
   * it takes that character's formatting, as typing over a selection does.
   */
  readonly overwritesFirst: boolean;
  /** Ids of the word's characters that stay. */
  readonly keptIds: ReadonlySet<string>;
  /** The kept end of the word, last character first-to-last (may be empty). */
  readonly suffixIds: readonly string[];
}

export function planRecomposition(
  runs: CharRun[] | undefined,
  word: ReopenedWord,
  data: string,
): RecompositionPlan {
  const { prefix, suffix } = sharedEnds(word.text, data);
  const end = word.text.length - suffix;
  const replacedIds = word.charIds.slice(prefix, end);

  const positions = replacedIds
    .map((id) => getVisiblePositionOfChar(runs, id))
    .filter((p) => p >= 0)
    .sort((a, b) => a - b);
  const deletes: { from: number; to: number }[] = [];
  for (const p of positions) {
    const last = deletes[deletes.length - 1];
    if (last && last.to === p) last.to = p + 1;
    else deletes.push({ from: p, to: p + 1 });
  }

  const anchorId = prefix > 0 ? word.charIds[prefix - 1] : word.beforeId;
  const anchored = getVisibleOffsetAfterChar(runs, anchorId);
  // An anchor id unknown to this block (never expected: tombstones stay) falls
  // back to the first delete, or the block start.
  const insertAt = anchored ?? deletes[0]?.from ?? 0;

  return {
    deletes,
    insertAt,
    inserted: data.slice(prefix, data.length - suffix),
    overwritesFirst: deletes.length > 0 && deletes[0].from === insertAt,
    keptIds: new Set([
      ...word.charIds.slice(0, prefix),
      ...word.charIds.slice(end),
    ]),
    suffixIds: word.charIds.slice(end),
  };
}
