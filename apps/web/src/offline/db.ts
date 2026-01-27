import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Operation, HLC } from "@/editor/sync/types";
import type { Block } from "@/deserializer/loadPage";
import type { IListPage } from "@/app/api/pages.api";

export interface PersistedOperation {
  key: string; // `${pageId}:${operationId}`
  pageId: string;
  operation: Operation;
  synced: boolean;
}

export interface CachedPage {
  id: string;
  snapshot: Block[];
  snapshotClock: HLC | null;
  cachedAt: number;
}

export interface CachedPageList {
  parentId: string;
  pages: IListPage[];
  cachedAt: number;
}

export interface QueuedMutation {
  id: string;
  url: string;
  method: "PUT" | "POST" | "DELETE";
  body: unknown;
  timestamp: number;
  retries: number;
}

export interface PendingImage {
  localId: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
  pageId: string;
  blockId: string;
  createdAt: number;
}

interface CypherDB extends DBSchema {
  operations: {
    key: string;
    value: PersistedOperation;
    indexes: {
      "by-page": string;
      "by-synced": [string, number]; // [pageId, synced as 0|1]
    };
  };

  pages: {
    key: string;
    value: CachedPage;
  };

  pageList: {
    key: string;
    value: CachedPageList;
  };

  mutations: {
    key: string;
    value: QueuedMutation;
  };

  pendingImages: {
    key: string;
    value: PendingImage;
    indexes: {
      "by-page": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<CypherDB>> | null = null;

export async function getDB(): Promise<IDBPDatabase<CypherDB>> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = openDB<CypherDB>("cypher-offline", 2, {
    upgrade(db, oldVersion) {
      // Handle upgrade from version 1: recreate operations store to fix index
      if (oldVersion === 1) {
        if (db.objectStoreNames.contains("operations")) {
          db.deleteObjectStore("operations");
        }
        // Recreate operations store with proper indexes
        const opsStore = db.createObjectStore("operations", { keyPath: "key" });
        opsStore.createIndex("by-page", "pageId");
        opsStore.createIndex("by-synced", ["pageId", "synced"]);
        return; // Other stores should already exist from v1
      }

      // Fresh install (oldVersion === 0)
      // Operations store
      const opsStore = db.createObjectStore("operations", { keyPath: "key" });
      opsStore.createIndex("by-page", "pageId");
      opsStore.createIndex("by-synced", ["pageId", "synced"]);

      // Pages cache
      db.createObjectStore("pages", { keyPath: "id" });

      // Page list cache
      db.createObjectStore("pageList", { keyPath: "parentId" });

      // Mutation queue
      db.createObjectStore("mutations", { keyPath: "id" });

      // Pending images
      const imagesStore = db.createObjectStore("pendingImages", {
        keyPath: "localId",
      });
      imagesStore.createIndex("by-page", "pageId");
    },
  });

  return dbPromise;
}
