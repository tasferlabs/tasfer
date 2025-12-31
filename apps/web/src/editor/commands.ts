import type { EditorState, Position } from "./types";
import type { Block, Text, TextFormat } from "../deserializer/loadPage";
import type { SlashCommand } from "./types";
import {
  getBlockTextContent,
  getBlockTextLength,
  closeSlashCommand,
  generateBlockId,
} from "./state";
import { invalidateBlockCache } from "./renderer";
import {
  moveCursorToPosition,
  updateMode,
  startSelection,
  updateSelectionFocus,
  clearSelection,
} from "./state";
import { recordUndo } from "./undo";

/**
 * Insert text at a specific position in formatted content while preserving formatting
 */
export function insertTextIntoFormattedContent(
  content: Text[],
  textIndex: number,
  textToInsert: string
): Text[] {
  if (content.length === 0) {
    return [{ content: textToInsert }];
  }

  let currentIndex = 0;
  const newContent: Text[] = [];

  for (let i = 0; i < content.length; i++) {
    const segment = content[i];
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;

    if (textIndex >= segmentStart && textIndex <= segmentEnd) {
      // Insert point is in this segment
      const relativeIndex = textIndex - segmentStart;
      const before = segment.content.slice(0, relativeIndex);
      const after = segment.content.slice(relativeIndex);

      // Split the segment and insert the new text
      // The inserted text inherits the formats of the current segment
      if (before) {
        newContent.push({ content: before, formats: segment.formats });
      }
      newContent.push({ content: textToInsert, formats: segment.formats });
      if (after) {
        newContent.push({ content: after, formats: segment.formats });
      }

      // Add remaining segments
      newContent.push(...content.slice(i + 1));
      // Merge adjacent segments with same formatting
      return mergeAdjacentSegments(newContent);
    } else {
      // This segment comes before the insert point
      newContent.push(segment);
      currentIndex = segmentEnd;
    }
  }

  // If we get here, textIndex is at or beyond the end
  newContent.push({ content: textToInsert });
  // Merge adjacent segments with same formatting
  return mergeAdjacentSegments(newContent);
}

/**
 * Delete text range in formatted content while preserving formatting
 */
export function deleteTextRangeInFormattedContent(
  content: Text[],
  startIndex: number,
  endIndex: number
): Text[] {
  if (content.length === 0 || startIndex === endIndex) {
    return content;
  }

  let currentIndex = 0;
  const newContent: Text[] = [];

  for (const segment of content) {
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;

    if (endIndex <= segmentStart) {
      // Deletion range is before this segment
      newContent.push(segment);
    } else if (startIndex >= segmentEnd) {
      // Deletion range is after this segment
      newContent.push(segment);
    } else {
      // Deletion range overlaps with this segment
      const deleteStart = Math.max(0, startIndex - segmentStart);
      const deleteEnd = Math.min(segment.content.length, endIndex - segmentStart);

      const before = segment.content.slice(0, deleteStart);
      const after = segment.content.slice(deleteEnd);

      if (before || after) {
        newContent.push({
          content: before + after,
          formats: segment.formats,
        });
      }
    }

    currentIndex = segmentEnd;
  }

  // Merge adjacent segments with same formatting
  return mergeAdjacentSegments(newContent);
}

/**
 * Merge adjacent text segments that have the same formatting
 */
export function mergeAdjacentSegments(content: Text[]): Text[] {
  if (content.length <= 1) return content;

  const merged: Text[] = [];
  let current = content[0];

  for (let i = 1; i < content.length; i++) {
    const next = content[i];
    const currentFormats = current.formats?.join(',') || '';
    const nextFormats = next.formats?.join(',') || '';

    if (currentFormats === nextFormats) {
      // Same formatting, merge
      current = {
        content: current.content + next.content,
        formats: current.formats,
      };
    } else {
      // Different formatting, push current and move to next
      if (current.content) merged.push(current);
      current = next;
    }
  }

  if (current.content) merged.push(current);
  return merged.length > 0 ? merged : [{ content: '' }];
}

/**
 * Extract text segments in a range while preserving their formatting
 */
