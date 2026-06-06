import { isCJKCharacter } from "../cjk";
import { invalidateBlockCache } from "../rendering/renderer";
import { isRTLChar } from "../rtl";
import { moveCursorToPosition } from "../selection";
import {
  clearSelection,
  startSelection,
  updateSelectionFocus,
} from "../selection";
import type { Block, CharRun, Page, TextFormat } from "../serlization/loadPage";
import { isListBlock, isTextualBlock } from "../serlization/loadPage";
import type {
  CommandResult,
  CRDTbinding,
  EditorState,
  Position,
  SlashCommand,
} from "../state-types";
import {
  clearAutoCreatedParagraph,
  closeSlashCommand,
  getBlockTextContent,
  getBlockTextLength,
  updateMode,
} from "../state-utils";
import {
  deleteFromRuns,
  getVisibleTextFromRuns,
  isCharIdInRange,
  iterateVisibleChars,
} from "../sync/char-runs";
import type {
  BlockInsert,
  BlockSet,
  FormatSet,
  Operation,
  TextDelete,
} from "../sync/crdt-types";
import {
  allCharsHaveFormat,
  crdtToPosition,
  crdtToSelectionRange,
  deleteCharsInRange,
  formatCharsInRange,
  getFormatsAtCharPosition,
  getVisibleLength,
  insertCharsAtPosition,
  positionToCRDT,
  selectionRangeToCRDT,
} from "../sync/crdt-utils";
import {
  applyOps,
  findNextVisibleBlockIndex,
  findPreviousVisibleBlockIndex,
} from "../sync/reducer";

/**
 * URL regex pattern for auto-detection.
 * Matches http://, https://, and www. prefixed URLs.
 */
const URL_REGEX = /https?:\/\/[^\s<>\"']+|www\.[^\s<>\"']+\.[^\s<>\"']+/i;

/**
 * Detect if the word ending just before `cursorIndex` in the text is a URL.
 * Returns the start and end indices of the URL, or null if no URL found.
 */
function detectUrlBeforeCursor(
  text: string,
  cursorIndex: number,
): { start: number; end: number; url: string } | null {
  // Walk backward from cursorIndex to find the word boundary
  let end = cursorIndex;
  // Skip trailing whitespace/newline (the character that triggered this)
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\n")) {
    end--;
  }
  if (end === 0) return null;

  // Find the start of the word (walk backward until whitespace or start)
  let start = end;
  while (start > 0 && text[start - 1] !== " " && text[start - 1] !== "\n") {
    start--;
  }

  const word = text.slice(start, end);
  if (!URL_REGEX.test(word)) return null;

  // Strip trailing punctuation that's likely not part of the URL
  let cleanWord = word.replace(/[.,;:!?)]+$/, "");
  if (!URL_REGEX.test(cleanWord)) return null;

  const cleanEnd = start + cleanWord.length;

  // Normalize the URL
  let url = cleanWord;
  if (url.startsWith("www.")) {
    url = "https://" + url;
  }

  return { start, end: cleanEnd, url };
}

/**
 * Apply link format to a detected URL in a block's char runs.
 * Returns the updated page and any CRDT ops, or null if no URL was detected.
 */
function autoLinkAtCursor(
  page: Page,
  blockId: string,
  text: string,
  cursorIndex: number,
  binding: CRDTbinding,
): { newPage: Page; ops: Operation[] } | null {
  const detected = detectUrlBeforeCursor(text, cursorIndex);
  if (!detected) return null;

  const block = page.blocks.find((b) => b.id === blockId);
  if (!block || !isTextualBlock(block)) return null;
  const charRuns = block.charRuns;

  // Check if this range is already a link
  for (const span of block.formats) {
    if (span.format.type === "link") {
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
      if (
        spanStart !== -1 &&
        spanStart < detected.end &&
        spanEnd > detected.start
      ) {
        return null;
      }
    }
  }

  const { newPage, op } = formatCharsInRange(
    page,
    blockId,
    detected.start,
    detected.end,
    { type: "link", url: detected.url },
    detected.url,
    binding,
  );

  return { newPage, ops: [op] };
}

/**
 * Helper to determine if text is RTL based on charRuns
 */
function isBlockRTL(charRuns: CharRun[]): boolean {
  let totalRtl = 0;
  let totalLtr = 0;

  for (const { char } of iterateVisibleChars(charRuns)) {
    if (isRTLChar(char)) {
      totalRtl++;
    } else if (/[a-zA-Z]/.test(char)) {
      totalLtr++;
    }
  }

  const totalDirectional = totalRtl + totalLtr;
  if (totalDirectional === 0) return false;

  return totalRtl / totalDirectional > 0.3;
}

/**
 * Get the formatting at a specific text position in a block
 * Returns the formats of the character just before the cursor position
 */
export function getFormatsAtPosition(
  block: Block,
  textIndex: number,
): readonly TextFormat[] | undefined {
  if (!isTextualBlock(block)) {
    return undefined;
  }

  return getFormatsAtCharPosition(block.charRuns, block.formats, textIndex);
}

/**
 * Detect and apply live markdown inline formatting patterns.
 * Returns null if no pattern matched, otherwise the transformed page,
 * new cursor index, and ops that produced it.
 */
