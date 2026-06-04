import type { Block, Page } from "./deserializer/loadPage";
import { isListBlock, isTextualBlock } from "./deserializer/loadPage";
import { getCurrentFontFamily, measureCharsUpToIndex, wrapText } from "./fonts";
import { getCharsDirection } from "./rtl";
import {
  createInitialMomentumState,
  createInitialScrollbarState,
} from "./scrollbar";
import { getEditorStyles, getTextStyle } from "./styles";
import {
  charRunsToChars,
  getVisibleLengthFromRuns,
  getVisibleTextFromRuns,
  iterateVisibleChars,
} from "./sync/char-runs";
import { initialUndoManagerState } from "./sync/crdt-undo";
import { extractCounter, generatePeerId } from "./sync/id";
import {
  findNextVisibleBlockIndex,
  findPreviousVisibleBlockIndex,
} from "./sync/reducer";
import {
  advanceGlobalIdCounter,
  getVisibleBlocks,
  setCRDTContext,
} from "./sync/sync";
import type {
  CursorState,
  EditorMode,
  EditorState,
  EditorStyles,
  PartialSelectionState,
  Position,
  ViewportState,
} from "./types";

// =============================================================================
// Block ID Generation
// =============================================================================

// Centralized Counter
let blockIdCounter = 10000; // Start high to avoid conflicts with parsed blocks

/**
 * Generate a unique block ID.
 * Block IDs are generated in the CRDTContext passed to commands.
 * This is a fallback for non-CRDT contexts (e.g., initial page load).
 */
export function generateBlockId(): string {
  return `block-${blockIdCounter++}`;
}

// State Creation Functions
export function createInitialState(
  page: Page,
  options?: { mode?: EditorMode },
): EditorState {
  const peerId = generatePeerId();

  // Only initialize the global CRDT context for editable editors.
  // Readonly editors (e.g. snapshot previews) never generate operations,
  // and calling setCRDTContext here would overwrite the main editor's
  // context — causing restore operations to get wrong pageId, peerId,
  // and HLC clocks near zero, which breaks op ordering and convergence.
  if (options?.mode !== "readonly") {
    setCRDTContext(page.id, peerId);
    // Bump the id-counter past every block / char counter present in the
    // loaded page so the next op we emit (e.g. user presses Enter to split
    // a block) out-counters its pre-existing siblings. Without this the
    // RGA sibling sort — counter-first via compareIds — places our fresh
    // low-counter inserts AFTER everything loaded, which materialises as
    // "the second half of a split jumps to the end of the page" and
    // "characters typed mid-block jump to the end".
    let maxCounter = 0;
    for (const block of page.blocks) {
      const blockCounter = extractCounter(block.id);
      if (blockCounter > maxCounter) maxCounter = blockCounter;
      if (isTextualBlock(block)) {
        for (const run of block.charRuns) {
          const lastCounter = run.startCounter + run.text.length - 1;
          if (lastCounter > maxCounter) maxCounter = lastCounter;
        }
      }
    }
    advanceGlobalIdCounter(maxCounter);
  }

  return {
    document: {
      page,
      cursor: null,
      selection: null,
    },
    ui: {
      mode: (options?.mode ?? "edit") as EditorMode,
      isReadonlyBase: options?.mode === "readonly",
      activeMenu: { type: "none" },
      isHoveringLinkWithModifier: false,
      isHoveringCheckbox: false,
      isHoveringPeerIndicator: false,
      inlineMathHover: null,
      hoveredMathBlockIndex: null,
      composition: null,
      activeFormatsMode: { type: "inherit" },
      imageHover: null,
      imageDrag: null,
      selectionHandleDrag: null,
      cursorDrag: null,
      autoCreatedParagraph: null,
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
      hasPhysicalKeyboard: false, // Default to false, will be updated by native
      visibleBlocks: getVisibleBlocks(page),
    },
    undoManager: initialUndoManagerState,
  };
}

// State Update Functions (Pure Functions)
export function updateCursor(
  state: EditorState,
  position: Position | null,
): EditorState {
  return {
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
  };
}

export function updateSelection(
  state: EditorState,
  updates: PartialSelectionState | null,
): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      selection: !!updates
        ? {
            anchor: updates.anchor,
            focus: updates.focus,
            isForward: isForwardSelection(updates),
            isCollapsed: isCollapsedSelection(updates),
            lastUpdate: Date.now(),
            // Only preserve initialBoundary if explicitly provided in updates
            // This prevents unintentional preservation of gesture boundaries in programmatic selections
            ...("initialBoundary" in updates && updates.initialBoundary !== null
              ? { initialBoundary: updates.initialBoundary }
              : {}),
          }
        : null,
    },
  };
}

