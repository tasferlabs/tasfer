/**
 * Web Driver
 *
 * Runs in the browser. Uses:
 * - wa-sqlite in a Web Worker (SQLite + AccessHandlePoolVFS on OPFS)
 * - OPFS (Origin Private File System) for file storage
 * - WebRTC for P2P networking (shared with all platforms)
 *
 * This is just the thin driver — all business logic is in Engine.
 */

import type { Driver, DbDriver, DbRow, DbRunResult, FsDriver, CryptoDriver } from "../driver";
import { createWebRtcNetworkDriver } from "./webrtc";
import SqliteWorker from "./sqlite.worker?worker";

// =============================================================================
// OPFS Filesystem Driver
// =============================================================================

class OpfsFsDriver implements FsDriver {
  private root: FileSystemDirectoryHandle | null = null;

  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    if (!this.root) {
      this.root = await navigator.storage.getDirectory();
    }
    return this.root;
  }

  private async getDir(
    path: string,
    create = false,
  ): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop()!;
    let dir = await this.getRoot();
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return { dir, name };
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      const { dir, name } = await this.getDir(path);
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const { dir, name } = await this.getDir(path, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data as ArrayBufferView<ArrayBuffer>);
    await writable.close();
  }

  async delete(path: string): Promise<void> {
    try {
      const { dir, name } = await this.getDir(path);
      await dir.removeEntry(name);
    } catch {
      // File doesn't exist — no-op
    }
  }

  async list(dirPath: string): Promise<string[]> {
    try {
      const parts = dirPath.split("/").filter(Boolean);
      let dir = await this.getRoot();
      for (const part of parts) {
        dir = await dir.getDirectoryHandle(part);
      }
      const names: string[] = [];
      for await (const key of (dir as any).keys()) {
        names.push(key);
      }
      return names;
    } catch {
      return [];
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { dir, name } = await this.getDir(path);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// Worker-backed Database Driver
// =============================================================================

class WorkerDbDriver implements DbDriver {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private txQueue: Promise<any> = Promise.resolve();

  constructor() {
    this.worker = new SqliteWorker();
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) {
        p.resolve(result);
      } else {
        p.reject(new Error(error));
      }
    };
  }

  private send(type: string, sql: string, params?: unknown[]): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, sql, params });
    });
  }

  async execute<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    return this.send("execute", sql, params);
  }

  async run(sql: string, params?: unknown[]): Promise<DbRunResult> {
    return this.send("run", sql, params);
  }

  async exec(sql: string): Promise<void> {
    await this.send("exec", sql);
  }

  async transaction<T>(fn: (db: DbDriver) => Promise<T>): Promise<T> {
    // Serialize transactions so concurrent callers don't interleave
    // their BEGIN/COMMIT messages on the single worker message queue.
    const prev = this.txQueue;
    let resolve!: () => void;
    this.txQueue = new Promise<void>((r) => { resolve = r; });

    await prev;
    try {
      await this.exec("BEGIN");
      const result = await fn(this);
      await this.exec("COMMIT");
      return result;
    } catch (e) {
      await this.exec("ROLLBACK");
      throw e;
    } finally {
      resolve();
    }
  }
}

// =============================================================================
// WebCrypto Driver
// =============================================================================

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

class WebCryptoDriver implements CryptoDriver {
  async generateKeypair(): Promise<{ publicKey: string; privateKey: string }> {
    const keyPair = await crypto.subtle.generateKey(
      { name: "Ed25519" } as any,
      true,
      ["sign", "verify"],
    );
    const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const privateKeyRaw = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    return {
      publicKey: bytesToHex(new Uint8Array(publicKeyRaw)),
      privateKey: bytesToHex(new Uint8Array(privateKeyRaw)),
    };
  }
}

// =============================================================================
// Web Driver (combines worker SQLite + OPFS + WebRTC)
// =============================================================================

export function createWebDriver(signalUrl: string): Driver {
  return {
    db: new WorkerDbDriver(),
    fs: new OpfsFsDriver(),
    crypto: new WebCryptoDriver(),
    network: createWebRtcNetworkDriver(signalUrl),
    basePath: "cypher",
  };
}