function detectAndApplyInlineMarkdown(
  page: Page,
  blockId: string,
  textIndex: number,
  binding: CRDTbinding,
): {
  newPage: Page;
  newTextIndex: number;
  ops: Operation[];
} | null {
  const block = page.blocks.find((b) => b.id === blockId);
  if (!block || !isTextualBlock(block)) return null;
  const fullText = getVisibleTextFromRuns(block.charRuns);

  const patterns: Array<{
    regex: RegExp;
    markerLen: number;
    format: TextFormat;
  }> = [
    { regex: /\*\*([^\*]+)\*\*$/, markerLen: 2, format: { type: "bold" } },
    { regex: /(?<!\*)\*([^\*]+)\*$/, markerLen: 1, format: { type: "italic" } },
    { regex: /~~([^~]+)~~$/, markerLen: 2, format: { type: "strikethrough" } },
    { regex: /\$([^$\n]+)\$$/, markerLen: 1, format: { type: "math" } },
    { regex: /`([^`]+)`$/, markerLen: 1, format: { type: "code" } },
  ];

  for (const { regex, markerLen, format } of patterns) {
    const match = fullText.slice(0, textIndex).match(regex);
    if (!match) continue;
    const matchStart = textIndex - match[0].length;
    const matchEnd = textIndex;
    const innerLen = match[1].length;
    const ops: Operation[] = [];

    // Delete the closing then opening marker (closing first to preserve indices).
    let pageAcc = page;
    const { newPage: p1, op: deleteOp1 } = deleteCharsInRange(
      pageAcc,
      blockId,
      matchEnd - markerLen,
      matchEnd,
      binding,
    );
    pageAcc = p1;
    ops.push(deleteOp1);

    const { newPage: p2, op: deleteOp2 } = deleteCharsInRange(
      pageAcc,
      blockId,
      matchStart,
      matchStart + markerLen,
      binding,
    );
    pageAcc = p2;
    ops.push(deleteOp2);

    const { newPage: p3, op: formatOp } = formatCharsInRange(
      pageAcc,
      blockId,
      matchStart,
      matchStart + innerLen,
      format,
      true,
      binding,
    );
    pageAcc = p3;
    ops.push(formatOp);

    return {
      newPage: pageAcc,
      newTextIndex: matchStart + innerLen,
      ops,
    };
  }

  return null;
}

/**
 * Apply markdown prefix detection to a block.
 * Detects patterns like "#", "##", "- [ ]", etc. and updates block type/properties.
 * Mutates the block in-place by removing the prefix from chars array.
 */
function applyMarkdownPrefix(
  block: Block,
  binding: CRDTbinding,
  preserveType: boolean = false,
): { block: Block; ops: Operation[] } {
  if (!isTextualBlock(block)) {
    return { block, ops: [] };
  }
  const text = getVisibleTextFromRuns(block.charRuns);
  const ops: Operation[] = [];
  const oldType = block.type;

  // Calculate indent level from leading spaces (2 spaces = 1 indent)
  const leadingSpaces = text.match(/^ +/)?.[0].length || 0;
  const indentLevel = Math.floor(leadingSpaces / 2);
  const textAfterSpaces = text.slice(leadingSpaces);

  // Helper to remove prefix characters (mutates block.charRuns, generates text_delete op)
  const removePrefix = (startIdx: number, endIdx: number) => {
    const charIds: string[] = [];
    let visibleCount = 0;
    for (const { id } of iterateVisibleChars(block.charRuns)) {
      if (visibleCount >= startIdx && visibleCount < endIdx) {
        charIds.push(id);
      }
      visibleCount++;
      if (visibleCount >= endIdx) break;
    }
    if (charIds.length > 0) {
      block.charRuns = deleteFromRuns(block.charRuns, charIds);
      const deleteOp: TextDelete = {
        op: "text_delete",
        id: binding.nextId(),
        clock: binding.getClock(),
        pageId: binding.pageId,
        blockId: block.id,
        charIds,
      };
      ops.push(deleteOp);
    }
  };

  // Helper to emit block_set ops for type/property changes
  const setBlockField = (field: string, value: any) => {
    const setOp: BlockSet = {
      op: "block_set",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      blockId: block.id,
      field,
      value,
    };
    ops.push(setOp);
  };

  // Check for list markers
  if (textAfterSpaces.startsWith("- [ ] ")) {
    // Unchecked todo list
    (block as any).type = "todo_list";
    (block as any).checked = false;
    (block as any).indent = indentLevel;
    removePrefix(0, leadingSpaces + 6);
    if (oldType !== "todo_list") setBlockField("type", "todo_list");
    setBlockField("checked", false);
    setBlockField("indent", indentLevel);
  } else if (
    textAfterSpaces.startsWith("- [x] ") ||
    textAfterSpaces.startsWith("- [X] ")
  ) {
    // Checked todo list
    (block as any).type = "todo_list";
    (block as any).checked = true;
    (block as any).indent = indentLevel;
    removePrefix(0, leadingSpaces + 6);
    if (oldType !== "todo_list") setBlockField("type", "todo_list");
    setBlockField("checked", true);
    setBlockField("indent", indentLevel);
  } else if (textAfterSpaces.match(/^[-*+] /)) {
    // Bullet list
    (block as any).type = "bullet_list";
    (block as any).indent = indentLevel;
    removePrefix(0, leadingSpaces + 2);
    if (oldType !== "bullet_list") setBlockField("type", "bullet_list");
    setBlockField("indent", indentLevel);
  } else if (textAfterSpaces.match(/^\d+\. /)) {
    // Numbered list
    const match = textAfterSpaces.match(/^(\d+)\. /);
    if (match) {
      (block as any).type = "numbered_list";
      (block as any).indent = indentLevel;
      removePrefix(0, leadingSpaces + match[0].length);
      if (oldType !== "numbered_list") setBlockField("type", "numbered_list");
      setBlockField("indent", indentLevel);
    }
  } else if (text.startsWith("### ")) {
    block.type = "heading3";
    removePrefix(0, 4);
    if (oldType !== "heading3") setBlockField("type", "heading3");
  } else if (text.startsWith("## ")) {
    block.type = "heading2";
    removePrefix(0, 3);
    if (oldType !== "heading2") setBlockField("type", "heading2");
  } else if (text.startsWith("# ")) {
    block.type = "heading1";
    removePrefix(0, 2);
    if (oldType !== "heading1") setBlockField("type", "heading1");
  } else if (text.match(/^-{3,}$/)) {
    // Line/divider block - three or more dashes with nothing else
    // Generate text_delete for all visible chars before clearing
    const allCharIds: string[] = [];
    for (const { id } of iterateVisibleChars(block.charRuns)) {
      allCharIds.push(id);
    }
    if (allCharIds.length > 0) {
      block.charRuns = deleteFromRuns(block.charRuns, allCharIds);
      const deleteOp: TextDelete = {
        op: "text_delete",
        id: binding.nextId(),
        clock: binding.getClock(),
        pageId: binding.pageId,
        blockId: block.id,
        charIds: allCharIds,
      };
      ops.push(deleteOp);
    }
    (block as any).type = "line";
    (block as any).charRuns = [];
    setBlockField("type", "line");
  } else if (text === "$$") {
    // Math block - $$ on its own line
    const allCharIds: string[] = [];
    for (const { id } of iterateVisibleChars(block.charRuns)) {
      allCharIds.push(id);
    }
    if (allCharIds.length > 0) {
      block.charRuns = deleteFromRuns(block.charRuns, allCharIds);
      const deleteOp: TextDelete = {
        op: "text_delete",
        id: binding.nextId(),
        clock: binding.getClock(),
        pageId: binding.pageId,
        blockId: block.id,
        charIds: allCharIds,
      };
      ops.push(deleteOp);
    }
    (block as any).type = "math";
    (block as any).latex = "";
    (block as any).displayMode = true;
    (block as any).charRuns = [];
    (block as any).formats = [];
    setBlockField("type", "math");
  } else if (!preserveType) {
    if (oldType !== "paragraph") {
      (block as any).type = "paragraph";
      setBlockField("type", "paragraph");
    }
    // Chars stay as-is with formatting preserved
  }
  return { block, ops };
}

/**
 * Merge `source` into the end of `target`, emitting CRDT ops for everything
 * (text move + format transfer + block delete) so local apply, remote apply,
 * and undo all see the same change. No callers should ever splice the page
 * by hand alongside this.
 *
 * Mirrors the structure of `splitBlock` (which transfers formats onto
 * newly-inserted chars in a sibling block). The crucial bit is that
 * `insertCharsAtPosition` allocates FRESH char IDs in target's id-space —
 * undo's `text_delete` inverse targets those new ids and cleanly removes
 * the moved content from target, leaving source's tombstoned chars to be
 * restored by the inverse of `block_delete(source)`.
 *
 * Cursor positioning is the caller's responsibility: look up
 * `newPage.blocks.findIndex(b => b.id === target.id && !b.deleted)` after
 * this returns. The surviving block keeps target's id and original array
 * position; source is tombstoned at its original position.
 */
function mergeBlocksOps(
  page: Page,
  source: Block,
  target: Block,
  binding: CRDTbinding,
): { newPage: Page; ops: Operation[] } {
  const ops: Operation[] = [];
  let pageAcc = page;

  // Non-textual source can't contribute content; just tombstone it.
  if (!isTextualBlock(source) || !isTextualBlock(target)) {
    const delOp: Operation = {
      op: "block_delete",
      id: binding.nextId(),
      clock: binding.getClock(),
      pageId: binding.pageId,
      blockId: source.id,
    };
    ops.push(delOp);
    pageAcc = applyOps(pageAcc, [delOp]);
    return { newPage: pageAcc, ops };
  }

  const sourceText = getVisibleTextFromRuns(source.charRuns);

  if (sourceText.length > 0) {
    const targetLen = getVisibleLength(target.charRuns);
    const { newPage: pageAfterInsert, op: insertOp } = insertCharsAtPosition(
      pageAcc,
      target.id,
      targetLen,
      sourceText,
      binding,
    );
    pageAcc = pageAfterInsert;
    ops.push(insertOp);

    // Re-target source's format spans onto the freshly-inserted chars in
    // target. We map source char ids → new target char ids by visible
    // position (insertCharsAtPosition appended the new chars at the end of
    // target, so they're the trailing sourceText.length visible chars).
    if (source.formats.length > 0) {
      const sourceIds: string[] = [];
      for (const { id } of iterateVisibleChars(source.charRuns)) {
        sourceIds.push(id);
      }
      const targetAfter = pageAcc.blocks.find((b) => b.id === target.id);
      const targetIdsAll: string[] = [];
      if (targetAfter && isTextualBlock(targetAfter)) {
        for (const { id } of iterateVisibleChars(targetAfter.charRuns)) {
          targetIdsAll.push(id);
        }
      }
      const newIds = targetIdsAll.slice(-sourceText.length);

      if (sourceIds.length === newIds.length) {
        const sourceToNew = new Map<string, string>();
        for (let i = 0; i < sourceIds.length; i++) {
          sourceToNew.set(sourceIds[i], newIds[i]);
        }

        const formatOps: FormatSet[] = [];
        for (const span of source.formats) {
          const coveredNewIds: string[] = [];
          for (const oldId of sourceIds) {
            if (
              isCharIdInRange(
                source.charRuns,
                oldId,
                span.startCharId,
                span.endCharId,
              )
            ) {
              coveredNewIds.push(sourceToNew.get(oldId)!);
            }
          }
          if (coveredNewIds.length > 0) {
            formatOps.push({
              op: "format_set",
              id: binding.nextId(),
              clock: binding.getClock(),
              pageId: binding.pageId,
              blockId: target.id,
              charIds: coveredNewIds,
              format: span.format,
              value:
                span.format.type === "link" ? span.format.url || true : true,
            });
          }
        }
        if (formatOps.length > 0) {
          ops.push(...formatOps);
          pageAcc = applyOps(pageAcc, formatOps);
        }
      }
    }
  }

  const delOp: Operation = {
    op: "block_delete",
    id: binding.nextId(),
    clock: binding.getClock(),
    pageId: binding.pageId,
    blockId: source.id,
  };
  ops.push(delOp);
  pageAcc = applyOps(pageAcc, [delOp]);

  // Post-merge markdown detection on the surviving paragraph (e.g. backspacing
  // such that target's text now starts with "1. " should convert it to a
  // numbered list). Clone before passing to applyMarkdownPrefix — that
  // function mutates its argument in place; we don't want that bleeding into
  // pageAcc. The ops it returns are applied via applyOps for parity.
  const targetAfterMerge = pageAcc.blocks.find((b) => b.id === target.id);
  if (
    targetAfterMerge &&
    !targetAfterMerge.deleted &&
    targetAfterMerge.type === "paragraph" &&
    isTextualBlock(targetAfterMerge)
  ) {
    const clone = { ...targetAfterMerge } as Block;
    const { ops: prefixOps } = applyMarkdownPrefix(clone, binding);
    if (prefixOps.length > 0) {
      ops.push(...prefixOps);
      pageAcc = applyOps(pageAcc, prefixOps);
    }
  }

  return { newPage: pageAcc, ops };
}

// Helper function to get selection range in proper order (start to end)
export function getSelectionRange(
  state: EditorState,
): { start: Position; end: Position } | null {
  if (!state.document.selection || state.document.selection.isCollapsed)
    return null;

  const { anchor, focus } = state.document.selection;

  // Compare positions to determine which is start and which is end
  if (
    anchor.blockIndex < focus.blockIndex ||
    (anchor.blockIndex === focus.blockIndex &&
      anchor.textIndex < focus.textIndex)
  ) {
    return { start: anchor, end: focus };
  } else {
    return { start: focus, end: anchor };
  }
}

// Helper function to delete selected text
/**
 * Delete selected text.
 * Returns new state + CRDT operations for the deletion.
 */
export function deleteSelectedText(state: EditorState): CommandResult {
  // Note: Cache will naturally miss due to content length change
  // Only clear for multi-block operations below
  const range = getSelectionRange(state);
  if (!range) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert selection to CRDT and back for validation against concurrent updates
  const crdtRange = selectionRangeToCRDT(state.document.page, range);
  if (!crdtRange) return { state, ops: [] };

  const freshRange = crdtToSelectionRange(state.document.page, crdtRange);
  if (!freshRange) return { state, ops: [] };

  const { start, end } = freshRange;

  if (start.blockIndex === end.blockIndex) {
    // Single block selection
    const block = state.document.page.blocks[start.blockIndex];
    if (!block || block.deleted) return { state, ops: [] };

    // Handle visual (image/line/math) block deletion
    if (!isTextualBlock(block)) {
      // Delete the visual block — tombstone (don't splice) so undo can find it
      const blockDeleteOp: Operation = {
        op: "block_delete",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: block.id,
      };
      ops.push(blockDeleteOp);

      const visibleBlocks = state.view.visibleBlocks;
      const wasOnlyVisibleBlock = visibleBlocks.length === 1;

      // Tombstone the deleted block in place
      const tombstonedBlocks = [...state.document.page.blocks];
      tombstonedBlocks[start.blockIndex] = { ...block, deleted: true };

      let finalBlocks = tombstonedBlocks;
      let cursorBlockIndex = start.blockIndex;

      if (wasOnlyVisibleBlock) {
        // Append a new empty paragraph (the tombstone stays in place)
        const emptyParagraphId = state.CRDTbinding.nextId();
        const emptyParagraph: Block = {
          id: emptyParagraphId,
          type: "paragraph",
          charRuns: [],
          formats: [],
        };

        const blockInsertOp: Operation = {
          op: "block_insert",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          afterBlockId: null,
          blockId: emptyParagraphId,
          blockType: "paragraph",
        };
        ops.push(blockInsertOp);

        finalBlocks = [...tombstonedBlocks, emptyParagraph];
        cursorBlockIndex = finalBlocks.length - 1;
      } else {
        // Move cursor to the next visible block, or previous if at end
        let nextVisible = -1;
        for (let i = start.blockIndex + 1; i < finalBlocks.length; i++) {
          if (!finalBlocks[i].deleted) {
            nextVisible = i;
            break;
          }
        }
        if (nextVisible === -1) {
          for (let i = start.blockIndex - 1; i >= 0; i--) {
            if (!finalBlocks[i].deleted) {
              nextVisible = i;
              break;
            }
          }
        }
        cursorBlockIndex = nextVisible === -1 ? 0 : nextVisible;
      }

      const newPage = { ...state.document.page, blocks: finalBlocks };

      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      newState = moveCursorToPosition(newState, cursorBlockIndex, 0);
      newState = clearSelection(newState);
      return { state: newState, ops };
    }

    // Handle text block deletion using CRDT helper
    const { newPage: pageAfterDelete, op } = deleteCharsInRange(
      state.document.page,
      block.id,
      start.textIndex,
      end.textIndex,
      state.CRDTbinding,
    );
    ops.push(op);

    const blockCopy = pageAfterDelete.blocks[start.blockIndex];

    if (block.type === "paragraph") {
      ops.push(...applyMarkdownPrefix(blockCopy, state.CRDTbinding).ops);
    }

    invalidateBlockCache(blockCopy);

    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: pageAfterDelete },
    };
    newState = moveCursorToPosition(
      newState,
      start.blockIndex,
      start.textIndex,
    );
    newState = clearSelection(newState);
    return { state: newState, ops };
  } else {
    // Multi-block selection
    const startBlock = state.document.page.blocks[start.blockIndex];
    const endBlock = state.document.page.blocks[end.blockIndex];
    if (!startBlock || startBlock.deleted || !endBlock || endBlock.deleted) {
      return { state, ops: [] };
    }

    // Handle case where selection includes image blocks
    const startIsText = isTextualBlock(startBlock);
    const endIsText = isTextualBlock(endBlock);

    // If both start and end are non-text blocks, or if we're selecting multiple blocks
    // and at least one endpoint is a non-text block, we need special handling
    if (!startIsText || !endIsText) {
      // Delete all blocks in the range
      for (let i = start.blockIndex; i <= end.blockIndex; i++) {
        const blockToDelete = state.document.page.blocks[i];
        if (!blockToDelete || blockToDelete.deleted) continue;
        const blockDeleteOp: Operation = {
          op: "block_delete",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          blockId: blockToDelete.id,
        };
        ops.push(blockDeleteOp);
      }

      // Check if we need to create an empty paragraph (all blocks will be deleted)
      const visibleBlocksCount = state.view.visibleBlocks.length;
      const deletingAllBlocks =
        end.blockIndex - start.blockIndex + 1 >= visibleBlocksCount;

      if (deletingAllBlocks) {
        const emptyParagraphId = state.CRDTbinding.nextId();

        const blockInsertOp: Operation = {
          op: "block_insert",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          afterBlockId: null,
          blockId: emptyParagraphId,
          blockType: "paragraph",
        };
        ops.push(blockInsertOp);
      }

      // Apply operations to get new page state (blocks will be tombstoned, not removed)
      const newPage = applyOps(state.document.page, ops);

      // Find first non-deleted block at or after start position for cursor placement
      let newBlockIndex = start.blockIndex;
      while (
        newBlockIndex < newPage.blocks.length &&
        newPage.blocks[newBlockIndex].deleted
      ) {
        newBlockIndex++;
      }
      // If no non-deleted block found after start, search backwards
      if (
        newBlockIndex >= newPage.blocks.length ||
        newPage.blocks[newBlockIndex].deleted
      ) {
        newBlockIndex = start.blockIndex - 1;
        while (newBlockIndex >= 0 && newPage.blocks[newBlockIndex].deleted) {
          newBlockIndex--;
        }
      }
      // Fallback to first non-deleted block
      if (
        newBlockIndex < 0 ||
        newBlockIndex >= newPage.blocks.length ||
        newPage.blocks[newBlockIndex].deleted
      ) {
        newBlockIndex = newPage.blocks.findIndex((b: Block) => !b.deleted);
      }
      // Final fallback to 0
      if (newBlockIndex === -1) {
        newBlockIndex = 0;
      }

      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      newState = moveCursorToPosition(newState, newBlockIndex, 0);
      newState = clearSelection(newState);
      return { state: newState, ops };
    }

    // Both are text blocks - delete text from start and end, merge blocks
    // Delete from start position to end of start block
    const startBlockLen = getVisibleLength(startBlock.charRuns);
    const { newPage: pageAfterStartDelete, op: startDeleteOp } =
      deleteCharsInRange(
        state.document.page,
        startBlock.id,
        start.textIndex,
        startBlockLen,
        state.CRDTbinding,
      );
    ops.push(startDeleteOp);

    // Get the chars to keep from end block (after end.textIndex)
    const endBlockText = getBlockTextContent(endBlock);
    const textToKeep = endBlockText.slice(end.textIndex);

    let pageAfterMerge = pageAfterStartDelete;
    if (textToKeep.length > 0) {
      const { newPage: pageAfterInsert, op: insertOp } = insertCharsAtPosition(
        pageAfterMerge,
        startBlock.id,
        start.textIndex,
        textToKeep,
        state.CRDTbinding,
      );
      pageAfterMerge = pageAfterInsert;
      ops.push(insertOp);
    }

    // Delete all blocks from start+1 to end (inclusive). Build the block_delete
    // ops and apply them through applyOps so the page reflects tombstones.
    const blockDeleteOps: Operation[] = [];
    for (let i = start.blockIndex + 1; i <= end.blockIndex; i++) {
      const blockToDelete = state.document.page.blocks[i];
      if (!blockToDelete || blockToDelete.deleted) continue;
      blockDeleteOps.push({
        op: "block_delete",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: blockToDelete.id,
      });
    }
    ops.push(...blockDeleteOps);

    let newPage = applyOps(pageAfterMerge, blockDeleteOps);

    // TODO: Merge format spans from both blocks
    const startBlockIndex = newPage.blocks.findIndex(
      (b: Block) => b.id === startBlock.id,
    );
    if (startBlockIndex !== -1) {
      const blockCopy = newPage.blocks[startBlockIndex];
      if (startBlock.type === "paragraph") {
        ops.push(...applyMarkdownPrefix(blockCopy, state.CRDTbinding).ops);
      }
      invalidateBlockCache(blockCopy);
    }

    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };

    newState = moveCursorToPosition(
      newState,
      start.blockIndex,
      start.textIndex,
    );
    newState = clearSelection(newState);
    return { state: newState, ops };
  }
}

/**
 * Insert text at cursor position.
 * Returns new state + CRDT operation for the insertion.
 *
 * Phase 3 refactor: Uses CRDT helpers that return { newData, op } atomically
 */
export function insertText(state: EditorState, input: string): CommandResult {
  if (!state.document.cursor) {
    return { state, ops: [] };
  }

  const ops: Operation[] = [];

  // Block typing on a selected image (but allow deletion via deleteSelectedText elsewhere)
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const { anchor, focus } = state.document.selection;
    // Check if this is a single image selection (anchor and focus at same position)
    if (
      anchor.blockIndex === focus.blockIndex &&
      anchor.textIndex === focus.textIndex
    ) {
      const block = state.document.page.blocks[anchor.blockIndex];
      if (block && !block.deleted && !isTextualBlock(block)) {
        // Block typing on selected visual block (image/math/line)
        return { state, ops: [] };
      }
    }
    // For other selections, delete them first and collect ops
    const deleteResult = deleteSelectedText(state);
    state = deleteResult.state;
    ops.push(...deleteResult.ops);
    // Ensure cursor still exists after deletion
    if (!state.document.cursor) {
      return { state, ops };
    }
  }

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return { state, ops };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops };

  const { blockIndex: blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  if (!isTextualBlock(oldBlock)) {
    return { state, ops };
  }

  // Inline math chips are atomic: typing while the caret is strictly inside a
  // math span would mix new chars into the LaTeX source (visible chars between
  // startCharId/endCharId ARE the LaTeX) and corrupt the formula. Block here;
  // the user can navigate to either edge or click the chip to open the math
  // editor. Insertions at the edges (textIndex === spanStart or === spanEnd)
  // are allowed — those are "type before/after the chip".
  if (findInlineMathSpan(oldBlock, textIndex, "inside")) {
    return { state, ops };
  }

  // Use CRDT helper to insert chars and generate operation atomically
  const { newPage: pageAfterInsert, op } = insertCharsAtPosition(
    state.document.page,
    oldBlock.id,
    textIndex,
    input,
    state.CRDTbinding,
  );
  ops.push(op);

  const newTextIndex = textIndex + input.length;
  let pageAcc = pageAfterInsert;

  // Handle active formats (when user has toggled formatting without selection)
  if (state.ui.activeFormatsMode.type === "explicit") {
    for (const format of state.ui.activeFormatsMode.formats) {
      const { newPage: pageAfterFormat, op: formatOp } = formatCharsInRange(
        pageAcc,
        oldBlock.id,
        textIndex,
        newTextIndex,
        format,
        true,
        state.CRDTbinding,
      );
      pageAcc = pageAfterFormat;
      ops.push(formatOp);
    }
  }

  // Inline markdown detection (only on closing delimiter characters)
  const isClosingDelimiter =
    input === "*" || input === "`" || input === "~" || input === "$";
  let finalTextIndex = newTextIndex;

  if (isClosingDelimiter) {
    const markdownResult = detectAndApplyInlineMarkdown(
      pageAcc,
      oldBlock.id,
      newTextIndex,
      state.CRDTbinding,
    );
    if (markdownResult) {
      // Save history BEFORE applying markdown (with raw markdown text).
      // applyMarkdownPrefix mutates the block in place, so we operate on the
      // pre-markdown page's block directly.
      const blockBeforeMarkdown = pageAcc.blocks[blockIndex];
      ops.push(
        ...applyMarkdownPrefix(
          blockBeforeMarkdown,
          state.CRDTbinding,
          oldBlock.type !== "paragraph",
        ).ops,
      );
      invalidateBlockCache(blockBeforeMarkdown);

      let stateBeforeMarkdown: EditorState = {
        ...state,
        document: { ...state.document, page: pageAcc },
      };
      stateBeforeMarkdown = moveCursorToPosition(
        stateBeforeMarkdown,
        blockIndex,
        newTextIndex,
      );
      stateBeforeMarkdown = updateMode(stateBeforeMarkdown, "edit");

      // Record the state with raw markdown
      state = stateBeforeMarkdown;

      pageAcc = markdownResult.newPage;
      finalTextIndex = markdownResult.newTextIndex;
      ops.push(...markdownResult.ops);
    }
  }

  // Auto-detect URLs when a word boundary is typed (space)
  if (input === " ") {
    const currentBlock = pageAcc.blocks[blockIndex];
    if (isTextualBlock(currentBlock)) {
      const text = getVisibleTextFromRuns(currentBlock.charRuns);
      const linkResult = autoLinkAtCursor(
        pageAcc,
        oldBlock.id,
        text,
        finalTextIndex,
        state.CRDTbinding,
      );
      if (linkResult) {
        pageAcc = linkResult.newPage;
        ops.push(...linkResult.ops);
      }
    }
  }

  // Apply any markdown prefix (e.g. "## " → heading2). This mutates the
  // block in place; pageAcc.blocks[blockIndex] already holds the latest copy.
  const blockCopy = pageAcc.blocks[blockIndex];
  ops.push(
    ...applyMarkdownPrefix(
      blockCopy,
      state.CRDTbinding,
      oldBlock.type !== "paragraph",
    ).ops,
  );
  invalidateBlockCache(blockCopy);

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: pageAcc },
  };

  // If applyMarkdownPrefix converted this into a math block (e.g. user typed `$$`),
  // advance the cursor to the next block (creating one if needed) — math blocks
  // are non-textual, so the caret can't sit inside them.
  if ((blockCopy.type as string) === "math") {
    if (blockIndex + 1 >= pageAcc.blocks.length) {
      const newParagraphId = state.CRDTbinding.nextId();
      const newParagraph: Block = {
        id: newParagraphId,
        type: "paragraph",
        charRuns: [],
        formats: [],
      };
      const blockInsertOp: BlockInsert = {
        op: "block_insert",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        afterBlockId: blockCopy.id,
        blockId: newParagraphId,
        blockType: "paragraph",
      };
      ops.push(blockInsertOp);

      const blocksWithNewParagraph = [...pageAcc.blocks, newParagraph];
      newState = {
        ...newState,
        document: {
          ...newState.document,
          page: { ...pageAcc, blocks: blocksWithNewParagraph },
        },
      };
    }
    newState = moveCursorToPosition(newState, blockIndex + 1, 0);
    newState = clearAutoCreatedParagraph(newState);
    newState = updateMode(newState, "edit");
    return { state: newState, ops };
  }

  // Preserve active formats when moving cursor after typing
  newState = moveCursorToPosition(newState, blockIndex, finalTextIndex, true);
  newState = clearAutoCreatedParagraph(newState);
  newState = updateMode(newState, "edit");

  return { state: newState, ops };
}

