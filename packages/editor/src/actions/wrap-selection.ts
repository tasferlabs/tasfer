/**
 * Selection wrapping — VS Code-style "type a delimiter over a selection".
 *
 * When a non-collapsed text selection is held and the user types a wrap
 * trigger, the keystroke encloses the selection instead of replacing it:
 *
 *  - A mark's typed delimiter (declared via {@link Mark.selectionWrap})
 *    applies the markdown *meaning* of that delimiter — `*`/`_` → emphasis,
 *    `` ` `` → code, `~` → strike, `$` → inline math — by marking the selected
 *    range, never by inserting literal delimiter characters. Marks sharing a
 *    trigger at different levels (emphasis `*`/1, strong `*`/2) cycle through
 *    the delimiter-count combinations on repeated presses: plain → *em* →
 *    **strong** → ***both*** → plain, exactly as markdown reads `*`,`**`,`***`.
 *    The selection is kept so the next press advances the cycle.
 *
 *  - A bracket/quote ({@link SURROUND_PAIRS}) wraps the selection literally
 *    (`(sel)`, `"sel"`, …) and re-selects the original content, VS Code's
 *    auto-surround behavior. This is generic text editing, so it lives here in
 *    core; it works in preformatted blocks too.
 *
 * Core stays mark-agnostic: which chars are mark triggers and what they mean
 * comes entirely from the per-instance {@link MarkRegistry}, gated by
 * `DataSchema.isMarkAllowed` (per document) and the block's `hasFormats`
 * capability (per block), like every other mark application.
 *
 * Consumed by `insertText` (see `actions.ts`) only when the caller opts in —
 * the real typing path (the `INSERT_TEXT` action) does; IME commits and
 * programmatic inserts keep plain replace semantics. A successful wrap
 * short-circuits the insert entirely, so no `TEXT_INPUTTED` normalization
 * runs — nothing was typed at a caret for a node/mark to materialize.
 */

import { invalidateBlockCache } from "../rendering/renderer";
import { moveCursorToPosition, updateSelection } from "../selection";
import type {
  ActionResult,
  EditorState,
  Operation,
  Position,
} from "../state-types";
import { transformTypedInput } from "../state-utils";
import { canHaveFormats, isTextualBlock } from "../sync/block-registry";
import {
  allCharsHaveFormat,
  crdtToSelectionRange,
  getVisibleLength,
  insertCharsAtPosition,
  markCharsInRange,
  selectionRangeToCRDT,
} from "../sync/crdt-utils";

/**
 * Literal auto-surround pairs: typing the open char over a selection encloses
 * it. Backtick is a *fallback* pair — in formatted text the code mark's
 * `selectionWrap` trigger claims it first (marks win over literal pairs), so
 * the literal wrap only applies where no mark can (a preformatted block).
 */
const SURROUND_PAIRS: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
};

/** One mark type claiming the typed char, at its markdown delimiter level. */
interface ClaimedMark {
  readonly type: string;
  readonly level: number;
}

/** The format-capable slice of one selected block. */
interface FormatSegment {
  readonly blockIndex: number;
  readonly blockId: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Try to wrap the current selection for a typed character. Returns the
 * transformed state + ops, or `null` when the keystroke is not a wrap trigger
 * here (caller falls back to the ordinary replace-selection-and-type path).
 */
export function wrapSelectionOnInput(
  state: EditorState,
  input: string,
): ActionResult | null {
  if (input.length !== 1) return null;
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) return null;

  // Order anchor/focus into start/end.
  const { anchor, focus } = selection;
  const anchorFirst =
    anchor.blockIndex < focus.blockIndex ||
    (anchor.blockIndex === focus.blockIndex &&
      anchor.textIndex <= focus.textIndex);
  let start = anchorFirst ? anchor : focus;
  let end = anchorFirst ? focus : anchor;

  // A node selection (anchor === focus: a whole block held atomically) is not
  // a text range — typing there keeps its existing semantics.
  if (start.blockIndex === end.blockIndex && start.textIndex === end.textIndex)
    return null;

  // SAFETY: round-trip the range through CRDT ids to validate it against
  // concurrent updates (parity with toggleFormat).
  const crdtRange = selectionRangeToCRDT(state.document.page, { start, end });
  if (!crdtRange) return null;
  const fresh = crdtToSelectionRange(state.document.page, crdtRange);
  if (!fresh) return null;
  ({ start, end } = fresh);
  if (start.blockIndex === end.blockIndex && start.textIndex === end.textIndex)
    return null;

  return (
    wrapWithMarks(state, start, end, input) ??
    wrapWithPair(state, start, end, input)
  );
}

/**
 * Apply the markdown meaning of a typed delimiter to the selection: advance
 * the delimiter-count cycle over the marks claiming this char. The applied
 * set is read as a binary number over the claiming marks (ordered by level),
 * incremented, and written back — for a single mark that is a plain toggle;
 * for emphasis(1)/strong(2) on `*` it walks plain → emphasis → strong → both
 * → plain, matching what one/two/three markdown delimiters mean.
 */