function extractSegmentsInRange(
  content: Text[],
  startIndex: number,
  endIndex: number
): Text[] {
  const result: Text[] = [];
  let currentIndex = 0;

  for (const segment of content) {
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;

    if (endIndex <= segmentStart) {
      // Range ends before this segment
      break;
    } else if (startIndex >= segmentEnd) {
      // Range starts after this segment
      currentIndex = segmentEnd;
      continue;
    } else {
      // Range overlaps with this segment
      const extractStart = Math.max(0, startIndex - segmentStart);
      const extractEnd = Math.min(segment.content.length, endIndex - segmentStart);
      const extractedText = segment.content.slice(extractStart, extractEnd);

      if (extractedText) {
        result.push({
          content: extractedText,
          formats: segment.formats,
        });
      }
    }

    currentIndex = segmentEnd;
  }

  return result;
}

/**
 * Add a format to text segments, preserving their existing formats
 */
function addFormatToSegments(segments: Text[], newFormat: TextFormat): Text[] {
  return segments.map(segment => {
    const existingFormats = segment.formats || [];
    // Don't add duplicate formats
    if (existingFormats.includes(newFormat)) {
      return segment;
    }
    return {
      content: segment.content,
      formats: [...existingFormats, newFormat],
    };
  });
}

/**
 * Detect and apply live markdown inline formatting patterns
 * Returns null if no pattern was matched, otherwise returns the transformed content and new cursor position
 */
