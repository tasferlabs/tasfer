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
  BlockView,
  BlockViewRegistry,
  createBlockViewRegistry,
  createDefaultBlockViewRegistry,
  imageBlockView,
  lineBlockView,
  ListBlockView,
  listBlockView,
  textBlockView,
} from "./rendering/blocks";

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
  EditorState,
  EditorStyles,
  FontFamily,
  FontStyles,
  SlashCommand,
  ViewportState,
} from "./state-types";
export type { HLC, Operation } from "./sync/crdt-types";

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