export function updateMode(state: EditorState, mode: EditorMode): EditorState {
  // If editor was initialized as readonly, enforce readonly behavior
  if (state.ui.isReadonlyBase) {
    // Allow switching to "select" for drag selection, or "locked"
    if (mode === "select" || mode === "locked") {
      return {
        ...state,
        ui: { ...state.ui, mode },
      };
    }
    // When trying to go to "edit", return to "readonly" instead
    if (mode === "edit") {
      return {
        ...state,
        ui: { ...state.ui, mode: "readonly" },
      };
    }
    return state;
  }
  return {
    ...state,
    ui: { ...state.ui, mode },
  };
}

export function updateFocus(
  state: EditorState,
  isFocused: boolean,
): EditorState {
  const newState: EditorState = {
    ...state,
    view: { ...state.view, isFocused },
  };

  // When losing focus, cancel any active composition
  if (!isFocused && state.ui.composition) {
    return {
      ...newState,
      ui: {
        ...newState.ui,
        composition: null,
      },
    };
  }

  return newState;
}

export function updatePhysicalKeyboardState(
  state: EditorState,
  hasPhysicalKeyboard: boolean,
): EditorState {
  return {
    ...state,
    view: { ...state.view, hasPhysicalKeyboard },
  };
}

// Helper Functions

export function createInitialCursorState(state: EditorState): EditorState {
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
}

export function getBlockTextLength(block: Block): number {
  if (!block) return 0;

  if (!isTextualBlock(block)) return 0;

  return getVisibleLengthFromRuns(block.charRuns);
}

export function getBlockTextContent(block: Block): string {
  if (!block) return "";

  if (!isTextualBlock(block)) return "";

  // Get visible text from charRuns
  return getVisibleTextFromRuns(block.charRuns);
}

export function isForwardSelection(selection: PartialSelectionState): boolean {
  return (
    selection.anchor.blockIndex < selection.focus.blockIndex ||
    (selection.anchor.blockIndex === selection.focus.blockIndex &&
      selection.anchor.textIndex <= selection.focus.textIndex)
  );
}

export function isCollapsedSelection(
  selection: PartialSelectionState,
): boolean {
  return (
    selection.anchor.blockIndex === selection.focus.blockIndex &&
    selection.anchor.textIndex === selection.focus.textIndex
  );
}

export function isCursorBlinking(cursor: CursorState, styles: EditorStyles) {
  const now = Date.now();

  // If the cursor was recently updated (within one blink interval), always show it
  if (now - cursor.lastUpdate < styles.cursor.blinkInterval) {
    return false;
  }

  // Otherwise, blink based on time (alternating every blinkInterval)
  return Math.floor(now / styles.cursor.blinkInterval) % 2 !== 0;
}

/**
 * Inline math is stored as a tagged run of characters but is treated as a
 * single atomic chip in the editor. Caret positions inside the chip are
 * disallowed — this helper snaps a candidate visible-index past the chip in
 * the requested logical direction.
 *
 * Returns the snapped index, or the original index if it did not fall inside
 * an inline-math span.
 */
/**
 * If a cursor move went from one boundary of an inline-math span to the
 * opposite boundary (i.e. the snap fired and we crossed the chip), return the
 * span. Used to open the inline-math editor popover when arrow-keying inbound.
 */
export function getCrossedInlineMathSpan(
  block: Block,
  prevTextIndex: number,
  newTextIndex: number,
): { startIndex: number; endIndex: number; latex: string } | null {
  if (!isTextualBlock(block)) return null;

  const visibleIds: string[] = [];
  const visibleChars: string[] = [];
  for (const { id, char } of iterateVisibleChars(block.charRuns)) {
    visibleIds.push(id);
    visibleChars.push(char);
  }

  for (const span of block.formats) {
    if (span.format.type !== "math") continue;
    const startIdx = visibleIds.indexOf(span.startCharId);
    const endIdx = visibleIds.indexOf(span.endCharId);
    if (startIdx === -1 || endIdx === -1) continue;

    const spanStart = startIdx;
    const spanEnd = endIdx + 1;

    if (
      (prevTextIndex === spanStart && newTextIndex === spanEnd) ||
      (prevTextIndex === spanEnd && newTextIndex === spanStart)
    ) {
      return {
        startIndex: spanStart,
        endIndex: spanEnd,
        latex: visibleChars.slice(spanStart, spanEnd).join(""),
      };
    }
  }

  return null;
}

