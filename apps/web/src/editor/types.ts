import type { Block, Page, TextFormat } from "../deserializer/loadPage";
import type { FontFamily } from "./fonts";
import type { ScrollbarState, MomentumState } from "./scrollbar";

export interface SlashCommand {
  id: string;
  type: Block["type"];
  label: string;
  description: string;
  icon: string;
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

// UI State - Transient interaction state (menus, popovers, mode)
export interface UIState {
  readonly mode: EditorMode;
  readonly slashCommand: SlashCommandState | null;
  readonly contextMenu: ContextMenuState | null;
  readonly linkHover: LinkHoverState | null;
  readonly isHoveringLinkWithModifier: boolean;
  readonly composition: CompositionState | null;
  readonly activeFormatsMode: ActiveFormatsMode; // Formatting to apply to next typed text (Ctrl+B without selection)
}

// View State - Ephemeral view properties
export interface ViewState {
  readonly isFocused: boolean;
  readonly clickTracker: ClickTracker;
  readonly scrollbar: ScrollbarState;
  readonly momentum: MomentumState;
}

export interface SlashCommandState {
  readonly blockIndex: number;
  readonly textIndex: number;
  readonly filter: string;
  readonly selectedIndex: number;
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
  // Track initial selection boundaries from double/triple click for proper anchor adjustment
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
