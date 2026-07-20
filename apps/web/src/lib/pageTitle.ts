// Deep-import the canvas-free modules rather than the package barrels: this
// helper also runs inside the platform engine's SharedWorker (deriving titles
// from received content ops), and the root/`internal` barrels pull rendering
// and font code that touches `document` at module init.
import { extractTitleMarkdownFromBlocks } from "@tasfer/editor/serlization/codecs/inline";
import type { Block } from "@tasfer/editor/serlization/loadPage";
import { isHeadingType } from "@tasfer/editor/sync/block-registry";
import {
  extractBodyText,
  extractTitleFromBlocks,
  findTitleBlock,
} from "@tasfer/editor/sync/char-runs";
import { appDataSchema } from "../appDataSchema";

/**
 * The page's full-text body projection (every textual block's visible text),
 * derived from the doc's blocks. A LOCAL, rebuildable cache like the title
 * columns — it backs the `pages.body_text` search index (see
 * Engine.refreshDerivedTitlesFromBlocks) and is never replicated.
 */
export { extractBodyText };

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
    titleMd: extractTitleMarkdownFromBlocks(blocks, appDataSchema),
  };
}

/**
 * Whether these blocks carry their title in a heading (as opposed to falling
 * back to the first paragraph, or having no title at all). Import uses this to
 * decide when to substitute the file name: `deriveTitles` happily promotes a
 * leading paragraph to the title, but an imported document with no heading
 * should be titled by its file name instead.
 */
export function hasHeadingTitle(blocks: Block[] | undefined): boolean {
  const block = findTitleBlock(blocks);
  return block != null && isHeadingType(block.type);
}
