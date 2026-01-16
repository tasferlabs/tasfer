import { getDB, type CachedPage, type PendingImage } from "./db";
import type { Operation, HLC } from "@/editor/sync/types";
import type { Block } from "@/deserializer/loadPage";
import { isHLCLessOrEqual } from "@/editor/sync/hlc";
import { NativeStorage, PageStorage, ImageStorage } from "./native-storage";

export class OfflineStore {
  private pageId: string;
  private nativeStorage: PageStorage;

  constructor(pageId: string) {
    this.pageId = pageId;
    this.nativeStorage = new PageStorage(pageId);
  }

  /**
   * Persist operations to IndexedDB.
   * Called after local operations are emitted.
   * Note: Operations stay in IndexedDB for indexed queries; they're compacted after sync.
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
   * Uses native storage on iOS/Android (GB+ available), IndexedDB on web (50MB limit).
   */
  async cachePageSnapshot(
    snapshot: Block[],
    clock: HLC | null
  ): Promise<void> {
    if (NativeStorage.isNativeAvailable()) {
      // Use native file system storage (no browser quota limits)
      await this.nativeStorage.saveSnapshot({
        blocks: snapshot,
        clock,
        savedAt: Date.now(),
      });
    } else {
      // Fall back to IndexedDB for web
      const db = await getDB();
      await db.put("pages", {
        id: this.pageId,
        snapshot,
        snapshotClock: clock,
        cachedAt: Date.now(),
      });
    }
  }

  /**
   * Get cached page snapshot.
   * Tries native storage first on iOS/Android, then IndexedDB.
   */
  async getCachedSnapshot(): Promise<CachedPage | null> {
    if (NativeStorage.isNativeAvailable()) {
      // Try native storage first
      const native = await this.nativeStorage.loadSnapshot();
      if (native) {
        return {
          id: this.pageId,
          snapshot: native.blocks as Block[],
          snapshotClock: native.clock as HLC | null,
          cachedAt: native.savedAt,
        };
      }
    }

    // Fall back to IndexedDB
    const db = await getDB();
    const cached = await db.get("pages", this.pageId);
    return cached ?? null;
  }

  /**
   * Store an image blob for offline upload.
   * Uses native storage on iOS/Android for larger capacity.
   */
  async storePendingImage(
    localId: string,
    blob: Blob,
    fileName: string,
    mimeType: string,
    blockId: string
  ): Promise<void> {
    if (NativeStorage.isNativeAvailable()) {
      // Store image data in native storage
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      await ImageStorage.saveImage(localId, bytes);

      // Store metadata in IndexedDB (small, for querying)
      const db = await getDB();
      await db.put("pendingImages", {
        localId,
        blob: new Blob(), // Empty blob - actual data in native storage
        fileName,
        mimeType,
        pageId: this.pageId,
        blockId,
        createdAt: Date.now(),
      });
    } else {
      // Web: store everything in IndexedDB
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
  }

  /**
   * Get all pending images for this page.
   * Reconstructs blobs from native storage on iOS/Android.
   */
  async getPendingImages(): Promise<PendingImage[]> {
    const db = await getDB();
    const images = await db.getAllFromIndex("pendingImages", "by-page", this.pageId);

    if (NativeStorage.isNativeAvailable()) {
      // Reconstruct blobs from native storage
      const results: PendingImage[] = [];
      for (const img of images) {
        const bytes = await ImageStorage.loadImage(img.localId);
        if (bytes) {
          results.push({
            ...img,
            blob: new Blob([bytes], { type: img.mimeType }),
          });
        }
      }
      return results;
    }

    return images;
  }

  /**
   * Remove a pending image after successful upload.
   */
  async removePendingImage(localId: string): Promise<void> {
    if (NativeStorage.isNativeAvailable()) {
      // Remove from native storage
      await ImageStorage.deleteImage(localId);
    }

    // Remove metadata from IndexedDB
    const db = await getDB();
    await db.delete("pendingImages", localId);
  }

  /**
   * Clear all data for this page.
   * Use when page is deleted.
   */
  async clearPageData(): Promise<void> {
    // Clear native storage if available
    if (NativeStorage.isNativeAvailable()) {
      await this.nativeStorage.clearAll();
    }

    const db = await getDB();

    // Clear operations
    const opsTx = db.transaction("operations", "readwrite");
    const opsIndex = opsTx.store.index("by-page");
    const ops = await opsIndex.getAll(this.pageId);
    for (const op of ops) {
      await opsTx.store.delete(op.key);
    }
    await opsTx.done;

    // Clear cached snapshot from IndexedDB
    await db.delete("pages", this.pageId);

    // Clear pending images
    const imgsTx = db.transaction("pendingImages", "readwrite");
    const imgsIndex = imgsTx.store.index("by-page");
    const imgs = await imgsIndex.getAll(this.pageId);
    for (const img of imgs) {
      if (NativeStorage.isNativeAvailable()) {
        await ImageStorage.deleteImage(img.localId);
      }
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

/**
 * Get storage information across all storage backends.
 */
export async function getStorageStats(): Promise<{
  platform: "ios" | "android" | "web";
  free: number;
  total: number;
  used: number;
}> {
  const info = await NativeStorage.getStorageInfo();
  return {
    platform: NativeStorage.getPlatform(),
    ...info,
  };
}