function detectAndApplyInlineMarkdown(
  content: Text[],
  textIndex: number
): { content: Text[]; newTextIndex: number } | null {
  const fullText = content.map(t => t.content).join('');
  
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
    const innerTextLength = boldMatch[1].length;
    
    // Extract segments with existing formatting and add bold to them
    const beforeSegments = extractSegmentsInRange(content, 0, matchStart);
    const innerSegments = extractSegmentsInRange(content, matchStart + 2, matchStart + 2 + innerTextLength);
    const afterSegments = extractSegmentsInRange(content, matchEnd, fullText.length);
    
    const formattedInnerSegments = addFormatToSegments(innerSegments, 'bold');
    
    const newContent: Text[] = [
      ...beforeSegments,
      ...formattedInnerSegments,
      ...afterSegments,
    ];
    
    return {
      content: mergeAdjacentSegments(newContent.length > 0 ? newContent : [{ content: '' }]),
      newTextIndex: matchStart + innerTextLength
    };
  }
  
  // Check for italic pattern: *text* (but not **)
  const italicMatch = fullText.slice(0, textIndex).match(/(?<!\*)\*([^\*]+)\*$/);
  if (italicMatch) {
    const matchStart = textIndex - italicMatch[0].length;
    const matchEnd = textIndex;
    const innerTextLength = italicMatch[1].length;
    
    // Extract segments with existing formatting and add italic to them
    const beforeSegments = extractSegmentsInRange(content, 0, matchStart);
    const innerSegments = extractSegmentsInRange(content, matchStart + 1, matchStart + 1 + innerTextLength);
    const afterSegments = extractSegmentsInRange(content, matchEnd, fullText.length);
    
    const formattedInnerSegments = addFormatToSegments(innerSegments, 'italic');
    
    const newContent: Text[] = [
      ...beforeSegments,
      ...formattedInnerSegments,
      ...afterSegments,
    ];
    
    return {
      content: mergeAdjacentSegments(newContent.length > 0 ? newContent : [{ content: '' }]),
      newTextIndex: matchStart + innerTextLength
    };
  }
  
  // Check for strikethrough pattern: ~~text~~
  const strikethroughMatch = fullText.slice(0, textIndex).match(/~~([^~]+)~~$/);
  if (strikethroughMatch) {
    const matchStart = textIndex - strikethroughMatch[0].length;
    const matchEnd = textIndex;
    const innerTextLength = strikethroughMatch[1].length;
    
    // Extract segments with existing formatting and add strikethrough to them
    const beforeSegments = extractSegmentsInRange(content, 0, matchStart);
    const innerSegments = extractSegmentsInRange(content, matchStart + 2, matchStart + 2 + innerTextLength);
    const afterSegments = extractSegmentsInRange(content, matchEnd, fullText.length);
    
    const formattedInnerSegments = addFormatToSegments(innerSegments, 'strikethrough');
    
    const newContent: Text[] = [
      ...beforeSegments,
      ...formattedInnerSegments,
      ...afterSegments,
    ];
    
    return {
      content: mergeAdjacentSegments(newContent.length > 0 ? newContent : [{ content: '' }]),
      newTextIndex: matchStart + innerTextLength
    };
  }
  
  // Check for code pattern: `text`
  const codeMatch = fullText.slice(0, textIndex).match(/`([^`]+)`$/);
  if (codeMatch) {
    const matchStart = textIndex - codeMatch[0].length;
    const matchEnd = textIndex;
    const innerTextLength = codeMatch[1].length;
    
    // Extract segments with existing formatting and add code to them
    const beforeSegments = extractSegmentsInRange(content, 0, matchStart);
    const innerSegments = extractSegmentsInRange(content, matchStart + 1, matchStart + 1 + innerTextLength);
    const afterSegments = extractSegmentsInRange(content, matchEnd, fullText.length);
    
    const formattedInnerSegments = addFormatToSegments(innerSegments, 'code');
    
    const newContent: Text[] = [
      ...beforeSegments,
      ...formattedInnerSegments,
      ...afterSegments,
    ];
    
    return {
      content: mergeAdjacentSegments(newContent.length > 0 ? newContent : [{ content: '' }]),
      newTextIndex: matchStart + innerTextLength
    };
  }
  
  return null;
}

function applyMarkdownPrefix(
  block: Block,
  preserveType: boolean = false
): Block {
  const text = block.content.map((t) => t.content).join("");
  if (text.startsWith("### ")) {
    block.type = "heading3";
    // Remove "### " prefix while preserving formatting
    block.content = deleteTextRangeInFormattedContent(block.content, 0, 4);
  } else if (text.startsWith("## ")) {
    block.type = "heading2";
    // Remove "## " prefix while preserving formatting
    block.content = deleteTextRangeInFormattedContent(block.content, 0, 3);
  } else if (text.startsWith("# ")) {
    block.type = "heading1";
    // Remove "# " prefix while preserving formatting
    block.content = deleteTextRangeInFormattedContent(block.content, 0, 2);
  } else if (!preserveType) {
    block.type = "paragraph";
    // Content stays as-is with formatting preserved
  }
  return block;
}

// Helper function to get selection range in proper order (start to end)
export function getSelectionRange(
  state: EditorState
): { start: Position; end: Position } | null {
  if (!state.selection || state.selection.isCollapsed) return null;

  const { anchor, focus } = state.selection;

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
export function deleteSelectedText(state: EditorState): EditorState {
  // Note: Cache will naturally miss due to content length change
  // Only clear for multi-block operations below
  const range = getSelectionRange(state);
  if (!range) return state;

  const { start, end } = range;

  if (start.blockIndex === end.blockIndex) {
    // Single block selection - preserve formatting
    const block = state.page.blocks[start.blockIndex];
    const newContent = deleteTextRangeInFormattedContent(
      block.content,
      start.textIndex,
      end.textIndex
    );
    const blockCopy: Block = { ...block, content: newContent };

    if (block.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }

    // Invalidate cache for the changed block
    invalidateBlockCache(blockCopy);

    const newBlocks = [...state.page.blocks];
    newBlocks[start.blockIndex] = blockCopy;
    const newPage = { ...state.page, blocks: newBlocks };

    let newState = { ...state, page: newPage };
    newState = moveCursorToPosition(
      newState,
      start.blockIndex,
      start.textIndex
    );
    return clearSelection(newState);
  } else {
    // Multi-block selection - preserve formatting from start and end blocks
    const startBlock = state.page.blocks[start.blockIndex];
    const endBlock = state.page.blocks[end.blockIndex];
    
    // Keep the formatted content before selection start from startBlock
    const beforeContent = deleteTextRangeInFormattedContent(
      startBlock.content,
      start.textIndex,
      getBlockTextContent(startBlock).length
    );
    
    // Keep the formatted content after selection end from endBlock
    const afterContent = deleteTextRangeInFormattedContent(
      endBlock.content,
      0,
      end.textIndex
    );
    
    // Merge the two parts
    const mergedContent = [...beforeContent, ...afterContent];
    const blockCopy: Block = { ...startBlock, content: mergeAdjacentSegments(mergedContent) };

    if (startBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }

    // Invalidate cache for merged block
    invalidateBlockCache(blockCopy);

    // Remove all blocks from start+1 to end (inclusive) and replace start block
    const newBlocks = [
      ...state.page.blocks.slice(0, start.blockIndex),
      blockCopy,
      ...state.page.blocks.slice(end.blockIndex + 1),
    ];
    const newPage = { ...state.page, blocks: newBlocks };

    let newState = { ...state, page: newPage };

    newState = moveCursorToPosition(
      newState,
      start.blockIndex,
      start.textIndex
    );
    return clearSelection(newState);
  }
}

export function insertText(state: EditorState, input: string): EditorState {
  if (!state.cursor) return state;

  // If there's a selection, delete it first
  if (state.selection && !state.selection.isCollapsed) {
    state = deleteSelectedText(state);
    // Ensure cursor still exists after deletion
    if (!state.cursor) return state;
  }

  const { blockIndex, textIndex } = state.cursor.position;
  const oldBlock = state.page.blocks[blockIndex];
  
  // Preserve formatting by using the helper function
  let newContent = insertTextIntoFormattedContent(
    oldBlock.content,
    textIndex,
    input
  );
  
  // Calculate the position after insertion
  let newTextIndex = textIndex + input.length;
  
  // Only try to detect inline markdown patterns if we're typing a closing delimiter character (*, `, ~)
  // This ensures we only apply formatting when actively completing a pattern
  const isClosingDelimiter = input === '*' || input === '`' || input === '~';
  
  if (isClosingDelimiter) {
    const markdownResult = detectAndApplyInlineMarkdown(newContent, newTextIndex);
    if (markdownResult) {
      // Save history BEFORE applying markdown (with raw markdown text)
      const blockBeforeMarkdown: Block = { ...oldBlock, content: newContent };
      applyMarkdownPrefix(blockBeforeMarkdown, oldBlock.type !== "paragraph");
      invalidateBlockCache(blockBeforeMarkdown);
      
      const blocksBeforeMarkdown = [
        ...state.page.blocks.slice(0, blockIndex),
        blockBeforeMarkdown,
        ...state.page.blocks.slice(blockIndex + 1),
      ];
      const pageBeforeMarkdown = { ...state.page, blocks: blocksBeforeMarkdown };
      
      let stateBeforeMarkdown = { ...state, page: pageBeforeMarkdown } as EditorState;
      stateBeforeMarkdown = moveCursorToPosition(
        stateBeforeMarkdown,
        blockIndex,
        newTextIndex
      );
      stateBeforeMarkdown = updateMode(stateBeforeMarkdown, "edit");
      
      // Record the state with raw markdown
      state = recordUndo(stateBeforeMarkdown);
      
      // Now apply the markdown transformation
      newContent = markdownResult.content;
      newTextIndex = markdownResult.newTextIndex;
    }
  }
  
  const blockCopy: Block = { ...oldBlock, content: newContent };
  applyMarkdownPrefix(blockCopy, oldBlock.type !== "paragraph");
  
  // Invalidate cache for the changed block (do it BEFORE adding to page)
  invalidateBlockCache(blockCopy);
  
  const newBlocks = [
    ...state.page.blocks.slice(0, blockIndex),
    blockCopy,
    ...state.page.blocks.slice(blockIndex + 1),
  ];
  const newPage = { ...state.page, blocks: newBlocks };

  let newState = { ...state, page: newPage } as EditorState;
  newState = moveCursorToPosition(
    newState,
    blockIndex,
    newTextIndex
  );
  return updateMode(newState, "edit");
}

