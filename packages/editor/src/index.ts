/**
 * @cypherkit/editor — public surface.
 *
 * Phase 1 of the extraction: this re-exports the headless editor core. Deep
 * subpath imports (e.g. `@cypherkit/editor/sync/awareness`) remain available
 * for now; a curated public API is a follow-up.
 */

// Mount / lifecycle
export { mountEditor } from "./mount";
export type { MountedEditor, MountEditorOptions } from "./mount";

// Editor instance API
export { default as createEditor } from "./editor";
export type { Editor } from "./editor";

// Host adapters
export { setAssetResolver, resolveAssetUrl } from "./adapters";
export type { AssetResolver } from "./adapters";

// Core document model + CRDT operation types
export type {
  Block,
  Page,
  TextFormat,
  CharRun,
  FormatSpan,
  Char,
} from "./deserializer/loadPage";
export type { Operation, HLC } from "./sync/types";
export type { EditorState, ViewportState, SlashCommand } from "./types";