/**
 * Find the inline-math format span covering a given visible-index position.
 * `position` is interpreted as a caret edge (0..length); `mode` controls whether
 * positions exactly at the edges are considered "in" the span.
 */
function findInlineMathSpan(
  block: Block,
  position: number,
  mode: "leftEdge" | "rightEdge" | "inside",
): { startIndex: number; endIndex: number } | null {
  if (!isTextualBlock(block)) return null;

  const visibleIds: string[] = [];
  for (const { id } of iterateVisibleChars(block.charRuns)) {
    visibleIds.push(id);
  }

  for (const span of block.formats) {
    if (span.format.type !== "math") continue;
    const startIdx = visibleIds.indexOf(span.startCharId);
    const endIdx = visibleIds.indexOf(span.endCharId);
    if (startIdx === -1 || endIdx === -1) continue;
    const spanStart = startIdx;
    const spanEnd = endIdx + 1;

    if (mode === "leftEdge" && position === spanStart) {
      return { startIndex: spanStart, endIndex: spanEnd };
    }
    if (mode === "rightEdge" && position === spanEnd) {
      return { startIndex: spanStart, endIndex: spanEnd };
    }
    if (mode === "inside" && position > spanStart && position < spanEnd) {
      return { startIndex: spanStart, endIndex: spanEnd };
    }
  }
  return null;
}

export function deleteText(state: EditorState): CommandResult {
  if (!state.document.cursor) {
    return { state, ops: [] };
  }

  const ops: Operation[] = [];

  // If composition is active, cancel it instead of deleting
  if (state.ui.composition) {
    return {
      state: {
        ...state,
        ui: {
          ...state.ui,
          composition: null,
        },
      },
      ops: [],
    };
  }

  // If there's a selection, delete it
  if (state.document.selection && !state.document.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return { state, ops };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops };

  const { blockIndex: blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];
  if (!isTextualBlock(oldBlock)) {
    return { state, ops };
  }

  // Inline math is atomic: backspace at the right edge of a math chip deletes
  // the whole chip in one go rather than chipping characters off the LaTeX.
  if (textIndex > 0) {
    const mathSpan = findInlineMathSpan(oldBlock, textIndex, "rightEdge");
    if (mathSpan) {
      const { newPage, op } = deleteCharsInRange(
        state.document.page,
        oldBlock.id,
        mathSpan.startIndex,
        mathSpan.endIndex,
        state.CRDTbinding,
      );
      ops.push(op);
      invalidateBlockCache(newPage.blocks[blockIndex]);
      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      newState = moveCursorToPosition(
        newState,
        blockIndex,
        mathSpan.startIndex,
        true,
      );
      return { state: newState, ops };
    }
  }

  if (textIndex > 0) {
    // Delete one character before cursor using CRDT helper
    const { newPage, op } = deleteCharsInRange(
      state.document.page,
      oldBlock.id,
      textIndex - 1,
      textIndex,
      state.CRDTbinding,
    );
    ops.push(op);

    const blockCopy = newPage.blocks[blockIndex];
    if (oldBlock.type === "paragraph") {
      ops.push(...applyMarkdownPrefix(blockCopy, state.CRDTbinding).ops);
    }
    invalidateBlockCache(blockCopy);
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };

    // Preserve active formats when deleting during typing (e.g., pressing backspace while in bold mode)
    newState = moveCursorToPosition(newState, blockIndex, textIndex - 1, true);
    return { state: newState, ops };
  } else {
    // Find previous visible (non-deleted) block — skip tombstones left by snapshot restore
    const prevBlockIndex = findPreviousVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );

    if (prevBlockIndex !== null) {
      // Special handling for list blocks at textIndex 0: outdent instead of merging
      if (isListBlock(oldBlock)) {
        const currentIndent = oldBlock.indent || 0;
        const currentText = getBlockTextContent(oldBlock);

        // If block is empty, delete it instead of outdenting or converting
        if (currentText.length === 0) {
          const prevBlock = state.document.page.blocks[prevBlockIndex];

          // Delete the empty list block
          const blockDeleteOp: Operation = {
            op: "block_delete",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: oldBlock.id,
          };
          ops.push(blockDeleteOp);

          const newBlocks = [
            ...state.document.page.blocks.slice(0, blockIndex),
            ...state.document.page.blocks.slice(blockIndex + 1),
          ];
          const newPage = { ...state.document.page, blocks: newBlocks };
          let newState: EditorState = {
            ...state,
            document: { ...state.document, page: newPage },
          };
          // Move cursor to end of previous visible block
          const prevTextLength = isTextualBlock(prevBlock)
            ? getBlockTextContent(prevBlock).length
            : 0;
          newState = moveCursorToPosition(
            newState,
            prevBlockIndex,
            prevTextLength,
          );
          return { state: newState, ops };
        }

        if (currentIndent > 0) {
          // Outdent the list item
          const outdentedBlock: Block = {
            ...oldBlock,
            indent: currentIndent - 1,
          };
          invalidateBlockCache(outdentedBlock);
          const newBlocks = [...state.document.page.blocks];
          newBlocks[blockIndex] = outdentedBlock;
          const newPage = { ...state.document.page, blocks: newBlocks };
          return {
            state: {
              ...state,
              document: { ...state.document, page: newPage },
            },
            ops,
          };
        } else {
          // At indent 0: convert to paragraph
          const paragraphBlock: Block = {
            id: oldBlock.id,
            type: "paragraph",
            charRuns: oldBlock.charRuns,
            formats: oldBlock.formats,
          };
          invalidateBlockCache(paragraphBlock);
          const newBlocks = [...state.document.page.blocks];
          newBlocks[blockIndex] = paragraphBlock;
          const newPage = { ...state.document.page, blocks: newBlocks };
          return {
            state: {
              ...state,
              document: { ...state.document, page: newPage },
            },
            ops,
          };
        }
      }

      const prevBlock = state.document.page.blocks[prevBlockIndex];

      // If previous block is not a text block (e.g., image)
      if (!isTextualBlock(prevBlock)) {
        if (!isTextualBlock(oldBlock)) {
          return { state, ops };
        }

        const currentText = getBlockTextContent(oldBlock);
        const imagePosition = { blockIndex: prevBlockIndex, textIndex: 0 };

        // Only delete the current text block if it's empty
        if (currentText.length === 0) {
          // Delete the empty text block
          const blockDeleteOp: Operation = {
            op: "block_delete",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: oldBlock.id,
          };
          ops.push(blockDeleteOp);

          const newBlocks = [
            ...state.document.page.blocks.slice(0, blockIndex),
            ...state.document.page.blocks.slice(blockIndex + 1),
          ];

          // If we deleted the last block, add an empty paragraph
          if (newBlocks.length === 0) {
            const emptyParagraphId = state.CRDTbinding.nextId();
            const emptyParagraph: Block = {
              id: emptyParagraphId,
              type: "paragraph",
              charRuns: [],
              formats: [],
            };

            const blockInsertOp: Operation = {
              op: "block_insert",
              id: state.CRDTbinding.nextId(),
              clock: state.CRDTbinding.getClock(),
              pageId: state.CRDTbinding.pageId,
              afterBlockId: null,
              blockId: emptyParagraphId,
              blockType: "paragraph",
            };
            ops.push(blockInsertOp);

            newBlocks.push(emptyParagraph);
          }

          const newPage = { ...state.document.page, blocks: newBlocks };
          let newState: EditorState = {
            ...state,
            document: { ...state.document, page: newPage },
          };

          // Select the previous (image) block
          newState = moveCursorToPosition(newState, prevBlockIndex, 0);
          newState = {
            ...newState,
            document: {
              ...newState.document,
              selection: {
                anchor: imagePosition,
                focus: imagePosition,
                isForward: true,
                isCollapsed: false,
                lastUpdate: Date.now(),
              },
            },
          };

          return { state: newState, ops };
        }

        // If current block has content, just select the image without deleting the text
        let newState = moveCursorToPosition(state, prevBlockIndex, 0);
        newState = {
          ...newState,
          document: {
            ...newState.document,
            selection: {
              anchor: imagePosition,
              focus: imagePosition,
              isForward: true,
              isCollapsed: false,
              lastUpdate: Date.now(),
            },
          },
        };

        return { state: newState, ops };
      }

      if (!isTextualBlock(oldBlock)) {
        return { state, ops };
      }

      const prevText = getBlockTextContent(prevBlock);
      const prevIsEmpty = prevText.length === 0;
      const blockToPreserve = prevIsEmpty ? oldBlock : prevBlock;
      const blockToDelete = prevIsEmpty ? prevBlock : oldBlock;

      const { newPage, ops: mergeOps } = mergeBlocksOps(
        state.document.page,
        blockToDelete,
        blockToPreserve,
        state.CRDTbinding,
      );
      ops.push(...mergeOps);

      const survivingIdx = newPage.blocks.findIndex(
        (b) => b.id === blockToPreserve.id && !b.deleted,
      );
      const survivingBlock =
        survivingIdx !== -1 ? newPage.blocks[survivingIdx] : null;
      if (survivingBlock) invalidateBlockCache(survivingBlock);

      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      // Cursor lands at the join point: end of preserved block's pre-merge
      // text when prev had content; start of preserved (old) block when prev
      // was empty.
      newState = moveCursorToPosition(
        newState,
        survivingIdx !== -1 ? survivingIdx : prevBlockIndex,
        prevIsEmpty ? 0 : prevText.length,
      );
      return { state: newState, ops };
    } else {
      // No previous visible block — this is the first visible block
      // If it's an empty list item, convert to paragraph
      if (isListBlock(oldBlock)) {
        const currentText = getBlockTextContent(oldBlock);
        if (currentText.length === 0) {
          const paragraphBlock: Block = {
            id: oldBlock.id,
            type: "paragraph",
            charRuns: oldBlock.charRuns,
            formats: oldBlock.formats,
          };
          invalidateBlockCache(paragraphBlock);
          const newBlocks = [...state.document.page.blocks];
          newBlocks[blockIndex] = paragraphBlock;
          const newPage = { ...state.document.page, blocks: newBlocks };
          return {
            state: {
              ...state,
              document: { ...state.document, page: newPage },
            },
            ops,
          };
        }
      }
    }
  }
  return { state, ops };
}

