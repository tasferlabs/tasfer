import type { Block, Page } from "../deserializer/loadPage";
import { getCurrentFontFamily, wrapFormattedText, measureFormattedTextUpToIndex } from "./fonts";
import {
  createInitialMomentumState,
  createInitialScrollbarState,
} from "./scrollbar";
import { getEditorStyles, getTextStyle } from "./styles";
import { getFormattedTextDirection } from "./rtl";
import type {
  CursorState,
  EditorMode,
  EditorState,
  EditorStyles,
  PartialSelectionState,
  Position,
  ViewportState,
} from "./types";
import { initialUndoManagerState } from "./undo";

// Block ID Generation - Centralized Counter
let blockIdCounter = 10000; // Start high to avoid conflicts with parsed blocks

export function generateBlockId(): string {
  return `block-${blockIdCounter++}`;
}

// State Creation Functions
export const createInitialState = (page: Page): EditorState => ({
  document: {
    page,
    cursor: null,
    selection: null,
  },
  ui: {
    mode: "edit" as EditorMode,
    slashCommand: null,
    contextMenu: null,
    linkHover: null,
    isHoveringLinkWithModifier: false,
    composition: null,
  },
  view: {
    isFocused: false,
    clickTracker: {
      count: 0,
      lastClickTime: 0,
      lastClickPosition: null,
    },
    scrollbar: createInitialScrollbarState(),
    momentum: createInitialMomentumState(),
  },
  undoManager: initialUndoManagerState,
});

// State Update Functions (Pure Functions)
export const updateCursor = (
  state: EditorState,
  position: Position | null
): EditorState => ({
  ...state,
  document: {
    ...state.document,
    cursor: position
      ? {
          position,
          lastUpdate: Date.now(),
        }
      : null,
  },
});

export const updateSelection = (
  state: EditorState,
  updates: PartialSelectionState | null
): EditorState => ({
  ...state,
  document: {
    ...state.document,
    selection: !!updates
      ? {
          ...state.document.selection,
          anchor: updates.anchor,
          focus: updates.focus,
          isForward: isForwardSelection(updates),
          isCollapsed: isCollapsedSelection(updates),
          lastUpdate: Date.now(),
        }
      : null,
  },
});

export const updateMode = (
  state: EditorState,
  mode: EditorMode
): EditorState => ({
  ...state,
  ui: { ...state.ui, mode },
});

export const updateFocus = (
  state: EditorState,
  isFocused: boolean
): EditorState => ({
  ...state,
  view: { ...state.view, isFocused },
});

// Helper Functions

export const createInitialCursorState = (state: EditorState): EditorState => {
  return {
    ...state,
    document: {
      ...state.document,
      cursor: {
        position: {
          blockIndex: 0,
          textIndex: 0,
        },
        lastUpdate: Date.now(),
      },
    },
  };
};

export const getBlockTextLength = (block: Block): number => {
  if (!block) return 0;

  if ("level" in block) {
    // Heading block
    return block.content.reduce(
      (total, text) => total + text.content.length,
      0
    );
  } else {
    // Paragraph block
    return block.content.reduce(
      (total, text) => total + text.content.length,
      0
    );
  }
};

export const getBlockTextContent = (block: Block): string => {
  if (!block) return "";

  if ("level" in block) {
    // Heading block
    return block.content.map((text) => text.content).join("");
  } else {
    // Paragraph block
    return block.content.map((text) => text.content).join("");
  }
};

export const isForwardSelection = (
  selection: PartialSelectionState
): boolean => {
  return (
    selection.anchor.blockIndex < selection.focus.blockIndex ||
    (selection.anchor.blockIndex === selection.focus.blockIndex &&
      selection.anchor.textIndex <= selection.focus.textIndex)
  );
};

export const isCollapsedSelection = (
  selection: PartialSelectionState
): boolean => {
  return (
    selection.anchor.blockIndex === selection.focus.blockIndex &&
    selection.anchor.textIndex === selection.focus.textIndex
  );
};

