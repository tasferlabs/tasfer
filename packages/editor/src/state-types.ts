import type { CommandBus } from "./command-bus";
import type { MarkRegistry } from "./rendering/marks/Mark";
import type { NodeRegistry } from "./rendering/nodes/Node";
import type { MomentumState, ScrollbarState } from "./rendering/scrollbar";
import type { Block, CharRun, Mark, Page } from "./serlization/loadPage";
import type { ReactElement } from "react";

// =============================================================================
// CRDT Types — P2P Offline-Tolerant Live Updates
//
// The CRDT is a first-class part of the editor state model: every edit is an
// `Operation`, `EditorState` carries the `CRDTbinding` that stamps them, and
// undo/redo stores operations rather than snapshots. These types therefore
// live here, alongside the rest of the state model, rather than in sync/.
// =============================================================================

/**
 * Hybrid Logical Clock for total ordering of operations.
 * Pure Lamport clock: counter + peerId for causality tracking.
 * No wall clock dependency - immune to system clock skew.
 */
export interface HLC {
  /** Logical counter - increments on each operation */
  counter: number;
  /** Peer ID - tie-breaker for concurrent operations */
  peerId: string;
}

/**
 * The block types built into the engine. Kept a closed union: the built-in
 * registries (BLOCK_REGISTRY, the codec tables) key on it for exhaustiveness,
 * and the compile-time field check in sync.ts indexes it.
 *
 * Custom (schema-registered) block types are NOT in this union — they flow as
 * plain strings at the op/registry boundary (`BlockInsert.blockType` is a
 * `string`, the registry helpers take `string`, and `CustomBlock.type` is a
 * `string`). So `Block["type"]` is `string`, while internal code that needs
 * exhaustiveness narrows against these literals.
 */
export type BlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullet_list"
  | "numbered_list"
  | "todo_list"
  | "image"
  | "line"
  | "math";

/**
 * Block properties that can be set via BlockSet operation.
 */
export interface BlockProps {
  /** List item indentation level */
  indent?: number;
  /** Todo item checked state */
  checked?: boolean;
  /** Image URL */
  url?: string;
  /** Image alt text */
  alt?: string;
  /** Image width */
  width?: number | "full";
  /** Image height */
  height?: number;
  /** Image object fit */
  objectFit?: "cover" | "contain";
  /** Math block LaTeX source */
  latex?: string;
  /** Math block display mode (true = display/block, false = inline) */
  displayMode?: boolean;
}

/**
 * Base operation fields shared by all operation types.
 */
export interface BaseOp {
  /** Unique operation ID: `${peerId}:${counter}` */
  id: string;
  /** Hybrid logical clock timestamp */
  clock: HLC;
  /** Page this operation belongs to */
  pageId: string;
}

/**
 * Insert characters into a block's text content.
 */
export interface TextInsert extends BaseOp {
  op: "text_insert";
  /** Block to insert into */
  blockId: string;
  /** Insert after this character ID (null = beginning) */
  afterCharId: string | null;
  /** Character runs to insert (compressed format) */
  charRuns: CharRun[];
}

/**
 * Delete characters from a block (tombstone).
 */
export interface TextDelete extends BaseOp {
  op: "text_delete";
  /** Block to delete from */
  blockId: string;
  /** Character IDs to mark as deleted */
  charIds: string[];
}

/**
 * Set formatting on a range of characters.
 */
export interface MarkSet extends BaseOp {
  op: "mark_set";
  /** Block containing the characters */
  blockId: string;
  /** Character IDs to format */
  charIds: string[];
  /** Mark to apply (its per-mark data, e.g. a link's url, rides `format.attrs`) */
  format: Mark;
  /** Whether to apply the mark (`true`) or remove it from the range (`false`) */
  value: boolean;
}

/**
 * Insert a new block into the document.
 */
export interface BlockInsert extends BaseOp {
  op: "block_insert";
  /** Insert after this block ID (null = beginning) */
  afterBlockId: string | null;
  /** New block's unique ID */
  blockId: string;
  /** Block type — a built-in `BlockType` or a custom schema-registered name. */
  blockType: string & {};
  /** Initial block properties */
  initialProps?: BlockProps;
}

/**
 * Delete a block (tombstone).
 */
export interface BlockDelete extends BaseOp {
  op: "block_delete";
  /** Block ID to mark as deleted */
  blockId: string;
}

/**
 * Set a block property (type, indent, checked, etc.).
 */