export function deleteText(state: EditorState): EditorState {
  if (!state.cursor) return state;

  // If there's a selection, delete it
  if (state.selection && !state.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  const { blockIndex, textIndex } = state.cursor.position;
  const oldBlock = state.page.blocks[blockIndex];
  if (textIndex > 0) {
    // Delete one character before cursor, preserving formatting
    const newContent = deleteTextRangeInFormattedContent(
      oldBlock.content,
      textIndex - 1,
      textIndex
    );
    const blockCopy: Block = { ...oldBlock, content: newContent };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate cache for the changed block
    invalidateBlockCache(blockCopy);
    const newBlocks = [...state.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex, textIndex - 1);
  } else if (blockIndex > 0) {
    const prevBlock = state.page.blocks[blockIndex - 1];
    const prevText = getBlockTextContent(prevBlock);
    // Merge the formatted content arrays
    const mergedContent = [...prevBlock.content, ...oldBlock.content];
    const blockCopy: Block = { ...prevBlock, content: mergeAdjacentSegments(mergedContent) };
    // Preserve the original block type when joining blocks
    // Only apply markdown prefix if the original was a paragraph
    if (prevBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate the merged block
    invalidateBlockCache(blockCopy);
    const newBlocks = [
      ...state.page.blocks.slice(0, blockIndex - 1),
      blockCopy,
      ...state.page.blocks.slice(blockIndex + 1),
    ];
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex - 1, prevText.length);
  }
  return state;
}

// Forward delete (Delete key) - deletes character after cursor
export function deleteForward(state: EditorState): EditorState {
  if (!state.cursor) return state;

  // If there's a selection, delete it
  if (state.selection && !state.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  const { blockIndex, textIndex } = state.cursor.position;
  const oldBlock = state.page.blocks[blockIndex];
  const oldText = getBlockTextContent(oldBlock);

  if (textIndex < oldText.length) {
    // Delete character after cursor, preserving formatting
    const newContent = deleteTextRangeInFormattedContent(
      oldBlock.content,
      textIndex,
      textIndex + 1
    );
    const blockCopy: Block = { ...oldBlock, content: newContent };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate cache for the changed block
    invalidateBlockCache(blockCopy);
    const newBlocks = [...state.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex, textIndex);
  } else if (blockIndex < state.page.blocks.length - 1) {
    // Merge with next block, preserving formatting
    const nextBlock = state.page.blocks[blockIndex + 1];
    const mergedContent = [...oldBlock.content, ...nextBlock.content];
    const blockCopy: Block = { ...oldBlock, content: mergeAdjacentSegments(mergedContent) };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate the merged block
    invalidateBlockCache(blockCopy);
    const newBlocks = [
      ...state.page.blocks.slice(0, blockIndex),
      blockCopy,
      ...state.page.blocks.slice(blockIndex + 2),
    ];
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex, textIndex);
  }
  return state;
}

// Helper function to find word boundaries - distinguishes between word characters and non-word characters
// Uses Unicode property escapes to support all languages
function findWordBoundary(
  text: string,
  index: number,
  direction: "left" | "right"
): number {
  if (direction === "left") {
    // Move left to find start of previous word
    let i = index;
    
    if (i === 0) return 0;
    
    // Skip current character type
    const startIsWordChar = /[\p{L}\p{N}_]/u.test(text[i - 1]);
    if (startIsWordChar) {
      while (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1])) {
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
    
    // Skip current character type
    const startIsWordChar = /[\p{L}\p{N}_]/u.test(text[i]);
    if (startIsWordChar) {
      while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i])) {
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

  // Check what type of character we're starting from (Unicode-aware)
  const isWordChar = /[\p{L}\p{N}_]/u.test(text[i - 1]);

  if (isWordChar) {
    // Delete word characters (Unicode letters, numbers, underscores)
    while (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1])) {
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

  // Check what type of character we're starting from (Unicode-aware)
  const isWordChar = /[\p{L}\p{N}_]/u.test(text[i]);

  if (isWordChar) {
    // Delete word characters (Unicode letters, numbers, underscores)
    while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i])) {
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
  if (!state.cursor) return state;
  const { blockIndex, textIndex } = state.cursor.position;
  const block = state.page.blocks[blockIndex];
  const text = getBlockTextContent(block);

  if (textIndex > 0) {
    const newIndex = findWordBoundary(text, textIndex, "left");
    return moveCursorToPosition(state, blockIndex, newIndex);
  } else if (blockIndex > 0) {
    // Move to end of previous block
    const prevBlock = state.page.blocks[blockIndex - 1];
    const prevText = getBlockTextContent(prevBlock);
    return moveCursorToPosition(state, blockIndex - 1, prevText.length);
  }
  return state;
}

