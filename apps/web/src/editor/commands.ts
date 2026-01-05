import type { Block, Text, TextBlock, TextFormat } from "../deserializer/loadPage";
import { areFormatArraysEqual, isTextBlock } from "../deserializer/loadPage";
import { isCJKCharacter } from "./fonts";
import { invalidateBlockCache } from "./renderer";
import { getFormattedTextDirection } from "./rtl";
import {
  clearSelection,
  closeSlashCommand,
  generateBlockId,
  getBlockTextContent,
  getBlockTextLength,
  moveCursorToPosition,
  startSelection,
  updateMode,
  updateSelectionFocus,
} from "./state";
import type { EditorState, Position, SlashCommand } from "./types";
import { recordUndo } from "./undo";

/**
 * Insert text at a specific position in formatted content while preserving formatting
 */
export function insertTextIntoFormattedContent(
  content: Text[],
  textIndex: number,
  textToInsert: string,
  activeFormats?: readonly TextFormat[]
): Text[] {
  if (content.length === 0) {
    return [{ content: textToInsert, formats: activeFormats && activeFormats.length > 0 ? [...activeFormats] : undefined }];
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
      // Use activeFormats if provided, otherwise inherit from current segment
      const formatsToUse = activeFormats !== undefined ? activeFormats : segment.formats;
      
      if (before) {
        newContent.push({ content: before, formats: segment.formats });
      }
      newContent.push({ content: textToInsert, formats: formatsToUse && formatsToUse.length > 0 ? [...formatsToUse] : undefined });
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
  const lastSegment = content[content.length - 1];
  const formatsToUse = activeFormats !== undefined ? activeFormats : lastSegment?.formats;
  newContent.push({ content: textToInsert, formats: formatsToUse && formatsToUse.length > 0 ? [...formatsToUse] : undefined });
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
      const deleteEnd = Math.min(
        segment.content.length,
        endIndex - segmentStart
      );

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
 * Get the formatting at a specific text position in a block
 * Returns the formats of the character just before the cursor position
 */
function getFormatsAtPosition(
  block: Block,
  textIndex: number
): readonly TextFormat[] | undefined {
  if (!isTextBlock(block)) {
    return undefined;
  }

  if (textIndex === 0) {
    // At the start of the block, no formatting
    return undefined;
  }

  let currentIndex = 0;
  for (const segment of block.content) {
    const segmentStart = currentIndex;
    const segmentEnd = currentIndex + segment.content.length;

    // If cursor is within or at the end of this segment, return its formats
    if (textIndex > segmentStart && textIndex <= segmentEnd) {
      return segment.formats;
    }

    currentIndex = segmentEnd;
  }

  // Cursor is at the very end, return the last segment's formats
  const lastSegment = block.content[block.content.length - 1];
  return lastSegment?.formats;
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

    if (areFormatArraysEqual(current.formats, next.formats)) {
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
  return merged.length > 0 ? merged : [{ content: "" }];
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
      const extractEnd = Math.min(
        segment.content.length,
        endIndex - segmentStart
      );
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
  return segments.map((segment) => {
    const existingFormats = segment.formats || [];
    // Don't add duplicate formats
    if (existingFormats.some((f) => f.type === newFormat.type)) {
      return segment;
    }
    return {
      content: segment.content,
      formats: [...existingFormats, newFormat],
    };
  });
}

/**
 * Remove a format from text segments
 */
function removeFormatFromSegments(segments: Text[], formatType: TextFormat['type']): Text[] {
  return segments.map((segment) => {
    const existingFormats = segment.formats || [];
    const filteredFormats = existingFormats.filter((f) => f.type !== formatType);
    return {
      content: segment.content,
      formats: filteredFormats.length > 0 ? filteredFormats : undefined,
    };
  });
}

/**
 * Check if all segments have a specific format
 */
function allSegmentsHaveFormat(segments: Text[], formatType: TextFormat['type']): boolean {
  if (segments.length === 0) return false;
  return segments.every((segment) => 
    segment.formats?.some((f) => f.type === formatType)
  );
}

/**
 * Detect and apply live markdown inline formatting patterns
 * Returns null if no pattern was matched, otherwise returns the transformed content and new cursor position
 */
function detectAndApplyInlineMarkdown(
  content: Text[],
  textIndex: number
): { content: Text[]; newTextIndex: number } | null {
  const fullText = content.map((t) => t.content).join("");

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
    const innerSegments = extractSegmentsInRange(
      content,
      matchStart + 2,
      matchStart + 2 + innerTextLength
    );
    const afterSegments = extractSegmentsInRange(
      content,
      matchEnd,
      fullText.length
    );

    const formattedInnerSegments = addFormatToSegments(innerSegments, {
      type: "bold",
    });

    const newContent: Text[] = [
      ...beforeSegments,
      ...formattedInnerSegments,
      ...afterSegments,
    ];

    return {
      content: mergeAdjacentSegments(
        newContent.length > 0 ? newContent : [{ content: "" }]
      ),
      newTextIndex: matchStart + innerTextLength,
    };
  }

  // Check for italic pattern: *text* (but not **)
  const italicMatch = fullText
    .slice(0, textIndex)
    .match(/(?<!\*)\*([^\*]+)\*$/);
  if (italicMatch) {
    const matchStart = textIndex - italicMatch[0].length;
    const matchEnd = textIndex;
    const innerTextLength = italicMatch[1].length;

    // Extract segments with existing formatting and add italic to them
    const beforeSegments = extractSegmentsInRange(content, 0, matchStart);
    const innerSegments = extractSegmentsInRange(
      content,
      matchStart + 1,
      matchStart + 1 + innerTextLength
    );
    const afterSegments = extractSegmentsInRange(
      content,
      matchEnd,
      fullText.length
    );

    const formattedInnerSegments = addFormatToSegments(innerSegments, {
      type: "italic",
    });

    const newContent: Text[] = [
      ...beforeSegments,
      ...formattedInnerSegments,
      ...afterSegments,
    ];

    return {
      content: mergeAdjacentSegments(
        newContent.length > 0 ? newContent : [{ content: "" }]
      ),
      newTextIndex: matchStart + innerTextLength,
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
    const innerSegments = extractSegmentsInRange(
      content,
      matchStart + 2,
      matchStart + 2 + innerTextLength
    );
    const afterSegments = extractSegmentsInRange(
      content,
      matchEnd,
      fullText.length
    );

    const formattedInnerSegments = addFormatToSegments(innerSegments, {
      type: "strikethrough",
    });

    const newContent: Text[] = [
      ...beforeSegments,
      ...formattedInnerSegments,
      ...afterSegments,
    ];

    return {
      content: mergeAdjacentSegments(
        newContent.length > 0 ? newContent : [{ content: "" }]
      ),
      newTextIndex: matchStart + innerTextLength,
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
    const innerSegments = extractSegmentsInRange(
      content,
      matchStart + 1,
      matchStart + 1 + innerTextLength
    );
    const afterSegments = extractSegmentsInRange(
      content,
      matchEnd,
      fullText.length
    );

    const formattedInnerSegments = addFormatToSegments(innerSegments, {
      type: "code",
    });

    const newContent: Text[] = [
      ...beforeSegments,
      ...formattedInnerSegments,
      ...afterSegments,
    ];

    return {
      content: mergeAdjacentSegments(
        newContent.length > 0 ? newContent : [{ content: "" }]
      ),
      newTextIndex: matchStart + innerTextLength,
    };
  }

  return null;
}

function applyMarkdownPrefix(
  block: Block,
  preserveType: boolean = false
): Block {
  if (!isTextBlock(block)) {
    return block;
  }
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
export function deleteSelectedText(state: EditorState): EditorState {
  // Note: Cache will naturally miss due to content length change
  // Only clear for multi-block operations below
  const range = getSelectionRange(state);
  if (!range) return state;

  const { start, end } = range;

  if (start.blockIndex === end.blockIndex) {
    // Single block selection
    const block = state.document.page.blocks[start.blockIndex];
    
    // Handle image block deletion
    if (!isTextBlock(block)) {
      // For image blocks (and other visual blocks), delete the entire block
      // Check if this is the only block - if so, replace with empty paragraph
      if (state.document.page.blocks.length === 1) {
        const emptyParagraph: Block = {
          id: generateBlockId(),
          type: "paragraph",
          content: [{ content: "" }],
        };
        const newPage = { ...state.document.page, blocks: [emptyParagraph] };
        
        let newState: EditorState = {
          ...state,
          document: { ...state.document, page: newPage },
        };
        newState = moveCursorToPosition(newState, 0, 0);
        return clearSelection(newState);
      }
      
      // Remove the image block
      const newBlocks = [
        ...state.document.page.blocks.slice(0, start.blockIndex),
        ...state.document.page.blocks.slice(start.blockIndex + 1),
      ];
      const newPage = { ...state.document.page, blocks: newBlocks };
      
      // Move cursor to the start of the next block, or end of previous block
      const newBlockIndex = start.blockIndex < newBlocks.length 
        ? start.blockIndex 
        : start.blockIndex - 1;
      
      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      newState = moveCursorToPosition(newState, newBlockIndex, 0);
      return clearSelection(newState);
    }
    
    // Handle text block deletion (preserve formatting)
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
    return clearSelection(newState);
  } else {
    // Multi-block selection
    const startBlock = state.document.page.blocks[start.blockIndex];
    const endBlock = state.document.page.blocks[end.blockIndex];

    // Handle case where selection includes image blocks
    const startIsText = isTextBlock(startBlock);
    const endIsText = isTextBlock(endBlock);
    
    // If both start and end are non-text blocks, or if we're selecting multiple blocks 
    // and at least one endpoint is a non-text block, we need special handling
    if (!startIsText || !endIsText) {
      // Delete all blocks in the range
      const blocksToKeep = [
        ...state.document.page.blocks.slice(0, start.blockIndex),
        ...state.document.page.blocks.slice(end.blockIndex + 1),
      ];
      
      // If we deleted all blocks, create an empty paragraph
      const newBlocks = blocksToKeep.length === 0 
        ? [{
            id: generateBlockId(),
            type: "paragraph" as const,
            content: [{ content: "" }],
          }]
        : blocksToKeep;
      
      const newPage = { ...state.document.page, blocks: newBlocks };
      
      // Move cursor to the start position (or 0 if all blocks were deleted)
      const newBlockIndex = Math.min(start.blockIndex, newBlocks.length - 1);
      
      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      newState = moveCursorToPosition(newState, newBlockIndex, 0);
      return clearSelection(newState);
    }

    // Both are text blocks - preserve formatting from start and end blocks
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
    const blockCopy: Block = {
      ...startBlock,
      content: mergeAdjacentSegments(mergedContent),
    };

    if (startBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }

    // Invalidate cache for merged block
    invalidateBlockCache(blockCopy);

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
    return clearSelection(newState);
  }
}

export function insertText(state: EditorState, input: string): EditorState {
  if (!state.document.cursor) return state;

  // Block typing on a selected image (but allow deletion via deleteSelectedText elsewhere)
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const { anchor, focus } = state.document.selection;
    // Check if this is a single image selection (anchor and focus at same position)
    if (anchor.blockIndex === focus.blockIndex && anchor.textIndex === focus.textIndex) {
      const block = state.document.page.blocks[anchor.blockIndex];
      if (block && block.type === "imageCover") {
        // Block typing on selected image
        return state;
      }
    }
    // For other selections, delete them first
    state = deleteSelectedText(state);
    // Ensure cursor still exists after deletion
    if (!state.document.cursor) return state;
  }

  const { blockIndex, textIndex } = state.document.cursor.position;
  const oldBlock = state.document.page.blocks[blockIndex];
  
  if (!isTextBlock(oldBlock)) {
    return state;
  }
  
  // Get active formats from UI (for toggle bold/italic/etc without selection)
  const activeFormats = state.ui.activeFormatsMode.type === 'explicit' 
    ? state.ui.activeFormatsMode.formats 
    : undefined;

  // Preserve formatting by using the helper function
  let newContent = insertTextIntoFormattedContent(
    oldBlock.content,
    textIndex,
    input,
    activeFormats
  );

  // Calculate the position after insertion
  let newTextIndex = textIndex + input.length;

  // Only try to detect inline markdown patterns if we're typing a closing delimiter character (*, `, ~)
  // This ensures we only apply formatting when actively completing a pattern
  const isClosingDelimiter = input === "*" || input === "`" || input === "~";

  if (isClosingDelimiter) {
    const markdownResult = detectAndApplyInlineMarkdown(
      newContent,
      newTextIndex
    );
    if (markdownResult) {
      // Save history BEFORE applying markdown (with raw markdown text)
      const blockBeforeMarkdown: Block = { ...oldBlock, content: newContent };
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

      let stateBeforeMarkdown = {
        ...state,
        page: pageBeforeMarkdown,
      } as EditorState;
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
  newState = moveCursorToPosition(newState, blockIndex, newTextIndex, true);
  
  return updateMode(newState, "edit");
}

export function deleteText(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  // If composition is active, cancel it instead of deleting
  if (state.ui.composition) {
    return {
      ...state,
      ui: {
        ...state.ui,
        composition: null,
      },
    };
  }

  // If there's a selection, delete it
  if (state.document.selection && !state.document.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  const { blockIndex, textIndex } = state.document.cursor.position;
  const oldBlock = state.document.page.blocks[blockIndex];
  if (!isTextBlock(oldBlock)) {
    return state;
  }
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
    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    // Preserve active formats when deleting during typing (e.g., pressing backspace while in bold mode)
    return moveCursorToPosition(newState, blockIndex, textIndex - 1, true);
  } else if (blockIndex > 0) {
    const prevBlock = state.document.page.blocks[blockIndex - 1];
    
    // If previous block is not a text block (e.g., image), delete the current text block
    if (!isTextBlock(prevBlock)) {
      if (!isTextBlock(oldBlock)) {
        return state;
      }
      
      // Delete the current text block
      const newBlocks = [
        ...state.document.page.blocks.slice(0, blockIndex),
        ...state.document.page.blocks.slice(blockIndex + 1),
      ];
      
      // If we deleted the last block, add an empty paragraph
      if (newBlocks.length === 0) {
        newBlocks.push({
          id: generateBlockId(),
          type: "paragraph",
          content: [{ content: "" }],
        });
      }
      
      const newPage = { ...state.document.page, blocks: newBlocks };
      let newState: EditorState = {
        ...state,
        document: { ...state.document, page: newPage },
      };
      
      // Select the previous (image) block
      const imageBlockIndex = blockIndex - 1;
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
      
      return newState;
    }
    
    if (!isTextBlock(oldBlock)) {
      return state;
    }
    
    const prevText = getBlockTextContent(prevBlock);
    // Merge the formatted content arrays
    const mergedContent = [...prevBlock.content, ...oldBlock.content];
    
    // Determine which block type to preserve:
    // If previous block is empty, preserve the current block's type
    // Otherwise, preserve the previous block's type
    const prevIsEmpty = prevText.length === 0;
    const typeToPreserve = prevIsEmpty ? oldBlock.type : prevBlock.type;
    
    const blockCopy: Block = {
      ...prevBlock,
      type: typeToPreserve,
      content: mergeAdjacentSegments(mergedContent),
    };
    // Only apply markdown prefix if the resulting type is a paragraph
    if (typeToPreserve === "paragraph") {
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
    return moveCursorToPosition(newState, blockIndex - 1, prevText.length);
  }
  return state;
}

// Forward delete (Delete key) - deletes character after cursor
export function deleteForward(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  // If composition is active, cancel it instead of deleting
  if (state.ui.composition) {
    return {
      ...state,
      ui: {
        ...state.ui,
        composition: null,
      },
    };
  }

  // If there's a selection, delete it
  if (state.document.selection && !state.document.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  const { blockIndex, textIndex } = state.document.cursor.position;
  const oldBlock = state.document.page.blocks[blockIndex];
  
  if (!isTextBlock(oldBlock)) {
    return state;
  }
  
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
    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    // Preserve active formats when deleting during typing
    return moveCursorToPosition(newState, blockIndex, textIndex, true);
  } else if (blockIndex < state.document.page.blocks.length - 1) {
    // Merge with next block, preserving formatting
    const nextBlock = state.document.page.blocks[blockIndex + 1];
    
    // If next block is not a text block (e.g., image), delete the current text block
    if (!isTextBlock(nextBlock)) {
      // Delete the current text block
      const newBlocks = [
        ...state.document.page.blocks.slice(0, blockIndex),
        ...state.document.page.blocks.slice(blockIndex + 1),
      ];
      
      // If we deleted the last block, add an empty paragraph
      if (newBlocks.length === 0) {
        newBlocks.push({
          id: generateBlockId(),
          type: "paragraph",
          content: [{ content: "" }],
        });
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
      
      return newState;
    }
    
    const mergedContent = [...oldBlock.content, ...nextBlock.content];
    
    // Determine which block type to preserve:
    // If current block is empty, preserve the next block's type
    // Otherwise, preserve the current block's type
    const currentIsEmpty = oldText.length === 0;
    const typeToPreserve = currentIsEmpty ? nextBlock.type : oldBlock.type;
    
    const blockCopy: Block = {
      ...oldBlock,
      type: typeToPreserve as TextBlock["type"],
      content: mergeAdjacentSegments(mergedContent),
    };
    // Only apply markdown prefix if the resulting type is a paragraph
    if (typeToPreserve === "paragraph") {
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
    return moveCursorToPosition(newState, blockIndex, textIndex);
  }
  return state;
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
      while (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1]) && !isCJKCharacter(text[i - 1])) {
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
      while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i]) && !isCJKCharacter(text[i])) {
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
    while (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1]) && !isCJKCharacter(text[i - 1])) {
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
    while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i]) && !isCJKCharacter(text[i])) {
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
  const { blockIndex, textIndex } = state.document.cursor.position;
  const block = state.document.page.blocks[blockIndex];
  const text = getBlockTextContent(block);

  if (!isTextBlock(block)) {
    return state;
  }

  // Check if current block is RTL
  const isRTL = getFormattedTextDirection(block.content) === "rtl";

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
  const { blockIndex, textIndex } = state.document.cursor.position;
  const block = state.document.page.blocks[blockIndex];
  const text = getBlockTextContent(block);

  if (!isTextBlock(block)) {
    return state;
  }

  // Check if current block is RTL
  const isRTL = getFormattedTextDirection(block.content) === "rtl";

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

export function deleteWordForward(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  if (state.document.selection && !state.document.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  const { blockIndex, textIndex } = state.document.cursor.position;
  const oldBlock = state.document.page.blocks[blockIndex];
  if (!isTextBlock(oldBlock)) {
    return state;
  }
  
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
    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    // Preserve active formats when deleting during typing
    return moveCursorToPosition(newState, blockIndex, textIndex, true);
  } else if (blockIndex < state.document.page.blocks.length - 1) {
    // At end of line - merge with next block, preserving formatting
    const nextBlock = state.document.page.blocks[blockIndex + 1];
    if (!isTextBlock(nextBlock)) {
      return state;
    }
    const mergedContent = [...oldBlock.content, ...nextBlock.content];
    
    // Determine which block type to preserve:
    // If current block is empty, preserve the next block's type
    // Otherwise, preserve the current block's type
    const currentIsEmpty = oldText.length === 0;
    const typeToPreserve = currentIsEmpty ? nextBlock.type : oldBlock.type;
    
    const blockCopy: Block = {
      ...oldBlock,
      type: typeToPreserve as TextBlock["type"],
      content: mergeAdjacentSegments(mergedContent),
    };
    // Only apply markdown prefix if the resulting type is a paragraph
    if (typeToPreserve === "paragraph") {
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
    return moveCursorToPosition(newState, blockIndex, textIndex);
  }
  return state;
}

export function deleteWordBackward(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  if (state.document.selection && !state.document.selection.isCollapsed) {
    return deleteSelectedText(state);
  }

  const { blockIndex, textIndex } = state.document.cursor.position;
  const oldBlock = state.document.page.blocks[blockIndex];
  
  if (!isTextBlock(oldBlock)) {
    return state;
  }
  
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
    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.document.page, blocks: newBlocks };
    let newState: EditorState = {
      ...state,
      document: { ...state.document, page: newPage },
    };
    // Preserve active formats when deleting during typing
    return moveCursorToPosition(newState, blockIndex, startIndex, true);
  } else if (blockIndex > 0) {
    // At start of line - merge with previous block, preserving formatting
    const prevBlock = state.document.page.blocks[blockIndex - 1];
    if (!isTextBlock(prevBlock)) {
      return state;
    }
    const prevText = getBlockTextContent(prevBlock);
    const mergedContent = [...prevBlock.content, ...oldBlock.content];
    
    // Determine which block type to preserve:
    // If previous block is empty, preserve the current block's type
    // Otherwise, preserve the previous block's type
    const prevIsEmpty = prevText.length === 0;
    const typeToPreserve = prevIsEmpty ? oldBlock.type : prevBlock.type;
    
    const blockCopy: Block = {
      ...prevBlock,
      type: typeToPreserve as TextBlock["type"],
      content: mergeAdjacentSegments(mergedContent),
    };
    // Only apply markdown prefix if the resulting type is a paragraph
    if (typeToPreserve === "paragraph") {
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
    return moveCursorToPosition(newState, blockIndex - 1, prevText.length);
  }
  return state;
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
  while (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1]) && !isCJKCharacter(text[i - 1])) {
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
  while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i]) && !isCJKCharacter(text[i])) {
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
  const { blockIndex } = position;
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
  const { blockIndex } = state.document.cursor.position;
  return moveCursorToPosition(state, blockIndex, 0);
}

// Move to end of current line (End key)
export function moveToLineEnd(state: EditorState): EditorState {
  if (!state.document.cursor) return state;
  const { blockIndex } = state.document.cursor.position;
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

export function splitBlock(state: EditorState): EditorState {
  if (!state.document.cursor) return state;
  const { blockIndex, textIndex } = state.document.cursor.position;
  const oldBlock = state.document.page.blocks[blockIndex];
  
  // Handle Enter key on selected image: create new paragraph below
  if (state.document.selection && !state.document.selection.isCollapsed) {
    const { anchor, focus } = state.document.selection;
    // Check if this is a single image selection (anchor and focus at same position)
    if (anchor.blockIndex === focus.blockIndex && anchor.textIndex === focus.textIndex) {
      const block = state.document.page.blocks[anchor.blockIndex];
      if (block && block.type === "imageCover") {
        // Create a new paragraph below the image
        const newParagraph: Block = {
          id: generateBlockId(),
          type: "paragraph",
          content: [{ content: "" }],
        };
        
        const newBlocks = [
          ...state.document.page.blocks.slice(0, blockIndex + 1),
          newParagraph,
          ...state.document.page.blocks.slice(blockIndex + 1),
        ];
        const newPage = { ...state.document.page, blocks: newBlocks };
        
        let newState: EditorState = {
          ...state,
          document: { ...state.document, page: newPage },
        };
        newState = clearSelection(newState);
        newState = moveCursorToPosition(newState, blockIndex + 1, 0);
        return newState;
      }
    }
  }
  
  if (!isTextBlock(oldBlock)) {
    return state;
  }
  
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

  // Determine types for both blocks based on cursor position
  const isAtStart = textIndex === 0;
  const isAtEnd = textIndex === oldText.length;
  const isEmpty = oldText.length === 0;
  
  let blockCopy1Type: Block["type"];
  let blockCopy2Type: Block["type"];
  
  if (originalType.startsWith("heading")) {
    if (isEmpty) {
      // Empty heading: keep heading above, create paragraph below
      blockCopy1Type = originalType;
      blockCopy2Type = "paragraph";
    } else if (isAtStart) {
      // At start of non-empty heading: new block above should be paragraph, heading stays below
      blockCopy1Type = "paragraph";
      blockCopy2Type = originalType;
    } else if (isAtEnd) {
      // At end of non-empty heading: heading stays above, new block below should be paragraph
      blockCopy1Type = originalType;
      blockCopy2Type = "paragraph";
    } else {
      // In middle of heading: split into two headings
      blockCopy1Type = originalType;
      blockCopy2Type = originalType;
    }
  } else {
    // For non-heading blocks (paragraphs, etc), preserve the type
    blockCopy1Type = originalType;
    blockCopy2Type = originalType;
  }

  const blockCopy1: Block = { ...oldBlock, type: blockCopy1Type, content: beforeContent };
  // Only apply markdown prefix if the block type is a paragraph
  if (blockCopy1Type === "paragraph") {
    applyMarkdownPrefix(blockCopy1);
  }

  const blockCopy2: Block = {
    ...oldBlock,
    id: generateBlockId(),
    type: blockCopy2Type,
    content: afterContent,
  };

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
  return moveCursorToPosition(newState, blockIndex + 1, 0);
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
  if (block.type === "imageCover") {
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
 * Toggle bold formatting on selected text or at cursor position
 * If there's no selection, toggles bold mode for next typed text
 */
export function toggleBold(state: EditorState): EditorState {
  const range = getSelectionRange(state);
  
  // If no selection, toggle bold in UI's active formats
  if (!range) {
    if (!state.document.cursor) return state;
    
    const { blockIndex, textIndex } = state.document.cursor.position;
    const block = state.document.page.blocks[blockIndex];
    
    // Get current active formats or infer from cursor position
    let currentFormats: readonly TextFormat[];
    if (state.ui.activeFormatsMode.type === 'explicit') {
      currentFormats = state.ui.activeFormatsMode.formats;
    } else {
      // Inherit mode: check formatting at cursor position
      currentFormats = getFormatsAtPosition(block, textIndex) || [];
    }
    
    const hasBold = currentFormats.some(f => f.type === 'bold');
    
    let newFormats: TextFormat[];
    if (hasBold) {
      // Remove bold
      newFormats = currentFormats.filter(f => f.type !== 'bold');
    } else {
      // Add bold
      newFormats = [...currentFormats, { type: 'bold' }];
    }
    
    return {
      ...state,
      ui: {
        ...state.ui,
        activeFormatsMode: { type: 'explicit', formats: newFormats },
      },
    };
  }

  const { start, end } = range;

  if (start.blockIndex === end.blockIndex) {
    // Single block selection
    const block = state.document.page.blocks[start.blockIndex];
    
    if (!isTextBlock(block)) {
      return state;
    }
    
    // Extract the segments in the selected range
    const selectedSegments = extractSegmentsInRange(
      block.content,
      start.textIndex,
      end.textIndex
    );

    // Check if all segments are already bold
    const isBold = allSegmentsHaveFormat(selectedSegments, 'bold');

    // Toggle bold formatting
    const modifiedSegments = isBold
      ? removeFormatFromSegments(selectedSegments, 'bold')
      : addFormatToSegments(selectedSegments, { type: 'bold' });

    // Reconstruct the block content
    const beforeSegments = extractSegmentsInRange(block.content, 0, start.textIndex);
    const afterSegments = extractSegmentsInRange(
      block.content,
      end.textIndex,
      getBlockTextContent(block).length
    );

    const newContent = mergeAdjacentSegments([
      ...beforeSegments,
      ...modifiedSegments,
      ...afterSegments,
    ]);

    const newBlock: Block = { ...block, content: newContent };
    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[start.blockIndex] = newBlock;
    const newPage = { ...state.document.page, blocks: newBlocks };

    return {
      ...state,
      document: { ...state.document, page: newPage },
    };
  } else {
    // Multi-block selection
    const newBlocks = [...state.document.page.blocks];
    
    // First, collect all segments from all blocks in the selection
    let allSelectedSegments: Text[] = [];
    
    for (let i = start.blockIndex; i <= end.blockIndex; i++) {
      const block = newBlocks[i];
      if (!isTextBlock(block)) {
        continue; // Skip non-text blocks
      }
      const blockText = getBlockTextContent(block);
      
      if (i === start.blockIndex) {
        // First block: from start.textIndex to end
        allSelectedSegments.push(
          ...extractSegmentsInRange(block.content, start.textIndex, blockText.length)
        );
      } else if (i === end.blockIndex) {
        // Last block: from 0 to end.textIndex
        allSelectedSegments.push(
          ...extractSegmentsInRange(block.content, 0, end.textIndex)
        );
      } else {
        // Middle blocks: entire block
        allSelectedSegments.push(...block.content);
      }
    }

    // Check if all segments are already bold
    const isBold = allSegmentsHaveFormat(allSelectedSegments, 'bold');

    // Now apply the formatting to each block
    for (let i = start.blockIndex; i <= end.blockIndex; i++) {
      const block = newBlocks[i];
      if (!isTextBlock(block)) {
        continue; // Skip non-text blocks
      }
      const blockText = getBlockTextContent(block);
      
      let beforeSegments: Text[];
      let selectedSegments: Text[];
      let afterSegments: Text[];

      if (i === start.blockIndex && i === end.blockIndex) {
        // Only one block (already handled above, but keep for completeness)
        beforeSegments = extractSegmentsInRange(block.content, 0, start.textIndex);
        selectedSegments = extractSegmentsInRange(block.content, start.textIndex, end.textIndex);
        afterSegments = extractSegmentsInRange(block.content, end.textIndex, blockText.length);
      } else if (i === start.blockIndex) {
        // First block
        beforeSegments = extractSegmentsInRange(block.content, 0, start.textIndex);
        selectedSegments = extractSegmentsInRange(block.content, start.textIndex, blockText.length);
        afterSegments = [];
      } else if (i === end.blockIndex) {
        // Last block
        beforeSegments = [];
        selectedSegments = extractSegmentsInRange(block.content, 0, end.textIndex);
        afterSegments = extractSegmentsInRange(block.content, end.textIndex, blockText.length);
      } else {
        // Middle blocks
        beforeSegments = [];
        selectedSegments = block.content;
        afterSegments = [];
      }

      // Toggle bold formatting
      const modifiedSegments = isBold
        ? removeFormatFromSegments(selectedSegments, 'bold')
        : addFormatToSegments(selectedSegments, { type: 'bold' });

      const newContent = mergeAdjacentSegments([
        ...beforeSegments,
        ...modifiedSegments,
        ...afterSegments,
      ]);

      const newBlock: Block = { ...block, content: newContent };
      invalidateBlockCache(newBlock);
      newBlocks[i] = newBlock;
    }

    const newPage = { ...state.document.page, blocks: newBlocks };

    return {
      ...state,
      document: { ...state.document, page: newPage },
    };
  }
}

// Convert block type at current cursor position
export function convertBlockType(
  state: EditorState,
  blockType: Block["type"]
): EditorState {
  if (!state.document.cursor) return state;

  const { blockIndex } = state.document.cursor.position;
  const oldBlock = state.document.page.blocks[blockIndex];

  // Can't convert image cover blocks to text blocks or vice versa
  if (blockType === "imageCover" && !isTextBlock(oldBlock)) {
    // Already an image cover block
    return state;
  }
  if (blockType !== "imageCover" && !isTextBlock(oldBlock)) {
    // Can't convert image cover to text block
    return state;
  }

  // Create new block with the specified type, preserving formatting
  const newBlock: Block = isTextBlock(oldBlock) ? {
    ...oldBlock,
    type: blockType as TextBlock["type"],
  } : oldBlock;

  // Invalidate cache only for the changed block
  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  return {
    ...state,
    document: { ...state.document, page: newPage },
  };
}

export function applySlashCommand(
  state: EditorState,
  command: SlashCommand
): EditorState {
  if (!state.document.cursor || state.ui.activeMenu.type !== 'slashCommand') return state;

  const { blockIndex, textIndex } = state.ui.activeMenu;

  // Remove the "/" and filter text, preserving formatting
  const block = state.document.page.blocks[blockIndex];

  // Special handling for image cover blocks
  if (command.type === "imageCover") {
    // For image cover blocks, we replace the current block with an empty image cover block
    const newBlock: Block = {
      id: block.id,
      type: "imageCover",
      url: "", // Will be filled when image is uploaded
      alt: "",
    };

    // Invalidate cache only for the changed block
    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = newBlock;
    const newPage = { ...state.document.page, blocks: newBlocks };

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
      const newParagraph: Block = {
        id: generateBlockId(),
        type: "paragraph",
        content: [{ content: "", formats: undefined }],
      };
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

    return newState;
  }

  // Regular text-based blocks
  // If the current block is already an image cover, just close the slash command
  if (block.type === "imageCover") {
    return closeSlashCommand(state);
  }

  if (!isTextBlock(block)) {
    return closeSlashCommand(state);
  }

  // Delete from "/" position to current cursor position
  const newContent = deleteTextRangeInFormattedContent(
    block.content,
    textIndex - 1, // Remove the "/"
    state.document.cursor.position.textIndex // Remove up to cursor (the filter text)
  );

  // Update block content and type
  const newBlock: Block = {
    ...block,
    type: command.type as TextBlock["type"],
    content: newContent,
  };

  // Invalidate cache only for the changed block
  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  // Update state
  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
  };
  newState = closeSlashCommand(newState);
  newState = moveCursorToPosition(newState, blockIndex, textIndex - 1);

  return newState;
}

/**
 * Update a link's URL and text at a specific text segment range in a block
 * @param start - Starting text segment index (inclusive)
 * @param end - Ending text segment index (inclusive)
 */
export function updateLinkInBlock(
  state: EditorState,
  blockIndex: number,
  segmentIndex: number,
  newUrl: string,
  newText: string
): EditorState {
  const block = state.document.page.blocks[blockIndex];
  if (!block) return state;

  if (!isTextBlock(block)) {
    return state;
  }

  // If newText is empty, don't update (prevents index shifting during editing)
  // User should use clearLinkInBlock to explicitly delete the link
  if (!newText || newText.length === 0) {
    return state;
  }

  // Build new content array by replacing the specified segment range
  const newBlock: Block = {
    ...block,
    content: [
      ...block.content.slice(0, segmentIndex),
      { content: newText, formats: [{ type: "link", url: newUrl }] },
      ...block.content.slice(segmentIndex + 1),
    ],
  };
  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
  };

  return newState;
}

/**
 * Clear a link format from specific text segments in a block (remove link, keep text)
 * @param start - Starting text segment index (inclusive)
 * @param end - Ending text segment index (inclusive)
 */
export function clearLinkInBlock(
  state: EditorState,
  blockIndex: number,
  segmentIndex: number
): EditorState {
  const block = state.document.page.blocks[blockIndex];
  if (!block) return state;

  if (!isTextBlock(block)) {
    return state;
  }

  const newBlock: Block = {
    ...block,
    content: block.content.filter((_, index) => index !== segmentIndex),
  };
  invalidateBlockCache(newBlock);

  const newBlocks = [...state.document.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.document.page, blocks: newBlocks };
  return {
    ...state,
    document: { ...state.document, page: newPage },
  };
}
