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

// Editor instance API
export type { Editor } from "./entries/editor";
export { default as createEditor } from "./entries/editor";

// Host adapters
export type { AssetResolver } from "./adapters";
export { resolveAssetUrl, setAssetResolver } from "./adapters";

// Core document model + CRDT operation types
export type {
  Block,
  Char,
  CharRun,
  FormatSpan,
  Page,
  TextFormat,
} from "./serlization/loadPage";
export type { EditorState, SlashCommand, ViewportState } from "./state-types";
export type { HLC, Operation } from "./sync/types";