export interface BlockSet extends BaseOp {
  op: "block_set";
  /** Block to update */
  blockId: string;
  /** Property field name */
  field: string;
  /** New property value */
  value: unknown;
}

/**
 * Union of all operation types.
 */
export type Operation =
  | TextInsert
  | TextDelete
  | MarkSet
  | BlockInsert
  | BlockDelete
  | BlockSet;

/**
 * Version vector tracking seen operations per peer.
 * Maps peer ID to highest operation counter seen from that peer.
 */
export type VersionVector = Map<string, number>;

/**
 * Operation log for a page.
 */
export interface OpLog {
  /** Page ID */
  pageId: string;
  /** All operations ordered by HLC */
  operations: Operation[];
  /** Version vector of seen operations */
  versionVector: VersionVector;
  /** Computed state from operations */
  state: Page;
}

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
  readonly startIndex: number;
  readonly endIndex: number;
}

// Unified menu system - only one menu can be active at a time
export type ActiveMenu =
  | { type: "none" }
  | {
      // The engine owns opening the menu and the `/filter` text; the host owns
      // the command list and the current selection (no `selectedIndex` here).
      type: "slashCommand";
      blockIndex: number;
      textIndex: number;
      filter: string;
    }
  | {
      type: "contextMenu";
      x: number;
      y: number;
      hoveredItemId?: string | null;
      selectedItemId?: string | null;
    }
  | {
      // A host-defined overlay (popover/drawer/tooltip), anchored at a block.
      // The engine knows nothing about which overlay it is: `key` maps to a host
      // component (the node/mark that declares it in `overlays()` reads this back
      // by key), `data` is an opaque host payload. This is the generic slot every
      // host overlay flows through — the engine never names a specific overlay.
      type: "overlay";
      key: string;
      blockIndex: number;
      x: number;
      y: number;
      data?: unknown;
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
  | { type: "explicit"; formats: readonly Mark[] }; // Explicit formatting mode (Ctrl+B toggled on/off)

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
  readonly activeMenu: ActiveMenu; // Unified menu system: engine-native menus (slash/context) + the generic host `overlay` slot
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
  readonly activeMarksMode: ActiveFormatsMode; // Formatting to apply to next typed text (Ctrl+B without selection)
  readonly imageHover: ImageHoverState | null; // Image hover overlay (not a blocking menu)
  // Link hover state (not a blocking menu): the engine detects hover over a link
  // mark and records it here; the host `link` mark renders a tooltip overlay from
  // it. Engine-owned hover state, parallel to imageHover/inlineMathHover.
  readonly linkHover: LinkHoverState | null;
  // Transient, per-block canvas view-state, keyed by blockId. An opaque host
  // payload a node reads to paint ephemeral chrome (e.g. an image's upload
  // spinner) without the engine modelling that chrome as a menu/overlay. Set via
  // `editor.setNodeViewState`; not document content, never persisted.
  readonly nodeViewState: Readonly<Record<string, unknown>>;
  readonly imageDrag: ImageDragState | null; // Active image drag operation
  readonly selectionHandleDrag: SelectionHandleDragState | null; // Active selection handle drag (mobile)
  readonly cursorDrag: CursorDragState | null; // Active cursor drag for repositioning (mobile)
  readonly autoCreatedParagraph: { blockIndex: number; blockId: string } | null; // Track auto-created paragraphs from arrow up/down on images
  readonly search: SearchState; // Find-in-document highlights (set by host FindBar, painted by text view + scrollbar)
}

// View State - Ephemeral view properties
export interface ViewState {
  readonly isFocused: boolean;
  readonly isWindowFocused: boolean; // Whether the browser window has focus (affects selection color); set by mount focus/blur handlers
  readonly clickTracker: ClickTracker;
  readonly scrollbar: ScrollbarState;
  readonly momentum: MomentumState;
  visibleBlocks: (Block & { originalIndex: number })[];
}

/**
 * The cross-node user-facing strings the editor paints onto the canvas (block
 * placeholders). The package ships English defaults and no i18n library; a
 * localized host overrides these at mount via `MountEditorOptions.strings`. For
 * the block placeholders, `placeholderOverrides` (more specific) wins over
 * `strings`.
 *
 * Strings that belong to a single block type (image upload/status labels, the
 * math placeholder, …) are NOT here — they live on the owning {@link Node} as
 * its `strings` catalog and are overridden per type via
 * {@link EditorTheme.nodeStrings}. This interface is only the strings with no
 * single owning node.
 */
