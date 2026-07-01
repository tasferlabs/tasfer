import { TEXT_INPUTTED } from "../action-bus";
import { isCJKCharacter } from "../cjk";
import { invalidateBlockCache } from "../rendering/renderer";
import { isBlockRTL } from "../rtl";
import {
  clearSelection,
  moveCursorToPosition,
  startSelection,
  updateSelection,
  updateSelectionFocus,
} from "../selection";
import {
  type Block,
  type CharRun,
  type Mark,
  type Page,
} from "../serlization/loadPage";
import { isListBlock } from "../serlization/loadPage";
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
  TextDelete,
} from "../state-types";
import {
  caretStep,
  caretTokenClamp,
  getBlockTextContent,
  getBlockTextLength,
  resolveDeleteUnit,
  transformTypedInput,
  updateMode,
} from "../state-utils";
import { findBlock, findBlockIndex } from "../sync/block-lookup";
import {
  canHaveFormats,
  createDefaultBlock,
  getBlockDescriptor,
  getBlockFieldNames,
  hasTextContent,
  isPreformattedType,
  isTextualBlock,
  isTogglable,
} from "../sync/block-registry";
import {
  deleteFromRuns,
  getVisibleTextFromRuns,
  isCharIdInRange,
  iterateVisibleChars,
} from "../sync/char-runs";
import {
  allCharsHaveFormat,
  crdtToPosition,
  crdtToSelectionRange,
  deleteCharsInRange,
  getFormatsAtCharPosition,
  getVisibleLength,
  insertCharsAtPosition,
  markCharsInRange,
  orderKeyAfter,
  positionToCRDT,
  selectionRangeToCRDT,
  sortBlocksByOrder,
} from "../sync/crdt-utils";
import {
  applyOp,
  applyOps,
  findNextVisibleBlockIndex,
  findPreviousVisibleBlockIndex,
} from "../sync/reducer";
import type { DataSchema } from "../sync/schema";
import { isWordChar } from "../word-chars";

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

  const block = findBlock(page, blockId);
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

  const { newPage, op } = markCharsInRange(
    page,
    blockId,
    detected.start,
    detected.end,
    { type: "link", attrs: { url: detected.url } },
    true,
    binding,
  );

  return { newPage, ops: [op] };
}

/**
 * Get the formatting at a specific text position in a block
 * Returns the formats of the character just before the cursor position
 */
