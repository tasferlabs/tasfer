import type { Block, Page } from "../deserializer/loadPage";
import type {
  CursorState,
  EditorMode,
  EditorState,
  EditorStyles,
  PartialSelectionState,
  Position,
  ViewportState,
} from "./types";

// State Creation Functions
export const createInitialState = (page: Page): EditorState => ({
  page,
  cursor: null,
  selection: null,
  mode: "edit" as EditorMode,
});

export const createInitialViewport = (
  width: number,
  height: number
): ViewportState => ({
  scrollY: 0,
  width,
  height,
  visibleBlocksStartIndex: 0,
  visibleBlocksEndIndex: 0,
});

// State Update Functions (Pure Functions)
export const updateCursor = (
  state: EditorState,
  position: Position | null
): EditorState => ({
  ...state,
  cursor: position
    ? {
        position,
        lastUpdate: Date.now(),
      }
    : null,
});

export const updateSelection = (
  state: EditorState,
  updates: PartialSelectionState | null
): EditorState => ({
  ...state,
  selection: !!updates
    ? {
        ...state.selection,
        anchor: updates.anchor,
        focus: updates.focus,
        isForward: isForwardSelection(updates),
        isCollapsed: isCollapsedSelection(updates),
        lastUpdate: Date.now(),
      }
    : null,
});

export const updateMode = (
  state: EditorState,
  mode: EditorMode
): EditorState => ({
  ...state,
  mode,
});

// Helper Functions

export const createInitialCursorState = (state: EditorState): EditorState => {
  return {
    ...state,
    cursor: {
      position: {
        blockIndex: 0,
        textIndex: 0,
      },
      lastUpdate: Date.now(),
    },
  };
};

export const getBlockTextLength = (block: Block): number => {
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
    Math.min(blockIndex, state.page.blocks.length - 1)
  );
  const block = state.page.blocks[clampedBlockIndex];

  if (!block) return state;

  const maxTextIndex = getBlockTextLength(block);
  const clampedTextIndex = Math.max(0, Math.min(textIndex, maxTextIndex));

  return updateCursor(state, {
    blockIndex: clampedBlockIndex,
    textIndex: clampedTextIndex,
  });
};

export const moveCursorLeft = (state: EditorState): EditorState => {
  if (!state.cursor) return createInitialCursorState(state);

  const { blockIndex, textIndex } = state.cursor.position;

  if (textIndex > 0) {
    return moveCursorToPosition(state, blockIndex, textIndex - 1);
  } else if (blockIndex > 0) {
    const prevBlock = state.page.blocks[blockIndex - 1];
    const prevBlockLength = getBlockTextLength(prevBlock);
    return moveCursorToPosition(state, blockIndex - 1, prevBlockLength);
  }

  return state;
};

export const moveCursorRight = (state: EditorState): EditorState => {
  if (!state.cursor) return createInitialCursorState(state);

  const { blockIndex, textIndex } = state.cursor.position;
  const currentBlock = state.page.blocks[blockIndex];

  if (!currentBlock) return state;

  const currentBlockLength = getBlockTextLength(currentBlock);

  if (textIndex < currentBlockLength) {
    return moveCursorToPosition(state, blockIndex, textIndex + 1);
  } else if (blockIndex < state.page.blocks.length - 1) {
    return moveCursorToPosition(state, blockIndex + 1, 0);
  }

  return state;
};

export const moveCursorUp = (state: EditorState): EditorState => {
  if (!state.cursor) return createInitialCursorState(state);

  const { blockIndex, textIndex } = state.cursor.position;

  if (blockIndex > 0) {
    return moveCursorToPosition(state, blockIndex - 1, textIndex);
  }

  return moveCursorToPosition(state, blockIndex, 0);
};

export const moveCursorDown = (state: EditorState): EditorState => {
  if (!state.cursor) return createInitialCursorState(state);

  const { blockIndex, textIndex } = state.cursor.position;

  if (blockIndex < state.page.blocks.length - 1) {
    return moveCursorToPosition(state, blockIndex + 1, textIndex);
  }

  const currentBlock = state.page.blocks[blockIndex];
  if (currentBlock) {
    const currentBlockLength = getBlockTextLength(currentBlock);
    return moveCursorToPosition(state, blockIndex, currentBlockLength);
  }

  return state;
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
  if (!state.selection) {
    return startSelection(state, position);
  }

  return updateSelection(state, {
    focus: position,
    anchor: state.selection.anchor,
    lastUpdate: Date.now(),
    isForward: isForwardSelection({
      anchor: state.selection.anchor,
      focus: position,
    }),
    isCollapsed: isCollapsedSelection({
      anchor: state.selection.anchor,
      focus: position,
    }),
  });
};

export const clearSelection = (state: EditorState): EditorState => {
  return updateSelection(state, null);
};
