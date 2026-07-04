// Deep-import the canvas-free modules rather than the package barrels: this
// helper also runs inside the platform engine's SharedWorker (deriving titles
// from received content ops), and the root/`internal` barrels pull rendering
// and font code that touches `document` at module init.
import { getBaseDataSchema } from "@cypherkit/editor/baseDataSchema";
import { extractTitleMarkdownFromBlocks } from "@cypherkit/editor/serlization/codecs/inline";
import type { Block } from "@cypherkit/editor/serlization/loadPage";
import { extractTitleFromBlocks } from "@cypherkit/editor/sync/char-runs";

/**
 * Both title record strings, derived from the doc's blocks: `title` is the
 * title line's visible text (marks stripped — search, tab titles, filenames),
 * `titleMd` the same line as inline markdown (marks intact — rich previews
 * via `TitlePreview`).
 *
 * These are LOCAL, rebuildable caches: the doc and its operation log are the
 * source of truth, and titles are never replicated as metadata. The live
 * editor derives them from its in-memory blocks on save; the platform engine
 * re-derives them from content ops it receives (Engine.refreshDerivedTitles),
 * so every peer's title columns always mirror its own copy of the doc.
 */
export function deriveTitles(blocks: Block[] | undefined): {
  title: string;
  titleMd: string;
} {
  return {
    title: extractTitleFromBlocks(blocks),
    titleMd: extractTitleMarkdownFromBlocks(blocks, getBaseDataSchema()),
  };
}