export function getFormatsAtPosition(
  block: Block,
  textIndex: number,
): readonly Mark[] | undefined {
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
  schema: DataSchema,
): {
  newPage: Page;
  newTextIndex: number;
  ops: Operation[];
} | null {
  const block = findBlock(page, blockId);
  if (!block || !isTextualBlock(block)) return null;
  const fullText = getVisibleTextFromRuns(block.charRuns);

  const patterns: Array<{
    regex: RegExp;
    markerLen: number;
    format: Mark;
  }> = [
    { regex: /\*\*([^\*]+)\*\*$/, markerLen: 2, format: { type: "strong" } },
    {
      regex: /(?<!\*)\*([^\*]+)\*$/,
      markerLen: 1,
      format: { type: "emphasis" },
    },
    { regex: /~~([^~]+)~~$/, markerLen: 2, format: { type: "strike" } },
    { regex: /\$([^$\n]+)\$$/, markerLen: 1, format: { type: "math" } },
    { regex: /`([^`]+)`$/, markerLen: 1, format: { type: "code" } },
  ];

  for (const { regex, markerLen, format } of patterns) {
    // Skip auto-format for a mark the schema forbids authoring (no-op when
    // unrestricted). Leaves the literal delimiters in place.
    if (!schema.isMarkAllowed(format.type)) continue;
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

    const { newPage: p3, op: formatOp } = markCharsInRange(
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
  schema: DataSchema,
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

  // Check for list markers. Each branch morphs to a specific type; skip it when
  // that type is not authorable in this schema, leaving the literal prefix in
  // place (a no-op for an unrestricted schema, where every type is allowed).
  if (
    textAfterSpaces.startsWith("- [ ] ") &&
    schema.isBlockAllowed("todo_list")
  ) {
    // Unchecked todo list
    (block as any).type = "todo_list";
    (block as any).checked = false;
    (block as any).indent = indentLevel;
    removePrefix(0, leadingSpaces + 6);
    if (oldType !== "todo_list") setBlockField("type", "todo_list");
    setBlockField("checked", false);
    setBlockField("indent", indentLevel);
  } else if (
    (textAfterSpaces.startsWith("- [x] ") ||
      textAfterSpaces.startsWith("- [X] ")) &&
    schema.isBlockAllowed("todo_list")
  ) {
    // Checked todo list
    (block as any).type = "todo_list";
    (block as any).checked = true;
    (block as any).indent = indentLevel;
    removePrefix(0, leadingSpaces + 6);
    if (oldType !== "todo_list") setBlockField("type", "todo_list");
    setBlockField("checked", true);
    setBlockField("indent", indentLevel);
  } else if (
    textAfterSpaces.match(/^[-*+] /) &&
    schema.isBlockAllowed("bullet_list")
  ) {
    // Bullet list
    (block as any).type = "bullet_list";
    (block as any).indent = indentLevel;
    removePrefix(0, leadingSpaces + 2);
    if (oldType !== "bullet_list") setBlockField("type", "bullet_list");
    setBlockField("indent", indentLevel);
  } else if (
    textAfterSpaces.match(/^\d+\. /) &&
    schema.isBlockAllowed("numbered_list")
  ) {
    // Numbered list
    const match = textAfterSpaces.match(/^(\d+)\. /);
    if (match) {
      (block as any).type = "numbered_list";
      (block as any).indent = indentLevel;
      removePrefix(0, leadingSpaces + match[0].length);
      if (oldType !== "numbered_list") setBlockField("type", "numbered_list");
      setBlockField("indent", indentLevel);
    }
  } else if (text.startsWith("### ") && schema.isBlockAllowed("heading3")) {
    block.type = "heading3";
    removePrefix(0, 4);
    if (oldType !== "heading3") setBlockField("type", "heading3");
  } else if (text.startsWith("## ") && schema.isBlockAllowed("heading2")) {
    block.type = "heading2";
    removePrefix(0, 3);
    if (oldType !== "heading2") setBlockField("type", "heading2");
  } else if (text.startsWith("# ") && schema.isBlockAllowed("heading1")) {
    block.type = "heading1";
    removePrefix(0, 2);
    if (oldType !== "heading1") setBlockField("type", "heading1");
  } else if (text.match(/^-{3,}$/) && schema.isBlockAllowed("line")) {
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
  } else if (text === "$$" && schema.isBlockAllowed("math")) {
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
    (block as any).displayMode = true;
    (block as any).charRuns = [];
    (block as any).formats = [];
    setBlockField("type", "math");
  } else if (text === "```" && schema.isBlockAllowed("code")) {
    // Code block — three backticks on their own line. Like math (and unlike the
    // void `line`), code is textual, so the caret stays inside the (now empty)
    // block; the bottom of insertText clamps the cursor into the cleared block.
    // Drop the three
    // backticks and morph to a code block; `language` initializes to "" from the
    // code descriptor's defaults on every peer (so only the type op is needed).
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
    (block as any).type = "code";
    (block as any).language = "";
    (block as any).charRuns = [];
    (block as any).formats = [];
    setBlockField("type", "code");
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
export function mergeBlocksOps(
  page: Page,
  source: Block,
  target: Block,
  binding: CRDTbinding,
  schema: DataSchema,
  applyMarkdown: boolean = true,
): {
  newPage: Page;
  ops: Operation[];
  joinPoint: number;
  insertedRange: { blockId: string; from: number; to: number } | null;
} {
  const ops: Operation[] = [];
  let pageAcc = page;
  const joinPoint = isTextualBlock(target)
    ? getVisibleLength(target.charRuns)
    : 0;
  let insertedRange: { blockId: string; from: number; to: number } | null =
    null;

  // Non-textual source can't contribute content; just tombstone it.
  if (isTextualBlock(source) && isTextualBlock(target)) {
    const sourceText = getVisibleTextFromRuns(source.charRuns);

    if (sourceText.length > 0) {
      const { newPage: pageAfterInsert, op: insertOp } = insertCharsAtPosition(
        pageAcc,
        target.id,
        joinPoint,
        sourceText,
        binding,
      );
      pageAcc = pageAfterInsert;
      ops.push(insertOp);
      insertedRange = {
        blockId: target.id,
        from: joinPoint,
        to: joinPoint + sourceText.length,
      };

      // Re-target source's format spans onto the freshly-inserted chars.
      const sourceIds = [...iterateVisibleChars(source.charRuns)].map(
        ({ id }) => id,
      );
      const targetAfter = findBlock(pageAcc, target.id);
      const targetIds =
        targetAfter && isTextualBlock(targetAfter)
          ? [...iterateVisibleChars(targetAfter.charRuns)].map(({ id }) => id)
          : [];
      const insertedIds = targetIds.slice(-sourceText.length);

      if (sourceIds.length === insertedIds.length) {
        const sourceToInserted = new Map<string, string>();
        for (let i = 0; i < sourceIds.length; i++) {
          sourceToInserted.set(sourceIds[i], insertedIds[i]);
        }

        const formatOps: MarkSet[] = [];
        for (const span of source.formats) {
          const coveredIds = sourceIds
            .filter((id) =>
              isCharIdInRange(
                source.charRuns,
                id,
                span.startCharId,
                span.endCharId,
              ),
            )
            .map((id) => sourceToInserted.get(id)!);
          if (coveredIds.length === 0) continue;
          formatOps.push({
            op: "mark_set",
            id: binding.nextId(),
            clock: binding.getClock(),
            pageId: binding.pageId,
            blockId: target.id,
            charIds: coveredIds,
            format: span.format,
            value: true,
          });
        }
        if (formatOps.length > 0) {
          ops.push(...formatOps);
          pageAcc = applyOps(pageAcc, formatOps);
        }
      }
    }
  }

  const deleteOp: Operation = {
    op: "block_delete",
    id: binding.nextId(),
    clock: binding.getClock(),
    pageId: binding.pageId,
    blockId: source.id,
  };
  ops.push(deleteOp);
  pageAcc = applyOps(pageAcc, [deleteOp]);

  // Post-merge markdown detection on the surviving paragraph (e.g. backspacing
  // such that target's text now starts with "1. " should convert it to a
  // numbered list). Clone before passing to applyMarkdownPrefix — that
  // function mutates its argument in place; we don't want that bleeding into
  // pageAcc. The ops it returns are applied via applyOps for parity.
  const targetAfterMerge = findBlock(pageAcc, target.id);
  if (
    applyMarkdown &&
    targetAfterMerge &&
    !targetAfterMerge.deleted &&
    targetAfterMerge.type === "paragraph" &&
    isTextualBlock(targetAfterMerge)
  ) {
    const clone = { ...targetAfterMerge } as Block;
    const { ops: prefixOps } = applyMarkdownPrefix(clone, binding, schema);
    if (prefixOps.length > 0) {
      ops.push(...prefixOps);
      pageAcc = applyOps(pageAcc, prefixOps);
    }
  }

  return { newPage: pageAcc, ops, joinPoint, insertedRange };
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

/**
 * Act on a resolved editing unit `[from, to)` (from a node/mark's `deleteUnit`
 * seam) per the selection model: a multi-part construct is SELECTED (so you see
 * it before the next press deletes it), a plain leaf is deleted outright. This is
 * the one place the unit delete converges for every direction and content type,
 * so the only type-specific knowledge upstream is "where is the unit", never "how
 * do I delete it".
 */
function applyDeleteUnit(
  state: EditorState,
  blockIndex: number,
  blockId: string,
  from: number,
  to: number,
  isConstruct: boolean,
): ActionResult {
  if (isConstruct) {
    const selected = updateSelection(state, {
      anchor: { blockIndex, textIndex: from },
      focus: { blockIndex, textIndex: to },
    });
    return {
      state: moveCursorToPosition(selected, blockIndex, to, true),
      ops: [],
    };
  }
  const { newPage, op } = deleteCharsInRange(
    state.document.page,
    blockId,
    from,
    to,
    state.CRDTbinding,
  );
  invalidateBlockCache(newPage.blocks[blockIndex]);
  return {
    state: moveCursorToPosition(
      { ...state, document: { ...state.document, page: newPage } },
      blockIndex,
      from,
      true,
    ),
    ops: [op],
  };
}

// Helper function to delete selected text
/**
 * Delete selected text.
 * Returns new state + CRDT operations for the deletion.
 */
export function deleteSelectedText(state: EditorState): ActionResult {
  // Note: Cache will naturally miss due to content length change
  // Only clear for multi-block operations below
  const range = getSelectionRange(state);
  if (!range) return { state, ops: [] };

  const ops: Operation[] = [];
  let { start, end } = range;

  if (start.blockIndex === end.blockIndex) {
    // Single block selection
    const block = state.document.page.blocks[start.blockIndex];
    if (!block || block.deleted) return { state, ops: [] };

    // Handle whole-block deletion. Non-text visual blocks and contained textual
    // blocks (code/math) use anchor === focus with isCollapsed=false to mean the
    // block itself is selected, not an empty character range.
    if (
      start.textIndex === end.textIndex &&
      (!isTextualBlock(block) || isPreformattedType(block.type))
    ) {
      // Delete the selected block — tombstone (don't splice) so undo can find it
      const blockDeleteOp: Operation = {
        op: "block_delete",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: block.id,
      };
      ops.push(blockDeleteOp);

      const wasOnlyVisibleBlock =
        state.document.page.blocks.filter((candidate) => !candidate.deleted)
          .length === 1;

      // Tombstone the deleted block in place
      const tombstonedBlocks = [...state.document.page.blocks];
      tombstonedBlocks[start.blockIndex] = { ...block, deleted: true };

      let finalBlocks = tombstonedBlocks;
      let cursorBlockIndex = start.blockIndex;

      if (wasOnlyVisibleBlock) {
        // Append a new empty paragraph (the tombstone stays in place)
        const emptyParagraphId = state.CRDTbinding.nextId();
        const orderKey = orderKeyAfter(state.document.page.blocks, null);
        const emptyParagraph: Block = {
          id: emptyParagraphId,
          orderKey,
          type: "paragraph",
          charRuns: [],
          formats: [],
        };

        const blockInsertOp: Operation = {
          op: "block_insert",
          id: state.CRDTbinding.nextId(),
          clock: state.CRDTbinding.getClock(),
          pageId: state.CRDTbinding.pageId,
          orderKey,
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

    // SAFETY: Convert selection to CRDT and back for validation against
    // concurrent updates. Whole-block selections are handled above because an
    // anchor === focus selection has no character range to convert.
    const crdtRange = selectionRangeToCRDT(state.document.page, range);
    if (!crdtRange) return { state, ops: [] };

    const freshRange = crdtToSelectionRange(state.document.page, crdtRange);
    if (!freshRange) return { state, ops: [] };
    start = freshRange.start;
    end = freshRange.end;

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

    // Re-run markdown-prefix promotion only from the neutral paragraph base.
    // `applyMarkdownPrefix` promotes by text content ("- " → list, "# " →
    // heading, …), so gating on `paragraph` is intentional, not incidental: an
    // already-promoted heading/list — or a code block holding literal "- foo" —
    // must not silently re-morph when its text is edited. (This is the same
    // "paragraph is the base type" convention as the schema's fallback codec.)
    if (block.type === "paragraph") {
      ops.push(
        ...applyMarkdownPrefix(blockCopy, state.CRDTbinding, state.schema).ops,
      );
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
    // SAFETY: Convert selection to CRDT and back for validation against
    // concurrent updates.
    const crdtRange = selectionRangeToCRDT(state.document.page, range);
    if (!crdtRange) return { state, ops: [] };

    const freshRange = crdtToSelectionRange(state.document.page, crdtRange);
    if (!freshRange) return { state, ops: [] };
    start = freshRange.start;
    end = freshRange.end;

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
          orderKey: orderKeyAfter(state.document.page.blocks, null),
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
        ops.push(
          ...applyMarkdownPrefix(blockCopy, state.CRDTbinding, state.schema)
            .ops,
        );
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
export function insertText(state: EditorState, input: string): ActionResult {
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

  // Give the block's node/mark a chance to rewrite the typed input and/or veto
  // inline-markdown for this keystroke (the caret may be inside atomic inline
  // content). E.g. inline/block math inserts a command-separating space (`\oint`
  // + `x` → `\oint x` → ∮x, never the unknown `\ointx`) and, inside a chip, asks
  // markdown auto-format to stand down so a stray `$`/`*` can't reinterpret it.
  let suppressInlineMarkdown = false;
  const typed = transformTypedInput(state, oldBlock, textIndex, input);
  if (typed) {
    input = typed.input;
    suppressInlineMarkdown = typed.suppressMarkdown ?? false;
  }

  // Nothing left to insert — either the keystroke was empty or a node's
  // transformTypedInput swallowed it (e.g. an atomic chip vetoing the char).
  // Return whatever ops the selection-deletion above produced; don't ask the
  // CRDT layer to insert an empty run.
  if (input.length === 0) {
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
  if (state.ui.activeMarksMode.type === "explicit") {
    for (const format of state.ui.activeMarksMode.formats) {
      const { newPage: pageAfterFormat, op: formatOp } = markCharsInRange(
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

  // Preformatted blocks (e.g. code) are verbatim source: no inline-mark
  // auto-format and no block-prefix conversion ever applies inside them (their
  // `hasFormats` is false, and "# "/"- "/"```" must stay literal text). The
  // paragraph→preformatted creation path below is unaffected — there `oldBlock`
  // is the paragraph.
  const inCodeBlock = isPreformattedType(oldBlock.type);

  // Inline markdown detection (only on closing delimiter characters)
  const isClosingDelimiter =
    input === "*" || input === "`" || input === "~" || input === "$";
  let finalTextIndex = newTextIndex;

  if (isClosingDelimiter && !inCodeBlock && !suppressInlineMarkdown) {
    const markdownResult = detectAndApplyInlineMarkdown(
      pageAcc,
      oldBlock.id,
      newTextIndex,
      state.CRDTbinding,
      state.schema,
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
          state.schema,
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

  // Auto-detect URLs when a word boundary is typed (space) — never in code, and
  // never when the schema forbids the link mark (no-op when unrestricted).
  if (input === " " && !inCodeBlock && state.schema.isMarkAllowed("link")) {
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

  // Apply any markdown prefix (e.g. "## " → heading2, "```" → code). This
  // mutates the block in place; pageAcc.blocks[blockIndex] already holds the
  // latest copy. Skipped inside code blocks (verbatim — see `inCodeBlock`).
  const blockCopy = pageAcc.blocks[blockIndex];
  if (!inCodeBlock) {
    ops.push(
      ...applyMarkdownPrefix(
        blockCopy,
        state.CRDTbinding,
        state.schema,
        oldBlock.type !== "paragraph",
      ).ops,
    );
  }
  invalidateBlockCache(blockCopy);

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: pageAcc },
  };

  // (Math blocks are textual now: the caret stays INSIDE the equation, so there
  // is no special "jump to the next block" after a `$$` conversion — the cleared
  // block clamps the cursor to offset 0 below, exactly like the ``` code path.)

  // Preserve active formats when moving cursor after typing
  newState = moveCursorToPosition(newState, blockIndex, finalTextIndex, true);
  newState = updateMode(newState, "edit");

  // Post-insert normalization: a node/mark observes TEXT_INPUTTED to materialize
  // an incomplete construct this edit just completed (e.g. `\frac` → `\frac{}{}`,
  // landing the caret in the numerator) and/or arm caret-anchored scratch. The
  // dispatch runs INSIDE this same edit transform, so any placeholder ops an
  // observer emits join this transaction's `ops` (one CRDT change / undo entry /
  // broadcast) — and a block whose node/mark has nothing to fill is untouched.
  const settled = newState.actionBus.dispatchState(TEXT_INPUTTED, newState, {
    blockIndex,
    textIndex: finalTextIndex,
  });
  newState = settled.state;
  ops.push(...settled.ops);

  return { state: newState, ops };
}

export function deleteText(state: EditorState): ActionResult {
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

  // Atomic inline content (a math equation/chip) deletes by *unit*, not by
  // character: the block's node/mark resolves the unit before the caret and the
  // selection model acts on it — a construct is SELECTED (the next Backspace,
  // seeing a non-collapsed selection, deletes it at the top of deleteText), a
  // leaf is deleted now. `null` (plain text, or nothing before the caret) falls
  // through to the normal character backspace / block-start merge below.
  const backUnit = resolveDeleteUnit(state, oldBlock, textIndex, "backward");
  if (backUnit) {
    return applyDeleteUnit(
      state,
      blockIndex,
      oldBlock.id,
      backUnit.from,
      backUnit.to,
      backUnit.isConstruct,
    );
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
      ops.push(
        ...applyMarkdownPrefix(blockCopy, state.CRDTbinding, state.schema).ops,
      );
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
    // A single-block surface never merges its block into (or outdents/deletes
    // itself toward) a neighbour outside the window — Backspace at offset 0 is a
    // no-op, so the block count and neighbours are untouched.
    if (state.view.window?.singleBlock) return { state, ops: [] };
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
            orderKey: oldBlock.orderKey,
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
            const orderKey = orderKeyAfter(state.document.page.blocks, null);
            const emptyParagraph: Block = {
              id: emptyParagraphId,
              orderKey,
              type: "paragraph",
              charRuns: [],
              formats: [],
            };

            const blockInsertOp: Operation = {
              op: "block_insert",
              id: state.CRDTbinding.nextId(),
              clock: state.CRDTbinding.getClock(),
              pageId: state.CRDTbinding.pageId,
              orderKey,
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
        state.schema,
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
            orderKey: oldBlock.orderKey,
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
export function deleteForward(state: EditorState): ActionResult {
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

  // Mirror of backspace: atomic inline content (a math equation/chip) forward-
  // deletes by *unit*. The block's node/mark resolves the unit after the caret;
  // `null` (plain text, or nothing after the caret) falls through to the normal
  // character delete / block-merge below.
  const fwdUnit = resolveDeleteUnit(state, oldBlock, textIndex, "forward");
  if (fwdUnit) {
    return applyDeleteUnit(
      state,
      blockIndex,
      oldBlock.id,
      fwdUnit.from,
      fwdUnit.to,
      fwdUnit.isConstruct,
    );
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
      ops.push(
        ...applyMarkdownPrefix(blockCopy, state.CRDTbinding, state.schema).ops,
      );
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
    // A single-block surface never merges its block into a neighbour outside the
    // window — forward-delete at the end of the block is a no-op.
    if (state.view.window?.singleBlock) return { state, ops: [] };
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
          const orderKey = orderKeyAfter(state.document.page.blocks, null);
          const emptyParagraph: Block = {
            id: emptyParagraphId,
            orderKey,
            type: "paragraph",
            charRuns: [],
            formats: [],
          };

          const blockInsertOp: Operation = {
            op: "block_insert",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            orderKey,
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
        state.schema,
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
    const startIsWordChar = isWordChar(text[i - 1]);
    if (startIsWordChar) {
      while (i > 0 && isWordChar(text[i - 1]) && !isCJKCharacter(text[i - 1])) {
        i--;
      }
    } else {
      while (i > 0 && !isWordChar(text[i - 1])) {
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
    const startIsWordChar = isWordChar(text[i]);
    if (startIsWordChar) {
      while (
        i < text.length &&
        isWordChar(text[i]) &&
        !isCJKCharacter(text[i])
      ) {
        i++;
      }
    } else {
      while (i < text.length && !isWordChar(text[i])) {
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
  const startsOnWord = isWordChar(text[i - 1]);

  if (startsOnWord) {
    // Delete word characters (see isWordChar: letters, numbers, marks, joiners, underscore)
    while (i > 0 && isWordChar(text[i - 1]) && !isCJKCharacter(text[i - 1])) {
      i--;
    }
  } else {
    // Delete non-word characters (spaces, punctuation, special characters together)
    while (i > 0 && !isWordChar(text[i - 1])) {
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
  const startsOnWord = isWordChar(text[i]);

  if (startsOnWord) {
    // Delete word characters (see isWordChar: letters, numbers, marks, joiners, underscore)
    while (i < text.length && isWordChar(text[i]) && !isCJKCharacter(text[i])) {
      i++;
    }
  } else {
    // Delete non-word characters (spaces, punctuation, special characters together)
    while (i < text.length && !isWordChar(text[i])) {
      i++;
    }
  }

  return i;
}

// Move cursor to previous word boundary
/**
 * Keep a word-movement `target` out of the middle of an atomic inline token by
 * routing it through the block's `caretTokenClamp` seam (e.g. a math block is one
 * "word" — jump to its near/far edge; a target inside an inline-math chip clamps
 * to the chip's edge). Returns `target` unchanged when nothing claims it. This is
 * what stops Ctrl+←/→ from parking the caret at `\in|t`.
 */
function snapWordTarget(
  state: EditorState,
  block: Block,
  target: number,
  dir: "left" | "right",
): number {
  return caretTokenClamp(state, block, target, dir) ?? target;
}

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
      const newIndex = snapWordTarget(
        state,
        block,
        findWordBoundary(text, textIndex, "right"),
        "right",
      );
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
      const newIndex = snapWordTarget(
        state,
        block,
        findWordBoundary(text, textIndex, "left"),
        "left",
      );
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
      const newIndex = snapWordTarget(
        state,
        block,
        findWordBoundary(text, textIndex, "left"),
        "left",
      );
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
      const newIndex = snapWordTarget(
        state,
        block,
        findWordBoundary(text, textIndex, "right"),
        "right",
      );
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

export function deleteWordForward(state: EditorState): ActionResult {
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
    // Delete word forward within the current line. Mirrors the backward case:
    // the boundary snaps to the next legal caret stop in atomic inline content
    // and never reaches into the middle of an inline-math chip from plain text.
    const endIndex =
      caretStep(state, oldBlock, textIndex, "right") ??
      snapWordTarget(
        state,
        oldBlock,
        findWordDeleteBoundaryRight(oldText, textIndex),
        "right",
      );
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
      ops.push(
        ...applyMarkdownPrefix(blockCopy, state.CRDTbinding, state.schema).ops,
      );
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
        state.schema,
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

export function deleteWordBackward(state: EditorState): ActionResult {
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
    // Delete word backward within the current line. In atomic inline content the
    // boundary snaps to the previous legal caret stop (a whole command/construct
    // unit), and a word delete in plain text never reaches into the middle of an
    // inline-math chip — so Ctrl+Backspace can't chop `\int` into `\in`.
    const startIndex =
      caretStep(state, oldBlock, textIndex, "left") ??
      snapWordTarget(
        state,
        oldBlock,
        findWordDeleteBoundaryLeft(oldText, textIndex),
        "left",
      );
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
      ops.push(
        ...applyMarkdownPrefix(blockCopy, state.CRDTbinding, state.schema).ops,
      );
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
      state.schema,
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

// Find word boundaries for selection. Word characters are defined by
// `isWordChar` (letters, numbers, combining marks, joiners, underscore) so
// vocalized Arabic and joined Persian/Indic words stay whole.
// For CJK characters, each character is treated as a word.
function findWordStart(text: string, index: number): number {
  let i = index;

  // If we're at a CJK character, just select that one character
  if (i < text.length && isCJKCharacter(text[i])) {
    return i;
  }

  // Move left while we're in word characters (see isWordChar)
  // Stop at CJK characters
  while (i > 0 && isWordChar(text[i - 1]) && !isCJKCharacter(text[i - 1])) {
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

  // Move right while we're in word characters (see isWordChar)
  // Stop at CJK characters
  while (i < text.length && isWordChar(text[i]) && !isCJKCharacter(text[i])) {
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

  // Check if we're on a word character (see isWordChar)
  const isOnWord = textIndex < text.length && isWordChar(text[textIndex]);

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

export function splitBlock(state: EditorState): ActionResult {
  if (!state.document.cursor) return { state, ops: [] };

  // A single-block surface (e.g. a TitleEditor) never splits into a second
  // block: Enter is inert here, so the block count stays fixed. Hosts map Enter
  // to their own intent (commit/blur/advance focus) above the engine.
  if (state.view.window?.singleBlock) return { state, ops: [] };

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

  // (A block equation must not split its LaTeX on Enter — it finalizes and starts
  // a fresh paragraph below. That's a node-specific exit, so it lives in the
  // MathNode SPLIT_BLOCK handler, not here; this function stays type-agnostic.)

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
        const orderKey = orderKeyAfter(state.document.page.blocks, oldBlock.id);
        const newParagraph: Block = {
          id: newParagraphId,
          orderKey,
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
          orderKey,
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
          orderKey: oldBlock.orderKey,
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
    // Continue the same list type — but clamp to the authoring allow-list so a
    // restricted editor never MINTS a disallowed type (coerceCreatable is
    // identity when unrestricted). The COERCED type is what we emit, so a remote
    // replay of this op converges. List-specific initialProps (checked/indent)
    // only apply while the continuation stays a list; a coerced-to-paragraph
    // fallback drops them.
    const newBlockType = state.schema.coerceCreatable(
      oldBlock.type,
    ) as Block["type"];
    const continuesList = newBlockType === oldBlock.type;

    const blockInsertOp: BlockInsert = {
      op: "block_insert",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      orderKey: orderKeyAfter(state.document.page.blocks, oldBlock.id),
      blockId: newBlockId,
      blockType: newBlockType,
      initialProps: continuesList
        ? isTogglable(oldBlock.type)
          ? { checked: false, indent: oldBlock.indent }
          : { indent: oldBlock.indent }
        : undefined,
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

    const block1Index = findBlockIndex(pageAcc, oldBlock.id);
    const block2Index = findBlockIndex(pageAcc, newBlockId);
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

  // Handle non-list text blocks. Headings have their familiar asymmetric split
  // policy; every other textual type preserves its registered type by default.
  // Node-specific handlers can still claim SPLIT_BLOCK for special exits
  // (MathNode, CodeNode, QuoteNode). Falling back to "paragraph" here used to
  // silently erase any new textual node type on Enter.
  let blockCopy1Type: Block["type"];
  let blockCopy2Type: Block["type"];

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
    // Paragraphs and extensible textual nodes preserve their type. A node that
    // wants different boundary behavior claims SPLIT_BLOCK in registerActions.
    blockCopy1Type = originalType;
    blockCopy2Type = originalType;
  }

  // Clamp the newly-minted continuation (block 2) to the authoring allow-list so
  // a restricted editor never CREATES a disallowed block on Enter — identity when
  // unrestricted; a disallowed continuation degrades to a plain paragraph. The
  // coerced type is what the block_insert below emits, so a remote replay of the
  // split converges. Block 1 already exists (never minted here) and needs no clamp.
  blockCopy2Type = state.schema.coerceCreatable(
    blockCopy2Type,
  ) as Block["type"];

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
    const currentBlock1 = findBlock(pageAcc, oldBlock.id);
    if (currentBlock1 && isTextualBlock(currentBlock1)) {
      const mutableClone = { ...currentBlock1, type: blockCopy1Type } as Block;
      const { ops: prefixOps } = applyMarkdownPrefix(
        mutableClone,
        state.CRDTbinding,
        state.schema,
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
    orderKey: orderKeyAfter(pageAcc.blocks, oldBlock.id),
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
  //    Match each original MarkSpan against the inserted chars, emit one
  //    mark_set per overlap, then apply them to pageAcc in one batch.
  const block2 = findBlock(pageAcc, newBlockId);
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

      const formatOps: MarkSet[] = [];
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
            op: "mark_set",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: newBlockId,
            charIds: coveredNewIds,
            format: span.format,
            value: true,
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
  const block1Final = findBlock(pageAcc, oldBlock.id);
  const block2Final = findBlock(pageAcc, newBlockId);
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

  // For atomic (non-textual) blocks — image/line/math/custom void — select the
  // whole block by marking its position. Gated on the textual capability, not
  // an `image` literal, so every visual block selects uniformly.
  if (!isTextualBlock(block)) {
    const blockPosition: Position = { blockIndex: blockIndex, textIndex: 0 };

    let newState = moveCursorToPosition(state, blockIndex, 0);

    // Create a selection that spans the atomic block
    newState = {
      ...newState,
      document: {
        ...newState.document,
        selection: {
          anchor: blockPosition,
          focus: blockPosition,
          isForward: true,
          isCollapsed: false, // Mark as not collapsed to show selection
          lastUpdate: Date.now(),
          initialBoundary: {
            start: blockPosition,
            end: blockPosition,
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
 * Generic function to toggle an inline mark on selected text or at the cursor.
 * If there's no selection, toggles the format mode for next typed text.
 *
 * `formatType` is any toggleable mark type (the built-ins plus custom toggle
 * marks); callers gate non-toggleable marks (link) before reaching here.
 */
export function toggleFormat(
  state: EditorState,
  formatType: string,
): ActionResult {
  // Honor the authoring allow-list: toggling a disallowed mark is a no-op on
  // every path that funnels through here (ChangeApi.setMark's toggle branch and
  // the built-in TOGGLE_* actions). No-op for an unrestricted schema.
  if (!state.schema.isMarkAllowed(formatType)) return { state, ops: [] };

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
    let currentFormats: readonly Mark[];
    if (state.ui.activeMarksMode.type === "explicit") {
      currentFormats = state.ui.activeMarksMode.formats;
    } else {
      // Inherit mode: check formatting at cursor position
      currentFormats = getFormatsAtCharPosition(
        block.charRuns,
        block.formats,
        textIndex,
      );
    }

    const hasFormat = currentFormats.some((f) => f.type === formatType);

    let newFormats: Mark[];
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
          activeMarksMode: { type: "explicit", formats: newFormats },
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
    const { newPage, op } = markCharsInRange(
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
        const { newPage, op } = markCharsInRange(
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
 * Toggle the `strong` (bold) mark on selected text or at cursor position.
 * If there's no selection, toggles `strong` mode for next typed text.
 */
export function toggleStrong(state: EditorState): ActionResult {
  return toggleFormat(state, "strong");
}

/**
 * Toggle the `emphasis` (italic) mark on selected text or at cursor position.
 * If there's no selection, toggles `emphasis` mode for next typed text.
 */
export function toggleEmphasis(state: EditorState): ActionResult {
  return toggleFormat(state, "emphasis");
}

/**
 * Toggle code formatting on selected text or at cursor position
 * If there's no selection, toggles code mode for next typed text
 */
export function toggleCode(state: EditorState): ActionResult {
  return toggleFormat(state, "code");
}

/**
 * Toggle the `strike` (strike-through) mark on selected text or at cursor
 * position. If there's no selection, toggles `strike` mode for next typed text.
 */
export function toggleStrike(state: EditorState): ActionResult {
  return toggleFormat(state, "strike");
}

/**
 * Convert the block at the cursor to `params.type`, emitting the CRDT ops and
 * placing the caret. A generic document operation — knows nothing about menus:
 * a slash plugin, a toolbar, or a shortcut can all drive it.
 *
 * `deleteFrom`/`deleteTo` describe an optional text range to strip from the
 * source block before converting (e.g. a slash plugin passes the `/filter`
 * range so the trigger text is consumed). They apply to the textual/list
 * conversions; void blocks (image/math/line) always clear all text. Both
 * default to the current caret index, i.e. no deletion.
 */
export function convertBlockAtCursor(
  state: EditorState,
  params: { type: Block["type"]; deleteFrom?: number; deleteTo?: number },
): ActionResult {
  if (!state.document.cursor) return { state, ops: [] };

  // Honor the schema's authoring allow-list — converting to a disallowed type is
  // a clean no-op (a slash/command convert simply does nothing), mirroring the
  // reducer dropping a type it can't model. No-op for an unrestricted schema.
  if (!state.schema.isBlockAllowed(params.type)) return { state, ops: [] };

  const ops: Operation[] = [];
  const blockIndex = state.document.cursor.position.blockIndex;
  const cursorIndex = state.document.cursor.position.textIndex;
  const deleteFrom = params.deleteFrom ?? cursorIndex;
  const deleteTo = params.deleteTo ?? cursorIndex;
  const action = { type: params.type };

  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return { state, ops: [] };

  // Converting TO a non-textual (atomic) block — image/math/line or any custom
  // void type. One path for all of them: the new block is the target type's
  // default (from its descriptor), the source block's text is cleared and its
  // type morphed, and the caret moves to the next block — creating a trailing
  // paragraph when this was the last block, since the caret can't live inside an
  // atomic block. A new atomic block type becomes slash-convertible with no
  // code here.
  if (!hasTextContent(action.type)) {
    const newBlock = createDefaultBlock(
      action.type,
      block.id,
      block.orderKey ?? "",
    );
    if (!newBlock) return { state, ops: [] };

    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = newBlock;
    const newPage = { ...state.document.page, blocks: newBlocks };

    // Emit CRDT ops only when morphing from a textual source: clear its text and
    // change its type. (An atomic→atomic slash conversion leaves the source's
    // CRDT type untouched, matching the prior per-type handlers.)
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
        value: action.type,
      };
      ops.push(blockSetOp);
    }

    // Update state
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };

    // Move the caret to the next block, creating a trailing paragraph if this
    // was the last block (the caret can't live inside an atomic block).
    if (blockIndex + 1 < newBlocks.length) {
      newState = moveCursorToPosition(newState, blockIndex + 1, 0);
    } else {
      const newParagraphId = state.CRDTbinding.nextId();
      const orderKey = orderKeyAfter(state.document.page.blocks, block.id);
      const newParagraph: Block = {
        id: newParagraphId,
        orderKey,
        type: "paragraph",
        charRuns: [],
        formats: [],
      };

      const blockInsertOp: BlockInsert = {
        op: "block_insert",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        orderKey,
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

  // Only textual blocks accept slash-triggered text edits below; any
  // non-textual block (image, math, divider, custom void) just closes the
  // slash action. One capability check covers them all — no per-type list.
  if (!isTextualBlock(block)) {
    return { state, ops: [] };
  }

  // Delete the requested trigger range (e.g. a slash plugin's "/filter" text)
  const deleteStart = deleteFrom;
  const deleteEnd = deleteTo;

  // Delete that text using CRDT helper
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

  // Update block content and type. The converted block is the target type's
  // default (which carries its own fields — a list's `indent`, a todo's
  // `checked`, a code block's `language` — and preserves the document
  // position via `orderKey`), with the source block's text carried over. Code
  // drops inline marks (it has none); other textual types keep them. No
  // per-type literal — a new textual type converts with no code here.
  const defaults = createDefaultBlock(
    action.type,
    block.id,
    block.orderKey ?? "",
  );
  if (!defaults) return { state, ops: [] };
  const newBlock = {
    ...defaults,
    charRuns: updatedCharRuns,
    formats: canHaveFormats(action.type) ? block.formats : [],
  } as Block;

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
    value: action.type,
  };
  ops.push(blockSetOp);

  // Sync the target type's own fields (a list's `indent`, a todo's `checked`,
  // …) as block_set ops, driven by the type's descriptor so a new textual type
  // with extra fields converges with no per-type code here.
  const descriptor = getBlockDescriptor(action.type);
  if (descriptor) {
    for (const field of getBlockFieldNames(action.type)) {
      if (field === "type") continue;
      const value = (newBlock as unknown as Record<string, unknown>)[field];
      if (value === undefined) continue;
      ops.push({
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: block.id,
        field,
        value,
      } as BlockSet);
    }
  }

  // Update state
  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
  };
  newState = moveCursorToPosition(newState, blockIndex, deleteFrom);

  return { state: newState, ops };
}

/**
 * Indent a list item (increase indent level)
 */
export function indentListItem(state: EditorState): ActionResult {
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
export function outdentListItem(state: EditorState): ActionResult {
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
      orderKey: block.orderKey,
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
 * Move a block to sit immediately after `afterBlockId` (null = head of the
 * document) by minting a fresh fractional-index `orderKey` and emitting a
 * single `block_set` op for it. Position is an LWW register, so a move
 * converges through the same last-writer-wins path as any other block property
 * — no neighbour re-anchoring, no dedicated move op.
 *
 * Pure `(state) => { state, ops }` transform. Guards refuse to emit a no-op;
 * the local page is derived by replaying the emitted op through `applyOp` so
 * local emit and remote apply can never drift.
 */
export function moveBlock(
  state: EditorState,
  blockId: string,
  afterBlockId: string | null,
): ActionResult {
  const page = state.document.page;

  const block = findBlock(page, blockId);
  if (!block || block.deleted) return { state, ops: [] };

  // A block cannot follow itself.
  if (afterBlockId === blockId) return { state, ops: [] };

  // Refuse to anchor to a target that does not exist (or is tombstoned): the
  // block would silently jump to the end of the document.
  if (afterBlockId !== null) {
    const target = findBlock(page, afterBlockId);
    if (!target || target.deleted) return { state, ops: [] };
  }

  // Already positioned immediately after the requested anchor — nothing to do.
  const ordered = sortBlocksByOrder(page.blocks);
  const currentIndex = ordered.findIndex((b) => b.id === blockId);
  const predecessorId = currentIndex > 0 ? ordered[currentIndex - 1].id : null;
  if (predecessorId === afterBlockId) return { state, ops: [] };

  const op: BlockSet = {
    op: "block_set",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId,
    field: "orderKey",
    value: orderKeyAfter(page.blocks, afterBlockId),
  };

  const newPage = applyOp(page, op);

  return {
    state: {
      ...state,
      document: { ...state.document, page: newPage },
    },
    ops: [op],
  };
}

/**
 * Toggle the checked state of a todo list item
 */
export function toggleTodoChecked(
  state: EditorState,
  blockIndex: number,
): ActionResult {
  const ops: Operation[] = [];

  // SAFETY: Validate blockIndex bounds and check block is not deleted
  if (blockIndex < 0 || blockIndex >= state.document.page.blocks.length) {
    return { state, ops: [] };
  }
  const block = state.document.page.blocks[blockIndex];
  // Gate on the `togglable` capability, not a `todo_list` literal — any block
  // type that declares it carries a `checked` field this can flip.
  if (!block || block.deleted || !isTogglable(block.type)) {
    return { state, ops: [] };
  }
  // A togglable block carries a `checked` field (todo today); read/flip it
  // structurally so this stays type-agnostic.
  const wasChecked = (block as { checked?: boolean }).checked ?? false;

  // Toggle checked state
  const newBlock = { ...block, checked: !wasChecked } as Block;

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
    value: !wasChecked,
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
): ActionResult {
  if (!state.document.cursor) return { state, ops: [] };

  // Honor the authoring allow-list. This builds the list block literal directly
  // (bypassing createDefaultBlock/convertBlockAtCursor), so it needs its own
  // gate; a disallowed list type is a clean no-op. No-op when unrestricted.
  if (!state.schema.isBlockAllowed(listType)) return { state, ops: [] };

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
