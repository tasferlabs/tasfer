import { deleteSelectedText, getSelectionRange } from "../actions/actions";
import { invalidateBlockCache } from "../rendering/renderer";
import { clearSelection, moveCursorToPosition } from "../selection";
import { serializeToHTMLFragment } from "../serlization/htmlSerializer";
import type {
  Block,
  Char,
  CharRun,
  Mark,
  MarkSpan,
  Page,
} from "../serlization/loadPage";
import { loadPage } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import { serializeToText } from "../serlization/textSerializer";
import type {
  ActionResult,
  CRDTbinding,
  EditorState,
  Position,
} from "../state-types";
import type {
  BlockInsert,
  BlockSet,
  MarkSet,
  Operation,
  TextInsert,
} from "../state-types";
import { getBlockTextLength } from "../state-utils";
import { findBlock } from "../sync/block-lookup";
import {
  getBlockDescriptor,
  getBlockFieldNames,
  isTextualBlock,
} from "../sync/block-registry";
import {
  charRunsToChars,
  charsToRuns,
  getVisibleTextFromRuns,
  iterateVisibleChars,
} from "../sync/char-runs";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "../sync/crdt-utils";
import { createIdGenerator, generateBlockId } from "../sync/id";
import { applyOps } from "../sync/reducer";
import { createMarkdownContent } from "defuddle/full";

function globalGenerateBlockId(binding: CRDTbinding): string {
  return generateBlockId(binding.nextId);
}

/**
 * Ops to recreate a non-textual (atomic) block — image, line, math, or any
 * custom void type — at a new position: one `block_insert` plus a `block_set`
 * per declared field that carries a value. The field set comes from the type's
 * own descriptor (the same field-driven path `inverse.ts` uses to build a
 * `block_insert`'s `initialProps`), so paste round-trips any atomic block type
 * with no per-type code here — that's what lets a block type be added to the
 * editor without editing this file.
 */
export function atomicBlockInsertOps(
  block: Block,
  newBlockId: string,
  afterBlockId: string | null,
  binding: CRDTbinding,
): Operation[] {
  const ops: Operation[] = [
    {
      op: "block_insert",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      afterBlockId,
      blockId: newBlockId,
      blockType: block.type,
    },
  ];

  const descriptor = getBlockDescriptor(block.type);
  if (!descriptor) return ops;
  for (const field of getBlockFieldNames(block.type)) {
    if (field === "type") continue;
    const value = descriptor.fields[field].extractForInverse(block);
    if (value === undefined) continue;
    ops.push({
      op: "block_set",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      blockId: newBlockId,
      field,
      value,
    } as BlockSet);
  }

  return ops;
}

/**
 * Emit `block_set` ops for every declared, non-type field of `block` onto an
 * already-inserted block (`blockId`). Descriptor-driven, so a new block type's
 * fields sync on paste with no edit here — replaces per-type "set indent / set
 * checked" branches. Fields whose value is `undefined` (genuinely unset, e.g.
 * an image with no explicit width) are skipped.
 */
function pushBlockFieldOps(
  block: Block,
  blockId: string,
  binding: CRDTbinding,
  ops: Operation[],
): void {
  const descriptor = getBlockDescriptor(block.type);
  if (!descriptor) return;
  for (const field of getBlockFieldNames(block.type)) {
    if (field === "type") continue;
    const value = descriptor.fields[field].extractForInverse(block);
    if (value === undefined) continue;
    ops.push({
      op: "block_set",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      blockId,
      field,
      value,
    } as BlockSet);
  }
}

/**
 * URL regex for detecting links in pasted text.
 */
const URL_REGEX_GLOBAL = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+\.[^\s<>"']+/gi;

/**
 * Detect all URLs in a text range and apply link formatting.
 * Used after pasting to auto-link any URLs in the pasted content.
 */
function autoLinkInRange(
  page: Page,
  blockId: string,
  text: string,
  rangeStart: number,
  rangeEnd: number,
  binding: CRDTbinding,
): { newPage: Page; ops: Operation[] } {
  // `mark_set` ops applied below only append link spans — they never
  // mutate charRuns. So the block's charRuns and the (link-)format spans we
  // need to check are stable across the URL loop; only the accumulated link
  // ops we ourselves emit need to be considered. Hoist the initial lookup
  // out of the loop and track newly-added links locally.
  const initialBlock = findBlock(page, blockId);
  if (!initialBlock || !isTextualBlock(initialBlock)) {
    return { newPage: page, ops: [] };
  }
  const charRuns = initialBlock.charRuns;
  const existingLinkSpans = initialBlock.formats.filter(
    (s) => s.format.type === "link",
  );

  const rangeText = text.slice(rangeStart, rangeEnd);
  const ops: Operation[] = [];
  let pageAcc = page;
  const newLinkRanges: Array<{ start: number; end: number }> = [];

  URL_REGEX_GLOBAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_REGEX_GLOBAL.exec(rangeText)) !== null) {
    const urlText = match[0].replace(/[.,;:!?)]+$/, "");
    const start = rangeStart + match.index;
    const end = start + urlText.length;

    let url = urlText;
    if (url.startsWith("www.")) {
      url = "https://" + url;
    }

    // Check if already formatted as link — either by a pre-existing span,
    // or by an auto-link we emitted earlier in this same loop.
    let alreadyLinked = newLinkRanges.some(
      (r) => r.start < end && r.end > start,
    );
    if (!alreadyLinked) {
      for (const span of existingLinkSpans) {
        let inSpan = false;
        let spanStart = -1;
        let spanEnd = -1;
        let idx = 0;
        for (const { id } of iterateVisibleChars(charRuns)) {
          if (id === span.startCharId) {
            inSpan = true;
            spanStart = idx;
          }
          if (inSpan) spanEnd = idx + 1;
          if (id === span.endCharId) break;
          idx++;
        }
        if (spanStart !== -1 && spanStart < end && spanEnd > start) {
          alreadyLinked = true;
          break;
        }
      }
    }

    if (!alreadyLinked) {
      const { newPage, op } = markCharsInRange(
        pageAcc,
        blockId,
        start,
        end,
        { type: "link", attrs: { url } },
        true,
        binding,
      );
      pageAcc = newPage;
      ops.push(op);
      newLinkRanges.push({ start, end });
    }
  }

  return { newPage: pageAcc, ops };
}

/**
 * Get the selected content from the editor state
 */