function snapInlineMathPosition(
  block: Block,
  textIndex: number,
  direction: "left" | "right",
): number {
  if (!isTextualBlock(block)) return textIndex;

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

    if (textIndex > spanStart && textIndex < spanEnd) {
      return direction === "left" ? spanStart : spanEnd;
    }
  }

  return textIndex;
}

// Cursor Movement Functions
export function moveCursorToPosition(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
  preserveActiveFormats: boolean = false,
): EditorState {
  const allBlocks = state.document.page.blocks;
  if (allBlocks.length === 0) return state;

  const clampedBlockIndex = Math.max(
    0,
    Math.min(blockIndex, allBlocks.length - 1),
  );
  const block = allBlocks[clampedBlockIndex];

  if (!block || block.deleted) return state;

  const maxTextIndex = getBlockTextLength(block);
  const clampedTextIndex = Math.max(0, Math.min(textIndex, maxTextIndex));

  let newState = updateCursor(state, {
    blockIndex: clampedBlockIndex,
    textIndex: clampedTextIndex,
  });

  // Clear active formats when cursor moves (unless explicitly preserving them, e.g., during typing)
  if (
    !preserveActiveFormats &&
    newState.ui.activeFormatsMode.type === "explicit"
  ) {
    newState = {
      ...newState,
      ui: {
        ...newState.ui,
        activeFormatsMode: { type: "inherit" },
      },
    };
  }

  return newState;
}

export function moveCursorLeft(state: EditorState): EditorState {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex: blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock || currentBlock.deleted) return state;

  // Handle visual blocks (image/line) - move to previous block
  if (!isTextualBlock(currentBlock)) {
    const prevBlockIndex = findPreviousVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );
    if (prevBlockIndex !== null) {
      const prevBlock = state.document.page.blocks[prevBlockIndex];
      if (!isTextualBlock(prevBlock)) {
        return moveCursorToPosition(state, prevBlockIndex, 0);
      } else if (isTextualBlock(prevBlock)) {
        const prevBlockLength = getBlockTextLength(prevBlock);
        return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
      }
    }
    return state;
  }

  if (!isTextualBlock(currentBlock)) {
    return state;
  }

  // Check if current block is RTL
  const isRTL = getCharsDirection(currentBlock.charRuns) === "rtl";

  if (isRTL) {
    // In RTL text, visual left is logical forward (increment)
    const currentBlockLength = getBlockTextLength(currentBlock);

    if (textIndex < currentBlockLength) {
      const snapped = snapInlineMathPosition(
        currentBlock,
        textIndex + 1,
        "right",
      );
      return moveCursorToPosition(state, blockIndex, snapped);
    } else {
      // Moving to next visible block
      const nextBlockIndex = findNextVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (nextBlockIndex !== null) {
        const nextBlock = state.document.page.blocks[nextBlockIndex];

        // Handle visual blocks (image/line) - move to the block
        if (!isTextualBlock(nextBlock)) {
          return moveCursorToPosition(state, nextBlockIndex, 0);
        }

        if (!isTextualBlock(nextBlock)) {
          return state;
        }
        const nextIsRTL = getCharsDirection(nextBlock.charRuns) === "rtl";

        if (nextIsRTL) {
          // Next block is RTL, position at start (visual right edge)
          return moveCursorToPosition(state, nextBlockIndex, 0);
        } else {
          // Next block is LTR, position at start (visual left edge)
          return moveCursorToPosition(state, nextBlockIndex, 0);
        }
      }
    }
  } else {
    // LTR text: visual left is logical backward (decrement)
    if (textIndex > 0) {
      const snapped = snapInlineMathPosition(
        currentBlock,
        textIndex - 1,
        "left",
      );
      return moveCursorToPosition(state, blockIndex, snapped);
    } else {
      // Moving to previous visible block
      const prevBlockIndex = findPreviousVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (prevBlockIndex !== null) {
        const prevBlock = state.document.page.blocks[prevBlockIndex];

        // Handle visual blocks (image/line) - move to the block
        if (!isTextualBlock(prevBlock)) {
          return moveCursorToPosition(state, prevBlockIndex, 0);
        }

        if (!isTextualBlock(prevBlock)) {
          return state;
        }
        const prevBlockLength = getBlockTextLength(prevBlock);
        const prevIsRTL = getCharsDirection(prevBlock.charRuns) === "rtl";

        if (prevIsRTL) {
          // Previous block is RTL, position at end (visual left edge)
          return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
        } else {
          // Previous block is LTR, position at end (visual right edge)
          return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
        }
      }
    }
  }

  return state;
}

