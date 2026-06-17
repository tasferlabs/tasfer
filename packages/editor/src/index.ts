/**
 * @cypherkit/editor — public surface.
 *
 * Phase 1 of the extraction: this re-exports the headless editor core. Deep
 * subpath imports (e.g. `@cypherkit/editor/sync/awareness`) remain available
 * for now; a curated public API is a follow-up.
 */

// Mount / lifecycle
export type {
  MountedEditor,
  MountEditorOptions,
  PlaceholderBlockType,
  PlaceholderOption,
} from "./entries/mount";
export { mountEditor } from "./entries/mount";

// Block views — per-instance registry + built-in node classes for opt-in block
// sets. Each built-in node is a class hosts construct (`new TextNode()`) when
// assembling a custom `nodes` list — they hold no per-editor state.
export {
  AtomicNode,
  CANCEL_IMAGE_HANDLE_DRAG,
  CREATE_PARAGRAPH_BELOW_IMAGE,
  createDefaultNodeRegistry,
  createNodeRegistry,
  END_IMAGE_HANDLE_DRAG,
  ImageNode,
  INDENT_LIST_ITEM,
  LineNode,
  ListNode,
  MathNode,
  Node,
  type NodeActivateCtx,
  type NodeActivation,
  type NodeAtomicHit,
  type NodeHitRegion,
  type NodePointerMoveCtx,
  type NodePointerType,
  type NodeRegionCtx,
  NodeRegistry,
  type NodeTextClickCtx,
  OPEN_INLINE_MATH_OVERLAY,
  OUTDENT_LIST_ITEM,
  SET_IMAGE_HOVER,
  SET_INLINE_MATH_HOVER,
  SET_MATH_BLOCK_HOVER,
  START_IMAGE_HANDLE_DRAG,
  TextNode,
  TOGGLE_TODO_CHECKED,
  UPDATE_IMAGE_HANDLE_DRAG,
} from "./rendering/nodes";

// Inline marks. `Mark` is the base class to subclass for a custom mark's
// on-canvas paint (its `style()` returns the visual channels — color, a chip,
// an underline — composed across a run); pass instances via `defineMark`'s
// `render`. The built-in mark classes are re-exported too, so a host can
// subclass one (e.g. `class BrandLink extends LinkMark`) or assemble a `Schema`
// explicitly instead of relying on the default `baseSchema`.
export {
  CodeMark,
  EmphasisMark,
  LinkMark,
  Mark,
  type MarkChipStyle,
  type MarkOverlayCtx,
  type MarkReplacement,
  type MarkStyle,
  type MarkStyleCtx,
  type MarkUnderlineStyle,
  MathMark,
  StrikeMark,
  StrongMark,
  TOGGLE_BOLD,
  TOGGLE_CODE,
  TOGGLE_ITALIC,
  TOGGLE_STRIKE,
} from "./rendering/marks";

// Interaction regions are an internal concept — there is no host-level region
// API. Built-in chrome regions (scrollbar, selection handles, peer indicators)
// ship inside the engine, and block types contribute their interactive
// sub-regions through the node layer: a node declares geometry-only
// `NodeHitRegion`s via `Node.regions` (see the block-views export above) and
// the event layer binds behavior to them by id. Nodes are the extension point.

// Editor instance API. The public `Editor` type is the structural action/
// lifecycle surface (`EditorApi`) — host code holds the spread `CypherEditor`
// handle, not a class instance, so the public type must stay interface-shaped.
// The concrete `Editor` class is reachable via the `@cypherkit/editor/entries/
// editor` subpath for advanced use (`new Editor(...)`).
export type {
  ChangeApi,
  ChangeTransaction,
  EditorApi as Editor,
  EditorAction,
  EditorEvent,
  EditorStateSnapshot,
  MarkName,
} from "./entries/editor";

// Convenience constructor — parse Markdown + mount in a single call, returning
// one handle that merges the editor action API with the mount lifecycle. The
// lower-level `mountEditor` (above) stays available for hosts that want the
// split. (The raw `entries/editor` constructor remains reachable via the
// `@cypherkit/editor/entries/editor` subpath for advanced use.)
export type { CreateEditorOptions, CypherEditor } from "./entries/create";
export { createEditor } from "./entries/create";