// Forward delete (Delete key) - deletes character after cursor
export function deleteForward(state: EditorState): CommandResult {
  if (!state.document.cursor) {
    return { state, ops: [] };
  }

  const ops: Operation[] = [];

  // If composition is active, cancel it instead of deleting
  if (state.ui.composition) {
    return {
      state: {
        ...state,
        ui: {
          ...state.ui,
          composition: null,
        },
      },
      ops: [],
    };
  }

  // If there's a selection, delete it
  if (state.document.selection && !state.document.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return { state, ops };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops };

  const { blockIndex: blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  if (!isTextualBlock(oldBlock)) {
    return { state, ops };
  }

  const oldText = getBlockTextContent(oldBlock);

  // Inline math is atomic: forward delete at the left edge of a math chip
  // removes the whole chip rather than chipping off the first LaTeX char.
  if (textIndex < oldText.length) {
    const mathSpan = findInlineMathSpan(oldBlock, textIndex, "leftEdge");
    if (mathSpan) {
      const { newPage, op } = deleteCharsInRange(
        state.document.page,
        oldBlock.id,
        mathSpan.startIndex,
        mathSpan.endIndex,
        state.CRDTbinding,
      );
      ops.push(op);
      invalidateBlockCache(newPage.blocks[blockIndex]);
      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      newState = moveCursorToPosition(
        newState,
        blockIndex,
        mathSpan.startIndex,
        true,
      );
      return { state: newState, ops };
    }
  }

  if (textIndex < oldText.length) {
    // Delete character after cursor using CRDT helper
    const { newPage, op } = deleteCharsInRange(
      state.document.page,
      oldBlock.id,
      textIndex,
      textIndex + 1,
      state.CRDTbinding,
    );
    ops.push(op);

    const blockCopy = newPage.blocks[blockIndex];
    if (oldBlock.type === "paragraph") {
      ops.push(...applyMarkdownPrefix(blockCopy, state.CRDTbinding).ops);
    }
    invalidateBlockCache(blockCopy);
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    // Preserve active formats when deleting during typing
    newState = moveCursorToPosition(newState, blockIndex, textIndex, true);
    return { state: newState, ops };
  } else {
    // Check for next visible block to merge with
    const nextBlockIndex = findNextVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );
    if (nextBlockIndex !== null) {
      // Merge with next block, preserving formatting
      const nextBlock = state.document.page.blocks[nextBlockIndex];

      // If next block is not a text block (e.g., image), delete the current text block
      if (!isTextualBlock(nextBlock)) {
        // Delete the current text block
        const blockDeleteOp: Operation = {
          op: "block_delete",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          blockId: oldBlock.id,
        };
        ops.push(blockDeleteOp);

        const newBlocks = [
          ...state.document.page.blocks.slice(0, blockIndex),
          ...state.document.page.blocks.slice(blockIndex + 1),
        ];

        // If we deleted the last block, add an empty paragraph
        if (newBlocks.length === 0) {
          const emptyParagraphId = state.CRDTbinding.nextId();
          const emptyParagraph: Block = {
            id: emptyParagraphId,
            type: "paragraph",
            charRuns: [],
            formats: [],
          };

          const blockInsertOp: Operation = {
            op: "block_insert",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            afterBlockId: null,
            blockId: emptyParagraphId,
            blockType: "paragraph",
          };
          ops.push(blockInsertOp);

          newBlocks.push(emptyParagraph);
        }

        const newPage = { ...state.document.page, blocks: newBlocks };
        let newState: EditorState = {
          ...state,
          document: { ...state.document, page: newPage },
        };

        // Select the next (image) block, which is now at blockIndex after deletion
        const imageBlockIndex = blockIndex;
        const imagePosition = { blockIndex: imageBlockIndex, textIndex: 0 };
        newState = moveCursorToPosition(newState, imageBlockIndex, 0);
        newState = {
          ...newState,
          document: {
            ...newState.document,
            selection: {
              anchor: imagePosition,
              focus: imagePosition,
              isForward: true,
              isCollapsed: false,
              lastUpdate: Date.now(),
            },
          },
        };

        return { state: newState, ops };
      }

      const currentIsEmpty = oldText.length === 0;
      const blockToPreserve = currentIsEmpty ? nextBlock : oldBlock;
      const blockToDelete = currentIsEmpty ? oldBlock : nextBlock;

      const { newPage, ops: mergeOps } = mergeBlocksOps(
        state.document.page,
        blockToDelete,
        blockToPreserve,
        state.CRDTbinding,
      );
      ops.push(...mergeOps);

      const survivingIdx = newPage.blocks.findIndex(
        (b) => b.id === blockToPreserve.id && !b.deleted,
      );
      const survivingBlock =
        survivingIdx !== -1 ? newPage.blocks[survivingIdx] : null;
      if (survivingBlock) invalidateBlockCache(survivingBlock);

      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      // Cursor stays at the join point: textIndex (end of preserved old's
      // pre-merge text) when old was non-empty; 0 (start of next) otherwise.
      newState = moveCursorToPosition(
        newState,
        survivingIdx !== -1 ? survivingIdx : blockIndex,
        currentIsEmpty ? 0 : textIndex,
      );
      return { state: newState, ops };
    }
  }
  return { state, ops };
}

// Helper function to find word boundaries - distinguishes between word characters and non-word characters
// Uses Unicode property escapes to support all languages
// For CJK text, each character is treated as a word boundary
function findWordBoundary(
  text: string,
  index: number,
  direction: "left" | "right",
): number {
  if (direction === "left") {
    // Move left to find start of previous word
    let i = index;

    if (i === 0) return 0;

    // Check if current position is a CJK character
    if (i > 0 && isCJKCharacter(text[i - 1])) {
      // For CJK, move one character at a time
      return i - 1;
    }

    // Skip current character type for non-CJK
    const startIsWordChar = /[\p{L}\p{N}_]/u.test(text[i - 1]);
    if (startIsWordChar) {
      while (
        i > 0 &&
        /[\p{L}\p{N}_]/u.test(text[i - 1]) &&
        !isCJKCharacter(text[i - 1])
      ) {
        i--;
      }
    } else {
      while (i > 0 && !/[\p{L}\p{N}_]/u.test(text[i - 1])) {
        i--;
      }
    }

    return i;
  } else {
    // Move right to find end of next word
    let i = index;

    if (i === text.length) return text.length;

    // Check if current position is a CJK character
    if (i < text.length && isCJKCharacter(text[i])) {
      // For CJK, move one character at a time
      return i + 1;
    }

    // Skip current character type for non-CJK
    const startIsWordChar = /[\p{L}\p{N}_]/u.test(text[i]);
    if (startIsWordChar) {
      while (
        i < text.length &&
        /[\p{L}\p{N}_]/u.test(text[i]) &&
        !isCJKCharacter(text[i])
      ) {
        i++;
      }
    } else {
      while (i < text.length && !/[\p{L}\p{N}_]/u.test(text[i])) {
        i++;
      }
    }

    return i;
  }
}

function findWordDeleteBoundaryLeft(text: string, index: number): number {
  let i = index;

  if (i === 0) return 0;

  // For CJK characters, delete one character at a time
  if (isCJKCharacter(text[i - 1])) {
    return i - 1;
  }

  // Check what type of character we're starting from (Unicode-aware)
  const isWordChar = /[\p{L}\p{N}_]/u.test(text[i - 1]);

  if (isWordChar) {
    // Delete word characters (Unicode letters, numbers, underscores)
    while (
      i > 0 &&
      /[\p{L}\p{N}_]/u.test(text[i - 1]) &&
      !isCJKCharacter(text[i - 1])
    ) {
      i--;
    }
  } else {
    // Delete non-word characters (spaces, punctuation, special characters together)
    while (i > 0 && !/[\p{L}\p{N}_]/u.test(text[i - 1])) {
      i--;
    }
  }

  return i;
}

function findWordDeleteBoundaryRight(text: string, index: number): number {
  let i = index;

  if (i === text.length) return text.length;

  // For CJK characters, delete one character at a time
  if (isCJKCharacter(text[i])) {
    return i + 1;
  }

  // Check what type of character we're starting from (Unicode-aware)
  const isWordChar = /[\p{L}\p{N}_]/u.test(text[i]);

  if (isWordChar) {
    // Delete word characters (Unicode letters, numbers, underscores)
    while (
      i < text.length &&
      /[\p{L}\p{N}_]/u.test(text[i]) &&
      !isCJKCharacter(text[i])
    ) {
      i++;
    }
  } else {
    // Delete non-word characters (spaces, punctuation, special characters together)
    while (i < text.length && !/[\p{L}\p{N}_]/u.test(text[i])) {
      i++;
    }
  }

  return i;
}

// Move cursor to previous word boundary
export function moveToPreviousWord(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return state;

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return state;

  const { blockIndex: blockIndex, textIndex } = position;
  const block = state.document.page.blocks[blockIndex];
  const text = getBlockTextContent(block);

  if (!isTextualBlock(block)) {
    return state;
  }

  // Check if current block is RTL
  const isRTL = isBlockRTL(block.charRuns);

  if (isRTL) {
    // In RTL, "previous word" (Ctrl+Left) should move visually left, which is logically forward
    if (textIndex < text.length) {
      const newIndex = findWordBoundary(text, textIndex, "right");
      return moveCursorToPosition(state, blockIndex, newIndex);
    } else {
      // Move to start of next visible block
      const nextBlockIndex = findNextVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (nextBlockIndex !== null) {
        return moveCursorToPosition(state, nextBlockIndex, 0);
      }
    }
  } else {
    // LTR behavior (original)
    if (textIndex > 0) {
      const newIndex = findWordBoundary(text, textIndex, "left");
      return moveCursorToPosition(state, blockIndex, newIndex);
    } else {
      // Move to end of previous visible block
      const prevBlockIndex = findPreviousVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (prevBlockIndex !== null) {
        const prevBlock = state.document.page.blocks[prevBlockIndex];
        const prevText = getBlockTextContent(prevBlock);
        return moveCursorToPosition(state, prevBlockIndex, prevText.length);
      }
    }
  }
  return state;
}

// Move cursor to next word boundary
export function moveToNextWord(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return state;

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return state;

  const { blockIndex: blockIndex, textIndex } = position;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return state;
  const text = getBlockTextContent(block);

  if (!isTextualBlock(block)) {
    return state;
  }

  // Check if current block is RTL
  const isRTL = isBlockRTL(block.charRuns);

  if (isRTL) {
    // In RTL, "next word" (Ctrl+Right) should move visually right, which is logically backward
    if (textIndex > 0) {
      const newIndex = findWordBoundary(text, textIndex, "left");
      return moveCursorToPosition(state, blockIndex, newIndex);
    } else {
      // Move to end of previous visible block
      const prevBlockIndex = findPreviousVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (prevBlockIndex !== null) {
        const prevBlock = state.document.page.blocks[prevBlockIndex];
        const prevText = getBlockTextContent(prevBlock);
        return moveCursorToPosition(state, prevBlockIndex, prevText.length);
      }
    }
  } else {
    // LTR behavior (original)
    if (textIndex < text.length) {
      const newIndex = findWordBoundary(text, textIndex, "right");
      return moveCursorToPosition(state, blockIndex, newIndex);
    } else {
      // Move to start of next visible block
      const nextBlockIndex = findNextVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (nextBlockIndex !== null) {
        return moveCursorToPosition(state, nextBlockIndex, 0);
      }
    }
  }
  return state;
}

