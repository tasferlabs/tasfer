import { type Block } from "@tasfer/editor";
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

/**
 * Compute reader-facing statistics for a document. Only visible text from
 * textual, non-deleted blocks is considered; non-text blocks (image, math,
 * horizontal rule) contribute nothing.
 */
export function computeDocumentStats(blocks: Block[]): DocumentStats {
  let words = 0;
  let characters = 0;
  let charactersNoSpaces = 0;
  let sentences = 0;
  let paragraphs = 0;

  for (const block of blocks) {
    if (!isTextualBlock(block)) continue;
    if (block.deleted) continue;

    const text = getVisibleTextFromRuns((block as TextualBlock).charRuns);

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

/** Convenience wrapper for callers that only need the word count. */
export function countWordsFromBlocks(blocks: Block[]): number {
  return computeDocumentStats(blocks).words;
}