// CRDT document — the editor-independent source of truth. Create one with
// `createDoc` (markdown / blocks / persisted bytes), attach it via
// `createEditor({ doc })`, sync it via `applyUpdate` + `on("update")`, and
// persist it via `encodeState()`. Editors without an explicit doc get a
// private one, exposed as `editor.doc`.
export type { CreateDocOptions, Doc, DocUpdate } from "./doc";
export { createDoc, PERSISTED_DOC_VERSION } from "./doc";

// Error types — every editor-thrown error extends `EditorError`; see ./errors.
export { EditorError, IncompatibleDocVersionError } from "./errors";

// Schema & extensibility — declare custom block types (`defineNode`) and inline
// marks (`defineMark`), bundle them with `baseSchema.extend(...)`, and pass the
// result to `createEditor({ schema })` / `createDoc({ schema: schema.data })`.
// The canvas-free `DataSchema` (`schema.data`) carries the CRDT + serialization
// facets; the full `Schema` adds the rendering nodes. v1 custom nodes are leaf
// void blocks that round-trip through a generic `<x-type …>` HTML tag.
export { baseDataSchema } from "./baseDataSchema";
export { UnknownNode } from "./rendering/nodes";
export { BoxNode, type BoxRenderStyle } from "./rendering/nodes/BoxNode";
export type {
  AttrSpec,
  BlockSpec,
  DefineMarkConfig,
  DefineNodeConfig,
  MarkDef,
  SchemaExtension,
} from "./schema";
export { baseSchema, defineMark, defineNode, Schema } from "./schema";
export type {
  MarkCodec,
  MarkHtmlCodec,
  MarkHtmlCtx,
} from "./serlization/codecs/mark-codec";
export type { CustomBlock } from "./serlization/loadPage";
export type { BlockSpecCore, DataSchema, MarkSpec } from "./sync/schema";

