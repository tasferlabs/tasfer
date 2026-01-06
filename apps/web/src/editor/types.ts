import type { Block, Page, TextFormat } from "../deserializer/loadPage";
import type { FontFamily } from "./fonts";
import type { ScrollbarState, MomentumState } from "./scrollbar";

export interface SlashCommand {
  id: string;
  type: Block["type"];
  label: string;
  description: string;
  icon: string | React.ReactElement;
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
  | { type: 'none' }
  | { type: 'slashCommand'; blockIndex: number; textIndex: number; filter: string; selectedIndex: number }
  | { type: 'contextMenu'; x: number; y: number }
  | { type: 'linkHover'; position: Position; url: string; text: string; x: number; y: number; segmentIndex: number }
  | { type: 'linkEdit'; position: Position; url: string; text: string; x: number; y: number; segmentIndex: number }
  | { type: 'imageUpload'; blockIndex: number; x: number; y: number; uploadStatus?: 'uploading' | 'complete' | 'error' };

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
}

// Active formats mode for typing
export type ActiveFormatsMode = 
  | { type: 'inherit' } // Inherit formatting from previous character (normal typing)
  | { type: 'explicit'; formats: readonly TextFormat[] }; // Explicit formatting mode (Ctrl+B toggled on/off)

// Drag handle position on an image
export type DragHandlePosition = 'left' | 'right' | 'bottom' | null;

// Drag state for image resize
export interface ImageDragState {
  readonly blockIndex: number;
  readonly handle: DragHandlePosition;
  readonly startX: number;
  readonly startY: number;
  readonly startWidth: number | 'full';
  readonly startHeight: number;
  readonly startObjectFit: 'cover' | 'contain';
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
  readonly activeMenu: ActiveMenu; // Unified menu system - replaces slashCommand, contextMenu, linkHover, imageUpload
  readonly isHoveringLinkWithModifier: boolean;
  readonly composition: CompositionState | null;
  readonly activeFormatsMode: ActiveFormatsMode; // Formatting to apply to next typed text (Ctrl+B without selection)
  readonly imageHover: ImageHoverState | null; // Image hover overlay (not a blocking menu)
  readonly imageDrag: ImageDragState | null; // Active image drag operation
  readonly autoCreatedParagraph: { blockIndex: number; blockId: string } | null; // Track auto-created paragraphs from arrow up/down on images
}

// View State - Ephemeral view properties
export interface ViewState {
  readonly isFocused: boolean;
  readonly clickTracker: ClickTracker;
  readonly scrollbar: ScrollbarState;
  readonly momentum: MomentumState;
}

// Undo only tracks document state now
export interface UndoManagerState {
  readonly undoStack: readonly DocumentState[];
  readonly redoStack: readonly DocumentState[];
}

// New unified EditorState
export interface EditorState {
  readonly document: DocumentState;
  readonly ui: UIState;
  readonly view: ViewState;
  readonly undoManager: UndoManagerState;
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
  readonly lastUpdate: number;
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

export interface ViewportState {
  readonly scrollY: number;
  readonly width: number;
  readonly height: number;
}

export interface TouchState {
  readonly startY: number;
  readonly startScrollY: number;
  readonly lastY: number;
  readonly lastTime: number;
  readonly velocity: number;
  readonly isScrolling: boolean;
}

export type EditorMode = "edit" | "select" | "locked";

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
export interface EditorStyles {
  readonly canvas: CanvasStyles;
  readonly blocks: BlockStyles;
  readonly selection: SelectionStyles;
  readonly cursor: CursorStyles;
  readonly placeholder: PlaceholderStyles;
  readonly textFormats: TextFormatStyles;
  readonly imageResize: ImageResizeStyles;
}

export interface CanvasStyles {
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly paddingLeft: number;
  readonly paddingRight: number;
  readonly lineHeight: number;
}

export interface BlockStyles {
  readonly heading1: TextStyle;
  readonly heading2: TextStyle;
  readonly heading3: TextStyle;
  readonly paragraph: TextStyle;
  readonly image: ImageStyles;
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
    readonly text: string;
    readonly mobileText: string;
  };
  readonly color: string;
  readonly opacity: number;
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
  readonly characters: ReadonlyMap<string, CharacterMetrics>;
}

export interface WordMetrics {
  readonly word: string;
  readonly width: number;
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface TextMeasurementResult {
  readonly totalWidth: number;
  readonly words: readonly WordMetrics[];
}
export default interface FontConfig {
  readonly fontFamily: FontFamily;
}