// Move cursor to next word boundary
export function moveToNextWord(state: EditorState): EditorState {
  if (!state.cursor) return state;
  const { blockIndex, textIndex } = state.cursor.position;
  const block = state.page.blocks[blockIndex];
  const text = getBlockTextContent(block);

  if (textIndex < text.length) {
    const newIndex = findWordBoundary(text, textIndex, "right");
    return moveCursorToPosition(state, blockIndex, newIndex);
  } else if (blockIndex < state.page.blocks.length - 1) {
    // Move to start of next block
    return moveCursorToPosition(state, blockIndex + 1, 0);
  }
  return state;
}

export function deleteWordForward(state: EditorState): EditorState {
  if (!state.cursor) return state;

  if (state.selection && !state.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  const { blockIndex, textIndex } = state.cursor.position;
  const oldBlock = state.page.blocks[blockIndex];
  const oldText = getBlockTextContent(oldBlock);

  if (textIndex < oldText.length) {
    // Delete word forward within the current line, preserving formatting
    const endIndex = findWordDeleteBoundaryRight(oldText, textIndex);
    const newContent = deleteTextRangeInFormattedContent(
      oldBlock.content,
      textIndex,
      endIndex
    );
    const blockCopy: Block = { ...oldBlock, content: newContent };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate cache for the changed block
    invalidateBlockCache(blockCopy);
    const newBlocks = [...state.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex, textIndex);
  } else if (blockIndex < state.page.blocks.length - 1) {
    // At end of line - merge with next block, preserving formatting
    const nextBlock = state.page.blocks[blockIndex + 1];
    const mergedContent = [...oldBlock.content, ...nextBlock.content];
    const blockCopy: Block = { ...oldBlock, content: mergeAdjacentSegments(mergedContent) };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate the merged block
    invalidateBlockCache(blockCopy);
    const newBlocks = [
      ...state.page.blocks.slice(0, blockIndex),
      blockCopy,
      ...state.page.blocks.slice(blockIndex + 2),
    ];
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex, textIndex);
  }
  return state;
}