function wrapWithMarks(
  state: EditorState,
  start: Position,
  end: Position,
  char: string,
): ActionResult | null {
  const claimed: ClaimedMark[] = [];
  for (const mark of state.marks.markList()) {
    if (!state.schema.isMarkAllowed(mark.type)) continue;
    for (const trigger of mark.selectionWrap ?? []) {
      if (trigger.char === char)
        claimed.push({ type: mark.type, level: trigger.level ?? 1 });
    }
  }
  if (claimed.length === 0) return null;
  claimed.sort((a, b) => a.level - b.level);

  const segments = formatableSegments(state, start, end);
  if (segments.length === 0) return null;

  // A mark counts as applied only when EVERY selected format-capable char has
  // it — a partially-marked selection reads as "not applied", so the next
  // press completes it (same reading toggleFormat uses).
  const applied = claimed.map(({ type }) =>
    segments.every((seg) => {
      const block = state.document.page.blocks[seg.blockIndex];
      return (
        isTextualBlock(block) &&
        allCharsHaveFormat(
          block.charRuns,
          block.formats,
          seg.from,
          seg.to,
          type,
        )
      );
    }),
  );

  const value = applied.reduce((acc, has, i) => acc + (has ? 1 << i : 0), 0);
  const next = (value + 1) % (1 << claimed.length);

  const ops: Operation[] = [];
  let pageAcc = state.document.page;
  for (let i = 0; i < claimed.length; i++) {
    const want = (next & (1 << i)) !== 0;
    if (want === applied[i]) continue;
    for (const seg of segments) {
      const { newPage, op } = markCharsInRange(
        pageAcc,
        seg.blockId,
        seg.from,
        seg.to,
        { type: claimed[i].type },
        want,
        state.CRDTbinding,
      );
      invalidateBlockCache(newPage.blocks[seg.blockIndex]);
      pageAcc = newPage;
      ops.push(op);
    }
  }

  // Mark ops move no characters, so the selection stays valid as-is — kept
  // deliberately, so pressing the delimiter again advances the cycle.
  return {
    state: { ...state, document: { ...state.document, page: pageAcc } },
    ops,
  };
}

/**
 * The `[from, to)` slice of each selected block that can carry formats.
 * Preformatted blocks (code) are verbatim source and are skipped; a selection
 * living entirely inside them yields no segments, letting the literal pair
 * fallback (or plain replace) handle the keystroke instead.
 */
function formatableSegments(
  state: EditorState,
  start: Position,
  end: Position,
): FormatSegment[] {
  const segments: FormatSegment[] = [];
  for (let i = start.blockIndex; i <= end.blockIndex; i++) {
    const block = state.document.page.blocks[i];
    if (!block || block.deleted) continue;
    if (!isTextualBlock(block) || !canHaveFormats(block.type)) continue;
    const from = i === start.blockIndex ? start.textIndex : 0;
    const to =
      i === end.blockIndex ? end.textIndex : getVisibleLength(block.charRuns);
    if (from < to)
      segments.push({ blockIndex: i, blockId: block.id, from, to });
  }
  return segments;
}

/**
 * Literally enclose the selection in a bracket/quote pair and re-select the
 * original content (caret at the focus end), VS Code's auto-surround. The
 * closer is inserted first so the opener's insertion can't shift its offset
 * when both ends share a block. Each delimiter is first offered to the
 * node/mark typed-input seam at its landing position — the same rewrite the
 * plain typing path applies — so content with its own source syntax stays
 * well-formed (math rewrites a brace to its literal `\{`/`\}` instead of an
 * invisible grouping token). A swallowed delimiter (empty rewrite) falls back
 * to the raw char: auto-surround inserts what was typed, it never deletes.
 */
function wrapWithPair(
  state: EditorState,
  start: Position,
  end: Position,
  open: string,
): ActionResult | null {
  const close = SURROUND_PAIRS[open];
  if (!close) return null;

  const page = state.document.page;
  const startBlock = page.blocks[start.blockIndex];
  const endBlock = page.blocks[end.blockIndex];
  if (!startBlock || startBlock.deleted || !isTextualBlock(startBlock))
    return null;
  if (!endBlock || endBlock.deleted || !isTextualBlock(endBlock)) return null;

  const openText =
    transformTypedInput(state, startBlock, start.textIndex, open)?.input ||
    open;
  const closeText =
    transformTypedInput(state, endBlock, end.textIndex, close)?.input || close;

  const ops: Operation[] = [];
  const closeIns = insertCharsAtPosition(
    page,
    endBlock.id,
    end.textIndex,
    closeText,
    state.CRDTbinding,
  );
  ops.push(closeIns.op);
  const openIns = insertCharsAtPosition(
    closeIns.newPage,
    startBlock.id,
    start.textIndex,
    openText,
    state.CRDTbinding,
  );
  ops.push(openIns.op);
  const pageAcc = openIns.newPage;
  invalidateBlockCache(pageAcc.blocks[start.blockIndex]);
  if (end.blockIndex !== start.blockIndex)
    invalidateBlockCache(pageAcc.blocks[end.blockIndex]);

  // Re-select the original content, shifted past the opener where the opener
  // landed in the same block, preserving the selection's direction.
  const newStart: Position = {
    blockIndex: start.blockIndex,
    textIndex: start.textIndex + openText.length,
  };
  const newEnd: Position = {
    blockIndex: end.blockIndex,
    textIndex:
      end.blockIndex === start.blockIndex
        ? end.textIndex + openText.length
        : end.textIndex,
  };
  const isForward = state.document.selection?.isForward ?? true;
  const newAnchor = isForward ? newStart : newEnd;
  const newFocus = isForward ? newEnd : newStart;

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: pageAcc },
  };
  newState = updateSelection(newState, { anchor: newAnchor, focus: newFocus });
  newState = moveCursorToPosition(
    newState,
    newFocus.blockIndex,
    newFocus.textIndex,
    true,
  );
  return { state: newState, ops };
}
