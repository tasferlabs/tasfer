import type {
  Block,
  Char,
  FormatSpan,
  TextFormat,
} from "../deserializer/loadPage";
import {
  isListBlock,
  isTextualBlock,
} from "../deserializer/loadPage";
import type { BlockInsert, BlockSet, Operation } from "../sync/types";
import {
  allCharsHaveFormat,
  deleteCharsInRange,
  formatCharsInRange,
  getFormatsAtCharPosition,
  getVisibleLength,
  getVisibleText,
  insertCharsAtPosition,
} from "./crdt-helpers";
import { isCJKCharacter } from "./fonts";
import { invalidateBlockCache } from "./renderer";
import { isRTLChar } from "./rtl";
import {
  clearAutoCreatedParagraph,
  clearSelection,
  closeSlashCommand,
  getBlockTextContent,
  getBlockTextLength,
  moveCursorToPosition,
  startSelection,
  updateMode,
  updateSelectionFocus,
} from "./state";
import type {
  CommandResult,
  CRDTContext,
  EditorState,
  Position,
  SlashCommand,
} from "./types";
import {
  positionToCRDT,
  crdtToPosition,
  selectionRangeToCRDT,
  crdtToSelectionRange,
} from "./undo";

/**
 * Helper to determine if text is RTL based on character array
 */
