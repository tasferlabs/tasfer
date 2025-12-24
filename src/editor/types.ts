import type { Block, Page } from "../deserializer/loadPage";
import type { FontFamily } from "./fonts";
import type { ScrollbarState, MomentumState } from "./scrollbar";

// Editor State Types
export interface ClickTracker {
  count: number;
  lastClickTime: number;
  lastClickPosition: { x: number; y: number } | null;
}


export interface EditorModelState {
  readonly page: Page;
  readonly cursor: CursorState | null;
  readonly selection: SelectionState | null;
  readonly mode: EditorMode;
  readonly isFocused: boolean;
  readonly clickTracker: ClickTracker;
  readonly scrollbar: ScrollbarState;
  readonly momentum: MomentumState;
}

export interface UndoManagerState {
  readonly undoStack: readonly EditorModelState[];
  readonly redoStack: readonly EditorModelState[];
}

export interface EditorState extends EditorModelState {
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

export type EditorMode = "edit" | "select" | "readonly";

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
}

export interface CanvasStyles {
  readonly backgroundColor: string;
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