export interface EditorStrings {
  readonly placeholderHeading1: string;
  readonly placeholderHeading2: string;
  readonly placeholderHeading3: string;
  /** Paragraph placeholder on devices with a physical keyboard. */
  readonly placeholderParagraph: string;
  /** Paragraph placeholder on touch devices (no "/" key to advertise). */
  readonly placeholderParagraphTouch: string;
  readonly placeholderListItem: string;
  readonly placeholderTodoItem: string;
}

/**
 * Per-instance resolved node strings: block type → its localized string catalog
 * (the node's English defaults merged with `theme.nodeStrings[type]`). Built
 * once at mount and on every `setTheme`, stored on {@link EditorState}; a node
 * reads its slice via the protected `str(state, key)` helper. Keyed by node
 * `type` so it stays per-instance — never a field on the shared node singleton.
 */
export type NodeStringsMap = ReadonlyMap<
  string,
  Readonly<Record<string, string>>
>;

/**
 * A renderer-agnostic descriptor for a piece of host UI a node wants floated
 * over one of its blocks — an "overlay slot." A node declares these from its
 * current data + UI state (see `Node.overlays`); the engine collects them per
 * visible block (`editor.collectOverlays()`); the host maps `key` to a
 * component and mounts it at `rect`.
 *
 * This is what lets a node own its UI without the engine importing React: the
 * engine only ever says "render whatever is registered under `key`, here." The
 * built-in image/math popovers migrate onto this; custom nodes use it to bring
 * their own editing chrome.
 */
export interface NodeOverlay {
  /** Stable key the host's overlay registry maps to a component. */
  readonly key: string;
  /** The block this overlay belongs to (original page index). */
  readonly blockIndex: number;
  /**
   * Where to float the UI, in the same container/viewport coordinate space the
   * host positions its portals in (origin at the canvas top-left, current
   * scroll already applied — i.e. directly usable as `left`/`top`/`width`/
   * `height`). `width`/`height` are optional: omit them for a point anchor
   * (e.g. a popover that positions its own content off this origin) and
   * `collectOverlays` fills both with `1`.
   */
  readonly rect: OverlayRect;
  /** Optional serializable payload forwarded to the host component. */
  readonly data?: unknown;
}

/**
 * The placement of a {@link NodeOverlay}. `width`/`height` are optional at the
 * declaration site (a 1×1 point anchor by default); `collectOverlays`
 * normalizes them so every collected overlay carries concrete dimensions.
 */
export interface OverlayRect {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
}
// The host font registry and selected font family are per-instance: they live
// on `EditorTheme` (`fonts` / `fontFamily`), resolved into `resolvedStyles`.

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
  /**
   * Per-instance command bus (see `defineCommand`): hooks for the editor's
   * imperative actions — link activation, touch-gesture milestones. The engine
   * dispatches through `state.commandBus`; hosts attach handlers via
   * `editor.registerCommand`. Owned by this editor — NOT a module global — so
   * two editors on a page keep separate listeners.
   */
  readonly commandBus: CommandBus;
  /**
   * Per-instance registry of block views (layout/paint/hit-test per block type).
   * Owned by this editor — NOT a module global — so multiple editors on the same
   * page can register different block sets and so block types are opt-in at mount.
   */
  readonly nodes: NodeRegistry;
  /**
   * Per-instance registry of inline marks (the rendering facet: style channels
   * + replacement painting per mark type). Owned by this editor — NOT a module
   * global — so multiple editors on the same page can register different mark
   * sets and so marks are opt-in at mount. Mirrors {@link nodes}.
   */
  readonly marks: MarkRegistry;
  /**
   * The host's raw styling input for this instance (tokens + style overrides +
   * fonts + selected family + strings). Kept so `setTheme` can merge a partial
   * update and re-resolve. Read at render time only for the few dynamic overlays
   * (mobile horizontal padding, window-focus selection color).
   */
  readonly theme: EditorTheme;
  /**
   * The fully-resolved styles for this instance — `theme` merged over the
   * neutral defaults, computed once at mount and on every `setTheme`. Replaces
   * the former module-level style globals + per-render `getComputedStyle`
   * reads, so editors never clobber each other's styling and the engine never
   * touches the DOM. Read (with tiny dynamic overlays) by `getEditorStyles`.
   */
  readonly resolvedStyles: EditorStyles;
  /**
   * Per-instance node string catalogs (block type → localized strings), built
   * from each registered node's `strings` defaults overlaid with
   * `theme.nodeStrings`. Read by a node via its protected `str(state, key)`
   * helper. Per-instance (not a node-singleton field) so two editors localize
   * independently.
   */
  readonly resolvedNodeStrings: NodeStringsMap;
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
  /**
   * The currently-selected font family key (from `fonts.families`). When unset
   * the editor uses `fonts.defaultFamily`. Resolved per instance — switching it
   * is a theme change (`setTheme({ fontFamily })`), not a module global.
   */
  readonly fontFamily: FontFamily | null;
  readonly blocks: BlockStyles;
  readonly selection: SelectionStyles;
  readonly cursor: CursorStyles;
  readonly remoteCursor: RemoteCursorStyles;
  readonly placeholder: PlaceholderStyles;
  readonly textFormats: TextFormatStyles;
  readonly imageResize: ImageResizeStyles;
  readonly list: ListStyles;
  readonly search: SearchStyles;
  readonly scrollbar: ScrollbarStyles;
  readonly unknownBlock: UnknownBlockStyles;
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
  /** Fill for MathJax error-marker background rects (block + inline math). */
  readonly errorBackgroundColor: string;
  readonly placeholder: {
    readonly backgroundColor: string;
    readonly textColor: string;
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
  /** Radius of the touch-device cursor drag handle (the small circle). */
  readonly handleRadius: number;
  /** Height of the stem connecting the cursor to its touch drag handle. */
  readonly handleStemHeight: number;
}

