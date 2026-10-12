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
import {
  findNextVisibleBlockIndex,
  findPreviousVisibleBlockIndex,
} from "./sync/reducer";

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
 * A {@link ViewWindow} over every block AFTER the document's title block (see
 * {@link titleBlockIndex}) — the body half of a split view, paired with a
 * {@link titleBlockWindow} editor on the same doc. A document with no text block
 * is all body. Blocks before the title (a leading image or divider) belong to
 * neither half, so the window is one contiguous run and no selection inside it
 * can span the title. Merges never cross a window edge, so Backspace at the
 * start of the body leaves the title alone.
 *
 * A document holding only its title yields an empty window: nothing renders and
 * the editor holds no caret until the host inserts a first body block.
 */
export function bodyBlocksWindow(): ViewWindow {
  return {
    select: (blocks) => {
      const included = new Set<number>();
      for (let i = titleBlockIndex(blocks) + 1; i < blocks.length; i++) {
        if (!blocks[i].deleted) included.add(i);
      }
      return included;
    },
  };
}

/**
 * Whether the block at `index` is inside `window`. A full-document editor (no
 * window) holds every block. Edits that join two blocks check both sides, so a
 * windowed editor never merges its block into one it does not show.
 */
export function isInViewWindow(
  window: ViewWindow | undefined,
  blocks: readonly Block[],
  index: number,
): boolean {
  return !window || window.select(blocks).has(index);
}

/**
 * The block a Backspace at the start of block `index` would join with: the
 * previous non-deleted block, or null when there is none or it lies outside
 * `window` — the window edge acts as the document start.
 */
export function previousBlockInWindow(
  window: ViewWindow | undefined,
  blocks: Block[],
  index: number,
): number | null {
  const prev = findPreviousVisibleBlockIndex(blocks, index);
  return prev !== null && isInViewWindow(window, blocks, prev) ? prev : null;
}

/**
 * The block a Delete at the end of block `index` would join with: the next
 * non-deleted block, or null when there is none or it lies outside `window` —
 * the window edge acts as the document end.
 */
export function nextBlockInWindow(
  window: ViewWindow | undefined,
  blocks: Block[],
  index: number,
): number | null {
  const next = findNextVisibleBlockIndex(blocks, index);
  return next !== null && isInViewWindow(window, blocks, next) ? next : null;
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