export function deleteWordForward(state: EditorState): CommandResult {
  if (!state.document.cursor) {
    return { state, ops: [] };
  }

  const ops: Operation[] = [];

  if (state.document.selection && !state.document.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return { state, ops };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops };

  const { blockIndex: blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];
  if (!isTextualBlock(oldBlock)) {
    return { state, ops };
  }

  const oldText = getBlockTextContent(oldBlock);

  if (textIndex < oldText.length) {
    // Delete word forward within the current line using CRDT helper
    const endIndex = findWordDeleteBoundaryRight(oldText, textIndex);
    const { newPage, op } = deleteCharsInRange(
      state.document.page,
      oldBlock.id,
      textIndex,
      endIndex,
      state.CRDTbinding,
    );
    ops.push(op);

    const blockCopy = newPage.blocks[blockIndex];
    if (oldBlock.type === "paragraph") {
      ops.push(...applyMarkdownPrefix(blockCopy, state.CRDTbinding).ops);
    }
    invalidateBlockCache(blockCopy);
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    // Preserve active formats when deleting during typing
    newState = moveCursorToPosition(newState, blockIndex, textIndex, true);
    return { state: newState, ops };
  } else {
    // Check for next visible block
    const nextBlockIndex = findNextVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );
    if (nextBlockIndex !== null) {
      // Special handling for list blocks at end of text: don't merge, just return
      // This prevents Ctrl+Delete from merging list items when at the end
      if (isListBlock(oldBlock)) {
        return { state, ops };
      }

      // At end of line - merge with next block, preserving formatting
      const nextBlock = state.document.page.blocks[nextBlockIndex];
      if (!isTextualBlock(nextBlock)) {
        return { state, ops };
      }
      const currentIsEmpty = oldText.length === 0;
      const blockToPreserve = currentIsEmpty ? nextBlock : oldBlock;
      const blockToDelete = currentIsEmpty ? oldBlock : nextBlock;

      const { newPage, ops: mergeOps } = mergeBlocksOps(
        state.document.page,
        blockToDelete,
        blockToPreserve,
        state.CRDTbinding,
      );
      ops.push(...mergeOps);

      const survivingIdx = newPage.blocks.findIndex(
        (b) => b.id === blockToPreserve.id && !b.deleted,
      );
      const survivingBlock =
        survivingIdx !== -1 ? newPage.blocks[survivingIdx] : null;
      if (survivingBlock) invalidateBlockCache(survivingBlock);

      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      newState = moveCursorToPosition(
        newState,
        survivingIdx !== -1 ? survivingIdx : blockIndex,
        currentIsEmpty ? 0 : textIndex,
      );
      return { state: newState, ops };
    }
  }
  return { state, ops };
}

export function deleteWordBackward(state: EditorState): CommandResult {
  if (!state.document.cursor) {
    return { state, ops: [] };
  }

  const ops: Operation[] = [];

  if (state.document.selection && !state.document.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return { state, ops };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops };

  const { blockIndex: blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  if (!isTextualBlock(oldBlock)) {
    return { state, ops };
  }

  const oldText = getBlockTextContent(oldBlock);

  if (textIndex > 0) {
    // Delete word backward within the current line using CRDT helper
    const startIndex = findWordDeleteBoundaryLeft(oldText, textIndex);
    const { newPage, op } = deleteCharsInRange(
      state.document.page,
      oldBlock.id,
      startIndex,
      textIndex,
      state.CRDTbinding,
    );
    ops.push(op);

    const blockCopy = newPage.blocks[blockIndex];
    if (oldBlock.type === "paragraph") {
      ops.push(...applyMarkdownPrefix(blockCopy, state.CRDTbinding).ops);
    }
    invalidateBlockCache(blockCopy);
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    // Preserve active formats when deleting during typing
    newState = moveCursorToPosition(newState, blockIndex, startIndex, true);
    return { state: newState, ops };
  } else if (blockIndex > 0) {
    // Special handling for list blocks at textIndex 0: don't delete/merge, just return
    // This prevents Ctrl+Backspace from merging list items when at the start
    if (isListBlock(oldBlock)) {
      return { state, ops };
    }

    // At start of line - merge with previous block, preserving formatting
    const prevBlock = state.document.page.blocks[blockIndex - 1];
    if (!isTextualBlock(prevBlock)) {
      return { state, ops };
    }
    const prevText = getBlockTextContent(prevBlock);
    const prevIsEmpty = prevText.length === 0;
    const blockToPreserve = prevIsEmpty ? oldBlock : prevBlock;
    const blockToDelete = prevIsEmpty ? prevBlock : oldBlock;

    const { newPage, ops: mergeOps } = mergeBlocksOps(
      state.document.page,
      blockToDelete,
      blockToPreserve,
      state.CRDTbinding,
    );
    ops.push(...mergeOps);

    const survivingIdx = newPage.blocks.findIndex(
      (b) => b.id === blockToPreserve.id && !b.deleted,
    );
    const survivingBlock =
      survivingIdx !== -1 ? newPage.blocks[survivingIdx] : null;
    if (survivingBlock) invalidateBlockCache(survivingBlock);

    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    newState = moveCursorToPosition(
      newState,
      survivingIdx !== -1 ? survivingIdx : blockIndex - 1,
      prevIsEmpty ? 0 : prevText.length,
    );
    return { state: newState, ops };
  }
  return { state, ops };
}

// Find word boundaries for selection - only selects word characters (letters, numbers, underscore)
// Uses Unicode property escapes to support all languages
// For CJK characters, each character is treated as a word
function findWordStart(text: string, index: number): number {
  let i = index;

  // If we're at a CJK character, just select that one character
  if (i < text.length && isCJKCharacter(text[i])) {
    return i;
  }

  // Move left while we're in word characters (Unicode letters, numbers, or underscore)
  // Stop at CJK characters
  while (
    i > 0 &&
    /[\p{L}\p{N}_]/u.test(text[i - 1]) &&
    !isCJKCharacter(text[i - 1])
  ) {
    i--;
  }
  return i;
}

function findWordEnd(text: string, index: number): number {
  let i = index;

  // If we're at a CJK character, just select that one character
  if (i < text.length && isCJKCharacter(text[i])) {
    return i + 1;
  }

  // Move right while we're in word characters (Unicode letters, numbers, or underscore)
  // Stop at CJK characters
  while (
    i < text.length &&
    /[\p{L}\p{N}_]/u.test(text[i]) &&
    !isCJKCharacter(text[i])
  ) {
    i++;
  }
  return i;
}

// Select word at cursor position (for double-click)
export function selectWordAtPosition(
  state: EditorState,
  position: Position,
): EditorState {
  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const positionCRDT = positionToCRDT(state.document.page, position);
  if (!positionCRDT) return state;

  const validPosition = crdtToPosition(state.document.page, positionCRDT);
  if (!validPosition) return state;

  const { blockIndex: blockIndex, textIndex } = validPosition;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return state;
  const text = getBlockTextContent(block);

  if (text.length === 0) return state;

  // Check if we're on a word character (Unicode letter, number, or underscore)
  const isOnWord =
    textIndex < text.length && /[\p{L}\p{N}_]/u.test(text[textIndex]);

  if (!isOnWord) {
    // If not on a word, don't select anything
    return state;
  }

  // Find word boundaries
  const wordStart = findWordStart(text, textIndex);
  const wordEnd = findWordEnd(text, textIndex);

  // If we're not in a word, don't select anything
  if (wordStart === wordEnd) return state;

  const startPos: Position = { blockIndex: blockIndex, textIndex: wordStart };
  const endPos: Position = { blockIndex: blockIndex, textIndex: wordEnd };

  // Create selection from word start to word end, with cursor at end
  // Store initial boundary so anchor can adjust properly on drag
  let newState = moveCursorToPosition(state, blockIndex, wordEnd);
  newState = {
    ...newState,
    document: {
      ...newState.document,
      selection: {
        anchor: startPos,
        focus: endPos,
        isForward: true,
        isCollapsed: false,
        lastUpdate: Date.now(),
        initialBoundary: {
          start: startPos,
          end: endPos,
        },
      },
    },
  };
  return updateMode(newState, "select");
}

// Select entire line/paragraph (for triple-click)
export function selectLineAtPosition(
  state: EditorState,
  position: Position,
): EditorState {
  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const positionCRDT = positionToCRDT(state.document.page, position);
  if (!positionCRDT) return state;

  const validPosition = crdtToPosition(state.document.page, positionCRDT);
  if (!validPosition) return state;

  const { blockIndex: blockIndex } = validPosition;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return state;
  const text = getBlockTextContent(block);

  const startPos: Position = { blockIndex: blockIndex, textIndex: 0 };
  const endPos: Position = { blockIndex: blockIndex, textIndex: text.length };

  // Create selection for entire block
  // Store initial boundary so anchor can adjust properly on drag
  let newState = moveCursorToPosition(state, blockIndex, text.length);
  newState = {
    ...newState,
    document: {
      ...newState.document,
      selection: {
        anchor: startPos,
        focus: endPos,
        isForward: true,
        isCollapsed: false,
        lastUpdate: Date.now(),
        initialBoundary: {
          start: startPos,
          end: endPos,
        },
      },
    },
  };
  return updateMode(newState, "select");
}

// Move to start of current line (Home key)
export function moveToLineStart(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return state;

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return state;

  const { blockIndex: blockIndex } = position;
  return moveCursorToPosition(state, blockIndex, 0);
}

// Move to end of current line (End key)
export function moveToLineEnd(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return state;

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return state;

  const { blockIndex: blockIndex } = position;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return state;
  const text = getBlockTextContent(block);
  return moveCursorToPosition(state, blockIndex, text.length);
}

export function extendSelectionWordLeft(state: EditorState): EditorState {
  if (!state.document.cursor) return state;
  // If no selection exists, start one at current cursor position
  let newState = state;
  if (!state.document.selection) {
    newState = startSelection(state, state.document.cursor.position);
  }
  // Move cursor to previous word boundary
  const movedState = moveToPreviousWord(newState);
  if (movedState.document.cursor) {
    return updateSelectionFocus(
      movedState,
      movedState.document.cursor.position,
    );
  }
  return newState;
}

export function extendSelectionWordRight(state: EditorState): EditorState {
  if (!state.document.cursor) return state;
  // If no selection exists, start one at current cursor position
  let newState = state;
  if (!state.document.selection) {
    newState = startSelection(state, state.document.cursor.position);
  }
  // Move cursor to next word boundary
  const movedState = moveToNextWord(newState);
  if (movedState.document.cursor) {
    return updateSelectionFocus(
      movedState,
      movedState.document.cursor.position,
    );
  }
  return newState;
}

export function extendSelectionHome(
  state: EditorState,
  isCtrl: boolean,
): EditorState {
  if (!state.document.cursor) return state;
  // If no selection exists, start one at current cursor position
  let newState = state;
  if (!state.document.selection) {
    newState = startSelection(state, state.document.cursor.position);
  }
  // Move cursor to start of line or document
  const movedState = isCtrl
    ? moveCursorToPosition(newState, 0, 0)
    : moveToLineStart(newState);
  if (movedState.document.cursor) {
    return updateSelectionFocus(
      movedState,
      movedState.document.cursor.position,
    );
  }
  return newState;
}

export function extendSelectionEnd(
  state: EditorState,
  isCtrl: boolean,
): EditorState {
  if (!state.document.cursor) return state;
  // If no selection exists, start one at current cursor position
  let newState = state;
  if (!state.document.selection) {
    newState = startSelection(state, state.document.cursor.position);
  }
  // Move cursor to end of line or document
  const movedState = isCtrl
    ? (() => {
        // Get last visible block and find its index in the full array
        const visibleBlocks = newState.view.visibleBlocks;
        if (visibleBlocks.length === 0) return newState;
        const lastVisibleBlock = visibleBlocks[visibleBlocks.length - 1];
        const allBlocks = newState.document.page.blocks;
        const lastVisibleBlockIndex = allBlocks.findIndex(
          (b) => b.id === lastVisibleBlock.id,
        );
        if (lastVisibleBlockIndex === -1) return newState;
        return moveCursorToPosition(
          newState,
          lastVisibleBlockIndex,
          getBlockTextLength(lastVisibleBlock),
        );
      })()
    : moveToLineEnd(newState);
  if (movedState.document.cursor) {
    return updateSelectionFocus(
      movedState,
      movedState.document.cursor.position,
    );
  }
  return newState;
}

export function splitBlock(state: EditorState): CommandResult {
  if (!state.document.cursor) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return { state, ops: [] };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops: [] };

  const { blockIndex: blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  // Handle Enter key on selected visual block (image/math/line): create new paragraph below
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const { anchor, focus } = state.document.selection;
    // Check if this is a single visual-block selection (anchor and focus at same position)
    if (
      anchor.blockIndex === focus.blockIndex &&
      anchor.textIndex === focus.textIndex
    ) {
      const block = state.document.page.blocks[anchor.blockIndex];
      if (block && !block.deleted && !isTextualBlock(block)) {
        // Create a new paragraph below the image
        const newParagraphId = state.CRDTbinding.nextId();
        const newParagraph: Block = {
          id: newParagraphId,
          type: "paragraph",
          charRuns: [],
          formats: [],
        };

        const newBlocks = [
          ...state.document.page.blocks.slice(0, blockIndex + 1),
          newParagraph,
          ...state.document.page.blocks.slice(blockIndex + 1),
        ];
        const newPage = { ...state.document.page, blocks: newBlocks };

        // Create CRDT operation for new paragraph after image
        const blockInsertOp: BlockInsert = {
          op: "block_insert",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          afterBlockId: oldBlock.id,
          blockId: newParagraphId,
          blockType: "paragraph",
        };
        ops.push(blockInsertOp);

        let newState: EditorState = {
          ...state,
          document: { ...state.document, page: newPage },
        };
        newState = clearSelection(newState);
        newState = moveCursorToPosition(newState, blockIndex + 1, 0);
        return { state: newState, ops };
      }
    }
  }

  if (!isTextualBlock(oldBlock)) {
    return { state, ops: [] };
  }

  // Auto-detect URLs before splitting (Enter acts as a word boundary)
  let currentBlock = oldBlock;
  {
    const text = getVisibleTextFromRuns(currentBlock.charRuns);
    const linkResult = autoLinkAtCursor(
      state.document.page,
      currentBlock.id,
      text,
      textIndex,
      state.CRDTbinding,
    );
    if (linkResult) {
      const linkedBlock = linkResult.newPage.blocks[blockIndex];
      if (isTextualBlock(linkedBlock)) {
        currentBlock = linkedBlock;
      }
      invalidateBlockCache(currentBlock);
      ops.push(...linkResult.ops);

      state = {
        ...state,
        document: { ...state.document, page: linkResult.newPage },
      };
    }
  }

  const oldText = getVisibleTextFromRuns(currentBlock.charRuns);

  // Preserve the original block type for both blocks
  const originalType = currentBlock.type;

  // Determine types for both blocks based on cursor position
  const isAtStart = textIndex === 0;
  const isAtEnd = textIndex === oldText.length;
  const isEmpty = oldText.length === 0;

  // Handle list blocks
  if (isListBlock(oldBlock)) {
    // When Enter is pressed in an empty list item, outdent or convert to paragraph
    if (isEmpty) {
      if (oldBlock.indent === 0) {
        // Convert to paragraph if at base indent
        const newParagraph: Block = {
          id: oldBlock.id,
          type: "paragraph",
          charRuns: [],
          formats: [],
        };

        const blockSetOp: BlockSet = {
          op: "block_set",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          blockId: oldBlock.id,
          field: "type",
          value: "paragraph",
        };
        ops.push(blockSetOp);

        const newBlocks = [
          ...state.document.page.blocks.slice(0, blockIndex),
          newParagraph,
          ...state.document.page.blocks.slice(blockIndex + 1),
        ];
        const newPage = { ...state.document.page, blocks: newBlocks };
        return {
          state: {
            ...state,
            document: { ...state.document, page: newPage },
          },
          ops,
        };
      } else {
        // Outdent the list item
        const outdentedBlock: Block = {
          ...oldBlock,
          indent: oldBlock.indent - 1,
        };
        invalidateBlockCache(outdentedBlock);

        const blockSetOp: BlockSet = {
          op: "block_set",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          blockId: oldBlock.id,
          field: "indent",
          value: oldBlock.indent - 1,
        };
        ops.push(blockSetOp);

        const newBlocks = [...state.document.page.blocks];
        newBlocks[blockIndex] = outdentedBlock;
        const newPage = { ...state.document.page, blocks: newBlocks };
        return {
          state: {
            ...state,
            document: { ...state.document, page: newPage },
          },
          ops,
        };
      }
    }

    // Split the text content at cursor position
    const afterCharsText = oldText.slice(textIndex);
    let pageAcc = state.document.page;
    if (textIndex < oldText.length) {
      const { newPage: pageAfterDelete, op: deleteOp } = deleteCharsInRange(
        pageAcc,
        oldBlock.id,
        textIndex,
        oldText.length,
        state.CRDTbinding,
      );
      pageAcc = pageAfterDelete;
      ops.push(deleteOp);
    }

    const newBlockId = state.CRDTbinding.nextId();
    const newBlockType: "bullet_list" | "numbered_list" | "todo_list" =
      oldBlock.type === "bullet_list" || oldBlock.type === "numbered_list"
        ? oldBlock.type
        : "todo_list";

    const blockInsertOp: BlockInsert = {
      op: "block_insert",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      afterBlockId: oldBlock.id,
      blockId: newBlockId,
      blockType: newBlockType,
      initialProps:
        oldBlock.type === "todo_list"
          ? { checked: false, indent: oldBlock.indent }
          : { indent: oldBlock.indent },
    };
    ops.push(blockInsertOp);
    pageAcc = applyOps(pageAcc, [blockInsertOp]);

    if (afterCharsText.length > 0) {
      const { newPage: pageAfterInsert, op: insertOp } = insertCharsAtPosition(
        pageAcc,
        newBlockId,
        0,
        afterCharsText,
        state.CRDTbinding,
      );
      pageAcc = pageAfterInsert;
      ops.push(insertOp);
    }

    const block1Index = pageAcc.blocks.findIndex((b) => b.id === oldBlock.id);
    const block2Index = pageAcc.blocks.findIndex((b) => b.id === newBlockId);
    if (block1Index !== -1) invalidateBlockCache(pageAcc.blocks[block1Index]);
    if (block2Index !== -1) invalidateBlockCache(pageAcc.blocks[block2Index]);

    const newState: EditorState = {
      ...state,
      document: { ...state.document, page: pageAcc },
    };
    return {
      state: moveCursorToPosition(
        newState,
        block2Index !== -1 ? block2Index : blockIndex + 1,
        0,
      ),
      ops,
    };
  }

  // Handle heading and paragraph blocks (non-list text blocks)
  let blockCopy1Type: Block["type"];
  let blockCopy2Type: "heading1" | "heading2" | "heading3" | "paragraph";

  if (originalType.startsWith("heading")) {
    const headingType = originalType as "heading1" | "heading2" | "heading3";
    if (isEmpty) {
      // Empty heading: keep heading above, create paragraph below
      blockCopy1Type = headingType;
      blockCopy2Type = "paragraph";
    } else if (isAtStart) {
      // At start of non-empty heading: new block above should be paragraph, heading stays below
      blockCopy1Type = "paragraph";
      blockCopy2Type = headingType;
    } else if (isAtEnd) {
      // At end of non-empty heading: heading stays above, new block below should be paragraph
      blockCopy1Type = headingType;
      blockCopy2Type = "paragraph";
    } else {
      // In middle of heading: split into two headings
      blockCopy1Type = headingType;
      blockCopy2Type = headingType;
    }
  } else {
    // For paragraphs, preserve the type
    blockCopy1Type = "paragraph";
    blockCopy2Type = "paragraph";
  }

  // Split the text content. Every modification below routes through ops
  // and is replayed onto `pageAcc` via applyOps, so the local page state
  // ends up byte-identical to what `applyOps(pre-split-page, ops)` would
  // produce on a remote peer — no manual block overrides needed.
  const afterCharsText = oldText.slice(textIndex);
  let pageAcc = state.document.page;

  // 1. Delete text after cursor from block 1.
  if (textIndex < oldText.length) {
    const { newPage: pageAfterDelete, op: deleteOp } = deleteCharsInRange(
      pageAcc,
      oldBlock.id,
      textIndex,
      oldText.length,
      state.CRDTbinding,
    );
    pageAcc = pageAfterDelete;
    ops.push(deleteOp);
  }

  // 2. Apply markdown-prefix detection on block 1.
  //    applyMarkdownPrefix mutates its argument AND pushes the corresponding
  //    ops; we feed it a throwaway clone and apply the ops to pageAcc so
  //    pageAcc stays the single source of truth. Only blockCopy1.type from
  //    the clone matters downstream — to decide whether to emit an extra
  //    block_set in step 3.
  const typeBeforeMarkdown = blockCopy1Type;
  if (blockCopy1Type === "paragraph") {
    const currentBlock1 = pageAcc.blocks.find((b) => b.id === oldBlock.id);
    if (currentBlock1 && isTextualBlock(currentBlock1)) {
      const mutableClone = { ...currentBlock1, type: blockCopy1Type } as Block;
      const { ops: prefixOps } = applyMarkdownPrefix(
        mutableClone,
        state.CRDTbinding,
      );
      if (prefixOps.length > 0) {
        ops.push(...prefixOps);
        pageAcc = applyOps(pageAcc, prefixOps);
      }
      blockCopy1Type = mutableClone.type;
    }
  }

  // 3. If our split logic wants a type different from the original but
  //    applyMarkdownPrefix didn't already cover it (e.g. heading → paragraph
  //    at the start of a heading), emit a block_set and apply it.
  if (
    blockCopy1Type !== originalType &&
    blockCopy1Type === typeBeforeMarkdown
  ) {
    const blockSetOp: BlockSet = {
      op: "block_set",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: oldBlock.id,
      field: "type",
      value: blockCopy1Type,
    };
    ops.push(blockSetOp);
    pageAcc = applyOps(pageAcc, [blockSetOp]);
  }

  // 4. Insert block 2 (before its text so remote peers have the block when
  //    text ops for it arrive).
  const newBlockId = state.CRDTbinding.nextId();
  const blockInsertOp: BlockInsert = {
    op: "block_insert",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    afterBlockId: oldBlock.id,
    blockId: newBlockId,
    blockType: blockCopy2Type,
  };
  ops.push(blockInsertOp);
  pageAcc = applyOps(pageAcc, [blockInsertOp]);

  // 5. Insert text into block 2.
  if (afterCharsText.length > 0) {
    const { newPage: pageAfterInsert, op: insertOp } = insertCharsAtPosition(
      pageAcc,
      newBlockId,
      0,
      afterCharsText,
      state.CRDTbinding,
    );
    pageAcc = pageAfterInsert;
    ops.push(insertOp);
  }

  // 6. Transfer format spans covering the after-cursor range onto block 2.
  //    Match each original FormatSpan against the inserted chars, emit one
  //    format_set per overlap, then apply them to pageAcc in one batch.
  const block2 = pageAcc.blocks.find((b) => b.id === newBlockId);
  const block2CharRuns: CharRun[] =
    block2 && isTextualBlock(block2) ? block2.charRuns : [];
  if (afterCharsText.length > 0 && currentBlock.formats.length > 0) {
    const afterCharIds: string[] = [];
    let visibleCount = 0;
    for (const { id } of iterateVisibleChars(oldBlock.charRuns)) {
      if (visibleCount >= textIndex) {
        afterCharIds.push(id);
      }
      visibleCount++;
      if (afterCharIds.length >= afterCharsText.length) break;
    }

    const newCharIds: string[] = [];
    for (const { id } of iterateVisibleChars(block2CharRuns)) {
      newCharIds.push(id);
    }

    if (afterCharIds.length === newCharIds.length && afterCharIds.length > 0) {
      const oldIdToNewId = new Map<string, string>();
      for (let i = 0; i < afterCharIds.length; i++) {
        oldIdToNewId.set(afterCharIds[i], newCharIds[i]);
      }

      const formatOps: FormatSet[] = [];
      for (const span of currentBlock.formats) {
        const coveredNewIds: string[] = [];
        for (const oldId of afterCharIds) {
          if (
            isCharIdInRange(
              oldBlock.charRuns,
              oldId,
              span.startCharId,
              span.endCharId,
            )
          ) {
            coveredNewIds.push(oldIdToNewId.get(oldId)!);
          }
        }

        if (coveredNewIds.length > 0) {
          formatOps.push({
            op: "format_set",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: newBlockId,
            charIds: coveredNewIds,
            format: span.format,
            value: span.format.type === "link" ? span.format.url || true : true,
          });
        }
      }

      if (formatOps.length > 0) {
        ops.push(...formatOps);
        pageAcc = applyOps(pageAcc, formatOps);
      }
    }
  }

  // 7. Invalidate render caches on the final pageAcc blocks (NOT on any
  //    intermediate clone — invalidateBlockCache mutates the block ref
  //    in place, and only the rendered ref's caches need clearing).
  const block1Final = pageAcc.blocks.find((b) => b.id === oldBlock.id);
  const block2Final = pageAcc.blocks.find((b) => b.id === newBlockId);
  if (block1Final) invalidateBlockCache(block1Final);
  if (block2Final) invalidateBlockCache(block2Final);

  const newState: EditorState = {
    ...state,
    document: { ...state.document, page: pageAcc },
  };
  return {
    state: moveCursorToPosition(newState, blockIndex + 1, 0),
    ops,
  };
}

