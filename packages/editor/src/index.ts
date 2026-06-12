/**
 * @cypherkit/editor — public surface.
 *
 * Phase 1 of the extraction: this re-exports the headless editor core. Deep
 * subpath imports (e.g. `@cypherkit/editor/sync/awareness`) remain available
 * for now; a curated public API is a follow-up.
 */

// Mount / lifecycle
export type { MountedEditor, MountEditorOptions } from "./entries/mount";
export { mountEditor } from "./entries/mount";

// Block views — per-instance registry + built-in views for opt-in block sets
export {
  AtomicNode,
  createDefaultNodeRegistry,
  createNodeRegistry,
  imageNode,
  lineNode,
  ListNode,
  listNode,
  Node,
  type NodeHitRegion,
  type NodePointerType,
  type NodeRegionCtx,
  NodeRegistry,
  textNode,
} from "./rendering/nodes";

// Interaction regions are an internal concept — there is no host-level region
// API. Built-in chrome regions (scrollbar, selection handles, peer indicators)
// ship inside the engine, and block types contribute their interactive
// sub-regions through the node layer: a node declares geometry-only
// `NodeHitRegion`s via `Node.regions` (see the block-views export above) and
// the event layer binds behavior to them by id. Nodes are the extension point.

// Editor instance API
export type {
  ChangeTransaction,
  Editor,
  EditorCommandChain,
  EditorCommands,
  EditorEvent,
  EditorStateSnapshot,
  MarkName,
  SyncState,
} from "./entries/editor";

// Convenience constructor — parse Markdown + mount in a single call, returning
// one handle that merges the editor command API with the mount lifecycle. The
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
export { createDoc } from "./doc";

// Schema & extensibility — declare custom block types (`defineNode`) and inline
// marks (`defineMark`), bundle them with `baseSchema.extend(...)`, and pass the
// result to `createEditor({ schema })` / `createDoc({ schema: schema.data })`.
// The canvas-free `DataSchema` (`schema.data`) carries the CRDT + serialization
// facets; the full `Schema` adds the rendering nodes. v1 custom nodes are leaf
// void blocks that round-trip through a generic `<x-type …>` HTML tag.
export { UnknownNode, unknownNode } from "./rendering/nodes";
export { BoxNode, type BoxRenderStyle } from "./rendering/nodes/BoxNode";
export type {
  AttrSpec,
  BlockSpec,
  DefineMarkConfig,
  DefineNodeConfig,
  SchemaExtension,
} from "./schema";
export { baseSchema, defineMark, defineNode, Schema } from "./schema";
export type { CustomBlock } from "./serlization/loadPage";
export type { BlockSpecCore, DataSchema, MarkSpec } from "./sync/schema";
export { baseDataSchema } from "./sync/schema";

// Host adapters
export type { AssetResolver, SlashCommandProvider } from "./adapters";
export {
  getSlashCommands,
  resolveAssetUrl,
  setAssetResolver,
  setSlashCommandProvider,
} from "./adapters";

// Core document model + CRDT operation types
export type {
  Block,
  Char,
  CharRun,
  Mark,
  MarkSpan,
  Page,
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
  ScrollbarStyles,
  SlashCommand,
  ThemeTokens,
  VersionVector,
  ViewportState,
} from "./state-types";

// CRDT sync — the binding is the per-instance id/clock/peer-identity source;
// share one binding between `mountEditor` and `createSyncEngine`.
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
