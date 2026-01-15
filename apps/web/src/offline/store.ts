import { getDB, type CachedPage, type PendingImage } from "./db";
import type { Operation, HLC } from "@/editor/sync/types";
import type { Block } from "@/deserializer/loadPage";
import { isHLCLessOrEqual } from "@/editor/sync/hlc";

export class OfflineStore {
  private pageId: string;

  constructor(pageId: string) {
    this.pageId = pageId;
  }

  /**
   * Persist operations to IndexedDB.
   * Called after local operations are emitted.
   */
  async persistOperations(operations: Operation[]): Promise<void> {
    const db = await getDB();
    const tx = db.transaction("operations", "readwrite");

    for (const op of operations) {
      await tx.store.put({
        key: `${this.pageId}:${op.id}`,
        pageId: this.pageId,
        operation: op,
        synced: false,
      });
    }

    await tx.done;
  }

  /**
   * Load all persisted operations for this page.
   * Called on page mount to restore local state.
   */
  async loadOperations(): Promise<Operation[]> {
    const db = await getDB();
    const ops = await db.getAllFromIndex("operations", "by-page", this.pageId);
    return ops.map((o) => o.operation);
  }

  /**
   * Get unsynced operations for this page.
   * Used to determine what needs to be sent to server.
   */
  async getUnsyncedOperations(): Promise<Operation[]> {
    const db = await getDB();
    const tx = db.transaction("operations", "readonly");
    const index = tx.store.index("by-synced");

    // Get unsynced ops (synced = false = 0)
    const unsyncedOps = await index.getAll(
      IDBKeyRange.only([this.pageId, false])
    );

    await tx.done;
    return unsyncedOps.map((o) => o.operation);
  }

  /**
   * Mark operations as synced after server confirms save.
   * Operations at or before snapshotClock are considered synced.
   */
  async markSynced(snapshotClock: HLC): Promise<void> {
    const db = await getDB();
    const tx = db.transaction("operations", "readwrite");
    const index = tx.store.index("by-page");

    const ops = await index.getAll(this.pageId);

    for (const op of ops) {
      if (!op.synced && isHLCLessOrEqual(op.operation.clock, snapshotClock)) {
        op.synced = true;
        await tx.store.put(op);
      }
    }

    await tx.done;
  }

  /**
   * Remove synced operations to free up space.
   * Call periodically after confirming server has the data.
   */
  async compactSynced(): Promise<number> {
    const db = await getDB();
    const tx = db.transaction("operations", "readwrite");
    const index = tx.store.index("by-page");

    const ops = await index.getAll(this.pageId);
    let deleted = 0;

    for (const op of ops) {
      if (op.synced) {
        await tx.store.delete(op.key);
        deleted++;
      }
    }

    await tx.done;
    return deleted;
  }

  /**
   * Cache page snapshot for offline access.
   */
  async cachePageSnapshot(
    snapshot: Block[],
    clock: HLC | null
  ): Promise<void> {
    const db = await getDB();
    await db.put("pages", {
      id: this.pageId,
      snapshot,
      snapshotClock: clock,
      cachedAt: Date.now(),
    });
  }

  /**
   * Get cached page snapshot.
   */
  async getCachedSnapshot(): Promise<CachedPage | null> {
    const db = await getDB();
    const cached = await db.get("pages", this.pageId);
    return cached ?? null;
  }

  /**
   * Store an image blob for offline upload.
   */
  async storePendingImage(
    localId: string,
    blob: Blob,
    fileName: string,
    mimeType: string,
    blockId: string
  ): Promise<void> {
    const db = await getDB();
    await db.put("pendingImages", {
      localId,
      blob,
      fileName,
      mimeType,
      pageId: this.pageId,
      blockId,
      createdAt: Date.now(),
    });
  }

  /**
   * Get all pending images for this page.
   */
  async getPendingImages(): Promise<PendingImage[]> {
    const db = await getDB();
    return db.getAllFromIndex("pendingImages", "by-page", this.pageId);
  }

  /**
   * Remove a pending image after successful upload.
   */
  async removePendingImage(localId: string): Promise<void> {
    const db = await getDB();
    await db.delete("pendingImages", localId);
  }

  /**
   * Clear all data for this page.
   * Use when page is deleted.
   */
  async clearPageData(): Promise<void> {
    const db = await getDB();

    // Clear operations
    const opsTx = db.transaction("operations", "readwrite");
    const opsIndex = opsTx.store.index("by-page");
    const ops = await opsIndex.getAll(this.pageId);
    for (const op of ops) {
      await opsTx.store.delete(op.key);
    }
    await opsTx.done;

    // Clear cached snapshot
    await db.delete("pages", this.pageId);

    // Clear pending images
    const imgsTx = db.transaction("pendingImages", "readwrite");
    const imgsIndex = imgsTx.store.index("by-page");
    const imgs = await imgsIndex.getAll(this.pageId);
    for (const img of imgs) {
      await imgsTx.store.delete(img.localId);
    }
    await imgsTx.done;
  }
}

/**
 * Static methods for page list caching.
 */
export async function cachePageList(
  parentId: string | null,
  pages: import("@/app/api/pages.api").IListPage[]
): Promise<void> {
  const db = await getDB();
  await db.put("pageList", {
    parentId: parentId ?? "root",
    pages,
    cachedAt: Date.now(),
  });
}

export async function getCachedPageList(
  parentId: string | null
): Promise<import("@/app/api/pages.api").IListPage[] | null> {
  const db = await getDB();
  const cached = await db.get("pageList", parentId ?? "root");
  return cached?.pages ?? null;
}
