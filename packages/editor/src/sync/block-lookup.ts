import type { Block, Page } from "../serlization/loadPage";

interface BlockIndexCache {
  length: number;
  readonly byId: Map<string, number>;
}

/**
 * Derived ID index keyed by the exact blocks-array identity. Immutable page
 * updates naturally receive a fresh cache; old arrays and their indexes are
 * garbage-collected together.
 */
const blockIndexes = new WeakMap<readonly Block[], BlockIndexCache>();

function createBlockIndex(blocks: readonly Block[]): BlockIndexCache {
  const cache = { length: blocks.length, byId: new Map<string, number>() };
  blockIndexes.set(blocks, cache);
  return cache;
}

/**
 * Find a raw block-array index by stable ID.
 *
 * Every cached hit is verified against the current array before it is returned.
 * The cache is populated lazily: a new immutable blocks array pays only the same
 * single scan the old implementation did, while repeated lookups of the same
 * selected block become O(1). Length changes and same-length reorders/
 * replacements caused by accidental in-place mutation invalidate or fail
 * validation before an index is returned.
 */
export function findBlockIndex(page: Page, blockId: string): number {
  const blocks = page.blocks;
  let cache = blockIndexes.get(blocks);
  if (!cache) {
    cache = createBlockIndex(blocks);
  } else if (cache.length !== blocks.length) {
    cache.length = blocks.length;
    cache.byId.clear();
  }

  const cachedIndex = cache.byId.get(blockId);
  if (cachedIndex !== undefined && blocks[cachedIndex]?.id === blockId) {
    return cachedIndex;
  }
  if (cachedIndex !== undefined) cache.byId.delete(blockId);

  const index = blocks.findIndex((block) => block.id === blockId);
  if (index >= 0) cache.byId.set(blockId, index);
  return index;
}

/** Find a block by stable ID through the validated centralized index. */
export function findBlock(page: Page, blockId: string): Block | undefined {
  const index = findBlockIndex(page, blockId);
  return index < 0 ? undefined : page.blocks[index];
}