export function isCursorBlinking(cursor: CursorState, styles: EditorStyles) {
  const now = Date.now();
  const untilNextBlink = now % styles.cursor.blinkInterval;
  const endTime = cursor.lastUpdate + untilNextBlink;
  // if the cursor has been recently updated, it should be visible
  if (endTime > now) {
    return false;
  }

  // otherwise, it should blink
  return (
    Math.floor(
      (Date.now() - styles.cursor.blinkInterval) / styles.cursor.blinkInterval
    ) %
      2 !==
    0
  );
}

// Cursor Movement Functions
export const moveCursorToPosition = (
  state: EditorState,
  blockIndex: number,
  textIndex: number
): EditorState => {
  const clampedBlockIndex = Math.max(
    0,
    Math.min(blockIndex, state.document.page.blocks.length - 1)
  );
  const block = state.document.page.blocks[clampedBlockIndex];

  if (!block) return state;

  const maxTextIndex = getBlockTextLength(block);
  const clampedTextIndex = Math.max(0, Math.min(textIndex, maxTextIndex));

  return updateCursor(state, {
    blockIndex: clampedBlockIndex,
    textIndex: clampedTextIndex,
  });
};

export const moveCursorLeft = (state: EditorState): EditorState => {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];
  
  if (!currentBlock) return state;

  // Check if current block is RTL
  const isRTL = getFormattedTextDirection(currentBlock.content) === "rtl";
  
  if (isRTL) {
    // In RTL text, visual left is logical forward (increment)
    const currentBlockLength = getBlockTextLength(currentBlock);
    
    if (textIndex < currentBlockLength) {
      return moveCursorToPosition(state, blockIndex, textIndex + 1);
    } else if (blockIndex < state.document.page.blocks.length - 1) {
      // Moving to next block - check if next block is RTL or LTR
      const nextBlock = state.document.page.blocks[blockIndex + 1];
      const nextIsRTL = getFormattedTextDirection(nextBlock.content) === "rtl";
      
      if (nextIsRTL) {
        // Next block is RTL, position at start (visual right edge)
        return moveCursorToPosition(state, blockIndex + 1, 0);
      } else {
        // Next block is LTR, position at start (visual left edge)
        return moveCursorToPosition(state, blockIndex + 1, 0);
      }
    }
  } else {
    // LTR text: visual left is logical backward (decrement)
    if (textIndex > 0) {
      return moveCursorToPosition(state, blockIndex, textIndex - 1);
    } else if (blockIndex > 0) {
      // Moving to previous block - check if previous block is RTL or LTR
      const prevBlock = state.document.page.blocks[blockIndex - 1];
      const prevBlockLength = getBlockTextLength(prevBlock);
      const prevIsRTL = getFormattedTextDirection(prevBlock.content) === "rtl";
      
      if (prevIsRTL) {
        // Previous block is RTL, position at end (visual left edge)
        return moveCursorToPosition(state, blockIndex - 1, prevBlockLength);
      } else {
        // Previous block is LTR, position at end (visual right edge)
        return moveCursorToPosition(state, blockIndex - 1, prevBlockLength);
      }
    }
  }

  return state;
};

export const moveCursorRight = (state: EditorState): EditorState => {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock) return state;

  const currentBlockLength = getBlockTextLength(currentBlock);
  
  // Check if current block is RTL
  const isRTL = getFormattedTextDirection(currentBlock.content) === "rtl";
  
  if (isRTL) {
    // In RTL text, visual right is logical backward (decrement)
    if (textIndex > 0) {
      return moveCursorToPosition(state, blockIndex, textIndex - 1);
    } else if (blockIndex > 0) {
      // Moving to previous block - check if previous block is RTL or LTR
      const prevBlock = state.document.page.blocks[blockIndex - 1];
      const prevBlockLength = getBlockTextLength(prevBlock);
      const prevIsRTL = getFormattedTextDirection(prevBlock.content) === "rtl";
      
      if (prevIsRTL) {
        // Previous block is RTL, position at end (visual left edge)
        return moveCursorToPosition(state, blockIndex - 1, prevBlockLength);
      } else {
        // Previous block is LTR, position at end (visual right edge)
        return moveCursorToPosition(state, blockIndex - 1, prevBlockLength);
      }
    }
  } else {
    // LTR text: visual right is logical forward (increment)
    if (textIndex < currentBlockLength) {
      return moveCursorToPosition(state, blockIndex, textIndex + 1);
    } else if (blockIndex < state.document.page.blocks.length - 1) {
      // Moving to next block - check if next block is RTL or LTR
      const nextBlock = state.document.page.blocks[blockIndex + 1];
      const nextIsRTL = getFormattedTextDirection(nextBlock.content) === "rtl";
      
      if (nextIsRTL) {
        // Next block is RTL, position at start (visual right edge)
        return moveCursorToPosition(state, blockIndex + 1, 0);
      } else {
        // Next block is LTR, position at start (visual left edge)
        return moveCursorToPosition(state, blockIndex + 1, 0);
      }
    }
  }

  return state;
};

