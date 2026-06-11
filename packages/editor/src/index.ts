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

// Interaction regions — canvas hit areas with their own hit detection and
// tap/drag behavior, shared across mouse and touch input. Chrome regions
// ship built-in (scrollbar, selection handles, peer indicators); hosts can
// register custom regions via `mountEditor`'s `regions` option. Nodes
// contribute geometry-only sub-regions via `Node.regions` (NodeHitRegion),
// with behavior bound by id in the event layer.
export type {
  PointerType,
  Region,
  RegionClaim,
  RegionCtx,
  RegionDragSpec,
  RegionPoint,
  RegionResult,
} from "./events/regions";
export { RegionRegistry } from "./events/regions";

// Editor instance API
export type {
  Editor,
  EditorCommandChain,
  EditorCommands,
  EditorEvent,
  MarkName,
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
  FormatSpan,
  Page,
  TextFormat,
} from "./serlization/loadPage";
export type {
  CRDTbinding,
  EditorState,
  EditorStrings,
  EditorStyles,
  FontFamily,
  FontStyles,
  HLC,
  Operation,
  SlashCommand,
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

// Fonts — the host registers font families/stacks and loads the faces, then
// notifies the editor. The editor itself ships no bundled fonts.
export {
  getCurrentFontFamily,
  notifyFontsChanged,
  notifyFontsLoaded,
  onFontsReady,
  setCurrentFontFamily,
} from "./fonts";
export { getFontStyles, setFontStyles } from "./styles";