export function moveCursorRight(state: EditorState): EditorState {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex: blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock || currentBlock.deleted) return state;

  // Handle visual blocks (image/line) - move to next block
  if (!isTextualBlock(currentBlock)) {
    const nextBlockIndex = findNextVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );
    if (nextBlockIndex !== null) {
      const nextBlock = state.document.page.blocks[nextBlockIndex];
      if (!isTextualBlock(nextBlock)) {
        return moveCursorToPosition(state, nextBlockIndex, 0);
      } else if (isTextualBlock(nextBlock)) {
        return moveCursorToPosition(state, nextBlockIndex, 0);
      }
    }
    return state;
  }

  if (!isTextualBlock(currentBlock)) {
    return state;
  }

  const currentBlockLength = getBlockTextLength(currentBlock);

  // Check if current block is RTL
  const isRTL = getCharsDirection(currentBlock.charRuns) === "rtl";

  if (isRTL) {
    // In RTL text, visual right is logical backward (decrement)
    if (textIndex > 0) {
      const snapped = snapInlineMathPosition(
        currentBlock,
        textIndex - 1,
        "left",
      );
      return moveCursorToPosition(state, blockIndex, snapped);
    } else {
      // Moving to previous visible block
      const prevBlockIndex = findPreviousVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (prevBlockIndex !== null) {
        const prevBlock = state.document.page.blocks[prevBlockIndex];

        // Handle visual blocks (image/line) - move to the block
        if (!isTextualBlock(prevBlock)) {
          return moveCursorToPosition(state, prevBlockIndex, 0);
        }

        if (!isTextualBlock(prevBlock)) {
          return state;
        }
        const prevBlockLength = getBlockTextLength(prevBlock);
        const prevIsRTL = getCharsDirection(prevBlock.charRuns) === "rtl";

        if (prevIsRTL) {
          // Previous block is RTL, position at end (visual left edge)
          return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
        } else {
          // Previous block is LTR, position at end (visual right edge)
          return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
        }
      }
    }
  } else {
    // LTR text: visual right is logical forward (increment)
    if (textIndex < currentBlockLength) {
      const snapped = snapInlineMathPosition(
        currentBlock,
        textIndex + 1,
        "right",
      );
      return moveCursorToPosition(state, blockIndex, snapped);
    } else {
      // Moving to next visible block
      const nextBlockIndex = findNextVisibleBlockIndex(
        state.document.page.blocks,
        blockIndex,
      );
      if (nextBlockIndex !== null) {
        const nextBlock = state.document.page.blocks[nextBlockIndex];

        // Handle visual blocks (image/line) - move to the block
        if (!isTextualBlock(nextBlock)) {
          return moveCursorToPosition(state, nextBlockIndex, 0);
        }

        if (!isTextualBlock(nextBlock)) {
          return state;
        }
        const nextIsRTL = getCharsDirection(nextBlock.charRuns) === "rtl";

        if (nextIsRTL) {
          // Next block is RTL, position at start (visual right edge)
          return moveCursorToPosition(state, nextBlockIndex, 0);
        } else {
          // Next block is LTR, position at start (visual left edge)
          return moveCursorToPosition(state, nextBlockIndex, 0);
        }
      }
    }
  }

  return state;
}

/**
 * Get line information for a given position within a block
 * Returns the line index, line start/end indices, and total lines in the block
 */