/**
 * Get line information for a given position within a block
 * Returns the line index, line start/end indices, and total lines in the block
 */
function getLineInfoAtPosition(
  block: Block,
  textIndex: number,
  maxWidth: number,
  styles: EditorStyles = getEditorStyles()
): {
  lineIndex: number;
  lineStartIndex: number;
  lineEndIndex: number;
  totalLines: number;
  lines: string[];
} | null {
  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  const lines = wrapFormattedText(
    block.content,
    maxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding
  );

  let currentTextIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineStartIndex = currentTextIndex;
    const lineEndIndex = currentTextIndex + line.length;

    if (textIndex >= lineStartIndex && textIndex <= lineEndIndex) {
      return {
        lineIndex,
        lineStartIndex,
        lineEndIndex,
        totalLines: lines.length,
        lines,
      };
    }

    currentTextIndex += line.length;
    // Account for the space character consumed during text wrapping (if not last line)
    if (lineIndex < lines.length - 1) {
      currentTextIndex += 1;
    }
  }

  return null;
}

/**
 * Get the text index at a relative position within a line
 * Used to maintain horizontal position when moving up/down between lines
 */
function getTextIndexAtRelativePosition(
  lineStartIndex: number,
  lineEndIndex: number,
  relativePosition: number,
  block?: Block,
  maxWidth?: number,
  styles?: EditorStyles
): number {
  // If no block info provided, use simple logical positioning
  if (!block || !maxWidth || !styles) {
    const lineLength = lineEndIndex - lineStartIndex;
    const targetIndex = lineStartIndex + Math.min(relativePosition, lineLength);
    return targetIndex;
  }
  
  // Check if this is RTL text
  const isRTL = getFormattedTextDirection(block.content) === "rtl";
  
  if (!isRTL) {
    // LTR: simple logical positioning
    const lineLength = lineEndIndex - lineStartIndex;
    const targetIndex = lineStartIndex + Math.min(relativePosition, lineLength);
    return targetIndex;
  }
  
  // RTL: find the text index that corresponds to the visual position
  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;
  
  // Find the character position that has the target visual position
  // For RTL: relativePosition is widthFromStart (distance from line start)
  // We need to find the charIndex where widthFromStart matches relativePosition
  let bestIndex = lineStartIndex;
  let minDistance = Infinity;
  
  const lineLength = lineEndIndex - lineStartIndex;
  for (let i = 0; i <= lineLength; i++) {
    const charIndex = lineStartIndex + i;
    
    // Measure from line start to this character position
    const widthFromStart = measureFormattedTextUpToIndex(
      block.content,
      lineStartIndex,
      charIndex,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      codePadding
    );
    
    const distance = Math.abs(widthFromStart - relativePosition);
    
    if (distance < minDistance) {
      minDistance = distance;
      bestIndex = charIndex;
    }
  }
  
  return bestIndex;
}

/**
 * Move cursor up by one line (not block)
 * If on the first line of a block, moves to the last line of the previous block
 */
