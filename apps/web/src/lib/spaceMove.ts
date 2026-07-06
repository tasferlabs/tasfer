/**
 * Move a page (and its whole subtree) from one space into another.
 *
 * A page belongs to exactly one space and its content ops are scoped by its id,
 * so a cross-space "move" is a recreate: each page in the subtree is rebuilt as
 * a brand-new page in the destination space (new id, copied content), then the
 * originals are removed from the source via the normal delete() tombstone (CRDT
 * ops are never hard-deleted). This keeps every space's ids self-contained and
 * sidesteps the unresolvable page_add/page_remove race a shared id would create
 * for peers who belong to both spaces.
 *
 * Pure (no React): callers drive progress through {@link MoveProgress} and use
 * the returned id map to redirect a currently-open page to its new id.
 */

import { getPlatform } from "@/platform";

export interface MoveProgress {
  done: number;
  total: number;
}

export interface MoveAcrossSpacesOptions {
  /** Parent (in the target space) the dragged root lands under; null = top level. */
  targetParentId?: string | null;
  /** Sort order for the dragged root among its new siblings; omit to append. */
  order?: number;
  /** Called as each page is recreated so a host can render a progress bar. */
  onProgress?: (progress: MoveProgress) => void;
  /** Polled between pages; return true to stop before the source is purged. */
  isAborted?: () => boolean;
}

export interface MoveAcrossSpacesResult {
  /** New id of the dragged root, or null if nothing was moved. */
  newRootId: string | null;
  /** old page id → new page id, for every page in the moved subtree. */
  idMap: Map<string, string>;
  /** Whether the move was aborted before the source was removed. */
  aborted: boolean;
}

/**
 * Recreate `rootId`'s subtree in `targetSpaceId`, then remove the originals.
 *
 * The subtree is returned parent-before-child, so each page's remapped parent
 * id is already known by the time we reach it. If the caller aborts partway,
 * the pages recreated so far are kept but the source is left intact — the user
 * sees a partial copy rather than lost data.
 */
export async function movePageAcrossSpaces(
  rootId: string,
  targetSpaceId: string,
  opts: MoveAcrossSpacesOptions = {},
): Promise<MoveAcrossSpacesResult> {
  const platform = getPlatform();
  const aborted = () => opts.isAborted?.() ?? false;

  const subtree = await platform.pages.subtree(rootId);
  const total = subtree.length;
  const idMap = new Map<string, string>();

  opts.onProgress?.({ done: 0, total });

  for (let i = 0; i < subtree.length; i++) {
    if (aborted()) {
      return { newRootId: idMap.get(rootId) ?? null, idMap, aborted: true };
    }

    const item = subtree[i];
    const isRoot = item.id === rootId;
    // The root lands at the drop target; descendants keep their relative
    // parent/order within the moved subtree, remapped to freshly created ids.
    const parentId = isRoot
      ? (opts.targetParentId ?? null)
      : (idMap.get(item.parentId!) ?? null);
    // The root uses the caller's drop order (undefined → append into the target
    // list). Descendants keep their source order so siblings stay stable.
    const order = isRoot ? opts.order : item.order;

    const newId = await platform.pages.recreateInSpace({
      sourceId: item.id,
      spaceId: targetSpaceId,
      parentId,
      order,
    });
    idMap.set(item.id, newId);

    opts.onProgress?.({ done: i + 1, total });
  }

  // Everything is safely recreated — remove the source subtree. This is the
  // normal soft-delete tombstone (archive + page_remove), so the originals land
  // in the source Bin (recoverable) and their CRDT ops are retained, never
  // hard-deleted.
  await platform.pages.delete(rootId);

  return { newRootId: idMap.get(rootId) ?? null, idMap, aborted: false };
}
