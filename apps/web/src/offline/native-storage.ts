/**
 * Native Storage Bridge
 *
 * Provides unified storage API that uses native file system on iOS/Android
 * and falls back to IndexedDB on web. Native storage bypasses browser
 * quota limits (50MB) and can use GB+ of device storage.
 */

import { getBridge } from "@/platform/bridge";


/**
 * Encode Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode object to JSON and then to Uint8Array
 */
function encodeJSON(obj: unknown): Uint8Array {
  const json = JSON.stringify(obj);
  return new TextEncoder().encode(json);
}

/**
 * Decode Uint8Array to JSON object
 */
function decodeJSON<T>(bytes: Uint8Array): T {
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as T;
}

// Simple in-memory fallback for web (will be replaced with IndexedDB integration)
const webFallbackStorage = new Map<string, Uint8Array>();

export const NativeStorage = {
  /**
   * Check if native storage is available (iOS or Android)
   */
  isNativeAvailable(): boolean {
    return !!getBridge();
  },

  /**
   * Write binary data to a file path
   */
  async write(path: string, data: Uint8Array): Promise<void> {
    const bridge = getBridge();
    const base64 = uint8ArrayToBase64(data);

    if (bridge) {
      const success = await bridge.storage.write(path, base64);
      if (!success) throw new Error("Failed to write file");
    } else {
      webFallbackStorage.set(path, data);
    }
  },

  /**
   * Write JSON object to a file path
   */
  async writeJSON(path: string, obj: unknown): Promise<void> {
    const data = encodeJSON(obj);
    await this.write(path, data);
  },

  /**
   * Read binary data from a file path
   */
  async read(path: string): Promise<Uint8Array | null> {
    const bridge = getBridge();

    if (bridge) {
      const base64 = await bridge.storage.read(path);
      return base64 ? base64ToUint8Array(base64) : null;
    } else {
      return webFallbackStorage.get(path) ?? null;
    }
  },

  /**
   * Read JSON object from a file path
   */
  async readJSON<T>(path: string): Promise<T | null> {
    const data = await this.read(path);
    if (!data) return null;
    try {
      return decodeJSON<T>(data);
    } catch {
      return null;
    }
  },

  /**
   * Delete a file or directory
   */
  async delete(path: string): Promise<void> {
    const bridge = getBridge();

    if (bridge) {
      await bridge.storage.delete(path);
    } else {
      for (const key of webFallbackStorage.keys()) {
        if (key === path || key.startsWith(path + "/")) {
          webFallbackStorage.delete(key);
        }
      }
    }
  },

  /**
   * List files in a directory
   */
  async list(path: string): Promise<string[]> {
    const bridge = getBridge();

    if (bridge) {
      return bridge.storage.list(path);
    } else {
      const prefix = path ? path + "/" : "";
      const files = new Set<string>();
      for (const key of webFallbackStorage.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const firstPart = rest.split("/")[0];
          files.add(firstPart);
        }
      }
      return Array.from(files);
    }
  },

  /**
   * Check if a file exists
   */
  async exists(path: string): Promise<boolean> {
    const bridge = getBridge();

    if (bridge) {
      return bridge.storage.exists(path);
    } else {
      return webFallbackStorage.has(path);
    }
  },

  /**
   * Get storage info (free space, total space)
   */
  async getStorageInfo(): Promise<{ free: number; total: number; used: number }> {
    const bridge = getBridge();

    if (bridge) {
      const info = await bridge.storage.getInfo();
      return { ...info, used: info.total - info.free };
    } else {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const quota = estimate.quota ?? 50 * 1024 * 1024;
        const usage = estimate.usage ?? 0;
        return {
          free: quota - usage,
          total: quota,
          used: usage,
        };
      }
      return {
        free: 50 * 1024 * 1024,
        total: 50 * 1024 * 1024,
        used: 0,
      };
    }
  },
};

/**
 * Page-specific storage helper for snapshots and operations
 */
export class PageStorage {
  private pageId: string;

  constructor(pageId: string) {
    this.pageId = pageId;
  }

  private snapshotPath(): string {
    return `snapshots/${this.pageId}.json`;
  }

  private operationsPath(): string {
    return `operations/${this.pageId}`;
  }

  private operationPath(opId: string): string {
    return `operations/${this.pageId}/${opId}.json`;
  }

  /**
   * Save page snapshot
   */
  async saveSnapshot(snapshot: {
    blocks: unknown[];
    clock: unknown | null;
    savedAt: number;
  }): Promise<void> {
    await NativeStorage.writeJSON(this.snapshotPath(), snapshot);
  }

  /**
   * Load page snapshot
   */
  async loadSnapshot(): Promise<{
    blocks: unknown[];
    clock: unknown | null;
    savedAt: number;
  } | null> {
    return NativeStorage.readJSON(this.snapshotPath());
  }

  /**
   * Delete page snapshot
   */
  async deleteSnapshot(): Promise<void> {
    await NativeStorage.delete(this.snapshotPath());
  }

  /**
   * Save an operation
   */
  async saveOperation(operation: { id: string; [key: string]: unknown }): Promise<void> {
    await NativeStorage.writeJSON(this.operationPath(operation.id), operation);
  }

  /**
   * Load all operations for this page
   */
  async loadOperations(): Promise<Array<{ id: string; [key: string]: unknown }>> {
    const files = await NativeStorage.list(this.operationsPath());
    const operations: Array<{ id: string; [key: string]: unknown }> = [];

    for (const file of files) {
      if (file.endsWith(".json")) {
        const op = await NativeStorage.readJSON<{ id: string; [key: string]: unknown }>(
          `${this.operationsPath()}/${file}`
        );
        if (op) operations.push(op);
      }
    }

    return operations;
  }

  /**
   * Delete an operation
   */
  async deleteOperation(opId: string): Promise<void> {
    await NativeStorage.delete(this.operationPath(opId));
  }

  /**
   * Clear all operations for this page
   */
  async clearOperations(): Promise<void> {
    await NativeStorage.delete(this.operationsPath());
  }

  /**
   * Clear all data for this page
   */
  async clearAll(): Promise<void> {
    await Promise.all([this.deleteSnapshot(), this.clearOperations()]);
  }
}

/**
 * Image storage helper
 */
export const ImageStorage = {
  imagePath(imageId: string): string {
    return `images/${imageId}`;
  },

  async saveImage(imageId: string, data: Uint8Array): Promise<void> {
    await NativeStorage.write(this.imagePath(imageId), data);
  },

  async loadImage(imageId: string): Promise<Uint8Array | null> {
    return NativeStorage.read(this.imagePath(imageId));
  },

  async deleteImage(imageId: string): Promise<void> {
    await NativeStorage.delete(this.imagePath(imageId));
  },

  async imageExists(imageId: string): Promise<boolean> {
    return NativeStorage.exists(this.imagePath(imageId));
  },

  async listImages(): Promise<string[]> {
    return NativeStorage.list("images");
  },
};