export const moveCursorUp = (
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles()
): EditorState => {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock) return state;

  // Calculate maxWidth from viewport or use a default
  const maxWidth = viewport
    ? viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight)
    : 800; // Default fallback

  const lineInfo = getLineInfoAtPosition(
    currentBlock,
    textIndex,
    maxWidth,
    styles
  );

  if (!lineInfo) return state;

  // For RTL text, calculate visual position instead of logical position
  const isRTL = getFormattedTextDirection(currentBlock.content) === "rtl";
  let relativePosition: number;
  
  if (isRTL) {
    // Calculate visual position from the left edge of the line
    // For RTL: cursor at logical index 0 appears at RIGHT, cursor at index N appears at LEFT
    const textStyle = getTextStyle(styles, currentBlock.type);
    const fontFamily = getCurrentFontFamily();
    const codePadding = styles.textFormats.code.padding;
    
    // Measure from line start to cursor position
    const widthFromStart = measureFormattedTextUpToIndex(
      currentBlock.content,
      lineInfo.lineStartIndex,
      textIndex,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      codePadding
    );
    
    // Visual position from left edge: further from start logically = further LEFT visually
    // Since RTL text is right-aligned and grows leftward, we use widthFromStart directly
    relativePosition = widthFromStart;
  } else {
    relativePosition = textIndex - lineInfo.lineStartIndex;
  }

  // If not on the first line of the block, move to the previous line within the same block
  if (lineInfo.lineIndex > 0) {
    const prevLine = lineInfo.lines[lineInfo.lineIndex - 1];
    let prevLineStartIndex = 0;

    // Calculate the start index of the previous line
    for (let i = 0; i < lineInfo.lineIndex - 1; i++) {
      prevLineStartIndex += lineInfo.lines[i].length;
      if (i < lineInfo.totalLines - 1) {
        prevLineStartIndex += 1; // Account for space
      }
    }

    const prevLineEndIndex = prevLineStartIndex + prevLine.length;
    const targetTextIndex = getTextIndexAtRelativePosition(
      prevLineStartIndex,
      prevLineEndIndex,
      relativePosition,
      currentBlock,
      maxWidth,
      styles
    );

    return moveCursorToPosition(state, blockIndex, targetTextIndex);
  }

  // On the first line of the block, move to the previous block's last line
  if (blockIndex > 0) {
    const prevBlock = state.document.page.blocks[blockIndex - 1];
    const prevTextStyle = getTextStyle(styles, prevBlock.type);
    const fontFamily = getCurrentFontFamily();
    const codePadding = styles.textFormats.code.padding;

    const prevLines = wrapFormattedText(
      prevBlock.content,
      maxWidth,
      prevTextStyle.fontSize,
      prevTextStyle.fontWeight,
      fontFamily,
      codePadding
    );

    if (prevLines.length > 0) {
      // Calculate the start index of the last line in the previous block
      let lastLineStartIndex = 0;
      for (let i = 0; i < prevLines.length - 1; i++) {
        lastLineStartIndex += prevLines[i].length;
        if (i < prevLines.length - 1) {
          lastLineStartIndex += 1; // Account for space
        }
      }

      const lastLine = prevLines[prevLines.length - 1];
      const lastLineEndIndex = lastLineStartIndex + lastLine.length;
      const targetTextIndex = getTextIndexAtRelativePosition(
        lastLineStartIndex,
        lastLineEndIndex,
        relativePosition,
        prevBlock,
        maxWidth,
        styles
      );

      return moveCursorToPosition(state, blockIndex - 1, targetTextIndex);
    }

    // If previous block is empty, just go to its start
    return moveCursorToPosition(state, blockIndex - 1, 0);
  }

  // Already at the first line of the first block, move to start
  return moveCursorToPosition(state, blockIndex, 0);
};

/**
 * Move cursor down by one line (not block)
 * If on the last line of a block, moves to the first line of the next block
 */