export function selectAll(state: EditorState): EditorState {
  const visibleBlocks = state.view.visibleBlocks;
  if (visibleBlocks.length === 0) return state;

  const allBlocks = state.document.page.blocks;
  const firstVisibleBlock = visibleBlocks[0];
  const firstBlockIndex = allBlocks.findIndex(
    (b) => b.id === firstVisibleBlock.id,
  );
  const startPos: Position = {
    blockIndex: firstBlockIndex >= 0 ? firstBlockIndex : 0,
    textIndex: 0,
  };

  const lastVisibleBlock = visibleBlocks[visibleBlocks.length - 1];
  const lastBlockIndex = allBlocks.findIndex(
    (b) => b.id === lastVisibleBlock.id,
  );
  if (lastBlockIndex === -1) return state;
  const lastBlock = allBlocks[lastBlockIndex];
  const lastBlockText = getBlockTextContent(lastBlock);
  const endPos: Position = {
    blockIndex: lastBlockIndex,
    textIndex: lastBlockText.length,
  };

  let newState = moveCursorToPosition(
    state,
    endPos.blockIndex,
    endPos.textIndex,
  );
  newState = startSelection(newState, startPos);
  newState = updateSelectionFocus(newState, endPos);
  return updateMode(newState, "edit");
}

/**
 * Select the current block (text or image)
 * For text blocks: selects all text in the block
 * For image blocks: selects the entire image block
 */
export function selectCurrentBlock(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  const { blockIndex: blockIndex } = state.document.cursor.position;
  const block = state.document.page.blocks[blockIndex];

  if (!block || block.deleted) return state;

  // For image blocks, select the block by marking it with a selection
  if (block.type === "image") {
    const imagePosition: Position = { blockIndex: blockIndex, textIndex: 0 };

    let newState = moveCursorToPosition(state, blockIndex, 0);

    // Create a selection that spans the image block
    newState = {
      ...newState,
      document: {
        ...newState.document,
        selection: {
          anchor: imagePosition,
          focus: imagePosition,
          isForward: true,
          isCollapsed: false, // Mark as not collapsed to show selection
          lastUpdate: Date.now(),
          initialBoundary: {
            start: imagePosition,
            end: imagePosition,
          },
        },
      },
    };

    return updateMode(newState, "edit");
  }

  // For text blocks, select all text in the block
  const blockLength = getBlockTextLength(block);
  const startPos: Position = { blockIndex: blockIndex, textIndex: 0 };
  const endPos: Position = { blockIndex: blockIndex, textIndex: blockLength };

  let newState = moveCursorToPosition(state, blockIndex, blockLength);
  newState = startSelection(newState, startPos);
  newState = updateSelectionFocus(newState, endPos);

  return updateMode(newState, "edit");
}

