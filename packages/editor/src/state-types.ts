import type { MomentumState, ScrollbarState } from "./rendering/scrollbar";
import type { Block, Page, TextFormat } from "./serlization/loadPage";
import type { HLC, Operation } from "./sync/crdt-types";
import type { ReactElement } from "react";

/**
 * A font family key. Opaque string chosen by the host application — the editor
 * does not assume any particular fonts exist. Keys are mapped to CSS
 * font-stacks via `EditorStyles.fonts.families`.
 */
export type FontFamily = string;
export interface SlashCommand {
  id: string;
  type: Block["type"];
  label: string;
  description: string;
  icon: string | ReactElement; //NOTE -  add perdeps, but the project should be headless no opninion about ui.
  keywords?: string[];
}
// Editor State Types
export interface ClickTracker {
  count: number;
  lastClickTime: number;
  lastClickPosition: { x: number; y: number } | null;
}

export interface ContextMenuState {
  readonly x: number;
  readonly y: number;
}

export interface LinkHoverState {
  readonly position: Position;
  readonly url: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly segmentIndex: number;
}

// Unified menu system - only one menu can be active at a time
export type ActiveMenu =
  | { type: "none" }
  | {
      type: "slashCommand";
      blockIndex: number;
      textIndex: number;
      filter: string;
      selectedIndex: number;
    }
  | {
      type: "contextMenu";
      x: number;
      y: number;
      hoveredItemId?: string | null;
      selectedItemId?: string | null;
    }
  | {
      type: "linkHover";
      position: Position;
      url: string;
      text: string;
      x: number;
      y: number;
      startIndex: number;
      endIndex: number;
    }
  | {
      type: "linkEdit";
      position: Position;
      url: string;
      text: string;
      x: number;
      y: number;
      startIndex: number;
      endIndex: number;
    }
  | {
      type: "imageUpload";
      blockIndex: number;
      x: number;
      y: number;
      uploadStatus?: "uploading" | "complete" | "error";
    }
  | {
      type: "mathEdit";
      blockIndex: number;
      x: number;
      y: number;
    }
  | {
      type: "inlineMathEdit";
      blockIndex: number;
      startIndex: number;
      endIndex: number;
      latex: string;
      x: number;
      y: number;
    };

// Document State - Only this goes in undo/redo
export interface DocumentState {
  readonly page: Page;
  readonly cursor: CursorState | null;
  readonly selection: SelectionState | null;
}

// Composition State - IME input composition tracking
export interface CompositionState {
  readonly isComposing: boolean;
  readonly text: string;
  readonly startPosition: Position;
  readonly cursorOffset: number; // Cursor position within composition text
}

// Active formats mode for typing
export type ActiveFormatsMode =
  | { type: "inherit" } // Inherit formatting from previous character (normal typing)
  | { type: "explicit"; formats: readonly TextFormat[] }; // Explicit formatting mode (Ctrl+B toggled on/off)

// Drag handle position on an image
export type DragHandlePosition = "left" | "right" | "bottom" | null;

// Drag state for image resize
export interface ImageDragState {
  readonly blockIndex: number;
  readonly handle: DragHandlePosition;
  readonly startX: number;
  readonly startY: number;
  readonly startWidth: number | "full";
  readonly startHeight: number;
  readonly startObjectFit: "cover" | "contain";
}

// Drag state for selection handle (mobile text selection)
export interface SelectionHandleDragState {
  readonly handleType: "anchor" | "focus";
  readonly startX: number;
  readonly startY: number;
}

// Cursor drag state for mobile cursor repositioning with magnifier
export interface CursorDragState {
  readonly isActive: boolean;
  readonly touchX: number; // Current touch X (canvas coords)
  readonly touchY: number; // Current touch Y (canvas coords)
  readonly cursorX: number; // Current cursor X (viewport coords)
  readonly cursorY: number; // Current cursor Y (viewport coords)
  readonly touchRadiusY: number; // Touch contact radius Y (px) for finger-aware positioning
  readonly lineHeight: number; // Rendered line height in px (fontSize * lineHeightMultiplier)
  readonly lastPosition: Position | null; // Last cursor position (for haptic on change)
}

/**
 * A single find-in-document match range. Set by the host's FindBar via
 * `editor.setSearchHighlights`, consumed at paint time by the text block view
 * and the scrollbar markers. Lives on per-instance UI state (not a module
 * global) so multiple editors on one page don't clobber each other's find
 * results, and is deliberately NOT part of DocumentState (never enters
 * undo/redo).
 */