export function deleteWordBackward(state: EditorState): EditorState {
  if (!state.cursor) return state;

  if (state.selection && !state.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  const { blockIndex, textIndex } = state.cursor.position;
  const oldBlock = state.page.blocks[blockIndex];
  const oldText = getBlockTextContent(oldBlock);

  if (textIndex > 0) {
    // Delete word backward within the current line, preserving formatting
    const startIndex = findWordDeleteBoundaryLeft(oldText, textIndex);
    const newContent = deleteTextRangeInFormattedContent(
      oldBlock.content,
      startIndex,
      textIndex
    );
    const blockCopy: Block = { ...oldBlock, content: newContent };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate cache for the changed block
    invalidateBlockCache(blockCopy);
    const newBlocks = [...state.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex, startIndex);
  } else if (blockIndex > 0) {
    // At start of line - merge with previous block, preserving formatting
    const prevBlock = state.page.blocks[blockIndex - 1];
    const prevText = getBlockTextContent(prevBlock);
    const mergedContent = [...prevBlock.content, ...oldBlock.content];
    const blockCopy: Block = { ...prevBlock, content: mergeAdjacentSegments(mergedContent) };
    if (prevBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    // Invalidate the merged block
    invalidateBlockCache(blockCopy);
    const newBlocks = [
      ...state.page.blocks.slice(0, blockIndex - 1),
      blockCopy,
      ...state.page.blocks.slice(blockIndex + 1),
    ];
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex - 1, prevText.length);
  }
  return state;
}

// Find word boundaries for selection - only selects word characters (letters, numbers, underscore)
// Uses Unicode property escapes to support all languages
function findWordStart(text: string, index: number): number {
  let i = index;
  // Move left while we're in word characters (Unicode letters, numbers, or underscore)
  while (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1])) {
    i--;
  }
  return i;
}