export const moveCursorDown = (
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles()
): EditorState => {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock) return state;

  // Calculate maxWidth from viewport or use a default
  const maxWidth = viewport
    ? viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight)
    : 800; // Default fallback

  const lineInfo = getLineInfoAtPosition(
    currentBlock,
    textIndex,
    maxWidth,
    styles
  );

  if (!lineInfo) return state;

  // For RTL text, calculate visual position instead of logical position
  const isRTL = getFormattedTextDirection(currentBlock.content) === "rtl";
  let relativePosition: number;
  
  if (isRTL) {
    // Calculate visual position from the left edge of the line
    // For RTL: cursor at logical index 0 appears at RIGHT, cursor at index N appears at LEFT
    const textStyle = getTextStyle(styles, currentBlock.type);
    const fontFamily = getCurrentFontFamily();
    const codePadding = styles.textFormats.code.padding;
    
    // Measure from line start to cursor position
    const widthFromStart = measureFormattedTextUpToIndex(
      currentBlock.content,
      lineInfo.lineStartIndex,
      textIndex,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      codePadding
    );
    
    // Visual position from left edge: further from start logically = further LEFT visually
    // Since RTL text is right-aligned and grows leftward, we use widthFromStart directly
    relativePosition = widthFromStart;
  } else {
    relativePosition = textIndex - lineInfo.lineStartIndex;
  }

  // If not on the last line of the block, move to the next line within the same block
  if (lineInfo.lineIndex < lineInfo.totalLines - 1) {
    const nextLine = lineInfo.lines[lineInfo.lineIndex + 1];
    let nextLineStartIndex = 0;

    // Calculate the start index of the next line
    for (let i = 0; i <= lineInfo.lineIndex; i++) {
      if (i > 0) {
        nextLineStartIndex += lineInfo.lines[i - 1].length;
        if (i < lineInfo.totalLines) {
          nextLineStartIndex += 1; // Account for space
        }
      }
    }

    // Adjust calculation - iterate properly
    nextLineStartIndex = 0;
    for (let i = 0; i < lineInfo.lineIndex + 1; i++) {
      nextLineStartIndex += lineInfo.lines[i].length;
      if (i < lineInfo.totalLines - 1) {
        nextLineStartIndex += 1; // Account for space
      }
    }

    const nextLineEndIndex = nextLineStartIndex + nextLine.length;
    const targetTextIndex = getTextIndexAtRelativePosition(
      nextLineStartIndex,
      nextLineEndIndex,
      relativePosition,
      currentBlock,
      maxWidth,
      styles
    );

    return moveCursorToPosition(state, blockIndex, targetTextIndex);
  }

  // On the last line of the block, move to the next block's first line
  if (blockIndex < state.document.page.blocks.length - 1) {
    const nextBlock = state.document.page.blocks[blockIndex + 1];
    const nextTextStyle = getTextStyle(styles, nextBlock.type);
    const fontFamily = getCurrentFontFamily();
    const codePadding = styles.textFormats.code.padding;

    const nextLines = wrapFormattedText(
      nextBlock.content,
      maxWidth,
      nextTextStyle.fontSize,
      nextTextStyle.fontWeight,
      fontFamily,
      codePadding
    );

    if (nextLines.length > 0) {
      const firstLine = nextLines[0];
      const targetTextIndex = getTextIndexAtRelativePosition(
        0,
        firstLine.length,
        relativePosition,
        nextBlock,
        maxWidth,
        styles
      );

      return moveCursorToPosition(state, blockIndex + 1, targetTextIndex);
    }

    // If next block is empty, just go to its start
    return moveCursorToPosition(state, blockIndex + 1, 0);
  }

  // Already at the last line of the last block, move to end
  const currentBlockLength = getBlockTextLength(currentBlock);
  return moveCursorToPosition(state, blockIndex, currentBlockLength);
};

/**
 * Move cursor up by one page
 * Moves the cursor up by approximately one viewport height
 */
export const moveCursorPageUp = (
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles()
): EditorState => {
  if (!state.document.cursor || !viewport) return state;

  // Move up by viewport height worth of lines
  // Estimate ~10-20 lines per page depending on font size
  const linesToMove = Math.floor(viewport.height / 30); // Approximate line height

  let newState = state;
  for (let i = 0; i < linesToMove && newState.document.cursor; i++) {
    newState = moveCursorUp(newState, viewport, styles);
  }

  return newState;
};

/**
 * Move cursor down by one page
 * Moves the cursor down by approximately one viewport height
 */
export const moveCursorPageDown = (
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles()
): EditorState => {
  if (!state.document.cursor || !viewport) return state;

  // Move down by viewport height worth of lines
  // Estimate ~10-20 lines per page depending on font size
  const linesToMove = Math.floor(viewport.height / 30); // Approximate line height

  let newState = state;
  for (let i = 0; i < linesToMove && newState.document.cursor; i++) {
    newState = moveCursorDown(newState, viewport, styles);
  }

  return newState;
};

