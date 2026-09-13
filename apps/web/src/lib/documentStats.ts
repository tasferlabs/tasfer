import {
  isContentSelectionCollapsed,
  type Block,
  type ContentSelection,
  type DocRange,
  type Editor,
} from "@tasfer/editor";
import type { TextualBlock } from "@tasfer/editor/internal";
import {
  blockTextFields,
  getVisibleTextFromRuns,
  isTextualBlock,
} from "@tasfer/editor/internal";
import { appDataSchema } from "@/appDataSchema";

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
 * Aggregate the statistics over one text fragment per counted paragraph, plus
 * `snippets` — text that is not a paragraph of its own (a table's cells): its
 * words and characters count, and a sentence only where one actually ends.
 */
function statsFromTexts(
  texts: string[],
  snippets: string[] = [],
): DocumentStats {
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
  for (const text of snippets) {
    words += countWords(text);
    characters += [...text].length;
    charactersNoSpaces += [...text.replace(/\s/g, "")].length;
    sentences += text.match(SENTENCE_TERMINATORS)?.length ?? 0;
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
 * Compute reader-facing statistics for a document. Visible text from textual,
 * non-deleted blocks counts, and so does prose kept inside structured content
 * (a table's cells); other non-text blocks (image, math, horizontal rule)
 * contribute nothing.
 */
export function computeDocumentStats(blocks: Block[]): DocumentStats {
  const cells = blocks.flatMap((block) =>
    blockTextFields(block, appDataSchema).map((field) => field.text),
  );
  return statsFromTexts(blocks.map(visibleText), cells);
}

/**
 * A selection resolved to block ids and offsets — the shape
 * `editor.state.selection.range` takes while text is selected.
 */
export interface RangeSelectionSpan {
  from: { block: string; offset: number };
  to: { block: string; offset: number };
}

/**
 * A selection held inside a block's structured prose (text in a table cell),
 * carried as the text it covers — `editor.query.selectedText()`, so a range
 * over several cells arrives tab- and newline-separated.
 */
export interface ContentSelectionText {
  text: string;
}

/** What the statistics follow while something is selected. */
export type SelectionSpan = RangeSelectionSpan | ContentSelectionText;

/**
 * Narrow the editor's `DocRange` to a span that covers text, or `null` when it
 * covers none: a bare caret, an unresolved range, or a zero-width one (an image
 * or other atomic block held as a node selection). Callers treat `null` as "no
 * selection" and fall back to whole-document statistics.
 */
export function selectionSpanFromRange(
  range: DocRange | null | undefined,
): RangeSelectionSpan | null {
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
 * The selection held inside a block's structured prose (text in table cells),
 * or `null` when there is none. Only content that keeps prose fields counts —
 * the same content {@link computeDocumentStats} counts — so a selection inside
 * an equation's source still reports the whole document rather than LaTeX.
 */
export function contentSelectionSpan(editor: {
  readonly state: { readonly contentSelection: ContentSelection | null };
  readonly query: Pick<Editor["query"], "textFields" | "selectedText">;
}): ContentSelectionText | null {
  const selection = editor.state.contentSelection;
  if (!selection || isContentSelectionCollapsed(selection)) return null;
  if (editor.query.textFields(selection.focus.blockId).length === 0) {
    return null;
  }
  const text = editor.query.selectedText();
  return text ? { text } : null;
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
  // Cell text counts the way the document count treats it: words and
  // characters, but no paragraphs of its own.
  if ("text" in span) return statsFromTexts([], span.text.split(/[\t\n]/));

  const start = blocks.findIndex((block) => block.id === span.from.block);
  const end = blocks.findIndex((block) => block.id === span.to.block);
  // A stale span — the blocks it names have been edited away — counts nothing
  // rather than silently reporting the whole document.
  if (start === -1 || end === -1 || end < start) return statsFromTexts([]);

  const texts: string[] = [];
  const cells: string[] = [];
  for (let i = start; i <= end; i++) {
    const text = visibleText(blocks[i]);
    texts.push(
      text.slice(
        i === start ? span.from.offset : 0,
        i === end ? span.to.offset : undefined,
      ),
    );
    // A block the range passes over whole (a table) brings its cells along.
    if (i !== start && i !== end) {
      const block = blocks[i];
      if (block) {
        for (const field of blockTextFields(block, appDataSchema)) {
          cells.push(field.text);
        }
      }
    }
  }
  return statsFromTexts(texts, cells);
}

/** Convenience wrapper for callers that only need the word count. */
export function countWordsFromBlocks(blocks: Block[]): number {
  return computeDocumentStats(blocks).words;
}
