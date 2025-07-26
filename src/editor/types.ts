import type { Block, Page } from "../deserializer/loadPage";

// Editor State Types
export interface EditorState {
  readonly page: Page;
  readonly cursor: CursorState | null;
  readonly selection: SelectionState | null;
  readonly viewport: ViewportState;
  readonly mode: EditorMode;
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

export interface RenderingState {
  currentY: number;
  readonly renderedBlocks: RenderedBlock[];
  readonly characterMap: CharacterMap;
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
}

export interface CanvasStyles {
  readonly backgroundColor: string;
  readonly padding: number;
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
  readonly fontFamily: string;
  readonly fontWeight: string;
  readonly color: string;
  readonly lineHeight: number;
  readonly marginBottom: number;
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
  readonly altKey: boolean;
}

// Character Positioning Types for Mouse Selection
export interface CharacterPosition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly blockIndex: number;
  readonly textIndex: number;
  readonly lineIndex: number;
}

export interface RenderedCharacter {
  readonly char: string;
  readonly position: CharacterPosition;
}

export interface ViewportBounds {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly overshoot: number;
}

export interface CharacterMap {
  readonly characters: Map<string, CharacterPosition>;
  readonly viewportBounds: ViewportBounds;
  readonly blockCharacterRanges: Map<number, { start: string; end: string }>;
}
