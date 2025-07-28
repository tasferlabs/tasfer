import type { Block, Page } from "../deserializer/loadPage";
import type { FontFamily } from "./fonts";

// Editor State Types
export interface EditorState {
  readonly page: Page;
  readonly cursor: CursorState | null;
  readonly selection: SelectionState | null;
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
  scrollY: number;
  width: number;
  height: number;
  visibleBlocksStartIndex: number;
  visibleBlocksEndIndex: number;
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