export interface SearchHighlight {
  readonly blockIndex: number;
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface SearchState {
  readonly highlights: readonly SearchHighlight[];
  readonly activeIndex: number; // -1 when no match is active
}

// Image Hover State - Not a menu, just visual feedback
export interface ImageHoverState {
  readonly blockIndex: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly hoveredHandle: DragHandlePosition; // Track which drag handle is being hovered
}

// UI State - Transient interaction state (menus, popovers, mode)
export interface UIState {
  readonly mode: EditorMode;
  readonly isReadonlyBase: boolean; // True if editor was initialized in readonly mode (persists through select mode)
  readonly activeMenu: ActiveMenu; // Unified menu system - replaces slashCommand, contextMenu, linkHover, imageUpload
  readonly isHoveringLinkWithModifier: boolean;
  readonly isHoveringCheckbox: boolean;
  readonly isHoveringPeerIndicator: boolean;
  readonly inlineMathHover: {
    readonly blockIndex: number;
    readonly startIndex: number;
    readonly endIndex: number;
  } | null;
  readonly hoveredMathBlockIndex: number | null;
  readonly composition: CompositionState | null;
  readonly activeFormatsMode: ActiveFormatsMode; // Formatting to apply to next typed text (Ctrl+B without selection)
  readonly imageHover: ImageHoverState | null; // Image hover overlay (not a blocking menu)
  readonly imageDrag: ImageDragState | null; // Active image drag operation
  readonly selectionHandleDrag: SelectionHandleDragState | null; // Active selection handle drag (mobile)
  readonly cursorDrag: CursorDragState | null; // Active cursor drag for repositioning (mobile)
  readonly autoCreatedParagraph: { blockIndex: number; blockId: string } | null; // Track auto-created paragraphs from arrow up/down on images
  readonly search: SearchState; // Find-in-document highlights (set by host FindBar, painted by text view + scrollbar)
}

// View State - Ephemeral view properties
export interface ViewState {
  readonly isFocused: boolean;
  readonly clickTracker: ClickTracker;
  readonly scrollbar: ScrollbarState;
  readonly momentum: MomentumState;
  readonly hasPhysicalKeyboard: boolean; // Set by native side when hardware keyboard is connected
  visibleBlocks: (Block & { originalIndex: number })[];
}

// Undo tracks operations per user for independent undo/redo.
//
// Inverses are captured AT EMIT TIME (in `recordUndoOps`) against the page
// state the user actually had, then stored on the group. At undo time the
// stored inverses are re-stamped with fresh id/clock and applied directly
// — no recomputation from current state. This decouples undo from any
// intervening remote edits and eliminates the class of bugs where inverse
// extraction drifts behind apply behaviour (e.g. forgetting to copy a new
// block field into the inverse block_insert's initialProps).
export interface UndoGroup {
  readonly operations: readonly Operation[]; // Original operations performed (used for redo broadcast)
  readonly inverses: readonly Operation[]; // Captured at emit time; replayed verbatim on undo
  readonly peerId?: string; // User who performed these operations
  readonly cursorBefore: CRDTCursorState | null; // Cursor state before operations (restored on undo)
  readonly selectionBefore: CRDTSelectionState | null; // Selection state before operations (restored on undo)
  readonly cursorAfter: CRDTCursorState | null; // Cursor state after operations (restored on redo)
  readonly selectionAfter: CRDTSelectionState | null; // Selection state after operations (restored on redo)
}

export interface UndoManagerState {
  readonly undoStack: readonly UndoGroup[];
  readonly redoStack: readonly UndoGroup[];
}

// New unified EditorState
export interface EditorState {
  readonly document: DocumentState;
  readonly ui: UIState;
  readonly view: ViewState;
  readonly undoManager: UndoManagerState;
  readonly CRDTbinding: CRDTbinding;
}

// Command result - all commands return state + operations
export interface CommandResult {
  readonly state: EditorState;
  readonly ops: Operation[];
}

export interface CursorState {
  readonly position: Position;
  readonly lastUpdate: number;
}

export interface SelectionState {
  readonly anchor: Position;
  readonly focus: Position;
  readonly isForward: boolean;
  readonly isCollapsed: boolean;
  readonly lastUpdate?: number;
  /**
   * Tracks initial selection boundaries from double/triple-click gestures.
   *
   * When a user double-clicks a word or triple-clicks a line, this boundary preserves
   * the original selected range. As the user drags to extend the selection, the anchor
   * point dynamically adjusts based on drag direction:
   * - Dragging before the start: anchor moves to end, focus follows cursor
   * - Dragging after the end: anchor stays at start, focus follows cursor
   * - Dragging within boundary: keeps the full boundary selected
   *
   * This ensures intuitive word/line-level selection expansion while maintaining
   * the originally selected unit. Should NOT be preserved when creating programmatic
   * selections (like Select All) that don't originate from user gestures.
   */
  readonly initialBoundary?: {
    readonly start: Position;
    readonly end: Position;
  };
}

export interface PartialSelectionState {
  readonly anchor: Position;
  readonly focus: Position;
  readonly lastUpdate?: number;
  readonly isForward?: boolean;
  readonly isCollapsed?: boolean;
  /**
   * Optional initial boundary for gesture-based selections (double/triple-click).
   * If undefined, any existing initialBoundary will be cleared.
   * Set to null to explicitly clear it, or provide a boundary to set/preserve it.
   */
  readonly initialBoundary?: {
    readonly start: Position;
    readonly end: Position;
  } | null;
}

export interface Position {
  readonly blockIndex: number;
  readonly textIndex: number;
}

/**
 * CRDT-compatible position that uses IDs instead of indexes.
 * This survives concurrent operations since IDs are stable.
 */
export interface CRDTPosition {
  readonly blockId: string; // Block ID (stable across operations)
  readonly afterCharId: string | null; // Character ID the cursor is after, null = start of block
}

/**
 * CRDT-compatible cursor state for undo/redo.
 */
export interface CRDTCursorState {
  readonly position: CRDTPosition;
}

/**
 * CRDT-compatible selection state for undo/redo.
 */
export interface CRDTSelectionState {
  readonly anchor: CRDTPosition;
  readonly focus: CRDTPosition;
}

export interface ViewportState {
  readonly scrollY: number;
  readonly width: number;
  readonly height: number;
  readonly documentHeight: number;
}

export interface TouchState {
  readonly startY: number;
  readonly startScrollY: number;
  readonly lastY: number;
  readonly lastTime: number;
  readonly velocity: number;
  readonly isScrolling: boolean;
}

export type EditorMode = "edit" | "select" | "locked" | "readonly";

// Rendering Types
export interface RenderedBlock {
  readonly block: Block;
  readonly bounds: BlockBounds;
  readonly lines: RenderedLine[];
}

export interface BlockBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RenderedLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly startIndex: number;
  readonly endIndex: number;
}