function getSelectedContent(state: EditorState): {
  blocks: Block[];
  isPartial: boolean;
  start: Position;
  end: Position;
} | null {
  const range = getSelectionRange(state);
  if (!range) return null;

  const { start, end } = range;

  // If selection is in a single block
  if (start.blockIndex === end.blockIndex) {
    const block = state.document.page.blocks[start.blockIndex];
    if (!block || block.deleted) return null;
    const textLength = getBlockTextLength(block);

    if (!isTextualBlock(block)) {
      return {
        blocks: [block],
        isPartial: false,
        start,
        end,
      };
    }

    // Extract the selected portion of chars and formats
    const selectedChars = extractCharsInRange(
      block.charRuns,
      start.textIndex,
      end.textIndex,
    );
    const selectedFormats = extractFormatsForChars(
      block.formats,
      selectedChars,
      block.charRuns,
    );

    const partialBlock: Block = {
      ...block,
      charRuns: charsToRuns(selectedChars),
      formats: selectedFormats,
    };

    return {
      blocks: [partialBlock],
      isPartial: start.textIndex > 0 || end.textIndex < textLength,
      start,
      end,
    };
  }

  // Multi-block selection
  const blocks: Block[] = [];

  for (let i = start.blockIndex; i <= end.blockIndex; i++) {
    const block = state.document.page.blocks[i];
    if (!block || block.deleted) continue;
    const textLength = getBlockTextLength(block);

    if (!isTextualBlock(block)) {
      blocks.push(block);
      continue;
    }

    let charRuns = block.charRuns;
    let formats = block.formats;

    if (i === start.blockIndex) {
      // First block - cut from start position
      const chars = extractCharsInRange(
        block.charRuns,
        start.textIndex,
        textLength,
      );
      charRuns = charsToRuns(chars);
      formats = extractFormatsForChars(block.formats, chars, block.charRuns);
    } else if (i === end.blockIndex) {
      // Last block - cut to end position
      const chars = extractCharsInRange(block.charRuns, 0, end.textIndex);
      charRuns = charsToRuns(chars);
      formats = extractFormatsForChars(block.formats, chars, block.charRuns);
    }
    // Middle blocks - include full content

    const newBlock: Block = {
      ...block,
      charRuns,
      formats,
    };

    blocks.push(newBlock);
  }

  return {
    blocks,
    isPartial: true,
    start,
    end,
  };
}

/**
 * Extract chars in a visible range (accounting for deleted chars)
 * Returns Char[] for compatibility with existing code
 */
function extractCharsInRange(
  charRuns: CharRun[],
  startIndex: number,
  endIndex: number,
): Char[] {
  const result: Char[] = [];
  let visibleCount = 0;

  for (const { id, char } of iterateVisibleChars(charRuns)) {
    if (visibleCount >= startIndex && visibleCount < endIndex) {
      result.push({ id, char, deleted: false });
    }
    visibleCount++;
    if (visibleCount >= endIndex) break;
  }

  return result;
}

/**
 * Extract format spans that apply to the given chars
 */
function extractFormatsForChars(
  formats: MarkSpan[],
  extractedChars: Char[],
  originalCharRuns: CharRun[],
): MarkSpan[] {
  if (extractedChars.length === 0) return [];

  const charIdSet = new Set(extractedChars.map((c) => c.id));
  const result: MarkSpan[] = [];

  // Build a map of char ID to index for original charRuns
  const originalCharMap = new Map<string, number>();
  let index = 0;
  for (const { id } of iterateVisibleChars(originalCharRuns)) {
    originalCharMap.set(id, index);
    index++;
  }

  for (const span of formats) {
    // Check if this span overlaps with extracted chars
    const startIdx = originalCharMap.get(span.startCharId);
    const endIdx = originalCharMap.get(span.endCharId);

    if (startIdx === undefined || endIdx === undefined) continue;

    // Find intersection with extracted chars
    let newStartCharId: string | null = null;
    let newEndCharId: string | null = null;

    let currentIdx = 0;
    for (const { id } of iterateVisibleChars(originalCharRuns)) {
      if (currentIdx >= startIdx && currentIdx <= endIdx) {
        if (charIdSet.has(id)) {
          if (!newStartCharId) newStartCharId = id;
          newEndCharId = id;
        }
      }
      currentIdx++;
      if (currentIdx > endIdx) break;
    }

    if (newStartCharId && newEndCharId) {
      result.push({
        ...span,
        startCharId: newStartCharId,
        endCharId: newEndCharId,
      });
    }
  }

  return result;
}

/**
 * Convert blocks to plain text. Dispatches through the registry — each block's
 * `outputText` lives on its node — rather than switching on block type here.
 * Feeds the accessibility input mirror (`getSelectionPlainText`); the rich
 * copy/cut payloads are markdown + HTML, not this.
 */
function blocksToPlainText(blocks: Block[]): string {
  return serializeToText(blocks);
}

/**
 * Convert blocks to markdown with formatting
 */
function blocksToMarkdown(blocks: Block[]): string {
  // Use the proper serializer that handles inline formatting
  return serializeToMarkdown(blocks);
}

/**
 * Leading marker on a Cypher-originated clipboard `text/html` payload. It is an
 * HTML comment (invisible to external apps, which just render the fragment that
 * follows) carrying the base64'd canonical Markdown of the selection. On paste
 * back into Cypher, `parseHTMLToBlocks` decodes this instead of round-tripping
 * the rendered HTML through defuddle — which is lossy for image sizing, block
 * math, list nesting, etc. base64 keeps the payload free of any `-->`.
 */
const CYPHER_CLIPBOARD_MARKER_RE =
  /^\s*<!--cypher-clipboard:([A-Za-z0-9+/=]+)-->/;

function encodeClipboardMarkdown(markdown: string): string {
  const utf8 = new TextEncoder().encode(markdown);
  let binary = "";
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return `<!--cypher-clipboard:${btoa(binary)}-->`;
}

