/**
 * View-window builders — construct a {@link ViewWindow} that scopes an editor to
 * a subset of a shared document's blocks (see `ViewWindow` and the `window`
 * option on `mountEditor`/`createEditor`/`useEditor`).
 *
 * A window is node/mark-agnostic in the CORE (`getVisibleBlocks` just applies
 * `window.select`); these builders are the host-facing helpers that encode a
 * concrete rule, in one place, on top of that generic mechanism. They mint no
 * ids and read only block type/order, so two peers building the same window over
 * the same blocks resolve the same view.
 */

import { type Block } from "./serlization/loadPage";
import type { ViewWindow } from "./state-types";
import { isTextualBlock } from "./sync/block-registry";

const EMPTY: ReadonlySet<number> = new Set<number>();

/**
 * Index of the block a document treats as its TITLE: the first non-deleted
 * text-bearing block in document order (heading, paragraph, list, quote, code,
 * math — anything that holds text), skipping non-text blocks (image, divider).
 * Returns -1 when the document has no text block.
 *
 * This is the block a `TitleEditor` binds to and the reader sees as the top
 * line. Unlike {@link extractTitleFromBlocks} — which returns the title STRING,
 * skips empty blocks, and prefers a heading — this identifies a stable block
 * even while the title is empty, so an editor window does not jump as the user
 * clears or retypes the title.
 */
export function titleBlockIndex(blocks: readonly Block[]): number {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.deleted) continue;
    if (isTextualBlock(block)) return i;
  }
  return -1;
}

/**
 * A single-block {@link ViewWindow} scoped to the document's title block (see
 * {@link titleBlockIndex}). Pair it with `schema.restrict({ blocks: ["heading1"],
 * marks: [...] })` to build a title surface over a shared `Doc`: it renders and
 * edits only the title block and can never create, split, or merge blocks. An
 * empty document (no text block) yields an empty window (nothing rendered).
 */
export function titleBlockWindow(): ViewWindow {
  return {
    select: (blocks) => {
      const index = titleBlockIndex(blocks);
      return index < 0 ? EMPTY : new Set([index]);
    },
    singleBlock: true,
  };
}

/**
 * A single-block {@link ViewWindow} scoped to the block with the given id, or an
 * empty window if that block is absent or deleted. Binds an editor to one
 * specific block of a shared doc (e.g. a card field or a comment body).
 */
export function blockIdWindow(id: string): ViewWindow {
  return {
    select: (blocks) => {
      const index = blocks.findIndex((b) => b.id === id && !b.deleted);
      return index < 0 ? EMPTY : new Set([index]);
    },
    singleBlock: true,
  };
}