/**
 * Generic function to toggle inline formatting on selected text or at cursor position
 * If there's no selection, toggles the format mode for next typed text
 */
export function toggleFormat(
  state: EditorState,
  formatType: "bold" | "italic" | "code" | "strikethrough",
): CommandResult {
  const range = getSelectionRange(state);

  // If no selection, toggle format in UI's active formats
  if (!range) {
    if (!state.document.cursor) {
      return { state, ops: [] };
    }

    // SAFETY: Convert to CRDT position and back for validation against concurrent updates
    const cursorCRDT = positionToCRDT(
      state.document.page,
      state.document.cursor.position,
    );
    if (!cursorCRDT) return { state, ops: [] };

    const position = crdtToPosition(state.document.page, cursorCRDT);
    if (!position) return { state, ops: [] };

    const { blockIndex: blockIndex, textIndex } = position;
    const block = state.document.page.blocks[blockIndex];
    if (!block || block.deleted) return { state, ops: [] };

    if (!isTextualBlock(block)) {
      return { state, ops: [] };
    }

    // Get current active formats or infer from cursor position
    let currentFormats: readonly TextFormat[];
    if (state.ui.activeFormatsMode.type === "explicit") {
      currentFormats = state.ui.activeFormatsMode.formats;
    } else {
      // Inherit mode: check formatting at cursor position
      currentFormats = getFormatsAtCharPosition(
        block.charRuns,
        block.formats,
        textIndex,
      );
    }

    const hasFormat = currentFormats.some((f) => f.type === formatType);

    let newFormats: TextFormat[];
    if (hasFormat) {
      // Remove format
      newFormats = currentFormats.filter((f) => f.type !== formatType);
    } else {
      // Add format
      newFormats = [...currentFormats, { type: formatType }];
    }

    return {
      state: {
        ...state,
        ui: {
          ...state.ui,
          activeFormatsMode: { type: "explicit", formats: newFormats },
        },
      },
      ops: [],
    };
  }

  // SAFETY: Convert selection to CRDT and back for validation against concurrent updates
  const crdtRange = selectionRangeToCRDT(state.document.page, range);
  if (!crdtRange) return { state, ops: [] };

  const freshRange = crdtToSelectionRange(state.document.page, crdtRange);
  if (!freshRange) return { state, ops: [] };

  const { start, end } = freshRange;

  if (start.blockIndex === end.blockIndex) {
    // Single block selection
    const block = state.document.page.blocks[start.blockIndex];
    if (!block || block.deleted) return { state, ops: [] };

    if (!isTextualBlock(block)) {
      return { state, ops: [] };
    }

    // Check if all characters in the range already have the format
    const hasFormat = allCharsHaveFormat(
      block.charRuns,
      block.formats,
      start.textIndex,
      end.textIndex,
      formatType,
    );

    // Toggle formatting: use helper to apply the op and get the new page
    const { newPage, op } = formatCharsInRange(
      state.document.page,
      block.id,
      start.textIndex,
      end.textIndex,
      { type: formatType },
      !hasFormat, // Toggle: if has format, remove it (false); otherwise add it (true)
      state.CRDTbinding,
    );

    invalidateBlockCache(newPage.blocks[start.blockIndex]);

    return {
      state: {
        ...state,
        document: { ...state.document, page: newPage },
      },
      ops: [op],
    };
  } else {
    // Multi-block selection
    const ops: Operation[] = [];
    let pageAcc = state.document.page;

    // First, check if all selected characters across all blocks have the format
    let hasFormat = true;
    for (let i = start.blockIndex; i <= end.blockIndex; i++) {
      const block = pageAcc.blocks[i];
      if (!isTextualBlock(block)) continue;

      let formatStart: number;
      let formatEnd: number;

      if (i === start.blockIndex && i === end.blockIndex) {
        formatStart = start.textIndex;
        formatEnd = end.textIndex;
      } else if (i === start.blockIndex) {
        formatStart = start.textIndex;
        formatEnd = getVisibleLength(block.charRuns);
      } else if (i === end.blockIndex) {
        formatStart = 0;
        formatEnd = end.textIndex;
      } else {
        formatStart = 0;
        formatEnd = getVisibleLength(block.charRuns);
      }

      if (formatStart < formatEnd) {
        const blockHasFormat = allCharsHaveFormat(
          block.charRuns,
          block.formats,
          formatStart,
          formatEnd,
          formatType,
        );
        if (!blockHasFormat) {
          hasFormat = false;
          break;
        }
      }
    }

    // Now apply the formatting to each block
    for (let i = start.blockIndex; i <= end.blockIndex; i++) {
      const block = pageAcc.blocks[i];
      if (!isTextualBlock(block)) continue;

      let formatStart: number;
      let formatEnd: number;

      if (i === start.blockIndex && i === end.blockIndex) {
        formatStart = start.textIndex;
        formatEnd = end.textIndex;
      } else if (i === start.blockIndex) {
        formatStart = start.textIndex;
        formatEnd = getVisibleLength(block.charRuns);
      } else if (i === end.blockIndex) {
        formatStart = 0;
        formatEnd = end.textIndex;
      } else {
        formatStart = 0;
        formatEnd = getVisibleLength(block.charRuns);
      }

      if (formatStart < formatEnd) {
        const { newPage, op } = formatCharsInRange(
          pageAcc,
          block.id,
          formatStart,
          formatEnd,
          { type: formatType },
          !hasFormat,
          state.CRDTbinding,
        );
        invalidateBlockCache(newPage.blocks[i]);
        pageAcc = newPage;
        ops.push(op);
      }
    }

    return {
      state: {
        ...state,
        document: { ...state.document, page: pageAcc },
      },
      ops,
    };
  }
}

/**
 * Toggle bold formatting on selected text or at cursor position
 * If there's no selection, toggles bold mode for next typed text
 */
export function toggleBold(state: EditorState): CommandResult {
  return toggleFormat(state, "bold");
}

/**
 * Toggle italic formatting on selected text or at cursor position
 * If there's no selection, toggles italic mode for next typed text
 */
export function toggleItalic(state: EditorState): CommandResult {
  return toggleFormat(state, "italic");
}

/**
 * Toggle code formatting on selected text or at cursor position
 * If there's no selection, toggles code mode for next typed text
 */
export function toggleCode(state: EditorState): CommandResult {
  return toggleFormat(state, "code");
}

/**
 * Toggle strikethrough formatting on selected text or at cursor position
 * If there's no selection, toggles strikethrough mode for next typed text
 */
export function toggleStrikethrough(state: EditorState): CommandResult {
  return toggleFormat(state, "strikethrough");
}

// Convert block type at current cursor position
export function convertBlockType(
  state: EditorState,
  blockType: Block["type"],
): CommandResult {
  if (!state.document.cursor) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return { state, ops: [] };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops: [] };

  const { blockIndex: blockIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  // Only text blocks can have content property
  if (!isTextualBlock(oldBlock)) {
    return { state, ops: [] };
  }

  let newBlock: Block;
  const typeChanged = oldBlock.type !== blockType;

  if (blockType === "bullet_list") {
    newBlock = {
      id: oldBlock.id,
      type: "bullet_list",
      charRuns: oldBlock.charRuns,
      formats: oldBlock.formats,
      indent: isListBlock(oldBlock) ? oldBlock.indent : 0,
    };
  } else if (blockType === "numbered_list") {
    newBlock = {
      id: oldBlock.id,
      type: "numbered_list",
      charRuns: oldBlock.charRuns,
      formats: oldBlock.formats,
      indent: isListBlock(oldBlock) ? oldBlock.indent : 0,
    };
  } else if (blockType === "todo_list") {
    newBlock = {
      id: oldBlock.id,
      type: "todo_list",
      charRuns: oldBlock.charRuns,
      formats: oldBlock.formats,
      checked:
        isListBlock(oldBlock) && oldBlock.type === "todo_list"
          ? oldBlock.checked
          : false,
      indent: isListBlock(oldBlock) ? oldBlock.indent : 0,
    };
  } else if (
    blockType === "paragraph" ||
    blockType === "heading1" ||
    blockType === "heading2" ||
    blockType === "heading3"
  ) {
    newBlock = {
      id: oldBlock.id,
      type: blockType,
      charRuns: oldBlock.charRuns,
      formats: oldBlock.formats,
    };
  } else if (blockType === "image") {
    // Convert text block to image block
    newBlock = {
      id: oldBlock.id,
      type: "image",
      url: "", // Will be filled when image is uploaded
      alt: "",
    };
  } else if (blockType === "line") {
    // Convert text block to line block (divider)
    newBlock = {
      id: oldBlock.id,
      type: "line",
    };
  } else {
    // Unknown type - shouldn't reach here
    return { state, ops: [] };
  }

  // Emit CRDT operation for block type change
  if (typeChanged) {
    const blockSetOp: BlockSet = {
      op: "block_set",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: oldBlock.id,
      field: "type",
      value: blockType,
    };
    ops.push(blockSetOp);
  }

  // Emit property changes for list blocks
  if (
    blockType === "bullet_list" ||
    blockType === "numbered_list" ||
    blockType === "todo_list"
  ) {
    const newIndent = isListBlock(oldBlock) ? oldBlock.indent : 0;
    // Only emit indent if it's different or this is a new list
    if (
      !isListBlock(oldBlock) ||
      (isListBlock(oldBlock) && oldBlock.indent !== newIndent)
    ) {
      const indentSetOp: BlockSet = {
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: oldBlock.id,
        field: "indent",
        value: newIndent,
      };
      ops.push(indentSetOp);
    }

    if (blockType === "todo_list") {
      const newChecked =
        isListBlock(oldBlock) && oldBlock.type === "todo_list"
          ? oldBlock.checked
          : false;
      const checkedSetOp: BlockSet = {
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: oldBlock.id,
        field: "checked",
        value: newChecked,
      };
      ops.push(checkedSetOp);
    }
  }

  // Invalidate cache only for the changed block
  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
  };

  // If converting to image or line, move cursor to next block and create one if needed
  if (blockType === "image" || blockType === "line") {
    // Move cursor to next block (create new paragraph if needed)
    if (blockIndex + 1 < newBlocks.length) {
      newState = moveCursorToPosition(newState, blockIndex + 1, 0);
    } else {
      // Create a new paragraph block after the image/line
      const newParagraphId = state.CRDTbinding.nextId();
      const newParagraph: Block = {
        id: newParagraphId,
        type: "paragraph",
        charRuns: [],
        formats: [],
      };

      const blockInsertOp: BlockInsert = {
        op: "block_insert",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        afterBlockId: oldBlock.id,
        blockId: newParagraphId,
        blockType: "paragraph",
      };
      ops.push(blockInsertOp);

      const blocksWithNewParagraph = [...newBlocks, newParagraph];
      newState = {
        ...newState,
        document: {
          ...newState.document,
          page: { ...newPage, blocks: blocksWithNewParagraph },
        },
      };
      newState = moveCursorToPosition(newState, blockIndex + 1, 0);
    }
  }

  return { state: newState, ops };
}

