import type { EditorState, Position } from "./types";
import type { Block } from "../deserializer/loadPage";
import type { SlashCommand } from "./types";
import { getBlockTextContent, closeSlashCommand } from "./state";
import {
  moveCursorToPosition,
  updateMode,
  startSelection,
  updateSelectionFocus,
  clearSelection,
} from "./state";

function applyMarkdownPrefix(
  block: Block,
  preserveType: boolean = false
): Block {
  const text = block.content.map((t) => t.content).join("");
  if (text.startsWith("### ")) {
    block.type = "heading3";
    block.content = [{ content: text.slice(4) }];
  } else if (text.startsWith("## ")) {
    block.type = "heading2";
    block.content = [{ content: text.slice(3) }];
  } else if (text.startsWith("# ")) {
    block.type = "heading1";
    block.content = [{ content: text.slice(2) }];
  } else if (!preserveType) {
    block.type = "paragraph";
    block.content = [{ content: text }];
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
  const range = getSelectionRange(state);
  if (!range) return state;

  const { start, end } = range;

  if (start.blockIndex === end.blockIndex) {
    // Single block selection
    const block = state.page.blocks[start.blockIndex];
    const text = getBlockTextContent(block);
    const newText = text.slice(0, start.textIndex) + text.slice(end.textIndex);
    const blockCopy: Block = { ...block, content: [{ content: newText }] };

    if (block.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }

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
    // Multi-block selection
    const startBlock = state.page.blocks[start.blockIndex];
    const endBlock = state.page.blocks[end.blockIndex];
    const startText = getBlockTextContent(startBlock);
    const endText = getBlockTextContent(endBlock);

    // Create merged block with text before selection start and after selection end
    const newText =
      startText.slice(0, start.textIndex) + endText.slice(end.textIndex);
    const blockCopy: Block = { ...startBlock, content: [{ content: newText }] };

    if (startBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }

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
  const oldText = getBlockTextContent(oldBlock);
  const newText =
    oldText.slice(0, textIndex) + input + oldText.slice(textIndex);
  const blockCopy: Block = { ...oldBlock, content: [{ content: newText }] };
  applyMarkdownPrefix(blockCopy, oldBlock.type !== "paragraph");
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
    textIndex + input.length
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
  const oldText = getBlockTextContent(oldBlock);
  if (textIndex > 0) {
    const newText = oldText.slice(0, textIndex - 1) + oldText.slice(textIndex);
    const blockCopy: Block = { ...oldBlock, content: [{ content: newText }] };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    const newBlocks = [...state.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex, textIndex - 1);
  } else if (blockIndex > 0) {
    const prevBlock = state.page.blocks[blockIndex - 1];
    const prevText = getBlockTextContent(prevBlock);
    const newText = prevText + oldText;
    const blockCopy: Block = { ...prevBlock, content: [{ content: newText }] };
    // Preserve the original block type when joining blocks
    // Only apply markdown prefix if the original was a paragraph
    if (prevBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
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
    // Delete character after cursor
    const newText = oldText.slice(0, textIndex) + oldText.slice(textIndex + 1);
    const blockCopy: Block = { ...oldBlock, content: [{ content: newText }] };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    const newBlocks = [...state.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex, textIndex);
  } else if (blockIndex < state.page.blocks.length - 1) {
    // Merge with next block
    const nextBlock = state.page.blocks[blockIndex + 1];
    const nextText = getBlockTextContent(nextBlock);
    const newText = oldText + nextText;
    const blockCopy: Block = { ...oldBlock, content: [{ content: newText }] };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
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

// Helper function to find word boundaries - uses whitespace as boundaries
function findWordBoundary(
  text: string,
  index: number,
  direction: "left" | "right"
): number {
  if (direction === "left") {
    // Move left to find start of word
    let i = index;
    // Skip current non-whitespace characters
    while (i > 0 && !/\s/.test(text[i - 1])) {
      i--;
    }
    // Skip whitespace
    while (i > 0 && /\s/.test(text[i - 1])) {
      i--;
    }
    // Find start of previous word (non-whitespace)
    while (i > 0 && !/\s/.test(text[i - 1])) {
      i--;
    }
    return i;
  } else {
    // Move right to find end of word
    let i = index;
    // Skip whitespace
    while (i < text.length && /\s/.test(text[i])) {
      i++;
    }
    // Skip non-whitespace characters
    while (i < text.length && !/\s/.test(text[i])) {
      i++;
    }
    return i;
  }
}

function findWordDeleteBoundaryLeft(text: string, index: number): number {
  let i = index;

  if (i === 0) return 0;

  if (/\s/.test(text[i - 1])) {
    while (i > 0 && /\s/.test(text[i - 1])) {
      i--;
    }
  }

  while (i > 0 && !/\s/.test(text[i - 1])) {
    i--;
  }

  return i;
}

function findWordDeleteBoundaryRight(text: string, index: number): number {
  let i = index;

  if (i === text.length) return text.length;

  if (/\s/.test(text[i])) {
    while (i < text.length && /\s/.test(text[i])) {
      i++;
    }
  }

  while (i < text.length && !/\s/.test(text[i])) {
    i++;
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
    const endIndex = findWordDeleteBoundaryRight(oldText, textIndex);
    const newText = oldText.slice(0, textIndex) + oldText.slice(endIndex);
    const blockCopy: Block = { ...oldBlock, content: [{ content: newText }] };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    const newBlocks = [...state.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex, textIndex);
  } else if (blockIndex < state.page.blocks.length - 1) {
    const nextBlock = state.page.blocks[blockIndex + 1];
    const nextText = getBlockTextContent(nextBlock);

    if (nextText.length === 0) {
      const newBlocks = [
        ...state.page.blocks.slice(0, blockIndex),
        oldBlock,
        ...state.page.blocks.slice(blockIndex + 2),
      ];
      const newPage = { ...state.page, blocks: newBlocks };
      let newState = { ...state, page: newPage } as EditorState;
      return moveCursorToPosition(newState, blockIndex, textIndex);
    }

    const endIndex = findWordDeleteBoundaryRight(nextText, 0);
    const newText = oldText + nextText.slice(endIndex);
    const blockCopy: Block = { ...oldBlock, content: [{ content: newText }] };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
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
    const startIndex = findWordDeleteBoundaryLeft(oldText, textIndex);
    const newText = oldText.slice(0, startIndex) + oldText.slice(textIndex);
    const blockCopy: Block = { ...oldBlock, content: [{ content: newText }] };
    if (oldBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    const newBlocks = [...state.page.blocks];
    newBlocks[blockIndex] = blockCopy;
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex, startIndex);
  } else if (blockIndex > 0) {
    const prevBlock = state.page.blocks[blockIndex - 1];
    const prevText = getBlockTextContent(prevBlock);

    if (prevText.length === 0) {
      const newBlocks = [
        ...state.page.blocks.slice(0, blockIndex - 1),
        oldBlock,
        ...state.page.blocks.slice(blockIndex + 1),
      ];
      const newPage = { ...state.page, blocks: newBlocks };
      let newState = { ...state, page: newPage } as EditorState;
      return moveCursorToPosition(newState, blockIndex - 1, 0);
    }

    const startIndex = findWordDeleteBoundaryLeft(prevText, prevText.length);
    const newText = prevText.slice(0, startIndex) + oldText;
    const blockCopy: Block = { ...prevBlock, content: [{ content: newText }] };
    if (prevBlock.type === "paragraph") {
      applyMarkdownPrefix(blockCopy);
    }
    const newBlocks = [
      ...state.page.blocks.slice(0, blockIndex - 1),
      blockCopy,
      ...state.page.blocks.slice(blockIndex + 1),
    ];
    const newPage = { ...state.page, blocks: newBlocks };
    let newState = { ...state, page: newPage } as EditorState;
    return moveCursorToPosition(newState, blockIndex - 1, startIndex);
  }
  return state;
}

// Find word boundaries for selection - includes punctuation and non-whitespace
function findWordStart(text: string, index: number): number {
  let i = index;
  // Move left while we're not at whitespace or start of string
  while (i > 0 && !/\s/.test(text[i - 1])) {
    i--;
  }
  return i;
}

function findWordEnd(text: string, index: number): number {
  let i = index;
  // Move right while we're not at whitespace or end of string
  while (i < text.length && !/\s/.test(text[i])) {
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

export function splitBlock(state: EditorState): EditorState {
  if (!state.cursor) return state;
  const { blockIndex, textIndex } = state.cursor.position;
  const oldBlock = state.page.blocks[blockIndex];
  const oldText = getBlockTextContent(oldBlock);
  const beforeText = oldText.slice(0, textIndex);
  const afterText = oldText.slice(textIndex);

  // Preserve the original block type for both blocks
  const originalType = oldBlock.type;

  const blockCopy1: Block = { ...oldBlock, content: [{ content: beforeText }] };
  // Only apply markdown prefix if the original was a paragraph
  if (originalType === "paragraph") {
    applyMarkdownPrefix(blockCopy1);
  }

  const blockCopy2: Block = { ...oldBlock, content: [{ content: afterText }] };
  // Only apply markdown prefix if the original was a paragraph
  if (originalType === "paragraph") {
    applyMarkdownPrefix(blockCopy2);
  }

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
  const text = getBlockTextContent(oldBlock);

  // Create new block with the specified type
  const newBlock: Block = {
    ...oldBlock,
    type: blockType,
    content: [{ content: text }],
  };

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

  // Remove the "/" and filter text
  const block = state.page.blocks[blockIndex];
  const text = getBlockTextContent(block);
  const beforeSlash = text.slice(0, textIndex - 1);
  const afterFilter = text.slice(state.cursor.position.textIndex);
  const newText = beforeSlash + afterFilter;

  // Update block content and type
  const newBlock: Block = {
    ...block,
    type: command.type,
    content: [{ content: newText }],
  };

  const newBlocks = [...state.page.blocks];
  newBlocks[blockIndex] = newBlock;
  const newPage = { ...state.page, blocks: newBlocks };

  // Update state
  let newState: EditorState = { ...state, page: newPage };
  newState = closeSlashCommand(newState);
  newState = moveCursorToPosition(newState, blockIndex, beforeSlash.length);

  return newState;
}