// Selection Functions
export const startSelection = (
  state: EditorState,
  position: Position
): EditorState => {
  return updateSelection(state, {
    anchor: position,
    focus: position,
    isForward: true,
    isCollapsed: true,
  });
};

export const updateSelectionFocus = (
  state: EditorState,
  position: Position
): EditorState => {
  if (!state.document.selection) {
    return startSelection(state, position);
  }

  // If we have an initial boundary (from double/triple-click), adjust anchor based on drag direction
  if (state.document.selection.initialBoundary) {
    const { start, end } = state.document.selection.initialBoundary;
    
    // Determine if the new focus is before start or after end
    const isFocusBeforeStart =
      position.blockIndex < start.blockIndex ||
      (position.blockIndex === start.blockIndex &&
        position.textIndex < start.textIndex);
    
    const isFocusAfterEnd =
      position.blockIndex > end.blockIndex ||
      (position.blockIndex === end.blockIndex &&
        position.textIndex > end.textIndex);

    let newAnchor: Position;
    let newFocus: Position;
    
    if (isFocusBeforeStart) {
      // Dragging backward (before start): anchor at end, focus at new position
      newAnchor = end;
      newFocus = position;
    } else if (isFocusAfterEnd) {
      // Dragging forward (after end): anchor at start, focus at new position
      newAnchor = start;
      newFocus = position;
    } else {
      // Focus is within the initial boundary: keep the entire word/block selected
      // Determine which boundary is closer to position to decide which end to anchor
      const distanceToStart =
        Math.abs(position.blockIndex - start.blockIndex) * 10000 +
        Math.abs(position.textIndex - start.textIndex);
      const distanceToEnd =
        Math.abs(position.blockIndex - end.blockIndex) * 10000 +
        Math.abs(position.textIndex - end.textIndex);
      
      // Keep full selection: if closer to start, set focus at start and anchor at end (and vice versa)
      if (distanceToStart < distanceToEnd) {
        newAnchor = end;
        newFocus = start;
      } else {
        newAnchor = start;
        newFocus = end;
      }
    }

    return {
      ...state,
      document: {
        ...state.document,
        selection: {
          anchor: newAnchor,
          focus: newFocus,
          isForward: isForwardSelection({
            anchor: newAnchor,
            focus: newFocus,
          }),
          isCollapsed: isCollapsedSelection({
            anchor: newAnchor,
            focus: newFocus,
          }),
          lastUpdate: Date.now(),
          initialBoundary: state.document.selection.initialBoundary,
        },
      },
    };
  }

  return updateSelection(state, {
    focus: position,
    anchor: state.document.selection.anchor,
    lastUpdate: Date.now(),
    isForward: isForwardSelection({
      anchor: state.document.selection.anchor,
      focus: position,
    }),
    isCollapsed: isCollapsedSelection({
      anchor: state.document.selection.anchor,
      focus: position,
    }),
  });
};

export const clearSelection = (state: EditorState): EditorState => ({
  ...state,
  document: {
    ...state.document,
    selection: null,
  },
});

// Selection Extension Functions (for Shift+Arrow keys)
export const extendSelectionLeft = (state: EditorState): EditorState => {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const leftState = moveCursorLeft(newState);
    if (leftState.document.cursor) {
      return updateSelectionFocus(leftState, leftState.document.cursor.position);
    }
    return newState;
  }

  // Extend existing selection
  const leftState = moveCursorLeft(state);
  if (leftState.document.cursor) {
    return updateSelectionFocus(leftState, leftState.document.cursor.position);
  }
  return state;
};

export const extendSelectionRight = (state: EditorState): EditorState => {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const rightState = moveCursorRight(newState);
    if (rightState.document.cursor) {
      return updateSelectionFocus(rightState, rightState.document.cursor.position);
    }
    return newState;
  }

  // Extend existing selection
  const rightState = moveCursorRight(state);
  if (rightState.document.cursor) {
    return updateSelectionFocus(rightState, rightState.document.cursor.position);
  }
  return state;
};

