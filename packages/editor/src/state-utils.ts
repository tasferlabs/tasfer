import { getCurrentFontFamily, measureCharsUpToIndex, wrapText } from "./fonts";
import {
  createInitialMomentumState,
  createInitialScrollbarState,
} from "./rendering/scrollbar";
import { getTextDirection } from "./rtl";
import type { Block, Page } from "./serlization/loadPage";
import { isListBlock, isTextualBlock } from "./serlization/loadPage";
import type {
  EditorMode,
  EditorState,
  EditorStyles,
  Position,
} from "./state-types";
import { getEditorStyles, getTextStyle } from "./styles";
import {
  charRunsToChars,
  getVisibleLengthFromRuns,
  getVisibleTextFromRuns,
  iterateVisibleChars,
} from "./sync/char-runs";
import { initialUndoManagerState } from "./sync/crdt-undo";
import { generatePeerId } from "./sync/id";
import { createCRDTbinding, getVisibleBlocks } from "./sync/sync";

// State Creation Functions
export function createInitialState(
  page: Page,
  options?: { mode?: EditorMode },
): EditorState {
  const peerId = generatePeerId();

  // Each editor instance owns its own CRDT context. Because the binding is
  // per-instance (not a module global), a readonly snapshot-preview editor can
  // coexist with the main editor on the same page without clobbering its
  // id/clock state — so we always create one, readonly or not.
  const CRDTbinding = createCRDTbinding(page.id, peerId);

  return {
    CRDTbinding,
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
      composition: null,
      activeFormatsMode: { type: "inherit" },
      imageHover: null,
      imageDrag: null,
      selectionHandleDrag: null,
      cursorDrag: null,
      autoCreatedParagraph: null,
      inlineMathHover: null,
      hoveredMathBlockIndex: null,
      search: { highlights: [], activeIndex: -1 },
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

export function snapInlineMathPosition(
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

/**
 * Get line information for a given position within a block
 * Returns the line index, line start/end indices, and total lines in the block
 */
export function getLineInfoAtPosition(
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
export function getTextIndexAtRelativePosition(
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
  const isRTL =
    getTextDirection(getVisibleTextFromRuns(block.charRuns)) === "rtl";

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