function getLineInfoAtPosition(
  block: Block,
  textIndex: number,
  maxWidth: number,
  styles: EditorStyles = getEditorStyles(),
): {
  lineIndex: number;
  lineStartIndex: number;
  lineEndIndex: number;
  totalLines: number;
  lines: string[];
} | null {
  if (!isTextualBlock(block)) {
    return null;
  }

  const textStyle = getTextStyle(styles, block.type);
  const fontFamily = getCurrentFontFamily();
  const codePadding = styles.textFormats.code.padding;

  // Calculate adjusted max width for list blocks
  let adjustedMaxWidth = maxWidth;
  if (isListBlock(block)) {
    const indent = block.indent || 0;
    const indentOffset = indent * styles.list.indent.size;
    const markerWidth =
      styles.list.numbered.minWidth + styles.list.marker.textGap;
    adjustedMaxWidth = maxWidth - indentOffset - markerWidth;
  }

  const wrappedLines = wrapText(
    charRunsToChars(block.charRuns),
    block.formats,
    adjustedMaxWidth,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    codePadding,
  );

  let currentTextIndex = 0;
  for (let lineIndex = 0; lineIndex < wrappedLines.length; lineIndex++) {
    const wrappedLine = wrappedLines[lineIndex];
    const line = wrappedLine.text;
    const lineStartIndex = currentTextIndex;
    const lineEndIndex = currentTextIndex + line.length;

    if (textIndex >= lineStartIndex && textIndex <= lineEndIndex) {
      return {
        lineIndex,
        lineStartIndex,
        lineEndIndex,
        totalLines: wrappedLines.length,
        lines: wrappedLines.map((wl) => wl.text),
      };
    }

    currentTextIndex += line.length;
    // Account for the space character consumed during text wrapping
    if (wrappedLine.consumedSpace) {
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
  styles?: EditorStyles,
): number {
  // If no block info provided, use simple logical positioning
  if (!block || !maxWidth || !styles) {
    const lineLength = lineEndIndex - lineStartIndex;
    const targetIndex = lineStartIndex + Math.min(relativePosition, lineLength);
    return targetIndex;
  }

  if (!isTextualBlock(block)) {
    const lineLength = lineEndIndex - lineStartIndex;
    return lineStartIndex + Math.min(relativePosition, lineLength);
  }

  // Check if this is RTL text
  const isRTL = getCharsDirection(block.charRuns) === "rtl";

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
    const widthFromStart = measureCharsUpToIndex(
      block.charRuns,
      block.formats,
      lineStartIndex,
      charIndex,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      codePadding,
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
export function moveCursorUp(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(),
): EditorState {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex: blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock || currentBlock.deleted) return state;

  // Handle visual blocks (image/line) - move to previous block
  if (!isTextualBlock(currentBlock)) {
    const prevBlockIndex = findPreviousVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );
    if (prevBlockIndex !== null) {
      const prevBlock = state.document.page.blocks[prevBlockIndex];
      if (!isTextualBlock(prevBlock)) {
        // Move to previous visual block
        return moveCursorToPosition(state, prevBlockIndex, 0);
      } else if (isTextualBlock(prevBlock)) {
        // Move to end of previous text block
        const prevBlockLength = getBlockTextLength(prevBlock);
        return moveCursorToPosition(state, prevBlockIndex, prevBlockLength);
      }
    }
    return state;
  }

  // Calculate maxWidth from viewport or use a default
  const maxWidth = viewport
    ? viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight)
    : 800; // Default fallback

  const lineInfo = getLineInfoAtPosition(
    currentBlock,
    textIndex,
    maxWidth,
    styles,
  );

  if (!lineInfo) return state;

  if (!isTextualBlock(currentBlock)) {
    return state;
  }

  // For RTL text, calculate visual position instead of logical position
  const isRTL = getCharsDirection(currentBlock.charRuns) === "rtl";
  let relativePosition: number;

  if (isRTL) {
    // Calculate visual position from the left edge of the line
    // For RTL: cursor at logical index 0 appears at RIGHT, cursor at index N appears at LEFT
    const textStyle = getTextStyle(styles, currentBlock.type);
    const fontFamily = getCurrentFontFamily();
    const codePadding = styles.textFormats.code.padding;

    // Measure from line start to cursor position
    const widthFromStart = measureCharsUpToIndex(
      currentBlock.charRuns,
      currentBlock.formats,
      lineInfo.lineStartIndex,
      textIndex,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      codePadding,
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
      styles,
    );

    return moveCursorToPosition(state, blockIndex, targetTextIndex);
  }

  // On the first line of the block, move to the previous block's last line
  const prevBlockIndex = findPreviousVisibleBlockIndex(
    state.document.page.blocks,
    blockIndex,
  );
  if (prevBlockIndex !== null) {
    const prevBlock = state.document.page.blocks[prevBlockIndex];

    // Handle visual blocks (image/line) - position cursor at start of the block
    if (!isTextualBlock(prevBlock)) {
      return moveCursorToPosition(state, prevBlockIndex, 0);
    }

    if (!isTextualBlock(prevBlock)) {
      return state;
    }
    const prevTextStyle = getTextStyle(styles, prevBlock.type);
    const fontFamily = getCurrentFontFamily();
    const codePadding = styles.textFormats.code.padding;

    const prevLines = wrapText(
      charRunsToChars(prevBlock.charRuns),
      prevBlock.formats,
      maxWidth,
      prevTextStyle.fontSize,
      prevTextStyle.fontWeight,
      fontFamily,
      codePadding,
    );

    if (prevLines.length > 0) {
      // Calculate the start index of the last line in the previous block
      let lastLineStartIndex = 0;
      for (let i = 0; i < prevLines.length - 1; i++) {
        lastLineStartIndex += prevLines[i].text.length;
        if (prevLines[i].consumedSpace) {
          lastLineStartIndex += 1; // Account for consumed space
        }
      }

      const lastWrappedLine = prevLines[prevLines.length - 1];
      const lastLine = lastWrappedLine.text;
      const lastLineEndIndex = lastLineStartIndex + lastLine.length;
      const targetTextIndex = getTextIndexAtRelativePosition(
        lastLineStartIndex,
        lastLineEndIndex,
        relativePosition,
        prevBlock,
        maxWidth,
        styles,
      );

      return moveCursorToPosition(state, prevBlockIndex, targetTextIndex);
    }

    // If previous block is empty, just go to its start
    return moveCursorToPosition(state, prevBlockIndex, 0);
  }

  // Already at the first line of the first block, move to start
  return moveCursorToPosition(state, blockIndex, 0);
}

/**
 * Move cursor down by one line (not block)
 * If on the last line of a block, moves to the first line of the next block
 */
export function moveCursorDown(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(),
): EditorState {
  if (!state.document.cursor) return createInitialCursorState(state);

  const { blockIndex: blockIndex, textIndex } = state.document.cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];

  if (!currentBlock || currentBlock.deleted) return state;

  // Handle visual blocks (image/line) - move to next block
  if (!isTextualBlock(currentBlock)) {
    const nextBlockIndex = findNextVisibleBlockIndex(
      state.document.page.blocks,
      blockIndex,
    );
    if (nextBlockIndex !== null) {
      const nextBlock = state.document.page.blocks[nextBlockIndex];
      if (!isTextualBlock(nextBlock)) {
        // Move to next visual block
        return moveCursorToPosition(state, nextBlockIndex, 0);
      } else if (isTextualBlock(nextBlock)) {
        // Move to start of next text block
        return moveCursorToPosition(state, nextBlockIndex, 0);
      }
    }
    return state;
  }

  // Calculate maxWidth from viewport or use a default
  const maxWidth = viewport
    ? viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight)
    : 800; // Default fallback

  const lineInfo = getLineInfoAtPosition(
    currentBlock,
    textIndex,
    maxWidth,
    styles,
  );

  if (!lineInfo) return state;

  if (!isTextualBlock(currentBlock)) {
    return state;
  }

  // For RTL text, calculate visual position instead of logical position
  const isRTL = getCharsDirection(currentBlock.charRuns) === "rtl";
  let relativePosition: number;

  if (isRTL) {
    // Calculate visual position from the left edge of the line
    // For RTL: cursor at logical index 0 appears at RIGHT, cursor at index N appears at LEFT
    const textStyle = getTextStyle(styles, currentBlock.type);
    const fontFamily = getCurrentFontFamily();
    const codePadding = styles.textFormats.code.padding;

    // Measure from line start to cursor position
    const widthFromStart = measureCharsUpToIndex(
      currentBlock.charRuns,
      currentBlock.formats,
      lineInfo.lineStartIndex,
      textIndex,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      codePadding,
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
      styles,
    );

    return moveCursorToPosition(state, blockIndex, targetTextIndex);
  }

  // On the last line of the block, move to the next block's first line
  const nextBlockIndex = findNextVisibleBlockIndex(
    state.document.page.blocks,
    blockIndex,
  );
  if (nextBlockIndex !== null) {
    const nextBlock = state.document.page.blocks[nextBlockIndex];

    // Handle visual blocks (image/line) - position cursor at start of the block
    if (!isTextualBlock(nextBlock)) {
      return moveCursorToPosition(state, nextBlockIndex, 0);
    }

    if (!isTextualBlock(nextBlock)) {
      return state;
    }
    const nextTextStyle = getTextStyle(styles, nextBlock.type);
    const fontFamily = getCurrentFontFamily();
    const codePadding = styles.textFormats.code.padding;

    const nextLines = wrapText(
      charRunsToChars(nextBlock.charRuns),
      nextBlock.formats,
      maxWidth,
      nextTextStyle.fontSize,
      nextTextStyle.fontWeight,
      fontFamily,
      codePadding,
    );

    if (nextLines.length > 0) {
      const firstWrappedLine = nextLines[0];
      const firstLine = firstWrappedLine.text;
      const targetTextIndex = getTextIndexAtRelativePosition(
        0,
        firstLine.length,
        relativePosition,
        nextBlock,
        maxWidth,
        styles,
      );

      return moveCursorToPosition(state, nextBlockIndex, targetTextIndex);
    }

    // If next block is empty, just go to its start
    return moveCursorToPosition(state, nextBlockIndex, 0);
  }

  // Already at the last line of the last block, move to end
  const currentBlockLength = getBlockTextLength(currentBlock);
  return moveCursorToPosition(state, blockIndex, currentBlockLength);
}