function findWordEnd(text: string, index: number): number {
  let i = index;
  // Move right while we're in word characters (Unicode letters, numbers, or underscore)
  while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i])) {
    i++;
  }
  return i;
}

// Select word at cursor position (for double-click)
export function selectWordAtPosition(
  state: EditorState,
  position: Position
): EditorState {
  const { blockIndex, textIndex } = position;
  const block = state.page.blocks[blockIndex];
  const text = getBlockTextContent(block);

  if (text.length === 0) return state;

  // Check if we're on a word character (Unicode letter, number, or underscore)
  const isOnWord = textIndex < text.length && /[\p{L}\p{N}_]/u.test(text[textIndex]);
  
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
  let newState = moveCursorToPosition(state, blockIndex, wordEnd);
  newState = startSelection(newState, startPos);
  newState = updateSelectionFocus(newState, endPos);
  return updateMode(newState, "select");
}

// Select entire line/paragraph (for triple-click)
export function selectLineAtPosition(
  state: EditorState,
  position: Position
): EditorState {
  const { blockIndex } = position;
  const block = state.page.blocks[blockIndex];
  const text = getBlockTextContent(block);

  const startPos: Position = { blockIndex, textIndex: 0 };
  const endPos: Position = { blockIndex, textIndex: text.length };

  // Create selection for entire block
  let newState = moveCursorToPosition(state, blockIndex, text.length);
  newState = startSelection(newState, startPos);
  newState = updateSelectionFocus(newState, endPos);
  return updateMode(newState, "select");
}

// Move to start of current line (Home key)
export function moveToLineStart(state: EditorState): EditorState {
  if (!state.cursor) return state;
  const { blockIndex } = state.cursor.position;
  return moveCursorToPosition(state, blockIndex, 0);
}

// Move to end of current line (End key)
export function moveToLineEnd(state: EditorState): EditorState {
  if (!state.cursor) return state;
  const { blockIndex } = state.cursor.position;
  const block = state.page.blocks[blockIndex];
  const text = getBlockTextContent(block);
  return moveCursorToPosition(state, blockIndex, text.length);
}

export function extendSelectionWordLeft(state: EditorState): EditorState {
  if (!state.cursor) return state;
  // If no selection exists, start one at current cursor position
  let newState = state;
  if (!state.selection) {
    newState = startSelection(state, state.cursor.position);
  }
  // Move cursor to previous word boundary
  const movedState = moveToPreviousWord(newState);
  if (movedState.cursor) {
    return updateSelectionFocus(movedState, movedState.cursor.position);
  }
  return newState;
}

export function extendSelectionWordRight(state: EditorState): EditorState {
  if (!state.cursor) return state;
  // If no selection exists, start one at current cursor position
  let newState = state;
  if (!state.selection) {
    newState = startSelection(state, state.cursor.position);
  }
  // Move cursor to next word boundary
  const movedState = moveToNextWord(newState);
  if (movedState.cursor) {
    return updateSelectionFocus(movedState, movedState.cursor.position);
  }
  return newState;
}

export function extendSelectionHome(state: EditorState, isCtrl: boolean): EditorState {
  if (!state.cursor) return state;
  // If no selection exists, start one at current cursor position
  let newState = state;
  if (!state.selection) {
    newState = startSelection(state, state.cursor.position);
  }
  // Move cursor to start of line or document
  const movedState = isCtrl 
    ? moveCursorToPosition(newState, 0, 0)
    : moveToLineStart(newState);
  if (movedState.cursor) {
    return updateSelectionFocus(movedState, movedState.cursor.position);
  }
  return newState;
}

