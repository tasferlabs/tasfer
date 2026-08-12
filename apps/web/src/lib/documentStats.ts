import { type Block, type DocRange } from "@tasfer/editor";
import type { TextualBlock } from "@tasfer/editor/internal";
import { getVisibleTextFromRuns, isTextualBlock } from "@tasfer/editor/internal";

// CJK (Chinese, Japanese, Korean) character ranges. Each such character is
// counted as its own word/concept rather than being space-delimited.
const CJK_REGEX =
  /[一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯]/g;

// Sentence terminators for both Latin (. ! ? …) and CJK (。！？) scripts.
const SENTENCE_TERMINATORS = /[.!?。！？…]+/g;

// Average adult silent reading speed (words per minute) used to estimate
// reading time. A widely cited middle-of-the-road figure.
const WORDS_PER_MINUTE = 200;

export interface DocumentStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  sentences: number;
  paragraphs: number;
  /** Estimated reading time in whole minutes (minimum 1 for any content). */
  readingTimeMinutes: number;
}

/** Count words in a single string, treating each CJK character as one word. */
function countWords(text: string): number {
  let count = 0;

  const cjkMatches = text.match(CJK_REGEX);
  if (cjkMatches) count += cjkMatches.length;

  const words = text
    .replace(CJK_REGEX, "")
    .split(/\s+/)
    // Strip leading/trailing punctuation so tokens like "word," count once.
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word.length > 0);
  count += words.length;

  return count;
}

/** Count sentences in a single block's text (a non-empty block is >= 1). */
function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const matches = trimmed.match(SENTENCE_TERMINATORS);
  return Math.max(1, matches ? matches.length : 0);
}

/** Aggregate the statistics over one text fragment per counted paragraph. */
function statsFromTexts(texts: string[]): DocumentStats {
  let words = 0;
  let characters = 0;
  let charactersNoSpaces = 0;
  let sentences = 0;
  let paragraphs = 0;

  for (const text of texts) {
    words += countWords(text);
    characters += [...text].length;
    charactersNoSpaces += [...text.replace(/\s/g, "")].length;
    sentences += countSentences(text);
    if (text.trim().length > 0) paragraphs += 1;
  }

  const readingTimeMinutes = words > 0 ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0;

  return {
    words,
    characters,
    charactersNoSpaces,
    sentences,
    paragraphs,
    readingTimeMinutes,
  };
}

/** Visible text of a block, or "" for non-textual and tombstoned blocks. */
function visibleText(block: Block | undefined): string {
  if (!block || !isTextualBlock(block) || block.deleted) return "";
  return getVisibleTextFromRuns((block as TextualBlock).charRuns);
}

/**
 * Compute reader-facing statistics for a document. Only visible text from
 * textual, non-deleted blocks is considered; non-text blocks (image, math,
 * horizontal rule) contribute nothing.
 */
export function computeDocumentStats(blocks: Block[]): DocumentStats {
  return statsFromTexts(blocks.map(visibleText));
}

/**
 * A selection resolved to block ids and offsets — the shape
 * `editor.state.selection.range` takes while text is selected.
 */
export interface SelectionSpan {
  from: { block: string; offset: number };
  to: { block: string; offset: number };
}

/**
 * Narrow the editor's `DocRange` to a span that covers text, or `null` when it
 * covers none: a bare caret, an unresolved range, or a zero-width one (an image
 * or other atomic block held as a node selection). Callers treat `null` as "no
 * selection" and fall back to whole-document statistics.
 */
export function selectionSpanFromRange(
  range: DocRange | null | undefined,
): SelectionSpan | null {
  if (!range || typeof range !== "object" || !("from" in range)) return null;
  const { from, to } = range;
  if (typeof from !== "object" || typeof to !== "object") return null;
  if (!("offset" in from) || !("offset" in to)) return null;
  if (from.offset === undefined || to.offset === undefined) return null;
  if (from.block === to.block && from.offset === to.offset) return null;
  return {
    from: { block: from.block, offset: from.offset },
    to: { block: to.block, offset: to.offset },
  };
}

/**
 * Statistics for the text inside `span` only. The first and last block
 * contribute their selected slice; blocks between them contribute in full.
 * Offsets are UTF-16 indices into a block's visible text, the same units the
 * engine's selection speaks (see packages/editor/src/code-points.ts).
 */
export function computeSelectionStats(
  blocks: Block[],
  span: SelectionSpan,
): DocumentStats {
  const start = blocks.findIndex((block) => block.id === span.from.block);
  const end = blocks.findIndex((block) => block.id === span.to.block);
  // A stale span — the blocks it names have been edited away — counts nothing
  // rather than silently reporting the whole document.
  if (start === -1 || end === -1 || end < start) return statsFromTexts([]);

  const texts: string[] = [];
  for (let i = start; i <= end; i++) {
    const text = visibleText(blocks[i]);
    texts.push(
      text.slice(
        i === start ? span.from.offset : 0,
        i === end ? span.to.offset : undefined,
      ),
    );
  }
  return statsFromTexts(texts);
}

/** Convenience wrapper for callers that only need the word count. */
export function countWordsFromBlocks(blocks: Block[]): number {
  return computeDocumentStats(blocks).words;
}