// Style Configuration
export interface RemoteCursorStyles {
  readonly labelTextColor: string;
}

export interface EditorStyles {
  readonly canvas: CanvasStyles;
  readonly fonts: FontStyles;
  readonly blocks: BlockStyles;
  readonly selection: SelectionStyles;
  readonly cursor: CursorStyles;
  readonly remoteCursor: RemoteCursorStyles;
  readonly placeholder: PlaceholderStyles;
  readonly textFormats: TextFormatStyles;
  readonly imageResize: ImageResizeStyles;
  readonly list: ListStyles;
}

/**
 * Host-defined font registry. The editor renders/measures text using these
 * CSS font-stacks; it ships only a neutral system-font default and expects the
 * consumer to register their own faces (and to load them).
 */
export interface FontStyles {
  /** Map of family key → CSS font-stack (e.g. `{ sans: "Inter, sans-serif" }`). */
  readonly families: Readonly<Record<string, string>>;
  /** Family key used when none is explicitly selected. Must exist in `families`. */
  readonly defaultFamily: FontFamily;
}

export interface CanvasStyles {
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly paddingLeft: number;
  readonly paddingRight: number;
  readonly lineHeight: number;
}

export interface MathStyles {
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly minHeight: number;
  readonly hoverBackgroundColor: string;
  readonly hoverBorderRadius: number;
  readonly placeholder: {
    readonly backgroundColor: string;
    readonly textColor: string;
    readonly text: string;
  };
}

export interface BlockStyles {
  readonly heading1: TextStyle;
  readonly heading2: TextStyle;
  readonly heading3: TextStyle;
  readonly paragraph: TextStyle;
  readonly image: ImageStyles;
  readonly line: LineStyles;
  readonly math: MathStyles;
  readonly bulletList: TextStyle;
  readonly numberedList: TextStyle;
  readonly todoList: TextStyle;
}

export interface LineStyles {
  readonly height: number; // Total height of the line block including padding
  readonly lineHeight: number; // Thickness of the actual line
  readonly color: string;
  readonly paddingTop: number;
  readonly paddingBottom: number;
}

export interface TextStyle {
  readonly fontSize: number;
  readonly fontWeight: string;
  readonly color: string;
  readonly lineHeight: number;
  readonly paddingBottom: number;
}

export interface CursorStyles {
  readonly width: number;
  readonly color: string;
  readonly blinkInterval: number;
}

export interface SelectionStyles {
  readonly backgroundColor: string;
  readonly opacity: number;
  readonly handles: SelectionHandleStyles;
}

export interface SelectionHandleStyles {
  readonly size: number; // Diameter of the handle circle
  readonly color: string; // Handle color (usually matches selection color)
  readonly touchTargetSize: number; // Larger touch target for easier interaction
  readonly stemHeight: number; // Height of the vertical stem below/above the circle
  readonly stemWidth: number; // Width of the stem
}