/** Find-in-document highlight fills (active match vs the rest). */
export interface SearchStyles {
  readonly activeColor: string;
  readonly activeOpacity: number;
  readonly inactiveColor: string;
  readonly inactiveOpacity: number;
}

/**
 * Scrollbar appearance — colors plus geometry/timing, all overridable per
 * instance through `theme.styles.scrollbar` (e.g.
 * `setTheme({ styles: { scrollbar: { width: 10, borderRadius: 0 } } })`).
 * Colors default from the `scrollbar*` tokens; geometry/timing from neutral
 * built-in defaults. `width` additionally narrows on touch devices — unless the
 * host sets it explicitly, in which case that value is used on every device.
 */
export interface ScrollbarStyles {
  // ── Colors (token-derived) ────────────────────────────────────────────────
  readonly trackColor: string;
  readonly thumbColor: string;
  readonly thumbHoverColor: string;
  readonly thumbActiveColor: string;
  // ── Geometry ──────────────────────────────────────────────────────────────
  /** Track/thumb width in px. Desktop default 12; touch narrows to 8 unless set. */
  readonly width: number;
  /** Smallest thumb height in px, so it stays grabbable in very long documents. */
  readonly minThumbHeight: number;
  /** Inset of the track from the viewport edges, in px. */
  readonly padding: number;
  /** Corner radius of the track and thumb, in px (0 = square). */
  readonly borderRadius: number;
  // ── Auto-hide timing ──────────────────────────────────────────────────────
  /** ms the scrollbar stays fully visible after interaction before fading out. */
  readonly fadeDelay: number;
  /** ms the fade-out animation takes once it starts. */
  readonly fadeDuration: number;
  /** Invisible touch hit-area width in px (≥ `width`) for easier grabbing. */
  readonly touchTargetWidth: number;
}

/**
 * Fallback paint for blocks the editor cannot render (unknown/custom-without-a-
 * view block types). Drawn as a muted dashed box with a label.
 */
export interface UnknownBlockStyles {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly textColor: string;
  /** CSS font-stack for the "Unsupported block" label. */
  readonly fontFamily: string;
}