export const extendSelectionUp = (
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles()
): EditorState => {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const upState = moveCursorUp(newState, viewport, styles);
    if (upState.document.cursor) {
      return updateSelectionFocus(upState, upState.document.cursor.position);
    }
    return newState;
  }

  // Extend existing selection
  const upState = moveCursorUp(state, viewport, styles);
  if (upState.document.cursor) {
    return updateSelectionFocus(upState, upState.document.cursor.position);
  }
  return state;
};

export const extendSelectionDown = (
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles()
): EditorState => {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const downState = moveCursorDown(newState, viewport, styles);
    if (downState.document.cursor) {
      return updateSelectionFocus(downState, downState.document.cursor.position);
    }
    return newState;
  }

  // Extend existing selection
  const downState = moveCursorDown(state, viewport, styles);
  if (downState.document.cursor) {
    return updateSelectionFocus(downState, downState.document.cursor.position);
  }
  return state;
};

export const extendSelectionPageUp = (
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles()
): EditorState => {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const pageUpState = moveCursorPageUp(newState, viewport, styles);
    if (pageUpState.document.cursor) {
      return updateSelectionFocus(pageUpState, pageUpState.document.cursor.position);
    }
    return newState;
  }

  // Extend existing selection
  const pageUpState = moveCursorPageUp(state, viewport, styles);
  if (pageUpState.document.cursor) {
    return updateSelectionFocus(pageUpState, pageUpState.document.cursor.position);
  }
  return state;
};

export const extendSelectionPageDown = (
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles()
): EditorState => {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const pageDownState = moveCursorPageDown(newState, viewport, styles);
    if (pageDownState.document.cursor) {
      return updateSelectionFocus(pageDownState, pageDownState.document.cursor.position);
    }
    return newState;
  }

  // Extend existing selection
  const pageDownState = moveCursorPageDown(state, viewport, styles);
  if (pageDownState.document.cursor) {
    return updateSelectionFocus(pageDownState, pageDownState.document.cursor.position);
  }
  return state;
};

// Slash Command State Management
export const openSlashCommand = (
  state: EditorState,
  blockIndex: number,
  textIndex: number
): EditorState => ({
  ...state,
  ui: {
    ...state.ui,
    slashCommand: {
      blockIndex,
      textIndex,
      filter: "",
      selectedIndex: 0,
    },
  },
});

export const updateSlashCommandFilter = (
  state: EditorState,
  filter: string
): EditorState => {
  if (!state.ui.slashCommand) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      slashCommand: {
        ...state.ui.slashCommand,
        filter,
        selectedIndex: 0, // Reset selection when filter changes
      },
    },
  };
};

export const updateSlashCommandSelection = (
  state: EditorState,
  selectedIndex: number
): EditorState => {
  if (!state.ui.slashCommand) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      slashCommand: {
        ...state.ui.slashCommand,
        selectedIndex,
      },
    },
  };
};

export const closeSlashCommand = (state: EditorState): EditorState => ({
  ...state,
  ui: {
    ...state.ui,
    slashCommand: null,
  },
});

// Context Menu State Management
export const openContextMenu = (
  state: EditorState,
  x: number,
  y: number
): EditorState => ({
  ...state,
  ui: {
    ...state.ui,
    contextMenu: { x, y },
  },
});

export const closeContextMenu = (state: EditorState): EditorState => ({
  ...state,
  ui: {
    ...state.ui,
    contextMenu: null,
  },
});

// Link Hover State Management
export const setLinkHover = (
  state: EditorState,
  linkHover: {
    position: Position;
    url: string;
    text: string;
    x: number;
    y: number;
    segmentIndex: number;
  } | null
): EditorState => ({
  ...state,
  ui: {
    ...state.ui,
    linkHover,
  },
});

// Composition (IME) State Management
export const startComposition = (
  state: EditorState,
  text: string,
  startPosition: Position
): EditorState => ({
  ...state,
  ui: {
    ...state.ui,
    composition: {
      isComposing: true,
      text,
      startPosition,
    },
  },
});

export const updateComposition = (
  state: EditorState,
  text: string
): EditorState => {
  if (!state.ui.composition) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        ...state.ui.composition,
        text,
      },
    },
  };
};

export const endComposition = (state: EditorState): EditorState => ({
  ...state,
  ui: {
    ...state.ui,
    composition: null,
  },
});
