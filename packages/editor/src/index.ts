/**
 * @cypherkit/editor — the curated public API.
 *
 * This module IS the contract owed to external consumers. The package exposes
 * exactly two entry points (see `package.json` `exports`): this root, and the
 * explicitly-unstable `@cypherkit/editor/internal` (engine machinery + host
 * plumbing, no semver guarantee). The former `./*` wildcard — which made every
 * source file a frozen public entry point — has been removed. Keep this surface
 * tight: prefer adding capability as new node/mark types or facets over new
 * top-level exports, and never re-export engine internals here.
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
  MathNode,
  Node,
  type NodeActivateCtx,
  type NodeActivation,
  type NodeAtomicHit,
  type NodeHitRegion,
  type NodePointerType,
  type NodeRegionCtx,
  NodeRegistry,
  TextNode,
  type TextSpan,
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
// The concrete `Editor` class is reachable as `EditorClass` from
// `@cypherkit/editor/internal` for advanced use (`new EditorClass(...)`).
export type {
  ChangeApi,
  ChangeTransaction,
  DocNode,
  DocPoint,
  DocRange,
  EditorApi as Editor,
  EditorAction,
  EditorEvent,
  EditorStateSnapshot,
  MarkName,
} from "./entries/editor";

// Convenience constructor — parse Markdown + mount in a single call, returning
// one handle that merges the editor action API with the mount lifecycle. The
// lower-level `mountEditor` (above) stays available for hosts that want the
// split. (The raw `entries/editor` constructor is reachable as `EditorClass`
// from `@cypherkit/editor/internal` for advanced use.)
export type { CreateEditorOptions, CypherEditor } from "./entries/create";
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
  TEXT_INPUTTED,
} from "./action-bus";
// ── Action namespaces ────────────────────────────────────────────────────────
// The editor's dispatchable actions, grouped into namespaced objects by the
// subsystem that owns each set, so the package root stays a tight handful of
// names instead of ~60 loose constants. Every member is the same
// reference-identified `Action` the engine dispatches internally; a host drives
// or observes one through `editor.dispatch` / `editor.registerAction`
// (`editor.dispatch(EditActions.SELECT_ALL)`,
// `editor.dispatch(MarkActions.TOGGLE_STRONG)`,
// `editor.dispatch(KeyboardActions.MOVE_CURSOR_LEFT, { viewport })`). The
// grouping also makes each set's altitude legible: `KeyboardActions` /
// `EditActions` / `MarkActions` are a stable command vocabulary (key remaps,
// command palettes, toolbars), whereas `MouseActions` / `TouchActions` /
// `NodeActions` are intimate event-layer and node-internal geometry few hosts
// will ever bind. The frequently-bound core signals (`OPEN_LINK`, the
// context-menu family, `CURSOR_DRAG_*`, `REGION_DRAG_START`, `TEXT_INPUT` /
// `TEXT_INPUTTED`) stay flat above — they are the centerpiece host-integration
// hooks, not part of this long tail.
export { EditActions } from "./actions/edit-actions";
export { InputActions } from "./actions/input-actions";
export { KeyboardActions } from "./actions/keyboard-actions";
export { MouseActions } from "./actions/mouse-actions";
export { TouchActions } from "./actions/touch-actions";
export { MarkActions } from "./rendering/marks";
export { NodeActions } from "./rendering/nodes";

// Core document model + CRDT operation types. The stored-mark CRDT record is
// exported as `StoredMark` so the top-level `Mark` can be the rendering base
// class (the extension point authors subclass); `StoredMark` is the `{ type,
// attrs }` record a run carries, reachable as `MarkStyleCtx.mark`.
export type { Block, Page, Mark as StoredMark } from "./serlization/loadPage";
export type {
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
} from "./state-types";

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
  DEFAULT_AWARENESS_COLORS,
  getColorForPeer,
  positionToAwarenessCursor,
  selectionToAwarenessSelection,
} from "./sync/awareness";

// Inline-math rendering — render a LaTeX run to an SVG string, and validate it.
export { isValidLatex, renderToSVG } from "./nodes/math";
// Inline-math chip detection (host UI building math chrome reads these to know
// when the caret is inside a chip and to recover the chip's LaTeX/offsets).
export { getInlineMathSpans, type InlineMathSpan } from "./inline-math-spans";
// The `\` command catalog behind the host's math autocomplete menu.
export {
  filterMathCommands,
  type MathCommand,
  mathCommandCaretOffset,
} from "./nodes/math-commands";

// Host-convenience helpers (block/format/selection readers), the low-level
// op-log engine, the image cache, magnifier geometry, and other engine
// machinery a first-party host needs live in the explicitly-unstable
// `@cypherkit/editor/internal` entry — they are not part of this public
// contract. See ./internal.ts.