/**
 * Move cursor up by one page
 * Moves the cursor up by approximately one viewport height
 */
export function moveCursorPageUp(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(),
): EditorState {
  if (!state.document.cursor || !viewport) return state;

  // Move up by viewport height worth of lines
  // Estimate ~10-20 lines per page depending on font size
  const linesToMove = Math.floor(viewport.height / 30); // Approximate line height

  let newState = state;
  for (let i = 0; i < linesToMove && newState.document.cursor; i++) {
    newState = moveCursorUp(newState, viewport, styles);
  }

  return newState;
}

/**
 * Move cursor down by one page
 * Moves the cursor down by approximately one viewport height
 */
export function moveCursorPageDown(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(),
): EditorState {
  if (!state.document.cursor || !viewport) return state;

  // Move down by viewport height worth of lines
  // Estimate ~10-20 lines per page depending on font size
  const linesToMove = Math.floor(viewport.height / 30); // Approximate line height

  let newState = state;
  for (let i = 0; i < linesToMove && newState.document.cursor; i++) {
    newState = moveCursorDown(newState, viewport, styles);
  }

  return newState;
}

// Selection Functions
export function startSelection(
  state: EditorState,
  position: Position,
): EditorState {
  // Clear active formats when starting a selection
  let newState = state;
  if (state.ui.activeFormatsMode.type === "explicit") {
    newState = {
      ...state,
      ui: {
        ...state.ui,
        activeFormatsMode: { type: "inherit" },
      },
    };
  }

  return updateSelection(newState, {
    anchor: position,
    focus: position,
    isForward: true,
    isCollapsed: true,
  });
}