// Action bus — declare imperative actions (`action`) that hosts hook
// via `editor.registerAction` (override by returning `true`, or observe by
// returning `void`). The engine dispatches built-ins like `OPEN_LINK` and the
// touch-gesture milestones below; a native shell maps them to its own effects.
// A `MutationAction` (declared with `action(name, mutate)`) goes one step
// further: its default is a document mutation, so `editor.dispatch` runs the
// default plus every observer inside ONE undoable transaction, and observers
// (registered via the same `registerAction`) are handed the `ChangeApi`.
// A `StateAction` (declared with `stateAction(name, transform)`) is the
// lower-level shape: its default is a pure `(state) => { state, ops }`
// transform, dispatched via `actionBus.dispatchState` from inside the event
// pipeline — the form that can express cursor/selection moves emitting no ops.
export type {
  Action,
  ActionBus,
  ActionHandler,
  Disposer,
  MutationAction,
  MutationHandler,
  Mutator,
  StateAction,
  StateHandler,
  StateMutator,
  StateResult,
} from "./action-bus";
export {
  action,
  CLOSE_CONTEXT_MENU,
  CONTEXT_MENU_POINTER_MOVE,
  CONTEXT_MENU_RELEASE,
  CURSOR_DRAG_BOUNDARY,
  CURSOR_DRAG_END,
  CURSOR_DRAG_START,
  isMutationAction,
  isStateAction,
  mergeRegister,
  OPEN_CONTEXT_MENU,
  OPEN_LINK,
  REGION_DRAG_START,
  stateAction,
  TEXT_INPUT,
} from "./action-bus";
// Editor keyboard actions — named cursor-movement / selection-extension
// actions migrated out of the event handlers (see `actions/keyboard-actions.ts`).
export {
  EXTEND_SELECTION_DOWN,
  EXTEND_SELECTION_END,
  EXTEND_SELECTION_HOME,
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_PAGE_DOWN,
  EXTEND_SELECTION_PAGE_UP,
  EXTEND_SELECTION_RIGHT,
  EXTEND_SELECTION_UP,
  EXTEND_SELECTION_WORD_LEFT,
  EXTEND_SELECTION_WORD_RIGHT,
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_PAGE_DOWN,
  MOVE_CURSOR_PAGE_UP,
  MOVE_CURSOR_RIGHT,
  MOVE_CURSOR_UP,
  MOVE_TO_DOCUMENT_END,
  MOVE_TO_DOCUMENT_START,
  MOVE_TO_LINE_END,
  MOVE_TO_LINE_START,
  MOVE_TO_NEXT_WORD,
  MOVE_TO_PREVIOUS_WORD,
} from "./actions/keyboard-actions";
// Editor edit actions — named content-mutating / selection-clearing actions
// (insert, delete, split, format, indent, clear) migrated out of the event
// handlers (see `actions/edit-actions.ts`).
export {
  CLEAR_SELECTION,
  CONVERT_BLOCK,
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  INSERT_TEXT,
  SELECT_ALL,
  SPLIT_BLOCK,
} from "./actions/edit-actions";
// Editor mouse actions — named click / selection / hover actions migrated out
// of the mouse event handlers (see `actions/mouse-actions.ts`).
export {
  CLEAR_SELECTION_IN_PADDING,
  CLEAR_VISUAL_BLOCK_SELECTION,
  OPEN_BLOCK_OVERLAY,
  PLACE_CURSOR_AT_POINT,
  PLACE_CURSOR_IN_SIDE_PADDING,
  SELECT_LINE_AT_POINT,
  SELECT_VISUAL_BLOCK,
  SELECT_WORD_AT_POINT,
} from "./actions/mouse-actions";
// Editor touch actions — named tap / long-press / visual-block actions migrated
// out of the touch event handlers (see `actions/touch-actions.ts`).
export {
  CLOSE_NODE_OVERLAY,
  FINISH_SELECT_MODE,
  OPEN_CONTEXT_MENU_AT,
  OPEN_NODE_OVERLAY,
  TAP_CLEAR_VISUAL_BLOCK_SELECTION,
  TAP_ON_SELECTION,
  TAP_OUTSIDE_CONTENT,
  TAP_PLACE_CURSOR,
  TAP_SELECT_LINE,
  TAP_SELECT_VISUAL_BLOCK,
  TAP_SELECT_WORD,
  TAP_SIDE_PADDING,
  TAP_TOP_PADDING,
} from "./actions/touch-actions";
// Editor input actions — named IME-composition / clipboard (copy / cut / paste)
// actions migrated out of the input event handlers (see
// `actions/input-actions.ts`). The image-resize-handle drag actions moved to
// the node they act on (see `nodes/ImageNode.ts` → `*_IMAGE_HANDLE_DRAG`,
// re-exported below via `./rendering/nodes`).
export {
  COMPOSITION_END,
  COMPOSITION_START,
  COMPOSITION_UPDATE,
  COPY,
  CUT,
  PASTE,
} from "./actions/input-actions";

// Core document model + CRDT operation types. The stored-mark CRDT record is
// exported as `StoredMark` so the top-level `Mark` can be the rendering base
// class (the extension point authors subclass); `StoredMark` is the `{ type,
// attrs }` record a run carries, reachable as `MarkStyleCtx.mark`.
export type {
  Block,
  Char,
  CharRun,
  MarkSpan,
  Page,
  Mark as StoredMark,
} from "./serlization/loadPage";
export type {
  CRDTbinding,
  DeepPartial,
  EditorState,
  EditorStrings,
  EditorStyles,
  EditorTheme,
  FontFamily,
  FontStyles,
  HLC,
  NodeOverlay,
  NodeStringsMap,
  Operation,
  OverlayRect,
  ScrollbarStyles,
  ThemeTokens,
  VersionVector,
  ViewportState,
} from "./state-types";