function isBlockRTL(chars: Char[]): boolean {
  let totalRtl = 0;
  let totalLtr = 0;
  
  for (const char of chars) {
    if (char.deleted) continue;
    if (isRTLChar(char.char)) {
      totalRtl++;
    } else if (/[a-zA-Z]/.test(char.char)) {
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
  textIndex: number
): readonly TextFormat[] | undefined {
  if (!isTextualBlock(block)) {
    return undefined;
  }

  return getFormatsAtCharPosition(block.chars, block.formats, textIndex);
}


/**
 * Detect and apply live markdown inline formatting patterns
 * Returns null if no pattern was matched, otherwise returns the transformed content and new cursor position
 */
function detectAndApplyInlineMarkdown(
  chars: Char[],
  formats: FormatSpan[],
  textIndex: number,
  blockId: string,
  crdt: CRDTContext
): {
  chars: Char[];
  formats: FormatSpan[];
  newTextIndex: number;
  ops: Operation[];
} | null {
  const fullText = getVisibleText(chars);
  const ops: Operation[] = [];

  // Patterns to match (in order of precedence to avoid conflicts)
  // **text** -> bold
  // *text* -> italic
  // ~~text~~ -> strikethrough
  // `text` -> code

  // Check for bold pattern: **text**
  const boldMatch = fullText.slice(0, textIndex).match(/\*\*([^\*]+)\*\*$/);
  if (boldMatch) {
    const matchStart = textIndex - boldMatch[0].length;
    const matchEnd = textIndex;
    const innerTextEnd = matchStart + 2 + boldMatch[1].length;

    // Delete the opening and closing ** markers
    const { newChars: charsAfterFirst, op: deleteOp1 } = deleteCharsInRange(
      chars,
      matchEnd - 2,
      matchEnd,
      blockId,
      crdt
    );
    ops.push(deleteOp1);

    const { newChars: charsAfterSecond, op: deleteOp2 } = deleteCharsInRange(
      charsAfterFirst,
      matchStart,
      matchStart + 2,
      blockId,
      crdt
    );
    ops.push(deleteOp2);

    // Apply bold formatting to the inner text
    const { newFormats: updatedFormats, op: formatOp } = formatCharsInRange(
      charsAfterSecond,
      formats,
      matchStart,
      innerTextEnd - 4, // Adjust for deleted markers
      blockId,
      { type: "bold" },
      true,
      crdt
    );
    ops.push(formatOp);

    return {
      chars: charsAfterSecond,
      formats: updatedFormats,
      newTextIndex: matchStart + boldMatch[1].length,
      ops,
    };
  }

  // Check for italic pattern: *text* (but not **)
  const italicMatch = fullText
    .slice(0, textIndex)
    .match(/(?<!\*)\*([^\*]+)\*$/);
  if (italicMatch) {
    const matchStart = textIndex - italicMatch[0].length;
    const matchEnd = textIndex;
    const innerTextEnd = matchStart + 1 + italicMatch[1].length;

    // Delete the opening and closing * markers
    const { newChars: charsAfterFirst, op: deleteOp1 } = deleteCharsInRange(
      chars,
      matchEnd - 1,
      matchEnd,
      blockId,
      crdt
    );
    ops.push(deleteOp1);

    const { newChars: charsAfterSecond, op: deleteOp2 } = deleteCharsInRange(
      charsAfterFirst,
      matchStart,
      matchStart + 1,
      blockId,
      crdt
    );
    ops.push(deleteOp2);

    // Apply italic formatting to the inner text
    const { newFormats: updatedFormats, op: formatOp } = formatCharsInRange(
      charsAfterSecond,
      formats,
      matchStart,
      innerTextEnd - 2, // Adjust for deleted markers
      blockId,
      { type: "italic" },
      true,
      crdt
    );
    ops.push(formatOp);

    return {
      chars: charsAfterSecond,
      formats: updatedFormats,
      newTextIndex: matchStart + italicMatch[1].length,
      ops,
    };
  }

  // Check for strikethrough pattern: ~~text~~
  const strikethroughMatch = fullText.slice(0, textIndex).match(/~~([^~]+)~~$/);
  if (strikethroughMatch) {
    const matchStart = textIndex - strikethroughMatch[0].length;
    const matchEnd = textIndex;
    const innerTextEnd = matchStart + 2 + strikethroughMatch[1].length;

    // Delete the opening and closing ~~ markers
    const { newChars: charsAfterFirst, op: deleteOp1 } = deleteCharsInRange(
      chars,
      matchEnd - 2,
      matchEnd,
      blockId,
      crdt
    );
    ops.push(deleteOp1);

    const { newChars: charsAfterSecond, op: deleteOp2 } = deleteCharsInRange(
      charsAfterFirst,
      matchStart,
      matchStart + 2,
      blockId,
      crdt
    );
    ops.push(deleteOp2);

    // Apply strikethrough formatting to the inner text
    const { newFormats: updatedFormats, op: formatOp } = formatCharsInRange(
      charsAfterSecond,
      formats,
      matchStart,
      innerTextEnd - 4, // Adjust for deleted markers
      blockId,
      { type: "strikethrough" },
      true,
      crdt
    );
    ops.push(formatOp);

    return {
      chars: charsAfterSecond,
      formats: updatedFormats,
      newTextIndex: matchStart + strikethroughMatch[1].length,
      ops,
    };
  }

  // Check for code pattern: `text`
  const codeMatch = fullText.slice(0, textIndex).match(/`([^`]+)`$/);
  if (codeMatch) {
    const matchStart = textIndex - codeMatch[0].length;
    const matchEnd = textIndex;
    const innerTextEnd = matchStart + 1 + codeMatch[1].length;

    // Delete the opening and closing ` markers
    const { newChars: charsAfterFirst, op: deleteOp1 } = deleteCharsInRange(
      chars,
      matchEnd - 1,
      matchEnd,
      blockId,
      crdt
    );
    ops.push(deleteOp1);

    const { newChars: charsAfterSecond, op: deleteOp2 } = deleteCharsInRange(
      charsAfterFirst,
      matchStart,
      matchStart + 1,
      blockId,
      crdt
    );
    ops.push(deleteOp2);

    // Apply code formatting to the inner text
    const { newFormats: updatedFormats, op: formatOp } = formatCharsInRange(
      charsAfterSecond,
      formats,
      matchStart,
      innerTextEnd - 2, // Adjust for deleted markers
      blockId,
      { type: "code" },
      true,
      crdt
    );
    ops.push(formatOp);

    return {
      chars: charsAfterSecond,
      formats: updatedFormats,
      newTextIndex: matchStart + codeMatch[1].length,
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
  preserveType: boolean = false
): Block {
  if (!isTextualBlock(block)) {
    return block;
  }
  const text = getVisibleText(block.chars);

  // Calculate indent level from leading spaces (2 spaces = 1 indent)
  const leadingSpaces = text.match(/^ +/)?.[0].length || 0;
  const indentLevel = Math.floor(leadingSpaces / 2);
  const textAfterSpaces = text.slice(leadingSpaces);

  // Helper to remove prefix characters (mutates block.chars)
  const removePrefix = (startIdx: number, endIdx: number) => {
    // Mark chars as deleted within the range
    let visibleCount = 0;
    block.chars = block.chars.map((char) => {
      if (!char.deleted) {
        if (visibleCount >= startIdx && visibleCount < endIdx) {
          visibleCount++;
          return { ...char, deleted: true };
        }
        visibleCount++;
      }
      return char;
    });
  };

  // Check for list markers
  if (textAfterSpaces.startsWith("- [ ] ")) {
    // Unchecked todo list
    (block as any).type = "todo_list";
    (block as any).checked = false;
    (block as any).indent = indentLevel;
    removePrefix(0, leadingSpaces + 6);
  } else if (
    textAfterSpaces.startsWith("- [x] ") ||
    textAfterSpaces.startsWith("- [X] ")
  ) {
    // Checked todo list
    (block as any).type = "todo_list";
    (block as any).checked = true;
    (block as any).indent = indentLevel;
    removePrefix(0, leadingSpaces + 6);
  } else if (textAfterSpaces.match(/^[-*+] /)) {
    // Bullet list
    (block as any).type = "bullet_list";
    (block as any).indent = indentLevel;
    removePrefix(0, leadingSpaces + 2);
  } else if (textAfterSpaces.match(/^\d+\. /)) {
    // Numbered list
    const match = textAfterSpaces.match(/^(\d+)\. /);
    if (match) {
      (block as any).type = "numbered_list";
      (block as any).indent = indentLevel;
      removePrefix(0, leadingSpaces + match[0].length);
    }
  } else if (text.startsWith("### ")) {
    block.type = "heading3";
    removePrefix(0, 4);
  } else if (text.startsWith("## ")) {
    block.type = "heading2";
    removePrefix(0, 3);
  } else if (text.startsWith("# ")) {
    block.type = "heading1";
    removePrefix(0, 2);
  } else if (text.match(/^-{3,}$/)) {
    // Line/divider block - three or more dashes with nothing else
    (block as any).type = "line";
    // Line blocks don't have chars - clear them
    (block as any).chars = [];
  } else if (!preserveType) {
    block.type = "paragraph";
    // Chars stay as-is with formatting preserved
  }
  return block;
}

// Helper function to get selection range in proper order (start to end)
export function getSelectionRange(
  state: EditorState
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
export function deleteSelectedText(
  state: EditorState,
  crdt: CRDTContext
): CommandResult {
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

    // Handle image block deletion
    if (!isTextualBlock(block)) {
      // For image blocks (and other visual blocks), delete the entire block
      // Check if this is the only block - if so, replace with empty paragraph
      if (state.document.page.blocks.length === 1) {
        // Delete the image block
        const blockDeleteOp: Operation = {
          op: "block_delete",
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
          blockId: block.id,
        };
        ops.push(blockDeleteOp);

        // Create new empty paragraph
        const emptyParagraphId = crdt.idGen();
        const emptyParagraph: Block = {
          id: emptyParagraphId,
          type: "paragraph",
          chars: [],
          formats: [],
        };
        
        const blockInsertOp: Operation = {
          op: "block_insert",
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
          afterBlockId: null,
          blockId: emptyParagraphId,
          blockType: "paragraph",
        };
        ops.push(blockInsertOp);

        const newPage = { ...state.document.page, blocks: [emptyParagraph] };

        let newState: EditorState = {
          ...state,
          document: { ...state.document, page: newPage },
        };
        newState = moveCursorToPosition(newState, 0, 0);
        newState = clearSelection(newState);
        return { state: newState, ops };
      }

      // Delete the image block
      const blockDeleteOp: Operation = {
        op: "block_delete",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
        blockId: block.id,
      };
      ops.push(blockDeleteOp);

      // Remove the image block
      const newBlocks = [
        ...state.document.page.blocks.slice(0, start.blockIndex),
        ...state.document.page.blocks.slice(start.blockIndex + 1),
      ];
      const newPage = { ...state.document.page, blocks: newBlocks };

      // Move cursor to the start of the next block, or end of previous block
      const newBlockIndex =
        start.blockIndex < newBlocks.length
          ? start.blockIndex
          : start.blockIndex - 1;

      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      newState = moveCursorToPosition(newState, newBlockIndex, 0);
      newState = clearSelection(newState);
      return { state: newState, ops };
    }

    // Handle text block deletion using CRDT helper
    const { newChars, op } = deleteCharsInRange(
      block.chars,
      start.textIndex,
      end.textIndex,
      block.id,
      crdt
    );
    ops.push(op);

    const blockCopy: Block = { ...block, chars: newChars };

    if (block.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }

    // Invalidate cache for the changed block
    invalidateBlockCache(blockCopy);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[start.blockIndex] = blockCopy;
    const newPage = { ...state.document.page, blocks: newBlocks };

    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    newState = moveCursorToPosition(
      newState,
      start.blockIndex,
      start.textIndex
    );
    newState = clearSelection(newState);
    return { state: newState, ops };
  } else {
    // Multi-block selection
    const startBlock = state.document.page.blocks[start.blockIndex];
    const endBlock = state.document.page.blocks[end.blockIndex];

    // Handle case where selection includes image blocks
    const startIsText = isTextualBlock(startBlock);
    const endIsText = isTextualBlock(endBlock);

    // If both start and end are non-text blocks, or if we're selecting multiple blocks
    // and at least one endpoint is a non-text block, we need special handling
    if (!startIsText || !endIsText) {
      // Delete all blocks in the range
      for (let i = start.blockIndex; i <= end.blockIndex; i++) {
        const blockToDelete = state.document.page.blocks[i];
        const blockDeleteOp: Operation = {
          op: "block_delete",
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
          blockId: blockToDelete.id,
        };
        ops.push(blockDeleteOp);
      }

      const blocksToKeep = [
        ...state.document.page.blocks.slice(0, start.blockIndex),
        ...state.document.page.blocks.slice(end.blockIndex + 1),
      ];

      // If we deleted all blocks, create an empty paragraph
      const needsEmptyParagraph = blocksToKeep.length === 0;
      let newBlocks: Block[];
      
      if (needsEmptyParagraph) {
        const emptyParagraphId = crdt.idGen();
        const emptyParagraph: Block = {
          id: emptyParagraphId,
          type: "paragraph" as const,
          chars: [],
          formats: [],
        };
        
        const blockInsertOp: Operation = {
          op: "block_insert",
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
          afterBlockId: null,
          blockId: emptyParagraphId,
          blockType: "paragraph",
        };
        ops.push(blockInsertOp);
        
        newBlocks = [emptyParagraph];
      } else {
        newBlocks = blocksToKeep;
      }

      const newPage = { ...state.document.page, blocks: newBlocks };

      // Move cursor to the start position (or 0 if all blocks were deleted)
      const newBlockIndex = Math.min(start.blockIndex, newBlocks.length - 1);

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
    const startBlockLen = getVisibleLength(startBlock.chars);
    const { newChars: startNewChars, op: startDeleteOp } = deleteCharsInRange(
      startBlock.chars,
      start.textIndex,
      startBlockLen,
      startBlock.id,
      crdt
    );
    ops.push(startDeleteOp);

    // Get the chars to keep from end block (after end.textIndex)
    const endBlockText = getBlockTextContent(endBlock);
    const textToKeep = endBlockText.slice(end.textIndex);

    // Merge: start block's chars (up to start.textIndex) + end block's chars (from end.textIndex)
    let mergedChars = startNewChars;

    if (textToKeep.length > 0) {
      // Insert the remaining text from end block into start block
      const { newChars: finalChars, op: insertOp } = insertCharsAtPosition(
        mergedChars,
        start.textIndex,
        textToKeep,
        startBlock.id,
        crdt
      );
      mergedChars = finalChars;
      ops.push(insertOp);
    }

    // TODO: Merge format spans from both blocks
    const blockCopy: Block = {
      ...startBlock,
      chars: mergedChars,
    };

    if (startBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }

    // Invalidate cache for merged block
    invalidateBlockCache(blockCopy);

    // Delete all blocks from start+1 to end (inclusive)
    for (let i = start.blockIndex + 1; i <= end.blockIndex; i++) {
      const blockToDelete = state.document.page.blocks[i];
      const blockDeleteOp: Operation = {
        op: "block_delete",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
        blockId: blockToDelete.id,
      };
      ops.push(blockDeleteOp);
    }

    // Remove all blocks from start+1 to end (inclusive) and replace start block
    const newBlocks = [
      ...state.document.page.blocks.slice(0, start.blockIndex),
      blockCopy,
      ...state.document.page.blocks.slice(end.blockIndex + 1),
    ];
    const newPage = { ...state.document.page, blocks: newBlocks };

    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };

    newState = moveCursorToPosition(
      newState,
      start.blockIndex,
      start.textIndex
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
export function insertText(
  state: EditorState,
  input: string,
  crdt: CRDTContext
): CommandResult {
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
      if (block && block.type === "image") {
        // Block typing on selected image
        return { state, ops: [] };
      }
    }
    // For other selections, delete them first and collect ops
    const deleteResult = deleteSelectedText(state, crdt);
    state = deleteResult.state;
    ops.push(...deleteResult.ops);
    // Ensure cursor still exists after deletion
    if (!state.document.cursor) {
      return { state, ops };
    }
  }

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return { state, ops };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops };

  const { blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  if (!isTextualBlock(oldBlock)) {
    return { state, ops };
  }

  // Use CRDT helper to insert chars and generate operation atomically
  // This ensures the data and operation always match by construction
  const { newChars, op } = insertCharsAtPosition(
    oldBlock.chars,
    textIndex,
    input,
    oldBlock.id,
    crdt
  );
  ops.push(op);

  // Calculate the position after insertion
  const newTextIndex = textIndex + input.length;

  // Handle active formats (when user has toggled formatting without selection)
  let newFormats = oldBlock.formats;
  if (state.ui.activeFormatsMode.type === "explicit") {
    const activeFormats = state.ui.activeFormatsMode.formats;
    // Apply each active format to the newly inserted characters
    for (const format of activeFormats) {
      const { newFormats: updatedFormats, op: formatOp } = formatCharsInRange(
        newChars,
        newFormats,
        textIndex,
        newTextIndex,
        oldBlock.id,
        format,
        true, // value for toggle formats (bold, italic, etc.)
        crdt
      );
      newFormats = updatedFormats;
      ops.push(formatOp);
    }
  }

  // Inline markdown detection (only on closing delimiter characters)
  const isClosingDelimiter = input === "*" || input === "`" || input === "~";
  let finalChars = newChars;
  let finalFormats = newFormats;
  let finalTextIndex = newTextIndex;

  if (isClosingDelimiter) {
    const markdownResult = detectAndApplyInlineMarkdown(
      newChars,
      newFormats,
      newTextIndex,
      oldBlock.id,
      crdt
    );
    if (markdownResult) {
      // Save history BEFORE applying markdown (with raw markdown text)
      const blockBeforeMarkdown: Block = {
        ...oldBlock,
        chars: newChars,
        formats: newFormats,
      };
      applyMarkdownPrefix(blockBeforeMarkdown, oldBlock.type !== "paragraph");
      invalidateBlockCache(blockBeforeMarkdown);

      const blocksBeforeMarkdown = [
        ...state.document.page.blocks.slice(0, blockIndex),
        blockBeforeMarkdown,
        ...state.document.page.blocks.slice(blockIndex + 1),
      ];
      const pageBeforeMarkdown = {
        ...state.document.page,
        blocks: blocksBeforeMarkdown,
      };

      let stateBeforeMarkdown: EditorState = {
        ...state,
        document: { ...state.document, page: pageBeforeMarkdown },
      };
      stateBeforeMarkdown = moveCursorToPosition(
        stateBeforeMarkdown,
        blockIndex,
        newTextIndex
      );
      stateBeforeMarkdown = updateMode(stateBeforeMarkdown, "edit");

      // Record the state with raw markdown
      state = (stateBeforeMarkdown);

      // Now apply the markdown transformation
      finalChars = markdownResult.chars;
      finalFormats = markdownResult.formats;
      finalTextIndex = markdownResult.newTextIndex;
      ops.push(...markdownResult.ops);
    }
  }

  // Create updated block with new chars and formats
  const blockCopy: Block = {
    ...oldBlock,
    chars: finalChars,
    formats: finalFormats,
  };
  applyMarkdownPrefix(blockCopy, oldBlock.type !== "paragraph");

  // Invalidate cache for the changed block (do it BEFORE adding to page)
  invalidateBlockCache(blockCopy);

  const newBlocks = [
    ...state.document.page.blocks.slice(0, blockIndex),
    blockCopy,
    ...state.document.page.blocks.slice(blockIndex + 1),
  ];
  const newPage = { ...state.document.page, blocks: newBlocks };

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
  };
  // Preserve active formats when moving cursor after typing
  newState = moveCursorToPosition(newState, blockIndex, finalTextIndex, true);
  // Clear auto-created paragraph tracking on text input
  newState = clearAutoCreatedParagraph(newState);
  newState = updateMode(newState, "edit");

  return { state: newState, ops };
}

export function deleteText(
  state: EditorState,
  crdt: CRDTContext
): CommandResult {
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
    return deleteSelectedText(state, crdt);
  }

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return { state, ops };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops };

  const { blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];
  if (!isTextualBlock(oldBlock)) {
    return { state, ops };
  }
  if (textIndex > 0) {
    // Delete one character before cursor using CRDT helper
    const { newChars, op } = deleteCharsInRange(
      oldBlock.chars,
      textIndex - 1,
      textIndex,
      oldBlock.id,
      crdt
    );
    ops.push(op);

    const blockCopy: Block = { ...oldBlock, chars: newChars };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate cache for the changed block
    invalidateBlockCache(blockCopy);
    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };

    // Preserve active formats when deleting during typing (e.g., pressing backspace while in bold mode)
    newState = moveCursorToPosition(newState, blockIndex, textIndex - 1, true);
    return { state: newState, ops };
  } else if (blockIndex > 0) {
    // Special handling for list blocks at textIndex 0: outdent instead of merging
    if (isListBlock(oldBlock)) {
      const currentIndent = oldBlock.indent || 0;
      const currentText = getBlockTextContent(oldBlock);

      // If block is empty, delete it instead of outdenting or converting
      if (currentText.length === 0) {
        const prevBlock = state.document.page.blocks[blockIndex - 1];
        
        // Delete the empty list block
        const blockDeleteOp: Operation = {
          op: "block_delete",
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
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
        // Move cursor to end of previous block
        const prevTextLength = isTextualBlock(prevBlock)
          ? getBlockTextContent(prevBlock).length
          : 0;
        newState = moveCursorToPosition(newState, blockIndex - 1, prevTextLength);
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
          chars: oldBlock.chars,
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

    const prevBlock = state.document.page.blocks[blockIndex - 1];

    // If previous block is not a text block (e.g., image)
    if (!isTextualBlock(prevBlock)) {
      if (!isTextualBlock(oldBlock)) {
        return { state, ops };
      }

      const currentText = getBlockTextContent(oldBlock);
      const imageBlockIndex = blockIndex - 1;
      const imagePosition = { blockIndex: imageBlockIndex, textIndex: 0 };

      // Only delete the current text block if it's empty
      if (currentText.length === 0) {
        // Delete the empty text block
        const blockDeleteOp: Operation = {
          op: "block_delete",
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
          blockId: oldBlock.id,
        };
        ops.push(blockDeleteOp);
        
        const newBlocks = [
          ...state.document.page.blocks.slice(0, blockIndex),
          ...state.document.page.blocks.slice(blockIndex + 1),
        ];

        // If we deleted the last block, add an empty paragraph
        if (newBlocks.length === 0) {
          const emptyParagraphId = crdt.idGen();
          const emptyParagraph: Block = {
            id: emptyParagraphId,
            type: "paragraph",
            chars: [],
            formats: [],
          };
          
          const blockInsertOp: Operation = {
            op: "block_insert",
            id: crdt.idGen(),
            clock: crdt.clock(),
            pageId: crdt.pageId,
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

      // If current block has content, just select the image without deleting the text
      let newState = moveCursorToPosition(state, imageBlockIndex, 0);
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
    // Merge the chars and formats arrays
    const mergedChars = [...prevBlock.chars, ...oldBlock.chars];
    const mergedFormats = [...prevBlock.formats, ...oldBlock.formats];

    // Determine which block to preserve
    const prevIsEmpty = prevText.length === 0;
    const blockToPreserve = prevIsEmpty ? oldBlock : prevBlock;
    const blockToDelete = prevIsEmpty ? prevBlock : oldBlock;

    // Delete the block that's being merged away
    const blockDeleteOp: Operation = {
      op: "block_delete",
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
      blockId: blockToDelete.id,
    };
    ops.push(blockDeleteOp);

    const blockCopy: Block = {
      ...blockToPreserve,
      chars: mergedChars,
      formats: mergedFormats,
    };
    // Only apply markdown prefix if the resulting type is a paragraph
    if (blockCopy.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate the merged block
    invalidateBlockCache(blockCopy);
    const newBlocks = [
      ...state.document.page.blocks.slice(0, blockIndex - 1),
      blockCopy,
      ...state.document.page.blocks.slice(blockIndex + 1),
    ];
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };

    newState = moveCursorToPosition(newState, blockIndex - 1, prevText.length);
    return { state: newState, ops };
  } else {
    // At textIndex 0 and blockIndex 0 (first block)
    // If it's an empty list item, convert to paragraph
    if (isListBlock(oldBlock)) {
      const currentText = getBlockTextContent(oldBlock);
      if (currentText.length === 0) {
        const paragraphBlock: Block = {
          id: oldBlock.id,
          type: "paragraph",
          chars: oldBlock.chars,
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
  return { state, ops };
}

// Forward delete (Delete key) - deletes character after cursor
export function deleteForward(
  state: EditorState,
  crdt: CRDTContext
): CommandResult {
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
    return deleteSelectedText(state, crdt);
  }

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return { state, ops };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops };

  const { blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  if (!isTextualBlock(oldBlock)) {
    return { state, ops };
  }

  const oldText = getBlockTextContent(oldBlock);

  if (textIndex < oldText.length) {
    // Delete character after cursor using CRDT helper
    const { newChars, op } = deleteCharsInRange(
      oldBlock.chars,
      textIndex,
      textIndex + 1,
      oldBlock.id,
      crdt
    );
    ops.push(op);

    const blockCopy: Block = { ...oldBlock, chars: newChars };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate cache for the changed block
    invalidateBlockCache(blockCopy);
    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    // Preserve active formats when deleting during typing
    newState = moveCursorToPosition(newState, blockIndex, textIndex, true);
    return { state: newState, ops };
  } else if (blockIndex < state.document.page.blocks.length - 1) {
    // Merge with next block, preserving formatting
    const nextBlock = state.document.page.blocks[blockIndex + 1];

    // If next block is not a text block (e.g., image), delete the current text block
    if (!isTextualBlock(nextBlock)) {
      // Delete the current text block
      const blockDeleteOp: Operation = {
        op: "block_delete",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
        blockId: oldBlock.id,
      };
      ops.push(blockDeleteOp);

      const newBlocks = [
        ...state.document.page.blocks.slice(0, blockIndex),
        ...state.document.page.blocks.slice(blockIndex + 1),
      ];

      // If we deleted the last block, add an empty paragraph
      if (newBlocks.length === 0) {
        const emptyParagraphId = crdt.idGen();
        const emptyParagraph: Block = {
          id: emptyParagraphId,
          type: "paragraph",
          chars: [],
          formats: [],
        };
        
        const blockInsertOp: Operation = {
          op: "block_insert",
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
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

    const mergedChars = [...oldBlock.chars, ...nextBlock.chars];
    const mergedFormats = [...oldBlock.formats, ...nextBlock.formats];

    // Determine which block to preserve
    const currentIsEmpty = oldText.length === 0;
    const blockToPreserve = currentIsEmpty ? nextBlock : oldBlock;
    const blockToDelete = currentIsEmpty ? oldBlock : nextBlock;

    // Delete the block that's being merged away
    const blockDeleteOp: Operation = {
      op: "block_delete",
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
      blockId: blockToDelete.id,
    };
    ops.push(blockDeleteOp);

    const blockCopy: Block = {
      ...blockToPreserve,
      chars: mergedChars,
      formats: mergedFormats,
    };
    // Only apply markdown prefix if the resulting type is a paragraph
    if (blockCopy.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate the merged block
    invalidateBlockCache(blockCopy);
    const newBlocks = [
      ...state.document.page.blocks.slice(0, blockIndex),
      blockCopy,
      ...state.document.page.blocks.slice(blockIndex + 2),
    ];
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    newState = moveCursorToPosition(newState, blockIndex, textIndex);
    return { state: newState, ops };
  }
  return { state, ops };
}

// Helper function to find word boundaries - distinguishes between word characters and non-word characters
// Uses Unicode property escapes to support all languages
// For CJK text, each character is treated as a word boundary
function findWordBoundary(
  text: string,
  index: number,
  direction: "left" | "right"
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
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return state;

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return state;

  const { blockIndex, textIndex } = position;
  const block = state.document.page.blocks[blockIndex];
  const text = getBlockTextContent(block);

  if (!isTextualBlock(block)) {
    return state;
  }

  // Check if current block is RTL
  const isRTL = isBlockRTL(block.chars);

  if (isRTL) {
    // In RTL, "previous word" (Ctrl+Left) should move visually left, which is logically forward
    if (textIndex < text.length) {
      const newIndex = findWordBoundary(text, textIndex, "right");
      return moveCursorToPosition(state, blockIndex, newIndex);
    } else if (blockIndex < state.document.page.blocks.length - 1) {
      // Move to start of next block
      return moveCursorToPosition(state, blockIndex + 1, 0);
    }
  } else {
    // LTR behavior (original)
    if (textIndex > 0) {
      const newIndex = findWordBoundary(text, textIndex, "left");
      return moveCursorToPosition(state, blockIndex, newIndex);
    } else if (blockIndex > 0) {
      // Move to end of previous block
      const prevBlock = state.document.page.blocks[blockIndex - 1];
      const prevText = getBlockTextContent(prevBlock);
      return moveCursorToPosition(state, blockIndex - 1, prevText.length);
    }
  }
  return state;
}

// Move cursor to next word boundary
export function moveToNextWord(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return state;

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return state;

  const { blockIndex, textIndex } = position;
  const block = state.document.page.blocks[blockIndex];
  const text = getBlockTextContent(block);

  if (!isTextualBlock(block)) {
    return state;
  }

  // Check if current block is RTL
  const isRTL = isBlockRTL(block.chars);

  if (isRTL) {
    // In RTL, "next word" (Ctrl+Right) should move visually right, which is logically backward
    if (textIndex > 0) {
      const newIndex = findWordBoundary(text, textIndex, "left");
      return moveCursorToPosition(state, blockIndex, newIndex);
    } else if (blockIndex > 0) {
      // Move to end of previous block
      const prevBlock = state.document.page.blocks[blockIndex - 1];
      const prevText = getBlockTextContent(prevBlock);
      return moveCursorToPosition(state, blockIndex - 1, prevText.length);
    }
  } else {
    // LTR behavior (original)
    if (textIndex < text.length) {
      const newIndex = findWordBoundary(text, textIndex, "right");
      return moveCursorToPosition(state, blockIndex, newIndex);
    } else if (blockIndex < state.document.page.blocks.length - 1) {
      // Move to start of next block
      return moveCursorToPosition(state, blockIndex + 1, 0);
    }
  }
  return state;
}

export function deleteWordForward(
  state: EditorState,
  crdt: CRDTContext
): CommandResult {
  if (!state.document.cursor) {
    return { state, ops: [] };
  }

  const ops: Operation[] = [];

  if (state.document.selection && !state.document.selection.isCollapsed) {
    return deleteSelectedText(state, crdt);
  }

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return { state, ops };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops };

  const { blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];
  if (!isTextualBlock(oldBlock)) {
    return { state, ops };
  }

  const oldText = getBlockTextContent(oldBlock);

  if (textIndex < oldText.length) {
    // Delete word forward within the current line using CRDT helper
    const endIndex = findWordDeleteBoundaryRight(oldText, textIndex);
    const { newChars, op } = deleteCharsInRange(
      oldBlock.chars,
      textIndex,
      endIndex,
      oldBlock.id,
      crdt
    );
    ops.push(op);

    const blockCopy: Block = { ...oldBlock, chars: newChars };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate cache for the changed block
    invalidateBlockCache(blockCopy);
    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    // Preserve active formats when deleting during typing
    newState = moveCursorToPosition(newState, blockIndex, textIndex, true);
    return { state: newState, ops };
  } else if (blockIndex < state.document.page.blocks.length - 1) {
    // Special handling for list blocks at end of text: don't merge, just return
    // This prevents Ctrl+Delete from merging list items when at the end
    if (isListBlock(oldBlock)) {
      return { state, ops };
    }

    // At end of line - merge with next block, preserving formatting
    const nextBlock = state.document.page.blocks[blockIndex + 1];
    if (!isTextualBlock(nextBlock)) {
      return { state, ops };
    }
    const mergedChars = [...oldBlock.chars, ...nextBlock.chars];
    const mergedFormats = [...oldBlock.formats, ...nextBlock.formats];

    // Determine which block to preserve
    const currentIsEmpty = oldText.length === 0;
    const blockToPreserve = currentIsEmpty ? nextBlock : oldBlock;
    const blockToDelete = currentIsEmpty ? oldBlock : nextBlock;

    // Delete the block that's being merged away
    const blockDeleteOp: Operation = {
      op: "block_delete",
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
      blockId: blockToDelete.id,
    };
    ops.push(blockDeleteOp);

    const blockCopy: Block = {
      ...blockToPreserve,
      chars: mergedChars,
      formats: mergedFormats,
    };
    // Only apply markdown prefix if the resulting type is a paragraph
    if (blockCopy.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate the merged block
    invalidateBlockCache(blockCopy);
    const newBlocks = [
      ...state.document.page.blocks.slice(0, blockIndex),
      blockCopy,
      ...state.document.page.blocks.slice(blockIndex + 2),
    ];
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    newState = moveCursorToPosition(newState, blockIndex, textIndex);
    return { state: newState, ops };
  }
  return { state, ops };
}

export function deleteWordBackward(
  state: EditorState,
  crdt: CRDTContext
): CommandResult {
  if (!state.document.cursor) {
    return { state, ops: [] };
  }

  const ops: Operation[] = [];

  if (state.document.selection && !state.document.selection.isCollapsed) {
    return deleteSelectedText(state, crdt);
  }

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return { state, ops };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops };

  const { blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  if (!isTextualBlock(oldBlock)) {
    return { state, ops };
  }

  const oldText = getBlockTextContent(oldBlock);

  if (textIndex > 0) {
    // Delete word backward within the current line using CRDT helper
    const startIndex = findWordDeleteBoundaryLeft(oldText, textIndex);
    const { newChars, op } = deleteCharsInRange(
      oldBlock.chars,
      startIndex,
      textIndex,
      oldBlock.id,
      crdt
    );
    ops.push(op);

    const blockCopy: Block = { ...oldBlock, chars: newChars };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate cache for the changed block
    invalidateBlockCache(blockCopy);
    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.document.page, blocks: newBlocks };
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
    const mergedChars = [...prevBlock.chars, ...oldBlock.chars];
    const mergedFormats = [...prevBlock.formats, ...oldBlock.formats];

    // Determine which block to preserve
    const prevIsEmpty = prevText.length === 0;
    const blockToPreserve = prevIsEmpty ? oldBlock : prevBlock;
    const blockToDelete = prevIsEmpty ? prevBlock : oldBlock;

    // Delete the block that's being merged away
    const blockDeleteOp: Operation = {
      op: "block_delete",
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
      blockId: blockToDelete.id,
    };
    ops.push(blockDeleteOp);

    const blockCopy: Block = {
      ...blockToPreserve,
      chars: mergedChars,
      formats: mergedFormats,
    };
    // Only apply markdown prefix if the resulting type is a paragraph
    if (blockCopy.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate the merged block
    invalidateBlockCache(blockCopy);
    const newBlocks = [
      ...state.document.page.blocks.slice(0, blockIndex - 1),
      blockCopy,
      ...state.document.page.blocks.slice(blockIndex + 1),
    ];
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    newState = moveCursorToPosition(newState, blockIndex - 1, prevText.length);
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
  if (i > 0 && isCJKCharacter(text[i - 1])) {
    return i - 1;
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
  position: Position
): EditorState {
  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const positionCRDT = positionToCRDT(state.document.page, position);
  if (!positionCRDT) return state;

  const validPosition = crdtToPosition(state.document.page, positionCRDT);
  if (!validPosition) return state;

  const { blockIndex, textIndex } = validPosition;
  const block = state.document.page.blocks[blockIndex];
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

  const startPos: Position = { blockIndex, textIndex: wordStart };
  const endPos: Position = { blockIndex, textIndex: wordEnd };

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
  position: Position
): EditorState {
  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const positionCRDT = positionToCRDT(state.document.page, position);
  if (!positionCRDT) return state;

  const validPosition = crdtToPosition(state.document.page, positionCRDT);
  if (!validPosition) return state;

  const { blockIndex } = validPosition;
  const block = state.document.page.blocks[blockIndex];
  const text = getBlockTextContent(block);

  const startPos: Position = { blockIndex, textIndex: 0 };
  const endPos: Position = { blockIndex, textIndex: text.length };

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
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return state;

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return state;

  const { blockIndex } = position;
  return moveCursorToPosition(state, blockIndex, 0);
}

// Move to end of current line (End key)
export function moveToLineEnd(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return state;

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return state;

  const { blockIndex } = position;
  const block = state.document.page.blocks[blockIndex];
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
      movedState.document.cursor.position
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
      movedState.document.cursor.position
    );
  }
  return newState;
}

export function extendSelectionHome(
  state: EditorState,
  isCtrl: boolean
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
      movedState.document.cursor.position
    );
  }
  return newState;
}

export function extendSelectionEnd(
  state: EditorState,
  isCtrl: boolean
): EditorState {
  if (!state.document.cursor) return state;
  // If no selection exists, start one at current cursor position
  let newState = state;
  if (!state.document.selection) {
    newState = startSelection(state, state.document.cursor.position);
  }
  // Move cursor to end of line or document
  const movedState = isCtrl
    ? moveCursorToPosition(
        newState,
        newState.document.page.blocks.length - 1,
        getBlockTextLength(
          newState.document.page.blocks[
            newState.document.page.blocks.length - 1
          ]
        )
      )
    : moveToLineEnd(newState);
  if (movedState.document.cursor) {
    return updateSelectionFocus(
      movedState,
      movedState.document.cursor.position
    );
  }
  return newState;
}

export function splitBlock(
  state: EditorState,
  crdt: CRDTContext
): CommandResult {
  if (!state.document.cursor) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return { state, ops: [] };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops: [] };

  const { blockIndex, textIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  // Handle Enter key on selected image: create new paragraph below
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const { anchor, focus } = state.document.selection;
    // Check if this is a single image selection (anchor and focus at same position)
    if (
      anchor.blockIndex === focus.blockIndex &&
      anchor.textIndex === focus.textIndex
    ) {
      const block = state.document.page.blocks[anchor.blockIndex];
      if (block && block.type === "image") {
        // Create a new paragraph below the image
        const newParagraphId = crdt.idGen();
        const newParagraph: Block = {
          id: newParagraphId,
          type: "paragraph",
          chars: [],
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
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
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

  const oldText = getVisibleText(oldBlock.chars);

  // Preserve the original block type for both blocks
  const originalType = oldBlock.type;

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
          chars: [],
          formats: [],
        };
        
        const blockSetOp: BlockSet = {
          op: "block_set",
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
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
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
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
    
    // Delete text after cursor from first block
    if (textIndex < oldText.length) {
      const { op: deleteOp } = deleteCharsInRange(
        oldBlock.chars,
        textIndex,
        oldText.length,
        oldBlock.id,
        crdt
      );
      ops.push(deleteOp);
    }

    // Create new list item of same type
    const blockCopy1: Block = { 
      ...oldBlock, 
      chars: textIndex < oldText.length ? 
        oldBlock.chars.map((char, i) => {
          if (i >= findInsertIndex(oldBlock.chars, textIndex)) {
            return { ...char, deleted: true };
          }
          return char;
        }) : oldBlock.chars
    };

    const newBlockId = crdt.idGen();
    let blockCopy2: Block;
    if (oldBlock.type === "bullet_list") {
      blockCopy2 = {
        id: newBlockId,
        type: "bullet_list",
        chars: [],
        formats: [],
        indent: oldBlock.indent,
      };
    } else if (oldBlock.type === "numbered_list") {
      blockCopy2 = {
        id: newBlockId,
        type: "numbered_list",
        chars: [],
        formats: [],
        indent: oldBlock.indent,
      };
    } else {
      blockCopy2 = {
        id: newBlockId,
        type: "todo_list",
        chars: [],
        formats: [],
        checked: false, // New todo items start unchecked
        indent: oldBlock.indent,
      };
    }

    // Insert the new block
    const blockInsertOp: BlockInsert = {
      op: "block_insert",
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
      afterBlockId: oldBlock.id,
      blockId: newBlockId,
      blockType: blockCopy2.type,
      initialProps: oldBlock.type === "todo_list" ? { checked: false, indent: oldBlock.indent } : { indent: oldBlock.indent },
    };
    ops.push(blockInsertOp);
    
    // Insert text into new block if there was text after cursor
    if (afterCharsText.length > 0) {
      const { newChars, op: insertOp } = insertCharsAtPosition(
        blockCopy2.chars,
        0,
        afterCharsText,
        newBlockId,
        crdt
      );
      blockCopy2.chars = newChars;
      ops.push(insertOp);
    }

    invalidateBlockCache(blockCopy1);
    invalidateBlockCache(blockCopy2);

    const newBlocks = [
      ...state.document.page.blocks.slice(0, blockIndex),
      blockCopy1,
      blockCopy2,
      ...state.document.page.blocks.slice(blockIndex + 1),
    ];
    const newPage = { ...state.document.page, blocks: newBlocks };

    const newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    return { 
      state: moveCursorToPosition(newState, blockIndex + 1, 0),
      ops 
    };
  }

  // Handle heading and paragraph blocks (non-list text blocks)
  let blockCopy1Type: "heading1" | "heading2" | "heading3" | "paragraph";
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

  // Split the text content
  const afterCharsText = oldText.slice(textIndex);
  
  // Delete text after cursor from first block if needed
  if (textIndex < oldText.length) {
    const { op: deleteOp } = deleteCharsInRange(
      oldBlock.chars,
      textIndex,
      oldText.length,
      oldBlock.id,
      crdt
    );
    ops.push(deleteOp);
  }

  const blockCopy1: Block = {
    id: oldBlock.id,
    type: blockCopy1Type,
    chars: textIndex < oldText.length ?
      oldBlock.chars.map((char, i) => {
        if (i >= findInsertIndex(oldBlock.chars, textIndex)) {
          return { ...char, deleted: true };
        }
        return char;
      }) : oldBlock.chars,
    formats: oldBlock.formats,
  };
  
  // Only apply markdown prefix if the block type is a paragraph
  if (blockCopy1Type === "paragraph") {
    applyMarkdownPrefix(blockCopy1);
  }
  
  // Change block type if needed
  if (blockCopy1Type !== originalType) {
    const blockSetOp: BlockSet = {
      op: "block_set",
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
      blockId: oldBlock.id,
      field: "type",
      value: blockCopy1Type,
    };
    ops.push(blockSetOp);
  }

  const newBlockId = crdt.idGen();
  let blockCopy2Chars: Char[] = [];

  // Insert the new block FIRST (before inserting text into it)
  // This ensures remote peers have the block before receiving text operations for it
  const blockInsertOp: BlockInsert = {
    op: "block_insert",
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
    afterBlockId: oldBlock.id,
    blockId: newBlockId,
    blockType: blockCopy2Type,
  };
  ops.push(blockInsertOp);

  // Insert text into new block if there was text after cursor
  if (afterCharsText.length > 0) {
    const { newChars, op: insertOp } = insertCharsAtPosition(
      [],
      0,
      afterCharsText,
      newBlockId,
      crdt
    );
    blockCopy2Chars = newChars;
    ops.push(insertOp);
  }

  const blockCopy2: Block = {
    id: newBlockId,
    type: blockCopy2Type,
    chars: blockCopy2Chars,
    formats: [],
  } as Block;

  // Invalidate cache for both new blocks
  invalidateBlockCache(blockCopy1);
  invalidateBlockCache(blockCopy2);

  const newBlocks = [
    ...state.document.page.blocks.slice(0, blockIndex),
    blockCopy1,
    blockCopy2,
    ...state.document.page.blocks.slice(blockIndex + 1),
  ];
  const newPage = { ...state.document.page, blocks: newBlocks };

  const newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
  };
  return { 
    state: moveCursorToPosition(newState, blockIndex + 1, 0),
    ops 
  };
}

// Helper function to find insert index (used in splitBlock)
function findInsertIndex(chars: Char[], visiblePosition: number): number {
  let visibleCount = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].deleted) {
      if (visibleCount === visiblePosition) return i;
      visibleCount++;
    }
  }
  return chars.length;
}

export function selectAll(state: EditorState): EditorState {
  if (state.document.page.blocks.length === 0) return state;

  const startPos: Position = { blockIndex: 0, textIndex: 0 };
  const lastBlockIndex = state.document.page.blocks.length - 1;
  const lastBlock = state.document.page.blocks[lastBlockIndex];
  const lastBlockText = getBlockTextContent(lastBlock);
  const endPos: Position = {
    blockIndex: lastBlockIndex,
    textIndex: lastBlockText.length,
  };

  let newState = moveCursorToPosition(
    state,
    endPos.blockIndex,
    endPos.textIndex
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

  const { blockIndex } = state.document.cursor.position;
  const block = state.document.page.blocks[blockIndex];

  if (!block) return state;

  // For image blocks, select the block by marking it with a selection
  if (block.type === "image") {
    const imagePosition: Position = { blockIndex, textIndex: 0 };

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
  const startPos: Position = { blockIndex, textIndex: 0 };
  const endPos: Position = { blockIndex, textIndex: blockLength };

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
  crdt: CRDTContext
): CommandResult {
  const range = getSelectionRange(state);

  // If no selection, toggle format in UI's active formats
  if (!range) {
    if (!state.document.cursor) {
      return { state, ops: [] };
    }

    // SAFETY: Convert to CRDT position and back for validation against concurrent updates
    const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
    if (!cursorCRDT) return { state, ops: [] };

    const position = crdtToPosition(state.document.page, cursorCRDT);
    if (!position) return { state, ops: [] };

    const { blockIndex, textIndex } = position;
    const block = state.document.page.blocks[blockIndex];

    if (!isTextualBlock(block)) {
      return { state, ops: [] };
    }

    // Get current active formats or infer from cursor position
    let currentFormats: readonly TextFormat[];
    if (state.ui.activeFormatsMode.type === "explicit") {
      currentFormats = state.ui.activeFormatsMode.formats;
    } else {
      // Inherit mode: check formatting at cursor position
      currentFormats = getFormatsAtCharPosition(block.chars, block.formats, textIndex);
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

    if (!isTextualBlock(block)) {
      return { state, ops: [] };
    }

    // Check if all characters in the range already have the format
    const hasFormat = allCharsHaveFormat(
      block.chars,
      block.formats,
      start.textIndex,
      end.textIndex,
      formatType
    );

    // Toggle formatting: use helper to get new formats and operation
    const { newFormats, op } = formatCharsInRange(
      block.chars,
      block.formats,
      start.textIndex,
      end.textIndex,
      block.id,
      { type: formatType },
      !hasFormat, // Toggle: if has format, remove it (false); otherwise add it (true)
      crdt
    );

    const newBlock: Block = { ...block, formats: newFormats };
    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[start.blockIndex] = newBlock;
    const newPage = { ...state.document.page, blocks: newBlocks };

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
    const newBlocks = [...state.document.page.blocks];

    // First, check if all selected characters across all blocks have the format
    let hasFormat = true;
    for (let i = start.blockIndex; i <= end.blockIndex; i++) {
      const block = newBlocks[i];
      if (!isTextualBlock(block)) {
        continue;
      }

      let formatStart: number;
      let formatEnd: number;

      if (i === start.blockIndex && i === end.blockIndex) {
        formatStart = start.textIndex;
        formatEnd = end.textIndex;
      } else if (i === start.blockIndex) {
        formatStart = start.textIndex;
        formatEnd = getVisibleLength(block.chars);
      } else if (i === end.blockIndex) {
        formatStart = 0;
        formatEnd = end.textIndex;
      } else {
        formatStart = 0;
        formatEnd = getVisibleLength(block.chars);
      }

      if (formatStart < formatEnd) {
        const blockHasFormat = allCharsHaveFormat(
          block.chars,
          block.formats,
          formatStart,
          formatEnd,
          formatType
        );
        if (!blockHasFormat) {
          hasFormat = false;
          break;
        }
      }
    }

    // Now apply the formatting to each block
    for (let i = start.blockIndex; i <= end.blockIndex; i++) {
      const block = newBlocks[i];
      if (!isTextualBlock(block)) {
        continue;
      }

      let formatStart: number;
      let formatEnd: number;

      if (i === start.blockIndex && i === end.blockIndex) {
        formatStart = start.textIndex;
        formatEnd = end.textIndex;
      } else if (i === start.blockIndex) {
        formatStart = start.textIndex;
        formatEnd = getVisibleLength(block.chars);
      } else if (i === end.blockIndex) {
        formatStart = 0;
        formatEnd = end.textIndex;
      } else {
        formatStart = 0;
        formatEnd = getVisibleLength(block.chars);
      }

      if (formatStart < formatEnd) {
        const { newFormats, op } = formatCharsInRange(
          block.chars,
          block.formats,
          formatStart,
          formatEnd,
          block.id,
          { type: formatType },
          !hasFormat, // Toggle based on overall selection state
          crdt
        );

        const newBlock: Block = { ...block, formats: newFormats };
        invalidateBlockCache(newBlock);
        newBlocks[i] = newBlock;
        ops.push(op);
      }
    }

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

/**
 * Toggle bold formatting on selected text or at cursor position
 * If there's no selection, toggles bold mode for next typed text
 */
export function toggleBold(state: EditorState, crdt: CRDTContext): CommandResult {
  return toggleFormat(state, "bold", crdt);
}

/**
 * Toggle italic formatting on selected text or at cursor position
 * If there's no selection, toggles italic mode for next typed text
 */
export function toggleItalic(state: EditorState, crdt: CRDTContext): CommandResult {
  return toggleFormat(state, "italic", crdt);
}

/**
 * Toggle code formatting on selected text or at cursor position
 * If there's no selection, toggles code mode for next typed text
 */
export function toggleCode(state: EditorState, crdt: CRDTContext): CommandResult {
  return toggleFormat(state, "code", crdt);
}

/**
 * Toggle strikethrough formatting on selected text or at cursor position
 * If there's no selection, toggles strikethrough mode for next typed text
 */
export function toggleStrikethrough(state: EditorState, crdt: CRDTContext): CommandResult {
  return toggleFormat(state, "strikethrough", crdt);
}

// Convert block type at current cursor position
export function convertBlockType(
  state: EditorState,
  blockType: Block["type"],
  crdt: CRDTContext
): CommandResult {
  if (!state.document.cursor) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return { state, ops: [] };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops: [] };

  const { blockIndex } = position;
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
      chars: oldBlock.chars,
      formats: oldBlock.formats,
      indent: isListBlock(oldBlock) ? oldBlock.indent : 0,
    };
  } else if (blockType === "numbered_list") {
    newBlock = {
      id: oldBlock.id,
      type: "numbered_list",
      chars: oldBlock.chars,
      formats: oldBlock.formats,
      indent: isListBlock(oldBlock) ? oldBlock.indent : 0,
    };
  } else if (blockType === "todo_list") {
    newBlock = {
      id: oldBlock.id,
      type: "todo_list",
      chars: oldBlock.chars,
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
      chars: oldBlock.chars,
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
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
      blockId: oldBlock.id,
      field: "type",
      value: blockType,
    };
    ops.push(blockSetOp);
  }

  // Emit property changes for list blocks
  if (blockType === "bullet_list" || blockType === "numbered_list" || blockType === "todo_list") {
    const newIndent = isListBlock(oldBlock) ? oldBlock.indent : 0;
    // Only emit indent if it's different or this is a new list
    if (!isListBlock(oldBlock) || (isListBlock(oldBlock) && oldBlock.indent !== newIndent)) {
      const indentSetOp: BlockSet = {
        op: "block_set",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
        blockId: oldBlock.id,
        field: "indent",
        value: newIndent,
      };
      ops.push(indentSetOp);
    }
    
    if (blockType === "todo_list") {
      const newChecked = isListBlock(oldBlock) && oldBlock.type === "todo_list" ? oldBlock.checked : false;
      const checkedSetOp: BlockSet = {
        op: "block_set",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
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
      const newParagraphId = crdt.idGen();
      const newParagraph: Block = {
        id: newParagraphId,
        type: "paragraph",
        chars: [],
        formats: [],
      };
      
      const blockInsertOp: BlockInsert = {
        op: "block_insert",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
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
  crdt: CRDTContext
): CommandResult {
  if (!state.document.cursor || state.ui.activeMenu.type !== "slashCommand")
    return { state, ops: [] };

  const ops: Operation[] = [];
  const { blockIndex, textIndex } = state.ui.activeMenu;

  // Remove the "/" and filter text, preserving formatting
  const block = state.document.page.blocks[blockIndex];

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
      const textLength = getVisibleLength(block.chars);
      if (textLength > 0) {
        const { op: deleteOp } = deleteCharsInRange(
          block.chars,
          0,
          textLength,
          block.id,
          crdt
        );
        ops.push(deleteOp);
      }
      
      const blockSetOp: BlockSet = {
        op: "block_set",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
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
      const newParagraphId = crdt.idGen();
      const newParagraph: Block = {
        id: newParagraphId,
        type: "paragraph",
        chars: [],
        formats: [],
      };
      
      const blockInsertOp: BlockInsert = {
        op: "block_insert",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
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
      const textLength = getVisibleLength(block.chars);
      if (textLength > 0) {
        const { op: deleteOp } = deleteCharsInRange(
          block.chars,
          0,
          textLength,
          block.id,
          crdt
        );
        ops.push(deleteOp);
      }
      
      const blockSetOp: BlockSet = {
        op: "block_set",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
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
      const newParagraphId = crdt.idGen();
      const newParagraph: Block = {
        id: newParagraphId,
        type: "paragraph",
        chars: [],
        formats: [],
      };
      
      const blockInsertOp: BlockInsert = {
        op: "block_insert",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
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
  // If the current block is already an image cover, just close the slash command
  if (block.type === "image") {
    return { state: closeSlashCommand(state), ops: [] };
  }

  if (!isTextualBlock(block)) {
    return { state: closeSlashCommand(state), ops: [] };
  }

  // Delete from "/" position to current cursor position
  const deleteStart = textIndex - 1;
  const deleteEnd = state.document.cursor.position.textIndex;
  
  // Delete the slash command text using CRDT helper
  let updatedChars = block.chars;
  if (deleteEnd > deleteStart) {
    const { newChars, op: deleteOp } = deleteCharsInRange(
      block.chars,
      deleteStart,
      deleteEnd,
      block.id,
      crdt
    );
    updatedChars = newChars;
    ops.push(deleteOp);
  }

  // Update block content and type
  let newBlock: Block;
  if (command.type === "bullet_list") {
    newBlock = {
      id: block.id,
      type: "bullet_list",
      chars: updatedChars,
      formats: block.formats,
      indent: 0,
    };
  } else if (command.type === "numbered_list") {
    newBlock = {
      id: block.id,
      type: "numbered_list",
      chars: updatedChars,
      formats: block.formats,
      indent: 0,
    };
  } else if (command.type === "todo_list") {
    newBlock = {
      id: block.id,
      type: "todo_list",
      chars: updatedChars,
      formats: block.formats,
      checked: false,
      indent: 0,
    };
  } else {
    // Regular text blocks (headings, paragraphs)
    newBlock = {
      id: block.id,
      type: command.type as "heading1" | "heading2" | "heading3" | "paragraph",
      chars: updatedChars,
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
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
    blockId: block.id,
    field: "type",
    value: command.type,
  };
  ops.push(blockSetOp);
  
  // Emit property changes for list blocks
  if (command.type === "bullet_list" || command.type === "numbered_list" || command.type === "todo_list") {
    const indentSetOp: BlockSet = {
      op: "block_set",
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
      blockId: block.id,
      field: "indent",
      value: 0,
    };
    ops.push(indentSetOp);
    
    if (command.type === "todo_list") {
      const checkedSetOp: BlockSet = {
        op: "block_set",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
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
export function indentListItem(
  state: EditorState,
  crdt: CRDTContext
): CommandResult {
  if (!state.document.cursor) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return { state, ops: [] };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops: [] };

  const { blockIndex } = position;
  const block = state.document.page.blocks[blockIndex];

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
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
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
export function outdentListItem(
  state: EditorState,
  crdt: CRDTContext
): CommandResult {
  if (!state.document.cursor) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return { state, ops: [] };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops: [] };

  const { blockIndex } = position;
  const block = state.document.page.blocks[blockIndex];

  if (!isListBlock(block)) return { state, ops: [] };

  const currentIndent = block.indent || 0;
  if (currentIndent === 0) {
    // At base indent - convert to paragraph
    const newBlock: Block = {
      id: block.id,
      type: "paragraph",
      chars: block.chars,
      formats: block.formats,
    };

    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = newBlock;
    const newPage = { ...state.document.page, blocks: newBlocks };

    // Emit CRDT operation for block type change
    const blockSetOp: BlockSet = {
      op: "block_set",
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
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
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
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
  crdt: CRDTContext
): CommandResult {
  const ops: Operation[] = [];

  // SAFETY: Validate blockIndex bounds before accessing
  if (blockIndex < 0 || blockIndex >= state.document.page.blocks.length) {
    return { state, ops: [] };
  }

  const block = state.document.page.blocks[blockIndex];

  if (!block || block.type !== "todo_list") return { state, ops: [] };

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
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
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
  crdt: CRDTContext
): CommandResult {
  if (!state.document.cursor) return { state, ops: [] };

  const ops: Operation[] = [];

  // SAFETY: Convert to CRDT position and back for validation against concurrent updates
  const cursorCRDT = positionToCRDT(state.document.page, state.document.cursor.position);
  if (!cursorCRDT) return { state, ops: [] };

  const position = crdtToPosition(state.document.page, cursorCRDT);
  if (!position) return { state, ops: [] };

  const { blockIndex } = position;
  const oldBlock = state.document.page.blocks[blockIndex];

  if (!isTextualBlock(oldBlock)) return { state, ops: [] };

  // Create new list block
  let newBlock: Block;
  if (listType === "bullet_list") {
    newBlock = {
      id: oldBlock.id,
      type: "bullet_list",
      chars: oldBlock.chars,
      formats: oldBlock.formats,
      indent: 0,
    };
  } else if (listType === "numbered_list") {
    newBlock = {
      id: oldBlock.id,
      type: "numbered_list",
      chars: oldBlock.chars,
      formats: oldBlock.formats,
      indent: 0,
    };
  } else {
    newBlock = {
      id: oldBlock.id,
      type: "todo_list",
      chars: oldBlock.chars,
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
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
    blockId: oldBlock.id,
    field: "type",
    value: listType,
  };
  ops.push(blockSetOp);
  
  // Emit indent property
  const indentSetOp: BlockSet = {
    op: "block_set",
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
    blockId: oldBlock.id,
    field: "indent",
    value: 0,
  };
  ops.push(indentSetOp);
  
  // Emit checked property for todo lists
  if (listType === "todo_list") {
    const checkedSetOp: BlockSet = {
      op: "block_set",
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
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
  crdt: CRDTContext
): CommandResult {
  const ops: Operation[] = [];

  // SAFETY: Validate blockIndex bounds before accessing
  if (blockIndex < 0 || blockIndex >= state.document.page.blocks.length) {
    return { state, ops: [] };
  }

  const block = state.document.page.blocks[blockIndex];
  if (!block) return { state, ops: [] };

  if (!isTextualBlock(block)) {
    return { state, ops: [] };
  }

  // If newText is empty, don't update (prevents index shifting during editing)
  // User should use clearLinkInBlock to explicitly delete the link
  if (!newText || newText.length === 0) {
    return { state, ops: [] };
  }

  const oldText = getVisibleText(block.chars).slice(startIndex, endIndex);
  let updatedChars = block.chars;
  let updatedFormats = block.formats;

  // If text changed, delete old text and insert new text
  if (oldText !== newText) {
    // Delete old text
    const { newChars: charsAfterDelete, op: deleteOp } = deleteCharsInRange(
      updatedChars,
      startIndex,
      endIndex,
      block.id,
      crdt
    );
    updatedChars = charsAfterDelete;
    ops.push(deleteOp);

    // Insert new text
    const { newChars: charsAfterInsert, op: insertOp } = insertCharsAtPosition(
      updatedChars,
      startIndex,
      newText,
      block.id,
      crdt
    );
    updatedChars = charsAfterInsert;
    ops.push(insertOp);
  }

  // Apply link formatting
  const { newFormats, op: formatOp } = formatCharsInRange(
    updatedChars,
    updatedFormats,
    startIndex,
    startIndex + newText.length,
    block.id,
    { type: "link", url: newUrl },
    newUrl, // value is the URL for link format
    crdt
  );
  updatedFormats = newFormats;
  ops.push(formatOp);

  const newBlock: Block = {
    ...block,
    chars: updatedChars,
    formats: updatedFormats,
  };
  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
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
  crdt: CRDTContext
): CommandResult {
  const ops: Operation[] = [];

  // SAFETY: Validate blockIndex bounds before accessing
  if (blockIndex < 0 || blockIndex >= state.document.page.blocks.length) {
    return { state, ops: [] };
  }

  const block = state.document.page.blocks[blockIndex];
  if (!block) return { state, ops: [] };

  if (!isTextualBlock(block)) {
    return { state, ops: [] };
  }

  // Remove link formatting by setting value to false
  const { newFormats, op } = formatCharsInRange(
    block.chars,
    block.formats,
    startIndex,
    endIndex,
    block.id,
    { type: "link" },
    false, // false removes the format
    crdt
  );
  ops.push(op);

  const newBlock: Block = {
    ...block,
    formats: newFormats,
  };
  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  return {
    state: {
      ...state,
      document: { ...state.document, page: newPage },
    },
    ops,
  };
}
