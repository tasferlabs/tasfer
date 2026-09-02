/**
 * `REPLACE_WORD` — swap a misspelled word for a suggestion as ONE undo step,
 * keeping the word's formatting.
 *
 * Why not a plain `insertText` over the word: replacing an explicit range
 * inserts BARE characters — the core neither copies the replaced run's marks
 * nor applies the caret's pending format. A bold or linked word would lose its
 * mark. Two measures keep it:
 *   1. minimal diff — only the changed middle of the word is replaced (common
 *      prefix/suffix stripped), so most fixes land strictly inside the run
 *      and inherit nothing because nothing at the edges moved;
 *   2. when the diff does touch the first or last character, every mark that
 *      covered the WHOLE word (read beforehand with `editor.query.marks`) is
 *      re-applied over the new word in the same `change()`.
 *
 * The action is a `MutationAction`, so hosts and native shells can
 * `editor.dispatch(REPLACE_WORD, payload)` by reference, observers can join the
 * transaction, and undo restores everything in one step. A mutator only sees
 * the `ChangeApi`, so the payload carries the old `word` (for the diff) and
 * the `marks` to re-apply; {@link replaceWord} gathers both from the editor.
 */

import type { FlagRef } from "./checker";
import type {
  ChangeApi,
  Editor,
  MutationAction,
  StoredMark,
} from "@tasfer/editor";
import { action } from "@tasfer/editor";

export interface ReplaceWordPayload {
  readonly block: string;
  /** Visible offsets of the word being replaced (`to` exclusive). */
  readonly from: number;
  readonly to: number;
  /** The replacement. */
  readonly text: string;
  /**
   * The word currently at `[from, to)`. Enables the minimal-diff replacement;
   * without it the whole range is replaced.
   */
  readonly word?: string;
  /** Marks covering the whole word, re-applied when the diff touches an edge. */
  readonly marks?: readonly StoredMark[];
}

/** A checker-shaped hook `replaceWord` calls to re-check the edited block. */
export interface RecheckHook {
  recheck(blockId: string): void;
  currentRange?(f: FlagRef): { from: number; to: number } | null;
}

export const REPLACE_WORD: MutationAction<ReplaceWordPayload> =
  action<ReplaceWordPayload>("spell:replaceWord", (c, p) => {
    replaceWordMutation(c, p);
  });

function replaceWordMutation(c: ChangeApi, p: ReplaceWordPayload): void {
  const { block, from, to, text } = p;
  if (to < from) return;
  const old = p.word ?? null;
  let prefix = 0;
  let suffix = 0;
  if (old !== null && old.length === to - from) {
    prefix = commonPrefix(old, text);
    suffix = commonSuffix(old, text, prefix);
  }
  const midFrom = from + prefix;
  const midTo = to - suffix;
  const midText = text.slice(prefix, text.length - suffix);
  const changed = midFrom !== midTo || midText.length > 0;
  const touchesEdge = prefix === 0 || suffix === 0;
  const marks = touchesEdge ? (p.marks ?? []) : [];

  if (changed) {
    const range = {
      from: { block, offset: midFrom },
      to: { block, offset: midTo },
    };
    if (midText.length === 0) {
      c.deleteRange(range);
    } else {
      // The first mark rides insertText itself; any further marks are applied
      // over the new word below (insertText accepts a single mark).
      c.insertText(midText, range, marks[0]);
    }
  }
  const newTo = from + text.length;
  if (newTo > from) {
    for (let i = changed && midText.length > 0 ? 1 : 0; i < marks.length; i++) {
      const m = marks[i];
      c.setMark(m.type, {
        active: true,
        ...(m.attrs ? { attrs: m.attrs } : {}),
        range: { from: { block, offset: from }, to: { block, offset: newTo } },
      });
    }
  }
  c.select({ block, offset: newTo });
}

/**
 * Replace the word a flag points at with `text`, in one undoable step, keeping
 * its formatting, and land the caret after it. Returns `false` (and changes
 * nothing) when the word is no longer where the flag says. Pass the checker
 * (or anything with `recheck`) to re-check the block immediately.
 */
export function replaceWord(
  editor: Editor,
  f: FlagRef,
  text: string,
  checker?: RecheckHook,
): boolean {
  const block = editor.query.block({ block: f.blockId });
  if (!block) return false;
  const span = locateWord(block.text, f, checker);
  if (!span) return false;
  const { from, to } = span;

  const marks: StoredMark[] = editor.query
    .marks({
      from: { block: f.blockId, offset: from },
      to: { block: f.blockId, offset: to },
    })
    .filter((m) => m.from <= from && m.to >= to)
    .map((m) =>
      Object.keys(m.attrs).length > 0
        ? { type: m.name, attrs: m.attrs }
        : { type: m.name },
    );

  const changed = editor.dispatch(REPLACE_WORD, {
    block: f.blockId,
    from,
    to,
    text,
    word: f.word,
    marks,
  });
  if (changed) checker?.recheck(f.blockId);
  return changed;
}

/**
 * Where the flag's word currently sits: the live anchors when a checker can
 * resolve them, else the occurrence of the word nearest the flag's original
 * offset. `null` when the word is gone.
 */
function locateWord(
  text: string,
  f: FlagRef,
  checker?: RecheckHook,
): { from: number; to: number } | null {
  const live = checker?.currentRange?.(f);
  if (live && text.slice(live.from, live.to) === f.word) return live;
  if (text.slice(f.from, f.to) === f.word) return { from: f.from, to: f.to };
  let best: number | null = null;
  let at = text.indexOf(f.word);
  while (at !== -1) {
    if (best === null || Math.abs(at - f.from) < Math.abs(best - f.from)) {
      best = at;
    }
    at = text.indexOf(f.word, at + 1);
  }
  return best === null ? null : { from: best, to: best + f.word.length };
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  // Never split a surrogate pair.
  if (i > 0 && isHighSurrogate(a.charCodeAt(i - 1))) i--;
  return i;
}

function commonSuffix(a: string, b: string, prefix: number): number {
  const n = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (
    i < n &&
    a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)
  ) {
    i++;
  }
  if (i > 0 && isLowSurrogate(a.charCodeAt(a.length - i))) i--;
  return i;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