export interface SelectionStyles {
  readonly backgroundColor: string;
  /** Selection fill used when the browser window is blurred (desktop only). */
  readonly unfocusedBackgroundColor: string;
  readonly opacity: number;
  /** Opacity of remote peers' selection fills (their color comes from awareness). */
  readonly remoteOpacity: number;
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
  readonly listItem: {
    readonly text: string;
  };
  readonly todoItem: {
    readonly text: string;
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
  };
  readonly loading: {
    readonly backgroundColor: string;
    readonly textColor: string;
  };
  readonly uploading: {
    readonly backgroundColor: string;
    readonly textColor: string;
  };
  readonly error: {
    readonly backgroundColor: string;
    readonly textColor: string;
  };
  readonly hover: {
    readonly overlayColor: string;
    readonly buttonBackgroundColor: string;
    readonly buttonTextColor: string;
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

/**
 * Recursive partial — every leaf of `T` becomes optional, arrays kept whole.
 * Used so a host can override any single style leaf without restating the tree.
 */
export type DeepPartial<T> = T extends readonly (infer _U)[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * Semantic color palette — the small set of values that drive the editor's
 * appearance. Setting a handful of tokens re-themes the whole editor; the
 * resolved {@link EditorStyles} default every color leaf to one of these.
 *
 * The editor ships neutral, opinion-free defaults (see `DEFAULT_TOKENS`); a
 * host overrides them per instance via `mountEditor({ theme: { tokens } })` or
 * `editor.setTheme({ tokens })`. Nothing here is read from the DOM — a host
 * driving these from CSS variables converts them on its own side.
 */
export interface ThemeTokens {
  /** Default body text. */
  readonly text: string;
  /** Heading text (h1–h3). */
  readonly heading: string;
  /** Placeholder/ghost text. */
  readonly placeholder: string;
  /** Page background (used for hover button backgrounds etc.). */
  readonly background: string;
  /** Foreground on `background`. */
  readonly foreground: string;
  /** Hairlines, dividers, the `line` block, checkbox borders. */
  readonly border: string;
  /** Muted surface (image/math placeholder backgrounds, hover wash). */
  readonly muted: string;
  /** Text/icon on a muted surface. */
  readonly mutedForeground: string;
  /** Accent (cursor, links, todo check, resize handles). */
  readonly primary: string;
  /** Foreground on `primary` (e.g. the checkmark). */
  readonly primaryForeground: string;
  /** Error surface (image upload failure). */
  readonly destructive: string;
  /** Foreground on `destructive`. */
  readonly destructiveForeground: string;
  /** Text caret. */
  readonly cursor: string;
  /** Selection fill (focused). */
  readonly selection: string;
  /** Selection fill when the window is blurred (desktop). */
  readonly selectionUnfocused: string;
  /** Label text on a remote peer's cursor flag. */
  readonly remoteCursorLabelText: string;
  /** Inline `code` background. */
  readonly codeBackground: string;
  /** Inline `code` text. */
  readonly codeText: string;
  /** Link text. */
  readonly link: string;
  /** Link text on hover. */
  readonly linkHover: string;
  /** Wash over a cover image on hover. */
  readonly coverImageOverlay: string;
  /** Scrollbar track. */
  readonly scrollbarTrack: string;
  /** Scrollbar thumb. */
  readonly scrollbarThumb: string;
  /** Scrollbar thumb (hover). */
  readonly scrollbarThumbHover: string;
  /** Scrollbar thumb (dragging). */
  readonly scrollbarThumbActive: string;
  /** Find-in-document highlight (non-active matches). */
  readonly searchHighlight: string;
  /** Find-in-document highlight (the active match). */
  readonly searchHighlightActive: string;
  /** Fallback box fill for unrenderable blocks. */
  readonly unknownBlockBackground: string;
  /** Fallback box border for unrenderable blocks. */
  readonly unknownBlockBorder: string;
  /** Fallback box label text for unrenderable blocks. */
  readonly unknownBlockText: string;
  /** MathJax error-marker background. */
  readonly mathErrorBackground: string;
}

/**
 * The host's styling input for an editor instance — the headless theming
 * surface. All fields optional; anything omitted falls back to the editor's
 * neutral defaults.
 *
 * Two tiers, layered: `tokens` (semantic palette — set a few, re-theme
 * everything) then `styles` (a deep-partial override of the fully-resolved
 * {@link EditorStyles}, for pixel-level control of any single leaf). `fonts`
 * registers the host's font families (the host loads the faces); `fontFamily`
 * selects the active one.
 *
 * Resolved once into an {@link EditorStyles} stored per instance — no module
 * globals, no DOM reads — so two editors on a page can be themed independently.
 */
export interface EditorTheme {
  readonly tokens?: Partial<ThemeTokens>;
  readonly styles?: DeepPartial<EditorStyles>;
  readonly fonts?: Partial<FontStyles>;
  readonly fontFamily?: FontFamily | null;
  /**
   * Localized canvas placeholder strings. English defaults ship with the
   * editor; override per instance. For block placeholders, an explicit
   * `styles.placeholder.*.text` wins over `strings`. Strings owned by a single
   * block type live in {@link nodeStrings}, not here.
   */
  readonly strings?: Partial<EditorStrings>;
  /**
   * Per-node string overrides, keyed by block `type` then by the node's local
   * string key — e.g. `{ image: { clickToUpload: "…" }, math: { … } }`. Each
   * node ships English defaults in its own `strings` catalog; values here win
   * for this instance. Merged into {@link EditorState.resolvedNodeStrings} at
   * resolve time.
   */
  readonly nodeStrings?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
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