export function applySlashCommand(
  state: EditorState,
  command: SlashCommand,
): CommandResult {
  if (!state.document.cursor || state.ui.activeMenu.type !== "slashCommand")
    return { state, ops: [] };

  const ops: Operation[] = [];
  const { blockIndex, textIndex } = state.ui.activeMenu;

  // Remove the "/" and filter text, preserving formatting
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return { state, ops: [] };

  // Special handling for image cover blocks
  if (command.type === "image") {
    // For image cover blocks, we replace the current block with an empty image cover block
    const newBlock: Block = {
      id: block.id,
      type: "image",
      url: "", // Will be filled when image is uploaded
      alt: "",
    };

    // Invalidate cache only for the changed block
    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = newBlock;
    const newPage = { ...state.document.page, blocks: newBlocks };

    // Emit CRDT operations: delete all text and change block type
    if (isTextualBlock(block)) {
      const textLength = getVisibleLength(block.charRuns);
      if (textLength > 0) {
        const { op: deleteOp } = deleteCharsInRange(
          state.document.page,
          block.id,
          0,
          textLength,
          state.CRDTbinding,
        );
        ops.push(deleteOp);
      }

      const blockSetOp: BlockSet = {
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: block.id,
        field: "type",
        value: "image",
      };
      ops.push(blockSetOp);
    }

    // Update state
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    newState = closeSlashCommand(newState);

    // Move cursor to next block (create one if needed)
    if (blockIndex + 1 < newBlocks.length) {
      newState = moveCursorToPosition(newState, blockIndex + 1, 0);
    } else {
      // Create a new paragraph block after the image
      const newParagraphId = state.CRDTbinding.nextId();
      const newParagraph: Block = {
        id: newParagraphId,
        type: "paragraph",
        charRuns: [],
        formats: [],
      };

      const blockInsertOp: BlockInsert = {
        op: "block_insert",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        afterBlockId: block.id,
        blockId: newParagraphId,
        blockType: "paragraph",
      };
      ops.push(blockInsertOp);

      const blocksWithNewParagraph = [...newBlocks, newParagraph];
      newState = {
        ...newState,
        document: {
          ...newState.document,
          page: { ...newPage, blocks: blocksWithNewParagraph },
        },
      };

      newState = moveCursorToPosition(newState, blockIndex + 1, 0);
    }

    return { state: newState, ops };
  }

  // Special handling for math blocks
  if (command.type === "math") {
    const newBlock: Block = {
      id: block.id,
      type: "math",
      latex: "",
      displayMode: true,
    };

    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = newBlock;
    const newPage = { ...state.document.page, blocks: newBlocks };

    // Emit CRDT operations: delete all text and change block type
    if (isTextualBlock(block)) {
      const textLength = getVisibleLength(block.charRuns);
      if (textLength > 0) {
        const { op: deleteOp } = deleteCharsInRange(
          state.document.page,
          block.id,
          0,
          textLength,
          state.CRDTbinding,
        );
        ops.push(deleteOp);
      }

      const blockSetOp: BlockSet = {
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: block.id,
        field: "type",
        value: "math",
      };
      ops.push(blockSetOp);
    }

    // Update state
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    newState = closeSlashCommand(newState);

    // Move cursor to next block (create one if needed)
    if (blockIndex + 1 < newBlocks.length) {
      newState = moveCursorToPosition(newState, blockIndex + 1, 0);
    } else {
      const newParagraphId = state.CRDTbinding.nextId();
      const newParagraph: Block = {
        id: newParagraphId,
        type: "paragraph",
        charRuns: [],
        formats: [],
      };

      const blockInsertOp: BlockInsert = {
        op: "block_insert",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        afterBlockId: block.id,
        blockId: newParagraphId,
        blockType: "paragraph",
      };
      ops.push(blockInsertOp);

      const blocksWithNewParagraph = [...newBlocks, newParagraph];
      newState = {
        ...newState,
        document: {
          ...newState.document,
          page: { ...newPage, blocks: blocksWithNewParagraph },
        },
      };

      newState = moveCursorToPosition(newState, blockIndex + 1, 0);
    }

    return { state: newState, ops };
  }

  // Special handling for line/divider blocks
  if (command.type === "line") {
    // For line blocks, we replace the current block with a line block
    const newBlock: Block = {
      id: block.id,
      type: "line",
    };

    // Invalidate cache only for the changed block
    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = newBlock;
    const newPage = { ...state.document.page, blocks: newBlocks };

    // Emit CRDT operations: delete all text and change block type
    if (isTextualBlock(block)) {
      const textLength = getVisibleLength(block.charRuns);
      if (textLength > 0) {
        const { op: deleteOp } = deleteCharsInRange(
          state.document.page,
          block.id,
          0,
          textLength,
          state.CRDTbinding,
        );
        ops.push(deleteOp);
      }

      const blockSetOp: BlockSet = {
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: block.id,
        field: "type",
        value: "line",
      };
      ops.push(blockSetOp);
    }

    // Update state
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    newState = closeSlashCommand(newState);

    // Move cursor to next block (create one if needed)
    if (blockIndex + 1 < newBlocks.length) {
      newState = moveCursorToPosition(newState, blockIndex + 1, 0);
    } else {
      // Create a new paragraph block after the line
      const newParagraphId = state.CRDTbinding.nextId();
      const newParagraph: Block = {
        id: newParagraphId,
        type: "paragraph",
        charRuns: [],
        formats: [],
      };

      const blockInsertOp: BlockInsert = {
        op: "block_insert",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        afterBlockId: block.id,
        blockId: newParagraphId,
        blockType: "paragraph",
      };
      ops.push(blockInsertOp);

      const blocksWithNewParagraph = [...newBlocks, newParagraph];
      newState = {
        ...newState,
        document: {
          ...newState.document,
          page: { ...newPage, blocks: blocksWithNewParagraph },
        },
      };

      newState = moveCursorToPosition(newState, blockIndex + 1, 0);
    }

    return { state: newState, ops };
  }

  // Regular text-based blocks and list blocks
  // If the current block is already an image cover or math block, just close the slash command
  if (block.type === "image" || block.type === "math") {
    return { state: closeSlashCommand(state), ops: [] };
  }

  if (!isTextualBlock(block)) {
    return { state: closeSlashCommand(state), ops: [] };
  }

  // Delete from "/" position to current cursor position
  const deleteStart = textIndex - 1;
  const deleteEnd = state.document.cursor.position.textIndex;

  // Delete the slash command text using CRDT helper
  let updatedCharRuns = block.charRuns;
  if (deleteEnd > deleteStart) {
    const { newPage: pageAfterDelete, op: deleteOp } = deleteCharsInRange(
      state.document.page,
      block.id,
      deleteStart,
      deleteEnd,
      state.CRDTbinding,
    );
    const updatedBlock = pageAfterDelete.blocks[blockIndex];
    if (isTextualBlock(updatedBlock)) {
      updatedCharRuns = updatedBlock.charRuns;
    }
    ops.push(deleteOp);
  }

  // Update block content and type
  let newBlock: Block;
  if (command.type === "bullet_list") {
    newBlock = {
      id: block.id,
      type: "bullet_list",
      charRuns: updatedCharRuns,
      formats: block.formats,
      indent: 0,
    };
  } else if (command.type === "numbered_list") {
    newBlock = {
      id: block.id,
      type: "numbered_list",
      charRuns: updatedCharRuns,
      formats: block.formats,
      indent: 0,
    };
  } else if (command.type === "todo_list") {
    newBlock = {
      id: block.id,
      type: "todo_list",
      charRuns: updatedCharRuns,
      formats: block.formats,
      checked: false,
      indent: 0,
    };
  } else {
    // Regular text blocks (headings, paragraphs)
    newBlock = {
      id: block.id,
      type: command.type as "heading1" | "heading2" | "heading3" | "paragraph",
      charRuns: updatedCharRuns,
      formats: block.formats,
    };
  }

  // Invalidate cache only for the changed block
  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  // Emit CRDT operation for block type change
  const blockSetOp: BlockSet = {
    op: "block_set",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId: block.id,
    field: "type",
    value: command.type,
  };
  ops.push(blockSetOp);

  // Emit property changes for list blocks
  if (
    command.type === "bullet_list" ||
    command.type === "numbered_list" ||
    command.type === "todo_list"
  ) {
    const indentSetOp: BlockSet = {
      op: "block_set",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: block.id,
      field: "indent",
      value: 0,
    };
    ops.push(indentSetOp);

    if (command.type === "todo_list") {
      const checkedSetOp: BlockSet = {
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: block.id,
        field: "checked",
        value: false,
      };
      ops.push(checkedSetOp);
    }
  }

  // Update state
  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
  };
  newState = closeSlashCommand(newState);
  newState = moveCursorToPosition(newState, blockIndex, textIndex - 1);

  return { state: newState, ops };
}

/**
 * Indent a list item (increase indent level)
 */
export function indentListItem(state: EditorState): CommandResult {
  if (!state.document.cursor) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return { state, ops: [] };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops: [] };

  const { blockIndex: blockIndex } = position;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return { state, ops: [] };

  if (!isListBlock(block)) return { state, ops: [] };

  // Check if we're at max indent level
  const currentIndent = block.indent || 0;
  const maxLevel = 6; // Match styles.list.indent.maxLevel
  if (currentIndent >= maxLevel) return { state, ops: [] };

  const newIndent = currentIndent + 1;

  // Create new block with increased indent
  const newBlock: Block = {
    ...block,
    indent: newIndent,
  };

  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  // Emit CRDT operation for indent change
  const blockSetOp: BlockSet = {
    op: "block_set",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId: block.id,
    field: "indent",
    value: newIndent,
  };
  ops.push(blockSetOp);

  return {
    state: {
      ...state,
      document: { ...state.document, page: newPage },
    },
    ops,
  };
}

/**
 * Outdent a list item (decrease indent level)
 */
export function outdentListItem(state: EditorState): CommandResult {
  if (!state.document.cursor) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return { state, ops: [] };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops: [] };

  const { blockIndex: blockIndex } = position;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return { state, ops: [] };

  if (!isListBlock(block)) return { state, ops: [] };

  const currentIndent = block.indent || 0;
  if (currentIndent === 0) {
    // At base indent - convert to paragraph
    const newBlock: Block = {
      id: block.id,
      type: "paragraph",
      charRuns: block.charRuns,
      formats: block.formats,
    };

    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = newBlock;
    const newPage = { ...state.document.page, blocks: newBlocks };

    // Emit CRDT operation for block type change
    const blockSetOp: BlockSet = {
      op: "block_set",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: block.id,
      field: "type",
      value: "paragraph",
    };
    ops.push(blockSetOp);

    return {
      state: {
        ...state,
        document: { ...state.document, page: newPage },
      },
      ops,
    };
  }

  const newIndent = currentIndent - 1;

  // Decrease indent level
  const newBlock: Block = {
    ...block,
    indent: newIndent,
  };

  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  // Emit CRDT operation for indent change
  const blockSetOp: BlockSet = {
    op: "block_set",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId: block.id,
    field: "indent",
    value: newIndent,
  };
  ops.push(blockSetOp);

  return {
    state: {
      ...state,
      document: { ...state.document, page: newPage },
    },
    ops,
  };
}

/**
 * Toggle the checked state of a todo list item
 */
export function toggleTodoChecked(
  state: EditorState,
  blockIndex: number,
): CommandResult {
  const ops: Operation[] = [];

  // SAFETY: Validate blockIndex bounds and check block is not deleted
  if (blockIndex < 0 || blockIndex >= state.document.page.blocks.length) {
    return { state, ops: [] };
  }
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || block.type !== "todo_list") {
    return { state, ops: [] };
  }

  // Toggle checked state
  const newBlock: Block = {
    ...block,
    checked: !block.checked,
  };

  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  // Emit CRDT operation for todo toggle
  const blockSetOp: BlockSet = {
    op: "block_set",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId: block.id,
    field: "checked",
    value: !block.checked,
  };
  ops.push(blockSetOp);

  return {
    state: {
      ...state,
      document: { ...state.document, page: newPage },
    },
    ops,
  };
}

/**
 * Convert current block to a list type
 */
export function convertToList(
  state: EditorState,
  listType: "bullet_list" | "numbered_list" | "todo_list",
): CommandResult {
  if (!state.document.cursor) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(
    state.document.page,
    state.document.cursor.position,
  );
  if (!cursorCRDT) return { state, ops: [] };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops: [] };

  const { blockIndex: blockIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  if (!isTextualBlock(oldBlock)) return { state, ops: [] };

  // Create new list block
  let newBlock: Block;
  if (listType === "bullet_list") {
    newBlock = {
      id: oldBlock.id,
      type: "bullet_list",
      charRuns: oldBlock.charRuns,
      formats: oldBlock.formats,
      indent: 0,
    };
  } else if (listType === "numbered_list") {
    newBlock = {
      id: oldBlock.id,
      type: "numbered_list",
      charRuns: oldBlock.charRuns,
      formats: oldBlock.formats,
      indent: 0,
    };
  } else {
    newBlock = {
      id: oldBlock.id,
      type: "todo_list",
      charRuns: oldBlock.charRuns,
      formats: oldBlock.formats,
      checked: false,
      indent: 0,
    };
  }

  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  // Emit CRDT operation for block type change
  const blockSetOp: BlockSet = {
    op: "block_set",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId: oldBlock.id,
    field: "type",
    value: listType,
  };
  ops.push(blockSetOp);

  // Emit indent property
  const indentSetOp: BlockSet = {
    op: "block_set",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId: oldBlock.id,
    field: "indent",
    value: 0,
  };
  ops.push(indentSetOp);

  // Emit checked property for todo lists
  if (listType === "todo_list") {
    const checkedSetOp: BlockSet = {
      op: "block_set",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: oldBlock.id,
      field: "checked",
      value: false,
    };
    ops.push(checkedSetOp);
  }

  return {
    state: {
      ...state,
      document: { ...state.document, page: newPage },
    },
    ops,
  };
}

/**
 * Update a link's URL and text at a specific character range in a block
 * @param startIndex - Starting character index (inclusive)
 * @param endIndex - Ending character index (exclusive)
 */
export function updateLinkInBlock(
  state: EditorState,
  blockIndex: number,
  startIndex: number,
  endIndex: number,
  newUrl: string,
  newText: string,
): CommandResult {
  const ops: Operation[] = [];

  // SAFETY: Validate blockIndex bounds and check block is not deleted
  if (blockIndex < 0 || blockIndex >= state.document.page.blocks.length) {
    return { state, ops: [] };
  }
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) {
    return { state, ops: [] };
  }

  // If newText is empty, don't update (prevents index shifting during editing)
  // User should use clearLinkInBlock to explicitly delete the link
  if (!newText || newText.length === 0) {
    return { state, ops: [] };
  }

  const oldText = getVisibleTextFromRuns(block.charRuns).slice(
    startIndex,
    endIndex,
  );
  let pageAcc = state.document.page;

  if (oldText !== newText) {
    const { newPage: pageAfterDelete, op: deleteOp } = deleteCharsInRange(
      pageAcc,
      block.id,
      startIndex,
      endIndex,
      state.CRDTbinding,
    );
    pageAcc = pageAfterDelete;
    ops.push(deleteOp);

    const { newPage: pageAfterInsert, op: insertOp } = insertCharsAtPosition(
      pageAcc,
      block.id,
      startIndex,
      newText,
      state.CRDTbinding,
    );
    pageAcc = pageAfterInsert;
    ops.push(insertOp);
  }

  const { newPage: pageAfterFormat, op: formatOp } = formatCharsInRange(
    pageAcc,
    block.id,
    startIndex,
    startIndex + newText.length,
    { type: "link", url: newUrl },
    newUrl,
    state.CRDTbinding,
  );
  pageAcc = pageAfterFormat;
  ops.push(formatOp);

  invalidateBlockCache(pageAcc.blocks[blockIndex]);

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: pageAcc },
  };

  return { state: newState, ops };
}

/**
 * Clear a link format from a character range in a block (remove link, keep text)
 * @param startIndex - Starting character index (inclusive)
 * @param endIndex - Ending character index (exclusive)
 */
export function clearLinkInBlock(
  state: EditorState,
  blockIndex: number,
  startIndex: number,
  endIndex: number,
): CommandResult {
  const ops: Operation[] = [];

  // SAFETY: Validate blockIndex bounds and check block is not deleted
  if (blockIndex < 0 || blockIndex >= state.document.page.blocks.length) {
    return { state, ops: [] };
  }
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) {
    return { state, ops: [] };
  }

  // Remove link formatting by setting value to false
  const { newPage, op } = formatCharsInRange(
    state.document.page,
    block.id,
    startIndex,
    endIndex,
    { type: "link" },
    false,
    state.CRDTbinding,
  );
  ops.push(op);

  invalidateBlockCache(newPage.blocks[blockIndex]);

  return {
    state: {
      ...state,
      document: { ...state.document, page: newPage },
    },
    ops,
  };
}