export function updateSelectionFocus(
  state: EditorState,
  position: Position,
): EditorState {
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
}

export function clearSelection(state: EditorState): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      selection: null,
    },
  };
}

// Selection Extension Functions (for Shift+Arrow keys)
export function extendSelectionLeft(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const leftState = moveCursorLeft(newState);
    if (leftState.document.cursor) {
      return updateSelectionFocus(
        leftState,
        leftState.document.cursor.position,
      );
    }
    return newState;
  }

  // Extend existing selection
  const leftState = moveCursorLeft(state);
  if (leftState.document.cursor) {
    return updateSelectionFocus(leftState, leftState.document.cursor.position);
  }
  return state;
}

export function extendSelectionRight(state: EditorState): EditorState {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const rightState = moveCursorRight(newState);
    if (rightState.document.cursor) {
      return updateSelectionFocus(
        rightState,
        rightState.document.cursor.position,
      );
    }
    return newState;
  }

  // Extend existing selection
  const rightState = moveCursorRight(state);
  if (rightState.document.cursor) {
    return updateSelectionFocus(
      rightState,
      rightState.document.cursor.position,
    );
  }
  return state;
}

export function extendSelectionUp(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(),
): EditorState {
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
}

export function extendSelectionDown(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(),
): EditorState {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const downState = moveCursorDown(newState, viewport, styles);
    if (downState.document.cursor) {
      return updateSelectionFocus(
        downState,
        downState.document.cursor.position,
      );
    }
    return newState;
  }

  // Extend existing selection
  const downState = moveCursorDown(state, viewport, styles);
  if (downState.document.cursor) {
    return updateSelectionFocus(downState, downState.document.cursor.position);
  }
  return state;
}

export function extendSelectionPageUp(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(),
): EditorState {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const pageUpState = moveCursorPageUp(newState, viewport, styles);
    if (pageUpState.document.cursor) {
      return updateSelectionFocus(
        pageUpState,
        pageUpState.document.cursor.position,
      );
    }
    return newState;
  }

  // Extend existing selection
  const pageUpState = moveCursorPageUp(state, viewport, styles);
  if (pageUpState.document.cursor) {
    return updateSelectionFocus(
      pageUpState,
      pageUpState.document.cursor.position,
    );
  }
  return state;
}

export function extendSelectionPageDown(
  state: EditorState,
  viewport?: ViewportState,
  styles: EditorStyles = getEditorStyles(),
): EditorState {
  if (!state.document.cursor) return state;

  // If no selection exists, start one at current cursor position
  if (!state.document.selection) {
    const newState = startSelection(state, state.document.cursor.position);
    const pageDownState = moveCursorPageDown(newState, viewport, styles);
    if (pageDownState.document.cursor) {
      return updateSelectionFocus(
        pageDownState,
        pageDownState.document.cursor.position,
      );
    }
    return newState;
  }

  // Extend existing selection
  const pageDownState = moveCursorPageDown(state, viewport, styles);
  if (pageDownState.document.cursor) {
    return updateSelectionFocus(
      pageDownState,
      pageDownState.document.cursor.position,
    );
  }
  return state;
}