// CRDT sync. For document sync + persistence prefer the high-level `Doc`
// (`createDoc` above): attach it via `createEditor({ doc })` or
// `mountEditor(el, blocks, { doc })`, then drive it with `applyUpdate` /
// `on("update")` / `load`. `createSyncEngine` is the lower-level op-log engine
// (op creators, version vector, merge) that sits underneath — reach for it
// directly only for advanced uses such as headless CRDT tooling and the
// convergence fuzz tests. The binding is the per-instance id/clock/peer-identity
// source; share one binding across whichever of these you combine.
export type { SyncEngine } from "./sync/sync";
export {
  createCRDTbinding,
  createSyncEngine,
  deserializeVV,
  maxOpIdCounter,
  maxPageIdCounter,
  serializeVV,
} from "./sync/sync";

// Fonts — the host registers font families/stacks via the per-instance theme
// (`EditorTheme.fonts`), loads the faces itself, then calls `notifyFontsLoaded`
// / `notifyFontsChanged` so the editor flushes its (shared, pure) metrics cache
// and re-measures. The selected family is `theme.fontFamily` (change it with
// `editor.setTheme({ fontFamily })`). The editor ships no bundled fonts.
export {
  currentFontFamily,
  notifyFontsChanged,
  notifyFontsLoaded,
  onFontsReady,
} from "./fonts";

// Theming — resolve a host `EditorTheme` (semantic `tokens` + deep-partial
// `styles` overrides + `fonts`) into the full style tree, the neutral default
// palette, and the merge used by `editor.setTheme`. A host driving appearance
// from CSS variables converts them to `tokens` and passes a theme at mount (or
// via `setTheme`); the engine never reads the DOM.
export { DEFAULT_TOKENS, mergeTheme, resolveTheme } from "./styles";

// ── Host-app surface ────────────────────────────────────────────────────────
// The following re-exports support hosts that build their own document tooling
// (import/export, presence UI, find, overlays) on top of the engine. They were
// promoted from deep subpath imports so consumers can stay on the package root.

// Serialization — project a document to Markdown / HTML, parse Markdown back
// into blocks, and collect the asset urls a block tree references.
export { collectAssetRefs } from "./baseDataSchema";
export { serializeToHTML } from "./serlization/htmlSerializer";
export { parseFrontmatter } from "./serlization/loadPage";
export { default as parsePage } from "./serlization/parser";
export type { PageMetadata } from "./serlization/serializer";
export { serializeToMarkdown } from "./serlization/serializer";
export { default as tokenizePage } from "./serlization/tokenizer";

// Awareness / presence — stable per-peer color, and converters from an editor
// cursor/selection into the awareness wire shape a host broadcasts to peers.
export type { AwarenessState, AwarenessUser } from "./sync/awareness";
export {
  getColorForPeer,
  positionToAwarenessCursor,
  selectionToAwarenessSelection,
} from "./sync/awareness";

// Inline-math rendering — render a LaTeX run to an SVG string, and validate it.
export { isValidLatex, renderToSVG } from "./nodes/math";

// Convenience helpers — candidates for future encapsulation behind a richer
// `Editor`/`Doc` handle. Exposed now so hosts that drive toolbars, link UI, and
// find can read block/format state without deep imports.
export { getFormatsAtPosition, getSelectionRange } from "./actions/actions";
export type { TextualBlock } from "./nodes/TextNode";
export { getLinkAtPosition } from "./rendering/marks/LinkMark";
export {
  getBlockTextContent,
  getBlockTextLength,
  isTouchDevice,
} from "./state-utils";
export { isTextualBlock } from "./sync/block-registry";
export {
  extractTitleFromBlocks,
  getVisibleTextFromRuns,
} from "./sync/char-runs";
export { allCharsHaveFormat } from "./sync/crdt-utils";

// Shared image cache (content-addressed image bitmaps) + a way to clear the
// failed-load set so a host can retry after fixing a source.
export { clearFailedImageCache, imageCache } from "./rendering/renderer";

// Touch cursor-magnifier geometry — a host that renders its own magnifier
// overlay sizes it against the same constants the engine lays out from.
export {
  MAGNIFIER_HEIGHT,
  MAGNIFIER_MIN_OFFSET_Y,
  MAGNIFIER_POINTER_SIZE,
  MAGNIFIER_WIDTH,
} from "./constants";

// Additional state-types used by host overlay/style code.
export type {
  CursorDragState,
  PlaceholderStyles,
  TextStyle,
} from "./state-types";