function decodeClipboardMarkdown(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Build the clipboard `text/html` payload. The visible markup is the node-owned
 * export fragment (each block's `html.output` — no per-block-type logic here);
 * it is prefixed with the Cypher-origin marker carrying `markdown` for lossless
 * internal paste.
 *
 * `preferSource` makes math serialize as its `$$…$$` / `$…$` LaTeX rather than a
 * rendered SVG: external apps prefer `text/html` over the plain-text flavor, so
 * without this a copied equation lands as a non-editable image. File export
 * (which wants the rendered formula) leaves the flag off.
 */
function blocksToHTML(blocks: Block[], markdown: string): string {
  return (
    encodeClipboardMarkdown(markdown) +
    serializeToHTMLFragment(blocks, { preferSource: true })
  );
}

/**
 * Build the clipboard representations of the current selection synchronously.
 * Returns `null` when there is no (non-empty) selection. Used both by the async
 * clipboard writers below and by the native `copy`/`cut` ClipboardEvent
 * handlers, which must call `setData` synchronously within the event.
 */
export function buildClipboardPayload(
  state: EditorState,
): { plainText: string; html: string; markdown: string } | null {
  const selectedContent = getSelectedContent(state);
  if (!selectedContent) return null;
  const { blocks } = selectedContent;
  if (blocks.length === 0) return null;
  const markdown = blocksToMarkdown(blocks);
  return {
    plainText: blocksToPlainText(blocks),
    html: blocksToHTML(blocks, markdown),
    markdown,
  };
}

/**
 * Plain text of the current selection (empty string when nothing is selected).
 * Used to mirror the selection into the accessible input surface so its text
 * matches exactly what a copy would produce.
 */
export function getSelectionPlainText(state: EditorState): string {
  const payload = buildClipboardPayload(state);
  return payload ? payload.plainText : "";
}

/**
 * Copy selected content to clipboard with formatting
 * Returns true if successful, false otherwise
 */
export async function copySelectionToClipboard(
  state: EditorState,
): Promise<boolean> {
  try {
    const payload = buildClipboardPayload(state);
    if (!payload) return false;

    const { markdown, html } = payload;

    if (navigator.clipboard && navigator.clipboard.write) {
      const clipboardItems = [
        new ClipboardItem({
          // text/plain carries the markdown (formatted) variant so the
          // markdown-aware paste path round-trips formatting when text/html
          // isn't used by the target.
          "text/plain": new Blob([markdown], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ];

      await navigator.clipboard.write(clipboardItems);
      return true;
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(markdown);
      return true;
    }

    return false;
  } catch (error) {
    console.error("Failed to copy to clipboard:", error);
    return false;
  }
}

export async function cutSelectionToClipboard(
  state: EditorState,
): Promise<{ success: boolean; result: ActionResult | null }> {
  try {
    const selectedContent = getSelectedContent(state);
    if (!selectedContent) return { success: false, result: null };

    const { blocks } = selectedContent;
    if (blocks.length === 0) return { success: false, result: null };

    let success = await copySelectionToClipboard(state);

    if (success) {
      const stateWithUndo = state;

      const result = deleteSelectedText(stateWithUndo);
      return { success: true, result };
    }

    return { success: false, result: null };
  } catch (error) {
    console.error("Failed to cut to clipboard:", error);
    return { success: false, result: null };
  }
}

/**
 * Convert text segments with formatting to chars and format spans
 */
function segmentsToCharsAndFormats(
  segments: Array<{ content: string; formats?: Mark[] }>,
): { chars: Char[]; formats: MarkSpan[] } {
  const chars: Char[] = [];
  const formats: MarkSpan[] = [];
  const idGen = createIdGenerator("clipboard");
  const clock = { counter: 0, peerId: "clipboard" };

  for (const segment of segments) {
    const startIdx = chars.length;

    // Create chars for this segment
    for (const char of segment.content) {
      chars.push({
        id: idGen(),
        char,
        deleted: false,
      });
    }

    const endIdx = chars.length - 1;

    // Create format spans for this segment
    if (segment.formats && segment.formats.length > 0 && startIdx <= endIdx) {
      for (const format of segment.formats) {
        formats.push({
          startCharId: chars[startIdx].id,
          endCharId: chars[endIdx].id,
          format,
          clock,
        });
      }
    }
  }

  return { chars, formats };
}

/**
 * Flatten block-level links into inline ones.
 *
 * When an `<a>` wraps block content (e.g. `<a href><h1>Title</h1></a>`, common
 * for card/teaser links), Turndown — via defuddle — emits multi-line Markdown:
 *
 *   [\n\n# Title\n\n](https://example.com)
 *
 * That isn't a valid inline link (an inline link can't span a blank line), so
 * Cypher's block model can't represent it and it renders as a literal `[`, a
 * heading, then `](url)`. We collapse such constructs into a single inline link
 * — `# [Title](https://example.com)` — preserving a leading heading level when
 * the wrapped content was a heading, and joining any other inner lines into the
 * link's visible text.
 */
export function flattenBlockLevelLinks(markdown: string): string {
  return markdown.replace(
    /\[[ \t]*\n+([\s\S]*?)\n+[ \t]*\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g,
    (_match, inner: string, url: string) => {
      const lines = inner.split("\n").map((l) => l.trim());
      const firstNonEmpty = lines.find((l) => l !== "") ?? "";
      const headingMatch = firstNonEmpty.match(/^(#{1,6})\s+/);
      const headingPrefix = headingMatch ? `${headingMatch[1]} ` : "";
      const text = lines
        .map((l) =>
          l
            .replace(/^#{1,6}\s+/, "") // heading marker
            .replace(/^>\s?/, "") // blockquote
            .replace(/^(?:[-*+]|\d+[.)])\s+/, "") // list marker
            .trim(),
        )
        .filter(Boolean)
        .join(" ");
      if (!text) return `[](${url})`;
      return `${headingPrefix}[${text}](${url})`;
    },
  );
}

/**
 * Parse pasted HTML into blocks.
 *
 * Source HTML from the system clipboard (Google Docs, web pages, other
 * editors) is wildly inconsistent, so instead of walking the DOM ourselves we
 * let defuddle normalize it into clean Markdown, then run that Markdown through
 * the same parser the plain-text path uses. This keeps a single, well-tested
 * Markdown -> blocks pipeline and inherits defuddle's HTML cleanup.
 */
export function parseHTMLToBlocks(html: string, binding: CRDTbinding): Block[] {
  if (!html.trim()) return [];

  // Our own copies carry the canonical Markdown in a leading marker comment.
  // Reconstruct from it directly — lossless, and skips defuddle entirely —
  // rather than parsing the rendered (lossy) HTML.
  const marker = html.match(CYPHER_CLIPBOARD_MARKER_RE);
  if (marker) {
    try {
      return parsePlainTextToBlocks(
        decodeClipboardMarkdown(marker[1]),
        binding,
      );
    } catch (error) {
      console.error("Failed to decode Cypher clipboard payload:", error);
      // Fall through to generic HTML handling.
    }
  }

  let markdown: string;
  try {
    markdown = createMarkdownContent(html, "");
  } catch (error) {
    console.error("Failed to convert pasted HTML to Markdown:", error);
    return [];
  }

  markdown = flattenBlockLevelLinks(markdown);
  if (!markdown.trim()) return [];
  return parsePlainTextToBlocks(markdown, binding);
}

/**
 * Parse plain text into blocks
 * Respects markdown formatting including inline formats
 */
function parsePlainTextToBlocks(text: string, binding: CRDTbinding): Block[] {
  try {
    // Use the markdown parser to properly handle inline formatting
    const page = loadPage(text);
    return page.blocks;
  } catch (error) {
    console.error(
      "Failed to parse markdown, falling back to plain text:",
      error,
    );

    // Fallback: create simple blocks without formatting
    const blocks: Block[] = [];
    const lines = text.split("\n");

    for (const line of lines) {
      let block: Block;
      let blockType: "heading1" | "heading2" | "heading3" | "paragraph";
      let content: string;

      // Check for markdown-style headings
      if (line.startsWith("### ")) {
        blockType = "heading3";
        content = line.slice(4);
      } else if (line.startsWith("## ")) {
        blockType = "heading2";
        content = line.slice(3);
      } else if (line.startsWith("# ")) {
        blockType = "heading1";
        content = line.slice(2);
      } else {
        blockType = "paragraph";
        content = line;
      }

      const { chars, formats } = segmentsToCharsAndFormats([{ content }]);
      block = {
        id: globalGenerateBlockId(binding),
        type: blockType,
        charRuns: charsToRuns(chars),
        formats,
      };

      blocks.push(block);
    }

    return blocks;
  }
}

/**
 * Insert blocks at cursor position
 * If there's a selection, it will be deleted first
 * If no cursor is set, inserts at the end of the document
 */
function insertBlocksAtCursor(
  state: EditorState,
  blocks: Block[],
): ActionResult {
  if (blocks.length === 0) return { state, ops: [] };

  const ops: Operation[] = [];

  // Record undo state before modification
  let newState = state;

  // If there's a selection, delete it first
  if (newState.document.selection && !newState.document.selection.isCollapsed) {
    const deleteResult = deleteSelectedText(newState);
    newState = deleteResult.state;
    ops.push(...deleteResult.ops);
  }

  // If no cursor is set, default to the end of the document
  let blockIndex: number;
  let textIndex: number;

  if (!newState.document.cursor) {
    // Insert at the end of the last visible block
    const visibleBlocks = newState.view.visibleBlocks;
    if (visibleBlocks.length === 0) {
      // No visible blocks, create a default position
      blockIndex = 0;
      textIndex = 0;
    } else {
      const lastVisibleBlock = visibleBlocks[visibleBlocks.length - 1];
      const allBlocks = newState.document.page.blocks;
      const lastVisibleBlockIndex = allBlocks.findIndex(
        (b) => b.id === lastVisibleBlock.id,
      );
      blockIndex = lastVisibleBlockIndex !== -1 ? lastVisibleBlockIndex : 0;
      textIndex = getBlockTextLength(lastVisibleBlock);
    }
  } else {
    blockIndex = newState.document.cursor.position.blockIndex;
    textIndex = newState.document.cursor.position.textIndex;
  }

  // Ensure cursor position is valid
  if (blockIndex < 0 || blockIndex >= newState.document.page.blocks.length) {
    // Fallback to last visible block
    const visibleBlocks = newState.view.visibleBlocks;
    if (visibleBlocks.length === 0) {
      blockIndex = 0;
      textIndex = 0;
    } else {
      const lastVisibleBlock = visibleBlocks[visibleBlocks.length - 1];
      const allBlocks = newState.document.page.blocks;
      const lastVisibleBlockIndex = allBlocks.findIndex(
        (b) => b.id === lastVisibleBlock.id,
      );
      blockIndex = lastVisibleBlockIndex !== -1 ? lastVisibleBlockIndex : 0;
      textIndex = getBlockTextLength(lastVisibleBlock);
    }
  }
  const currentBlock = newState.document.page.blocks[blockIndex];

  // If pasting a single block
  if (blocks.length === 1) {
    // Pasting a single atomic block (image, line, math, or any custom void
    // type): insert it after the current block. Descriptor-driven via
    // `atomicBlockInsertOps`, so a new atomic type pastes for free with no
    // per-type code here.
    if (!isTextualBlock(blocks[0])) {
      const atomicBlock = blocks[0];
      const newBlockId = globalGenerateBlockId(state.CRDTbinding);
      const newAtomicBlock: Block = {
        ...atomicBlock,
        id: newBlockId,
        afterId: currentBlock.id,
      };
      invalidateBlockCache(newAtomicBlock);

      ops.push(
        ...atomicBlockInsertOps(
          atomicBlock,
          newBlockId,
          currentBlock.id,
          state.CRDTbinding,
        ),
      );

      // Insert the block after the current block
      const newBlocks = [
        ...newState.document.page.blocks.slice(0, blockIndex + 1),
        newAtomicBlock,
        ...newState.document.page.blocks.slice(blockIndex + 1),
      ];

      newState = {
        ...newState,
        document: {
          ...newState.document,
          page: { ...newState.document.page, blocks: newBlocks },
        },
      };

      // Move cursor to the block after the inserted atomic block
      newState = moveCursorToPosition(newState, blockIndex + 2, 0);

      return { state: clearSelection(newState), ops };
    }

    // Can't paste into non-text blocks
    if (!isTextualBlock(currentBlock)) {
      return { state, ops: [] };
    }

    const pasteBlock = blocks[0];
    const pasteText = getVisibleTextFromRuns(pasteBlock.charRuns);

    // Nothing to paste (e.g. an empty source block): keep any selection-delete
    // ops already collected and leave the caret in place — don't insert an empty
    // run or run the format/autolink passes over zero chars.
    if (pasteText.length === 0) {
      return { state: clearSelection(newState), ops };
    }

    // Insert the pasted text at cursor position
    const { newPage: pageAfterInsert, op: insertOp } = insertCharsAtPosition(
      newState.document.page,
      currentBlock.id,
      textIndex,
      pasteText,
      state.CRDTbinding,
    );
    ops.push(insertOp);

    // Apply formatting from pasted block (manual op construction since the
    // format spans are computed from the paste-block's existing char IDs,
    // not from index ranges).
    let pageAcc = pageAfterInsert;
    const pasteChars: Char[] = [];
    for (const { id, char } of iterateVisibleChars(pasteBlock.charRuns)) {
      pasteChars.push({ id, char, deleted: false });
    }

    const insertedChars = charRunsToChars(insertOp.charRuns);
    for (const pasteFormat of pasteBlock.formats) {
      const pasteStartIdx = pasteChars.findIndex(
        (c) => c.id === pasteFormat.startCharId,
      );
      const pasteEndIdx = pasteChars.findIndex(
        (c) => c.id === pasteFormat.endCharId,
      );

      if (pasteStartIdx !== -1 && pasteEndIdx !== -1) {
        const newStartCharId = insertedChars[pasteStartIdx]?.id;
        const newEndCharId = insertedChars[pasteEndIdx]?.id;

        if (newStartCharId && newEndCharId) {
          const charIds = insertedChars
            .slice(pasteStartIdx, pasteEndIdx + 1)
            .map((c) => c.id);
          const formatOp: MarkSet = {
            op: "mark_set",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: currentBlock.id,
            charIds,
            format: pasteFormat.format,
            value: true,
          };
          ops.push(formatOp);
          pageAcc = applyOps(pageAcc, [formatOp]);
        }
      }
    }

    // Auto-detect URLs in pasted text (only for portions not already link-formatted)
    const insertedBlock = pageAcc.blocks.find(
      (b: Block) => b.id === currentBlock.id,
    );
    const fullText =
      insertedBlock && isTextualBlock(insertedBlock)
        ? getVisibleTextFromRuns(insertedBlock.charRuns)
        : "";
    const autoLinkResult = autoLinkInRange(
      pageAcc,
      currentBlock.id,
      fullText,
      textIndex,
      textIndex + pasteText.length,
      state.CRDTbinding,
    );
    pageAcc = autoLinkResult.newPage;
    ops.push(...autoLinkResult.ops);

    invalidateBlockCache(pageAcc.blocks[blockIndex]);

    newState = {
      ...newState,
      document: { ...newState.document, page: pageAcc },
    };

    // Move cursor to end of pasted text
    newState = moveCursorToPosition(
      newState,
      blockIndex,
      textIndex + pasteText.length,
    );

    return { state: clearSelection(newState), ops };
  } else {
    // Pasting multiple blocks - split current block and insert pasted blocks
    if (!isTextualBlock(currentBlock)) {
      return { state, ops: [] };
    }

    const currentTextLength = getBlockTextLength(currentBlock);

    // Extract chars before and after cursor
    const beforeChars = extractCharsInRange(
      currentBlock.charRuns,
      0,
      textIndex,
    );
    const afterChars = extractCharsInRange(
      currentBlock.charRuns,
      textIndex,
      currentTextLength,
    );
    const beforeFormats = extractFormatsForChars(
      currentBlock.formats,
      beforeChars,
      currentBlock.charRuns,
    );
    const afterFormats = extractFormatsForChars(
      currentBlock.formats,
      afterChars,
      currentBlock.charRuns,
    );

    // Delete text after cursor in current block
    let pasteWorkPage = newState.document.page;
    if (textIndex < currentTextLength) {
      const { newPage: p, op: deleteOp } = deleteCharsInRange(
        pasteWorkPage,
        currentBlock.id,
        textIndex,
        currentTextLength,
        state.CRDTbinding,
      );
      pasteWorkPage = p;
      ops.push(deleteOp);
    }

    // Emit the ops to recreate a non-textual (atomic) block — image, line,
    // math, or any custom void type — at a new position. The per-field work is
    // descriptor-driven in `atomicBlockInsertOps`, so there is no per-type code
    // here: a new atomic block type round-trips through paste for free.
    const pushAtomicBlockOps = (
      block: Block,
      newBlockId: string,
      afterBlockId: string | null,
    ) => {
      ops.push(
        ...atomicBlockInsertOps(
          block,
          newBlockId,
          afterBlockId,
          state.CRDTbinding,
        ),
      );
    };

    const firstPastedBlock = blocks[0];
    const lastPastedBlock = blocks[blocks.length - 1];
    const resultBlocks: Block[] = [];
    let lastInsertedBlockId = currentBlock.id;

    // Spill any after-cursor content (the text that followed the paste point in
    // the current block) into a trailing paragraph anchored after `anchorId`.
    // Atomic blocks can't hold a caret/text, so when the last pasted block is
    // atomic this preserves the original tail. No-op when there's no live
    // after-content. Type-agnostic, so every atomic block type behaves the same.
    const appendTrailingParagraph = (anchorId: string) => {
      const visibleAfter = afterChars.filter((c) => !c.deleted);
      if (visibleAfter.length === 0) return;

      const afterBlockId = globalGenerateBlockId(state.CRDTbinding);
      const newAfterChars: Char[] = visibleAfter.map((c) => ({
        id: state.CRDTbinding.nextId(),
        char: c.char,
        deleted: false,
      }));

      const oldToNew = new Map<string, string>();
      visibleAfter.forEach((oldChar, idx) => {
        oldToNew.set(oldChar.id, newAfterChars[idx].id);
      });

      const newAfterFormats: MarkSpan[] = afterFormats
        .map((f) => {
          const newStartId = oldToNew.get(f.startCharId);
          const newEndId = oldToNew.get(f.endCharId);
          if (newStartId && newEndId) {
            return {
              ...f,
              startCharId: newStartId,
              endCharId: newEndId,
              clock: state.CRDTbinding.getClock(),
            };
          }
          return null;
        })
        .filter((f): f is MarkSpan => f !== null);

      const afterBlock: Block = {
        id: afterBlockId,
        afterId: anchorId,
        type: "paragraph",
        charRuns: charsToRuns(newAfterChars),
        formats: newAfterFormats,
      };
      invalidateBlockCache(afterBlock);

      const afterBlockInsertOp: BlockInsert = {
        op: "block_insert",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        afterBlockId: anchorId,
        blockId: afterBlockId,
        blockType: "paragraph",
      };
      ops.push(afterBlockInsertOp);

      const textInsertOp: TextInsert = {
        op: "text_insert",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: afterBlockId,
        afterCharId: null,
        charRuns: charsToRuns(newAfterChars),
      };
      ops.push(textInsertOp);

      for (const format of newAfterFormats) {
        const startIdx = newAfterChars.findIndex(
          (c) => c.id === format.startCharId,
        );
        const endIdx = newAfterChars.findIndex(
          (c) => c.id === format.endCharId,
        );
        if (startIdx !== -1 && endIdx !== -1) {
          const charIds = newAfterChars
            .slice(startIdx, endIdx + 1)
            .map((c) => c.id);
          const formatOp: MarkSet = {
            op: "mark_set",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: afterBlockId,
            charIds,
            format: format.format,
            value: true,
          };
          ops.push(formatOp);
        }
      }

      resultBlocks.push(afterBlock);
      lastInsertedBlockId = afterBlockId;
    };

    // Handle first block
    if (isTextualBlock(firstPastedBlock)) {
      // Merge first pasted block's content with current block
      const firstPastedText = getVisibleTextFromRuns(firstPastedBlock.charRuns);
      const beforeLength = beforeChars.filter((c) => !c.deleted).length;
      // Skip the insert when the first pasted block contributes no visible chars
      // (e.g. an empty source block) — inserting an empty run would throw in the
      // CRDT layer. The current block then just keeps its before-cursor content,
      // and the format pass below finds no inserted chars to map onto.
      let firstInsertedCharRuns: CharRun[] = [];
      if (firstPastedText.length > 0) {
        const { newPage: pageAfterFirstInsert, op: firstInsertOp } =
          insertCharsAtPosition(
            pasteWorkPage,
            currentBlock.id,
            beforeLength,
            firstPastedText,
            state.CRDTbinding,
          );
        pasteWorkPage = pageAfterFirstInsert;
        ops.push(firstInsertOp);
        firstInsertedCharRuns = firstInsertOp.charRuns;
      }
      const firstBlockInPage = pasteWorkPage.blocks.find(
        (b) => b.id === currentBlock.id,
      );
      const firstBlockCharRuns =
        firstBlockInPage && isTextualBlock(firstBlockInPage)
          ? firstBlockInPage.charRuns
          : [];

      // Apply formats from first pasted block to inserted chars
      let firstBlockFormats = beforeFormats;
      // Convert firstPastedBlock.charRuns to Char[] for finding indices
      const firstPasteChars: Char[] = [];
      for (const { id, char } of iterateVisibleChars(
        firstPastedBlock.charRuns,
      )) {
        firstPasteChars.push({ id, char, deleted: false });
      }
      for (const pasteFormat of firstPastedBlock.formats) {
        const pasteStartIdx = firstPasteChars.findIndex(
          (c) => c.id === pasteFormat.startCharId,
        );
        const pasteEndIdx = firstPasteChars.findIndex(
          (c) => c.id === pasteFormat.endCharId,
        );

        if (pasteStartIdx !== -1 && pasteEndIdx !== -1) {
          const insertedChars = charRunsToChars(firstInsertedCharRuns);
          const newStartCharId = insertedChars[pasteStartIdx]?.id;
          const newEndCharId = insertedChars[pasteEndIdx]?.id;

          if (newStartCharId && newEndCharId) {
            const newSpan: MarkSpan = {
              startCharId: newStartCharId,
              endCharId: newEndCharId,
              format: pasteFormat.format,
              clock: state.CRDTbinding.getClock(),
            };
            firstBlockFormats = [...firstBlockFormats, newSpan];

            const charIds = insertedChars
              .slice(pasteStartIdx, pasteEndIdx + 1)
              .map((c) => c.id);
            const formatOp: MarkSet = {
              op: "mark_set",
              id: state.CRDTbinding.nextId(),
              clock: state.CRDTbinding.getClock(),
              pageId: state.CRDTbinding.pageId,
              blockId: currentBlock.id,
              charIds,
              format: pasteFormat.format,
              value: true,
            };
            ops.push(formatOp);
          }
        }
      }

      const firstBlock: Block = {
        ...currentBlock,
        charRuns: firstBlockCharRuns,
        formats: firstBlockFormats,
      };
      invalidateBlockCache(firstBlock);
      resultBlocks.push(firstBlock);
    } else {
      // Non-textual (atomic) first pasted block — image/line/math/custom void.
      // The current block keeps the before-cursor content; the atomic block is
      // inserted right after it. One path for every atomic type (no per-type
      // branch): the block is cloned with fresh ids and its ops come from the
      // descriptor-driven helper.
      const firstBlock: Block = {
        ...currentBlock,
        charRuns: charsToRuns(beforeChars),
        formats: beforeFormats,
      };
      invalidateBlockCache(firstBlock);
      resultBlocks.push(firstBlock);

      const newAtomicBlockId = globalGenerateBlockId(state.CRDTbinding);
      const newAtomicBlock: Block = {
        ...firstPastedBlock,
        id: newAtomicBlockId,
        afterId: currentBlock.id,
      };
      invalidateBlockCache(newAtomicBlock);
      pushAtomicBlockOps(firstPastedBlock, newAtomicBlockId, currentBlock.id);
      resultBlocks.push(newAtomicBlock);
      lastInsertedBlockId = newAtomicBlockId;
    }

    // Handle middle blocks (all blocks except first and last)
    const middleBlocks = blocks.slice(1, -1);
    for (const block of middleBlocks) {
      const newBlockId = globalGenerateBlockId(state.CRDTbinding);

      if (!isTextualBlock(block)) {
        // Atomic middle block (image/line/math/custom void): clone with fresh
        // ids, ops from the descriptor-driven helper — no per-type branch.
        const newAtomicBlock: Block = {
          ...block,
          id: newBlockId,
          afterId: lastInsertedBlockId,
        };
        invalidateBlockCache(newAtomicBlock);
        pushAtomicBlockOps(block, newBlockId, lastInsertedBlockId);
        resultBlocks.push(newAtomicBlock);
        lastInsertedBlockId = newBlockId;
      } else if (isTextualBlock(block)) {
        // Generate new chars with new IDs for CRDT sync
        const visibleOldChars: Array<{ id: string; char: string }> = [];
        for (const { id, char } of iterateVisibleChars(block.charRuns)) {
          visibleOldChars.push({ id, char });
        }

        const newChars: Char[] = visibleOldChars.map((c) => ({
          id: state.CRDTbinding.nextId(),
          char: c.char,
          deleted: false,
        }));

        // Build a mapping from old char IDs to new char IDs for format spans
        const oldToNewCharIdMap = new Map<string, string>();
        visibleOldChars.forEach((oldChar, idx) => {
          oldToNewCharIdMap.set(oldChar.id, newChars[idx].id);
        });

        // Map formats to use new char IDs
        const newFormats: MarkSpan[] = block.formats
          .map((f) => {
            const newStartId = oldToNewCharIdMap.get(f.startCharId);
            const newEndId = oldToNewCharIdMap.get(f.endCharId);
            if (newStartId && newEndId) {
              return {
                ...f,
                startCharId: newStartId,
                endCharId: newEndId,
                clock: state.CRDTbinding.getClock(),
              };
            }
            return null;
          })
          .filter((f): f is MarkSpan => f !== null);

        const newBlock: Block = {
          ...block,
          id: newBlockId,
          // `block` is parsed from the clipboard — its afterId points at a
          // parser-namespace id that doesn't exist in this document.
          afterId: lastInsertedBlockId,
          charRuns: charsToRuns(newChars),
          formats: newFormats,
        };
        invalidateBlockCache(newBlock);

        const blockInsertOp: BlockInsert = {
          op: "block_insert",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          afterBlockId: lastInsertedBlockId,
          blockId: newBlockId,
          blockType: newBlock.type as any,
        };
        ops.push(blockInsertOp);

        // Add text_insert operation for the block's content
        if (newChars.length > 0) {
          const charRuns = charsToRuns(newChars);
          const textInsertOp: TextInsert = {
            op: "text_insert",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: newBlockId,
            afterCharId: null, // Insert at beginning of new block
            charRuns: charRuns,
          };
          ops.push(textInsertOp);
        }

        // Add mark_set operations for each format span
        for (const format of newFormats) {
          const startIdx = newChars.findIndex(
            (c) => c.id === format.startCharId,
          );
          const endIdx = newChars.findIndex((c) => c.id === format.endCharId);
          if (startIdx !== -1 && endIdx !== -1) {
            const charIds = newChars
              .slice(startIdx, endIdx + 1)
              .map((c) => c.id);
            const formatOp: MarkSet = {
              op: "mark_set",
              id: state.CRDTbinding.nextId(),
              clock: state.CRDTbinding.getClock(),
              pageId: state.CRDTbinding.pageId,
              blockId: newBlockId,
              charIds,
              format: format.format,
              value: true,
            };
            ops.push(formatOp);
          }
        }

        // Sync the block's declared fields (e.g. list indent/checked)
        pushBlockFieldOps(newBlock, newBlockId, state.CRDTbinding, ops);

        resultBlocks.push(newBlock);
        lastInsertedBlockId = newBlockId;
      }
    }

    // Handle last block (if different from first block)
    if (blocks.length > 1) {
      if (isTextualBlock(lastPastedBlock)) {
        // Last block: pasted content + after content from current block
        const lastBlockId = globalGenerateBlockId(state.CRDTbinding);

        // Generate new chars with new IDs for pasted content
        const visiblePastedChars: Array<{ id: string; char: string }> = [];
        for (const { id, char } of iterateVisibleChars(
          lastPastedBlock.charRuns,
        )) {
          visiblePastedChars.push({ id, char });
        }
        const newPastedChars: Char[] = visiblePastedChars.map((c) => ({
          id: state.CRDTbinding.nextId(),
          char: c.char,
          deleted: false,
        }));

        // Build mapping from old pasted char IDs to new IDs
        const pastedOldToNewMap = new Map<string, string>();
        visiblePastedChars.forEach((oldChar, idx) => {
          pastedOldToNewMap.set(oldChar.id, newPastedChars[idx].id);
        });

        // Generate new chars with new IDs for after content
        const visibleAfterChars = afterChars.filter((c) => !c.deleted);
        const newAfterChars: Char[] = visibleAfterChars.map((c) => ({
          id: state.CRDTbinding.nextId(),
          char: c.char,
          deleted: false,
        }));

        // Build mapping from old after char IDs to new IDs
        const afterOldToNewMap = new Map<string, string>();
        visibleAfterChars.forEach((oldChar, idx) => {
          afterOldToNewMap.set(oldChar.id, newAfterChars[idx].id);
        });

        // Combine all chars for the new block
        const allNewChars = [...newPastedChars, ...newAfterChars];

        // Map pasted formats to use new char IDs
        const newPastedFormats: MarkSpan[] = lastPastedBlock.formats
          .map((f) => {
            const newStartId = pastedOldToNewMap.get(f.startCharId);
            const newEndId = pastedOldToNewMap.get(f.endCharId);
            if (newStartId && newEndId) {
              return {
                ...f,
                startCharId: newStartId,
                endCharId: newEndId,
                clock: state.CRDTbinding.getClock(),
              };
            }
            return null;
          })
          .filter((f): f is MarkSpan => f !== null);

        // Map after formats to use new char IDs
        const newAfterFormats: MarkSpan[] = afterFormats
          .map((f) => {
            const newStartId = afterOldToNewMap.get(f.startCharId);
            const newEndId = afterOldToNewMap.get(f.endCharId);
            if (newStartId && newEndId) {
              return {
                ...f,
                startCharId: newStartId,
                endCharId: newEndId,
                clock: state.CRDTbinding.getClock(),
              };
            }
            return null;
          })
          .filter((f): f is MarkSpan => f !== null);

        const allNewFormats = [...newPastedFormats, ...newAfterFormats];

        const lastBlock: Block = {
          ...lastPastedBlock,
          id: lastBlockId,
          // `lastPastedBlock` is parsed from the clipboard — its afterId
          // points at a parser-namespace id that doesn't exist here.
          afterId: lastInsertedBlockId,
          charRuns: charsToRuns(allNewChars),
          formats: allNewFormats,
        };
        invalidateBlockCache(lastBlock);

        const lastBlockInsertOp: BlockInsert = {
          op: "block_insert",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          afterBlockId: lastInsertedBlockId,
          blockId: lastBlockId,
          blockType: lastBlock.type as any,
        };
        ops.push(lastBlockInsertOp);

        // Add text_insert operation for the block's content
        if (allNewChars.length > 0) {
          const charRuns = charsToRuns(allNewChars);
          const textInsertOp: TextInsert = {
            op: "text_insert",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: lastBlockId,
            afterCharId: null, // Insert at beginning of new block
            charRuns: charRuns,
          };
          ops.push(textInsertOp);
        }

        // Add mark_set operations for each format span
        for (const format of allNewFormats) {
          const startIdx = allNewChars.findIndex(
            (c) => c.id === format.startCharId,
          );
          const endIdx = allNewChars.findIndex(
            (c) => c.id === format.endCharId,
          );
          if (startIdx !== -1 && endIdx !== -1) {
            const charIds = allNewChars
              .slice(startIdx, endIdx + 1)
              .map((c) => c.id);
            const formatOp: MarkSet = {
              op: "mark_set",
              id: state.CRDTbinding.nextId(),
              clock: state.CRDTbinding.getClock(),
              pageId: state.CRDTbinding.pageId,
              blockId: lastBlockId,
              charIds,
              format: format.format,
              value: true,
            };
            ops.push(formatOp);
          }
        }

        // Sync the block's declared fields (e.g. list indent/checked)
        pushBlockFieldOps(lastBlock, lastBlockId, state.CRDTbinding, ops);

        resultBlocks.push(lastBlock);
        lastInsertedBlockId = lastBlockId;
      } else if (!isTextualBlock(lastPastedBlock)) {
        // Re-create the atomic block (image, line, math, or any custom void
        // type) at the new position, then spill any after-cursor content into a
        // trailing paragraph. Type-agnostic: a new atomic type pastes for free.
        const newAtomicBlockId = globalGenerateBlockId(state.CRDTbinding);
        const newAtomicBlock: Block = {
          ...lastPastedBlock,
          id: newAtomicBlockId,
          afterId: lastInsertedBlockId,
        };
        invalidateBlockCache(newAtomicBlock);
        pushAtomicBlockOps(
          lastPastedBlock,
          newAtomicBlockId,
          lastInsertedBlockId,
        );
        resultBlocks.push(newAtomicBlock);
        lastInsertedBlockId = newAtomicBlockId;
        appendTrailingParagraph(newAtomicBlockId);
      }
    } else {
      // Single-block paste: the block itself was already handled above. If the
      // pasted block is atomic and the cursor had after-content, spill it into a
      // trailing paragraph (atomic blocks can't hold the tail text).
      if (!isTextualBlock(firstPastedBlock)) {
        appendTrailingParagraph(lastInsertedBlockId);
      }
    }

    const newBlocks = [
      ...newState.document.page.blocks.slice(0, blockIndex),
      ...resultBlocks,
      ...newState.document.page.blocks.slice(blockIndex + 1),
    ];

    newState = {
      ...newState,
      document: {
        ...newState.document,
        page: { ...newState.document.page, blocks: newBlocks },
      },
    };

    // Move cursor to appropriate position
    const lastResultBlockIndex = blockIndex + resultBlocks.length - 1;
    const lastResultBlock = resultBlocks[resultBlocks.length - 1];
    if (isTextualBlock(lastResultBlock)) {
      const lastBlockText = getVisibleTextFromRuns(lastResultBlock.charRuns);
      // If the last block has after-cursor content, position cursor at the start of it
      const afterTextLength = afterChars.filter((c) => !c.deleted).length;
      const cursorPosition = lastBlockText.length - afterTextLength;
      newState = moveCursorToPosition(
        newState,
        lastResultBlockIndex,
        Math.max(0, cursorPosition),
      );
    } else {
      // For non-textual last block, move cursor to the next block if it exists
      if (lastResultBlockIndex + 1 < newBlocks.length) {
        newState = moveCursorToPosition(newState, lastResultBlockIndex + 1, 0);
      } else {
        newState = moveCursorToPosition(newState, lastResultBlockIndex, 0);
      }
    }

    return { state: clearSelection(newState), ops };
  }
}

/**
 * Paste content from ClipboardEvent with HTML formatting (Ctrl+V)
 * This uses the paste event's clipboardData, which doesn't require permission
 */
export function pasteFromClipboardEvent(
  state: EditorState,
  event: ClipboardEvent,
  extractedData?: { html: string; text: string; imageFile: File | null } | null,
): (ActionResult & { pastedImageBlockIndex?: number }) | null {
  // Use extracted data if provided (from immediate event handler)
  // Otherwise try to get from event (may be empty if not called synchronously)
  let html = "";
  let text = "";
  let imageFile: File | null = null;

  if (extractedData) {
    html = extractedData.html;
    text = extractedData.text;
    imageFile = extractedData.imageFile;
  } else {
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      console.error("Failed to paste from clipboard event: no clipboard data");
      return null;
    }
    html = clipboardData.getData("text/html");
    text = clipboardData.getData("text/plain") || clipboardData.getData("text");
  }

  // Try to get HTML first
  if (html) {
    const blocks = parseHTMLToBlocks(html, state.CRDTbinding);
    if (blocks.length > 0) {
      return insertBlocksAtCursor(state, blocks);
    }
  }

  // Handle pasted image file (e.g. screenshot from clipboard)
  if (imageFile) {
    const blobUrl = URL.createObjectURL(imageFile);
    const result = insertBlocksAtCursor(state, [
      {
        id: globalGenerateBlockId(state.CRDTbinding),
        type: "image",
        url: blobUrl,
        alt: imageFile.name || "Pasted image",
      },
    ]);
    if (result) {
      // Find the image block by its blob URL (more reliable than cursor math,
      // since the cursor gets clamped when the image is inserted at the end)
      const pastedImageBlockIndex = result.state.document.page.blocks.findIndex(
        (b) => b.type === "image" && b.url === blobUrl,
      );
      return {
        ...result,
        pastedImageBlockIndex:
          pastedImageBlockIndex >= 0 ? pastedImageBlockIndex : undefined,
      };
    }
    return null;
  }

  // Fallback to plain text
  if (text) {
    const blocks = parsePlainTextToBlocks(text, state.CRDTbinding);
    if (blocks.length > 0) {
      return insertBlocksAtCursor(state, blocks);
    }
  }

  return null;
}

/**
 * Paste content from ClipboardEvent as plain text only (Ctrl+Shift+V)
 * This uses the paste event's clipboardData, which doesn't require permission
 */
export function pasteFromClipboardEventAsPlainText(
  state: EditorState,
  event: ClipboardEvent,
): Promise<ActionResult | null> {
  return new Promise((resolve) => {
    try {
      const clipboardData = event.clipboardData;
      if (!clipboardData) {
        resolve(null);
        console.error(
          "Failed to paste from clipboard event: no clipboard data",
        );
        return;
      }

      const text =
        clipboardData.getData("text/plain") || clipboardData.getData("text");
      if (!text) {
        resolve(null);
        console.error("Failed to paste from clipboard event: no text");
        return;
      }

      const blocks = parsePlainTextToBlocks(text, state.CRDTbinding);
      if (blocks.length === 0) {
        resolve(null);
        return;
      }

      resolve(insertBlocksAtCursor(state, blocks));
    } catch (error) {
      console.error("Failed to paste plain text from clipboard event:", error);
      resolve(null);
    }
  });
}

/**
 * Paste content by reading the system clipboard via the async `navigator.clipboard`
 * API (used by the imperative `editor.paste()`, e.g. a context-menu "Paste").
 *
 * Cmd/Ctrl+V flows through the synchronous {@link pasteFromClipboardEvent} on the
 * contenteditable surface instead; this path is for programmatic pastes that have
 * no `ClipboardEvent` to read from. Prefers `read()` so HTML formatting survives,
 * mirroring the event path, and falls back to plain text.
 */
export async function pasteFromSystemClipboard(
  state: EditorState,
): Promise<ActionResult | null> {
  try {
    let html = "";
    let text = "";

    if (navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (!html && item.types.includes("text/html")) {
            html = await (await item.getType("text/html")).text();
          }
          if (!text && item.types.includes("text/plain")) {
            text = await (await item.getType("text/plain")).text();
          }
        }
      } catch {
        // read() can reject (permissions / unsupported MIME types) — fall back
        // to readText() below.
      }
    }

    if (!html && !text && navigator.clipboard?.readText) {
      text = await navigator.clipboard.readText();
    }

    if (html) {
      const blocks = parseHTMLToBlocks(html, state.CRDTbinding);
      if (blocks.length > 0) return insertBlocksAtCursor(state, blocks);
    }
    if (text) {
      const blocks = parsePlainTextToBlocks(text, state.CRDTbinding);
      if (blocks.length > 0) return insertBlocksAtCursor(state, blocks);
    }
    return null;
  } catch (error) {
    console.error("Failed to paste from system clipboard:", error);
    return null;
  }
}