export interface PlaceholderStyles {
  readonly heading1: {
    readonly text: string;
  };
  readonly heading2: {
    readonly text: string;
  };
  readonly heading3: {
    readonly text: string;
  };
  readonly paragraph: {
    readonly keyboardCompatibleText: string;
    readonly touchCompatiableText: string;
  };
  readonly color: string;
}

export interface TextFormatStyles {
  readonly code: {
    readonly backgroundColor: string;
    readonly color: string;
    readonly padding: number;
    readonly borderRadius: number;
  };
  readonly link: {
    readonly color: string;
    readonly underlineThickness: number;
    readonly hoverColor: string;
  };
  readonly inlineMath: {
    readonly backgroundColor: string;
    readonly hoverBackgroundColor: string;
    readonly color: string;
    readonly padding: number;
    readonly borderRadius: number;
  };
}

export interface ImageResizeStyles {
  readonly dragHandles: {
    readonly vertical: {
      readonly length: number;
      readonly thickness: number;
      readonly borderRadius: number;
      readonly backgroundColor: string;
      readonly hoverBackgroundColor: string;
      readonly opacity: number;
      readonly hoverOpacity: number;
      readonly inset: number;
    };
    readonly horizontal: {
      readonly length: number;
      readonly thickness: number;
      readonly borderRadius: number;
      readonly backgroundColor: string;
      readonly hoverBackgroundColor: string;
      readonly opacity: number;
      readonly hoverOpacity: number;
      readonly inset: number;
    };
  };
  readonly outline: {
    readonly color: string;
    readonly width: number;
    readonly opacity: number;
    readonly hoverOpacity: number;
    readonly dashPattern: readonly number[];
  };
  readonly constraints: {
    readonly minWidth: number;
    readonly minHeight: number;
  };
}

export interface ListStyles {
  readonly bullet: {
    readonly character: string;
    readonly color: string;
    readonly size: number;
  };
  readonly numbered: {
    readonly color: string;
    readonly minWidth: number;
  };
  readonly todo: {
    readonly checkboxSize: number;
    readonly checkboxBorderColor: string;
    readonly checkboxCheckedColor: string;
    readonly checkboxBorderRadius: number;
    readonly checkmarkColor: string;
  };
  readonly indent: {
    readonly size: number;
    readonly maxLevel: number;
  };
  readonly marker: {
    readonly offsetX: number;
    readonly textGap: number;
  };
}

export interface ImageStyles {
  readonly placeholder: {
    readonly backgroundColor: string;
    readonly textColor: string;
    readonly borderColor: string;
    readonly text: string;
  };
  readonly loading: {
    readonly backgroundColor: string;
    readonly textColor: string;
    readonly text: string;
  };
  readonly uploading: {
    readonly backgroundColor: string;
    readonly textColor: string;
    readonly text: string;
  };
  readonly error: {
    readonly backgroundColor: string;
    readonly textColor: string;
    readonly text: string;
    readonly retryText: string;
  };
  readonly hover: {
    readonly overlayColor: string;
    readonly buttonBackgroundColor: string;
    readonly buttonTextColor: string;
    readonly buttonText: string;
  };
  readonly dimensions: {
    readonly height: number;
    readonly placeholderHeight: number;
    readonly paddingBottom: number;
    readonly buttonWidth: number;
    readonly buttonHeight: number;
    readonly borderRadius: number;
  };
}

// Event Types
export interface EditorEvent {
  readonly type: string;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}

export interface MouseEvent extends EditorEvent {
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

export interface KeyboardEvent extends EditorEvent {
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}
export interface CharacterMetrics {
  readonly width: number;
  readonly height: number;
}

export interface FontMetrics {
  readonly fontSize: number;
  readonly fontWeight: string;
  readonly fontFamily: FontFamily;
  readonly ascent: number;
  readonly descent: number;
}

/**
 * Per-editor-instance CRDT context. Replaces the former module-level globals
 * (id generator + Hybrid Logical Clock + page id) so two editor instances can
 * coexist on the same page (e.g. a readonly snapshot preview alongside the main
 * editor) without clobbering each other's id/clock state.
 *
 * Carried by reference on `EditorState`; its internal HLC and id-counter mutate
 * in place. It is intentionally NOT part of any undo/redo snapshot — it is
 * ambient instance context, not immutable document state.
 */
export interface CRDTbinding {
  /** The page this binding generates operations for. */
  readonly pageId: string;
  /** Generate the next unique id. Advances the internal id counter. */
  nextId(): string;
  /** Get the current clock, ticking it forward. Returns a fresh copy. */
  getClock(): HLC;
  /** This instance's peer id. */
  getPeerId(): string;
  /**
   * Advance the clock to be at least as recent as a remote clock. Call after
   * loading/receiving operations so new local ops out-order historical ones.
   */
  advanceClock(remote: HLC): void;
  /** Bump the id counter so the next generated id has counter > n. */
  advanceIdCounter(n: number): void;
}
