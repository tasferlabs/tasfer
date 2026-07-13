/**
 * @cypherkit/editor — the curated public API.
 *
 * This module IS the contract owed to external consumers. The package exposes
 * the stable root plus explicit optional-feature entries such as
 * `@cypherkit/editor/math`. Engine machinery and first-party host plumbing live
 * under `@cypherkit/editor/internal` (no semver guarantee); legacy deep entries
 * remain available while first-party consumers migrate. Keep this root surface
 * tight: prefer adding capability through nodes, marks, and feature facets over
 * new top-level exports. Math's historical root exports remain as compatibility
 * aliases; new integrations should use the explicit `./math` entry.
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
  type CaretModel,
  type CaretMotion,
  createDefaultNodeRegistry,
  createNodeRegistry,
  hitRegion,
  ImageNode,
  LineNode,
  ListNode,
  Node,
  type NodeActivateCtx,
  type NodeActivation,
  type NodeAtomicHit,
  type NodeContentHitCtx,
  type NodeContentHitOptions,
  type NodeHitRegion,
  type NodePointerType,
  type NodeRegionCtx,
  NodeRegistry,
  QuoteNode,
  TextNode,
  type TextSpan,
} from "./rendering/nodes";
// Compatibility alias. New feature-oriented consumers should import this from
// `@cypherkit/editor/math` and install `mathExtension()` explicitly.
export { type MathBlock, MathNode } from "./nodes/MathNode";

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
  type MarkReplacementContentCtx,
  type MarkReplacementSourceCtx,
  type MarkStyle,
  type MarkStyleCtx,
  type MarkUnderlineStyle,
  type SelectionWrapTrigger,
  StrikeMark,
  StrongMark,
} from "./rendering/marks";
// Compatibility alias; see the MathNode note above.
export { MathMark } from "./rendering/marks/MathMark";

// Interaction regions are an internal concept — there is no host-level region
// API. Built-in chrome regions (scrollbar, selection handles, peer indicators)
// ship inside the engine, and block types contribute their interactive
// sub-regions through the node layer: a node declares geometry-only
// `NodeHitRegion`s via `Node.regions` (see the block-views export above) and
// the event layer binds behavior to them by id. Nodes are the extension point.

// Editor instance API. The public `Editor` type is the structural action/
// lifecycle surface (`EditorApi`) — host code holds the spread `CypherEditor`
// handle, not a class instance, so the public type must stay interface-shaped.
// The concrete `Editor` class is reachable as `EditorClass` from
// `@cypherkit/editor/internal` for advanced use (`new EditorClass(...)`).
export type {
  BlockData,
  ChangeApi,
  ChangeTransaction,
  DocPoint,
  DocRange,
  EditorApi as Editor,
  EditorAction,
  EditorEvent,
  EditorHostApi,
  EditorStateSnapshot,
  EditorViewApi,
  MarkInfo,
  MarkName,
  QueryApi,
} from "./entries/editor";

// Convenience constructor — parse Markdown + mount in a single call, returning
// one handle that merges the editor action API with the mount lifecycle. The
// lower-level `mountEditor` (above) stays available for hosts that want the
// split. (The raw `entries/editor` constructor is reachable as `EditorClass`
// from `@cypherkit/editor/internal` for advanced use.)
export type {
  CreateEditorBaseOptions,
  CreateEditorContent,
  CreateEditorOptions,
  CypherEditor,
} from "./entries/create";
export { createEditor } from "./entries/create";

// CRDT document — the editor-independent source of truth. Create one with
// `createDoc` (markdown / blocks / persisted bytes), attach it via
// `createEditor({ doc })`, sync it via `applyUpdate` + `on("update")`, and
// persist it via `encodeState()`. Editors without an explicit doc get a
// private one, exposed as `editor.doc`.
export type { CreateDocOptions, Doc, DocUpdate } from "./doc";
export { createDoc, PERSISTED_DOC_VERSION } from "./doc";

// Internal-assertion helper, shared across the codebase. A violated invariant
// signals a bug (a guarantee the editor's own code should uphold), so
// `InvariantError` is a plain `Error` that escapes any host catch meant for
// recoverable failures.
export { invariant, InvariantError } from "@shared/invariant";

// Schema & extensibility — declare custom block types (`defineNode`) and inline
// marks (`defineMark`), register ad-hoc specs with `baseSchema.extend(...)` or
// bundle reusable features for `baseSchema.use(...)`, and pass the result to
// `createEditor({ schema })` / `createDoc({ schema: schema.data })`.
// The canvas-free `DataSchema` (`schema.data`) carries the CRDT + serialization
// facets; the full `Schema` adds the rendering nodes. v1 custom nodes are leaf
// void blocks that round-trip through a generic `<x-type …>` HTML tag.
// `baseDataSchema` is built lazily in its module to stay clear of the
// node-registry init cycle (see baseDataSchema.ts); the package entry is a safe
// eager position to materialize the public singleton — nothing imports this
// barrel during module init, so the node graph is fully evaluated by here.
export { getBaseDataSchema } from "./baseDataSchema";
import { getBaseDataSchema as resolveBaseDataSchema } from "./baseDataSchema";
export const baseDataSchema = resolveBaseDataSchema();
export type {
  FeatureActionHook,
  FeatureContentSelectionCtx,
  FeatureContentSelectionResolveCtx,
  FeatureContentSelectionResolver,
  FeatureContentSelectionSerializer,
  FeatureContentSelectionSlice,
  FeatureFacets,
  FeatureInputPhase,
  FeatureInputRule,
  FeatureInputRuleCtx,
  FeatureStructuredContentCloneCtx,
  FeatureStructuredContentCloneFacet,
  FeatureStructuredContentCloneResult,
  FeatureStructuredMarkAttachment,
  FeatureStructuredMarkCloneCtx,
  FeatureStructuredMarkCreateCtx,
  FeatureStructuredMarkCreateResult,
  FeatureStructuredMarkFacet,
  FeatureStructuredMarkResolveCtx,
  FeatureSyntaxCtx,
  FeatureSyntaxMatch,
  FeatureSyntaxRule,
  FeatureSyntaxToken,
  FeatureThemeDefaults,
  ResolvedFeatureThemeDefaults,
} from "./feature-facets";
export {
  FeatureFacetRegistry,
  matchFeatureSyntax,
  runFeatureInputRules,
} from "./feature-facets";
export { UnknownNode } from "./rendering/nodes";
export { BoxNode, type BoxRenderStyle } from "./rendering/nodes/BoxNode";
export type {
  AttrSpec,
  BlockSpec,
  DefineMarkConfig,
  DefineNodeConfig,
  FeatureExtension,
  MarkDef,
  SchemaDefinitionOf,
  SchemaExtension,
  SchemaRestriction,
} from "./schema";
export { baseSchema, defineMark, defineNode, Schema } from "./schema";
export type {
  AnySchemaDefinition,
  BaseSchemaDefinition,
  BlockAttrs,
  BlockDataFor,
  BlockName,
  MarkAttrs,
  MarkInfoFor,
  MarkNameOf,
  MergeSchema,
  SchemaBlockData,
  SchemaDefinition,
  SchemaMarkInfo,
} from "./schema-types";
export type {
  MarkCodec,
  MarkHtmlCodec,
  MarkHtmlCtx,
} from "./serlization/codecs/mark-codec";
export type { CustomBlock } from "./serlization/loadPage";
export type {
  BlockSpecCore,
  DataSchema,
  DataSchemaExtensionDefinition,
  MarkSpec,
} from "./sync/schema";

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
  CursorDragInfo,
  Disposer,
  ImagePasteEvent,
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
  CURSOR_DRAG_MOVE,
  CURSOR_DRAG_START,
  DRAG_DETENT,
  IMAGE_PASTE,
  isMutationAction,
  isStateAction,
  mergeRegister,
  OPEN_CONTEXT_MENU,
  OPEN_LINK,
  REGION_DRAG_START,
  SCROLL,
  stateAction,
  TEXT_INPUT,
  TEXT_INPUTTED,
} from "./action-bus";
// ── Dispatchable actions ─────────────────────────────────────────────────────
// Every editor action is exported flat, by its own name — there are no grouping
// objects. Each is the same reference-identified `Action` the engine dispatches
// internally; a host drives or observes one through `editor.dispatch` /
// `editor.registerAction` (`editor.dispatch(SELECT_ALL)`,
// `editor.dispatch(TOGGLE_STRONG)`,
// `editor.dispatch(MOVE_CURSOR_LEFT, { viewport })`). They span a range of
// altitudes — the move/edit/mark commands are a stable command vocabulary (key
// remaps, command palettes, toolbars), whereas the mouse/touch/node actions are
// intimate event-layer and node-internal geometry few hosts will ever bind —
// but they all live in one flat namespace. The frequently-bound core signals
// (`OPEN_LINK`, the context-menu family, `CURSOR_DRAG_*`, `REGION_DRAG_START`,
// `TEXT_INPUT` / `TEXT_INPUTTED`) are exported flat above alongside them.

// Content-editing commands.
export type { BlockBoundaryContext } from "./actions/edit-actions";
export {
  CLEAR_SELECTION,
  CONVERT_BLOCK,
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  INSERT_TEXT,
  JOIN_WITH_PREVIOUS_BLOCK,
  joinWithPreviousBlock,
  MOVE_BLOCK,
  moveBlock,
  registerEmptyBlockBackspaceExit,
  SELECT_ALL,
  SPLIT_BLOCK,
} from "./actions/edit-actions";
// Text-input event-layer actions: IME composition lifecycle + clipboard.
export {
  COMPOSITION_END,
  COMPOSITION_START,
  COMPOSITION_UPDATE,
  COPY,
  CUT,
  PASTE,
} from "./actions/input-actions";
// Keyboard command vocabulary: cursor motion + selection extension.
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
  MOVE_CONTENT_TAB,
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
// Desktop pointer event-layer actions: caret placement + selection geometry.
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
// Touch event-layer actions: tap / long-press / visual-block geometry.
export {
  CLOSE_NODE_OVERLAY,
  OPEN_CONTEXT_MENU_AT,
  OPEN_NODE_OVERLAY,
  TAP_CLEAR_VISUAL_BLOCK_SELECTION,
  TAP_OUTSIDE_CONTENT,
  TAP_PLACE_CURSOR,
  TAP_SELECT_LINE,
  TAP_SELECT_VISUAL_BLOCK,
  TAP_SELECT_WORD,
  TAP_SIDE_PADDING,
  TAP_TOP_PADDING,
} from "./actions/touch-actions";
// Built-in mark toggles.
export {
  TOGGLE_CODE,
  TOGGLE_EMPHASIS,
  TOGGLE_STRIKE,
  TOGGLE_STRONG,
} from "./rendering/marks";
// Built-in node commands (co-located with the node each acts on).
export {
  EXIT_INLINE_MATH,
  INSERT_MATH_COMMAND,
  RESIZE_MATH_MATRIX,
  SET_INLINE_MATH_HOVER,
  SET_MATH_BLOCK_HOVER,
} from "./nodes/MathNode";
export {
  CANCEL_IMAGE_HANDLE_DRAG,
  CREATE_PARAGRAPH_BELOW_IMAGE,
  END_IMAGE_HANDLE_DRAG,
  INDENT_CODE,
  INDENT_LIST_ITEM,
  OUTDENT_CODE,
  OUTDENT_LIST_ITEM,
  SET_IMAGE_HOVER,
  START_IMAGE_HANDLE_DRAG,
  TOGGLE_TODO_CHECKED,
  UPDATE_IMAGE_HANDLE_DRAG,
} from "./rendering/nodes";

// Core document model + CRDT operation types. The stored-mark CRDT record is
// exported as `StoredMark` so the top-level `Mark` can be the rendering base
// class (the extension point authors subclass); `StoredMark` is the `{ type,
// attrs }` record a run carries, reachable as `MarkStyleCtx.mark`.
export type { Block, Page, Mark as StoredMark } from "./serlization/loadPage";
export type {
  ContentEdit,
  EditorState,
  EditorStyles,
  EditorTheme,
  FontFamily,
  FontStyles,
  HLC,
  Operation,
  ScrollbarStyles,
  ThemeTokens,
  VersionVector,
  ViewWindow,
} from "./state-types";
export type {
  ContentGapPoint,
  ContentPoint,
  ContentSelection,
  ContentSelectionAffinity,
  ContentTextPoint,
} from "./structured-selection";
export {
  captureContentSelection,
  cloneContentSelection,
  contentGapPointsEqual,
  contentPointsEqual,
  contentSelectionsEqual,
  contentTextPointsEqual,
  isContentSelectionCollapsed,
  isSameContentGapSlot,
  isSameContentTextField,
  normalizeContentGapPoint,
  normalizeContentPoint,
  normalizeContentSelection,
  normalizeContentTextPoint,
  reconcileContentSelectionState,
  resolveContentTextPointOffset,
  restoreContentSelection,
  updateContentSelection,
} from "./structured-selection";
export {
  type AllocatedIdentity,
  createDeterministicIdentityAllocator,
  type IdentityAllocator,
  parseAllocatedIdentity,
} from "./sync/id";
export type {
  StructuredContentMap,
  StructuredDocument,
  StructuredEdit,
  StructuredMutation,
  StructuredNode,
  StructuredNodeSeed,
  StructuredPlacement,
  StructuredValue,
} from "./sync/structured-content";
export {
  applyStructuredEdit,
  applyStructuredEdits,
  applyStructuredMutation,
  canonicalizeStructuredDocument,
  createStructuredDocument,
  getStructuredChildren,
  getStructuredNode,
  getStructuredText,
  hasStructuredBlockAuthority,
  hasStructuredContent,
  invertStructuredEdit,
  structuredContentId,
  validateStructuredDocument,
} from "./sync/structured-content";

// View windows — scope an editor to a subset of a shared doc's blocks (the
// `window` option on `mountEditor`/`createEditor`/`useEditor`). `titleBlockWindow`
// builds a single-block title surface (pair with `Schema.restrict`); two editors
// on one `Doc` showing different windows stay live-synced through the doc.
export {
  blockIdWindow,
  titleBlockIndex,
  titleBlockWindow,
} from "./view-window";

// CRDT sync — version-vector codecs the providers exchange on the wire. For
// document sync + persistence prefer the high-level `Doc` (`createDoc` above):
// attach it via `createEditor({ doc })` or `mountEditor(el, blocks, { doc })`,
// then drive it with `applyUpdate` / `on("update")` / `load`. The lower-level
// op-log engine (`createSyncEngine`/`createCRDTbinding`) lives in
// `@cypherkit/editor/internal` for advanced headless CRDT tooling.
export { deserializeVV, serializeVV } from "./sync/sync";

// Fonts — the host registers font families/stacks via the per-instance theme
// (`EditorTheme.fonts`), loads the faces itself, then calls `notifyFontsLoaded`
// / `notifyFontsChanged` so the editor flushes its (shared, pure) metrics cache
// and re-measures. The selected family is `theme.fontFamily` (change it with
// `editor.setTheme({ fontFamily })`). The editor ships no bundled fonts.
export { notifyFontsChanged, notifyFontsLoaded } from "./fonts";

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
export type { ReplacementRenderer } from "./serlization/codecs";
export type { HtmlSerializeOptions } from "./serlization/htmlSerializer";
export { serializeToHTML } from "./serlization/htmlSerializer";
export { parseFrontmatter } from "./serlization/loadPage";
export { default as parsePage } from "./serlization/parser";
export type {
  MarkdownSerializeOptions,
  PageMetadata,
} from "./serlization/serializer";
export { serializeToMarkdown } from "./serlization/serializer";
export { default as tokenizePage } from "./serlization/tokenizer";

// Decorations — the generic, ephemeral overlay primitive (find highlights,
// remote cursors, …). Produced by the host/providers and fed in via
// `editor.setDecorations(layer, …)`; never document content.
export type {
  CaretDecoration,
  Decoration,
  DecorationLayers,
  DecorationPoint,
  DecorationRange,
  LabelIconShape,
  RangeDecoration,
} from "./rendering/decorations";

// Legacy root math surface. The explicit `@cypherkit/editor/math` entry is the
// preferred home for new consumers, but moving these symbols must not break
// existing applications.
export { getInlineMathSpans, type InlineMathSpan } from "./inline-math-spans";
export {
  isValidLatex,
  mathMatrixContext,
  mathMatrixResize,
  mathSourceAtEdge,
  type MatrixContext,
  type MatrixEditResult,
  type MatrixTextEdit,
  renderToSVG,
} from "./nodes/math";
export {
  filterMathCommands,
  MATH_COMMANDS,
  type MathCommand,
  mathCommandCaretOffset,
  mathCommandInsertion,
  unambiguousMathCommandCompletion,
} from "./nodes/math-commands";

// Host-convenience helpers (block/format/selection readers), the low-level
// op-log engine, the image cache, magnifier geometry, and other engine
// machinery a first-party host needs live in the explicitly-unstable
// `@cypherkit/editor/internal` entry — they are not part of this public
// contract. See ./internal.ts.