// Slash Command State Management
export function openSlashCommand(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
): EditorState {
  return setActiveMenu(state, {
    type: "slashCommand",
    blockIndex,
    textIndex,
    filter: "",
    selectedIndex: 0,
  });
}

export function updateSlashCommandFilter(
  state: EditorState,
  filter: string,
): EditorState {
  if (state.ui.activeMenu.type !== "slashCommand") return state;
  return setActiveMenu(state, {
    ...state.ui.activeMenu,
    filter,
    selectedIndex: 0, // Reset selection when filter changes
  });
}

export function updateSlashCommandSelection(
  state: EditorState,
  selectedIndex: number,
): EditorState {
  if (state.ui.activeMenu.type !== "slashCommand") return state;
  return setActiveMenu(state, {
    ...state.ui.activeMenu,
    selectedIndex,
  });
}

export function closeSlashCommand(state: EditorState): EditorState {
  return closeActiveMenu(state);
}

// Context Menu State Management
export function openContextMenu(
  state: EditorState,
  x: number,
  y: number,
  hoveredItemId?: string | null,
): EditorState {
  return setActiveMenu(state, { type: "contextMenu", x, y, hoveredItemId });
}

export function closeContextMenu(state: EditorState): EditorState {
  return closeActiveMenu(state);
}

export function updateContextMenuHover(
  state: EditorState,
  hoveredItemId: string | null,
): EditorState {
  if (state.ui.activeMenu.type !== "contextMenu") return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      activeMenu: {
        ...state.ui.activeMenu,
        hoveredItemId,
      },
    },
  };
}

export function selectContextMenuItem(
  state: EditorState,
  selectedItemId: string,
): EditorState {
  if (state.ui.activeMenu.type !== "contextMenu") return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      activeMenu: {
        ...state.ui.activeMenu,
        selectedItemId,
      },
    },
  };
}

// Link Hover State Management
export function setLinkHover(
  state: EditorState,
  linkHover: {
    position: Position;
    url: string;
    text: string;
    x: number;
    y: number;
    startIndex: number;
    endIndex: number;
  } | null,
): EditorState {
  return linkHover
    ? setActiveMenu(state, {
        type: "linkHover",
        position: linkHover.position,
        url: linkHover.url,
        text: linkHover.text,
        x: linkHover.x,
        y: linkHover.y,
        startIndex: linkHover.startIndex,
        endIndex: linkHover.endIndex,
      })
    : closeActiveMenu(state);
}

// Unified Menu Management
export function setActiveMenu(
  state: EditorState,
  menu: EditorState["ui"]["activeMenu"],
): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      activeMenu: menu,
    },
  };
}

export function closeActiveMenu(state: EditorState): EditorState {
  return setActiveMenu(state, { type: "none" });
}

// Clear auto-created paragraph tracking
export function clearAutoCreatedParagraph(state: EditorState): EditorState {
  if (!state.ui.autoCreatedParagraph) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      autoCreatedParagraph: null,
    },
  };
}

// Composition (IME) State Management
export function startComposition(
  state: EditorState,
  text: string,
  startPosition: Position,
): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        isComposing: true,
        text,
        startPosition,
        cursorOffset: text.length,
      },
    },
  };
}

export function updateComposition(
  state: EditorState,
  text: string,
): EditorState {
  if (!state.ui.composition) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        ...state.ui.composition,
        text,
        cursorOffset: Math.min(state.ui.composition.cursorOffset, text.length),
      },
    },
  };
}

export function endComposition(state: EditorState): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: null,
    },
  };
}

// Detect if device has touch support
export function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
}

/**
 * Heuristic detection for physical keyboard (used as fallback)
 * This is not 100% reliable but works in most cases
 */
export function detectPhysicalKeyboardHeuristic(): boolean {
  if (typeof window === "undefined") return false;

  // Check if this is a touch device first
  const isTouch = isTouchDevice();
  if (!isTouch) {
    // Non-touch devices always have a keyboard
    return true;
  }

  // For touch devices, use heuristics to detect physical keyboard
  // Method 1: Check for fine pointer (mouse/trackpad) which often indicates keyboard setup
  const hasFinePointer = window.matchMedia("(pointer: fine)").matches;

  // Method 2: Check if the device is a tablet in landscape mode with large screen
  // iPads with keyboards are often in landscape and have larger width
  const isLandscape = window.innerWidth > window.innerHeight;
  const isLargeScreen = window.innerWidth > 768;

  // Combine heuristics
  const hasKeyboardHeuristic = hasFinePointer || (isLandscape && isLargeScreen);

  return hasKeyboardHeuristic;
}
