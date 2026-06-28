/**
 * Block ordering — the canonical sort over a page's blocks.
 *
 * Kept in its own DOM-free module so headless hosts (e.g. the device-node
 * SharedWorker in `apps/web`) can order blocks without importing `crdt-utils`,
 * which pulls in selection/rendering code that touches `document`. Depends only
 * on the pure op-id comparator and the `Block` type.
 */

import type { Block } from "../serlization/loadPage";
import { compareBlocks } from "./id";

/**
 * Sort blocks by their fractional-index `orderKey`. Ties (equal keys, e.g. a
 * concurrent insert at the same anchor) break by `-compareBlocks`: the HIGHER
 * id (newer insert) sorts first, so pressing Enter mid-document lands the fresh
 * block immediately after the current one, ahead of a pre-existing sibling.
 * This mirrors the char-level skip-greater-ids rule in `insertIntoRuns`.
 *
 * @param blocks - All blocks (any order, may include deleted)
 * @returns Ordered array of all blocks (including tombstones)
 */
export function sortBlocksByOrder(blocks: Block[]): Block[] {
  return blocks.slice().sort((a, b) => {
    const ak = a.orderKey ?? "";
    const bk = b.orderKey ?? "";
    if (ak !== bk) {
      return ak < bk ? -1 : 1;
    }
    return -compareBlocks(a, b);
  });
}