export function extendSelectionEnd(state: EditorState, isCtrl: boolean): EditorState {
  if (!state.cursor) return state;
  // If no selection exists, start one at current cursor position
  let newState = state;
  if (!state.selection) {
    newState = startSelection(state, state.cursor.position);
  }
  // Move cursor to end of line or document
  const movedState = isCtrl
    ? moveCursorToPosition(
        newState,
        newState.page.blocks.length - 1,
        getBlockTextLength(newState.page.blocks[newState.page.blocks.length - 1])
      )
    : moveToLineEnd(newState);
  if (movedState.cursor) {
    return updateSelectionFocus(movedState, movedState.cursor.position);
  }
  return newState;
}

export function splitBlock(state: EditorState): EditorState {
  if (!state.cursor) return state;
  const { blockIndex, textIndex } = state.cursor.position;
  const oldBlock = state.page.blocks[blockIndex];
  const oldText = getBlockTextContent(oldBlock);

  // Preserve the original block type for both blocks
  const originalType = oldBlock.type;

  // Split the formatted content at the cursor position
  const beforeContent = deleteTextRangeInFormattedContent(
    oldBlock.content,
    textIndex,
    oldText.length
  );
  const afterContent = deleteTextRangeInFormattedContent(
    oldBlock.content,
    0,
    textIndex
  );

  const blockCopy1: Block = { ...oldBlock, content: beforeContent };
  // Only apply markdown prefix if the original was a paragraph
  if (originalType === "paragraph") {
    applyMarkdownPrefix(blockCopy1);
  }

  const blockCopy2: Block = {
    ...oldBlock,
    id: generateBlockId(),
    content: afterContent,
  };
  // Only apply markdown prefix if the original was a paragraph
  if (originalType === "paragraph") {
    applyMarkdownPrefix(blockCopy2);
  }

  // Invalidate cache for both new blocks
  invalidateBlockCache(blockCopy1);
  invalidateBlockCache(blockCopy2);

  const newBlocks = [
    ...state.page.blocks.slice(0, blockIndex),
    blockCopy1,
    blockCopy2,
    ...state.page.blocks.slice(blockIndex + 1),
  ];
  const newPage = { ...state.page, blocks: newBlocks };

  const newState = { ...state, page: newPage } as EditorState;
  return moveCursorToPosition(newState, blockIndex + 1, 0);
}

export function selectAll(state: EditorState): EditorState {
  if (state.page.blocks.length === 0) return state;

  const startPos: Position = { blockIndex: 0, textIndex: 0 };
  const lastBlockIndex = state.page.blocks.length - 1;
  const lastBlock = state.page.blocks[lastBlockIndex];
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

// Convert block type at current cursor position
export function convertBlockType(
  state: EditorState,
  blockType: Block["type"]
): EditorState {
  if (!state.cursor) return state;

  const { blockIndex } = state.cursor.position;
  const oldBlock = state.page.blocks[blockIndex];

  // Create new block with the specified type, preserving formatting
  const newBlock: Block = {
    ...oldBlock,
    type: blockType,
    content: oldBlock.content, // Keep the formatted content as-is
  };

  // Invalidate cache only for the changed block
  invalidateBlockCache(newBlock);

  const newBlocks = [...state.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.page, blocks: newBlocks };

  return { ...state, page: newPage };
}

export function applySlashCommand(
  state: EditorState,
  command: SlashCommand
): EditorState {
  if (!state.cursor || !state.slashCommand) return state;

  const { blockIndex, textIndex } = state.slashCommand;

  // Remove the "/" and filter text, preserving formatting
  const block = state.page.blocks[blockIndex];
  
  // Delete from "/" position to current cursor position
  const newContent = deleteTextRangeInFormattedContent(
    block.content,
    textIndex - 1, // Remove the "/"
    state.cursor.position.textIndex // Remove up to cursor (the filter text)
  );

  // Update block content and type
  const newBlock: Block = {
    ...block,
    type: command.type,
    content: newContent,
  };

  // Invalidate cache only for the changed block
  invalidateBlockCache(newBlock);

  const newBlocks = [...state.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.page, blocks: newBlocks };

  // Update state
  let newState: EditorState = { ...state, page: newPage };
  newState = closeSlashCommand(newState);
  newState = moveCursorToPosition(newState, blockIndex, textIndex - 1);

  return newState;
}
