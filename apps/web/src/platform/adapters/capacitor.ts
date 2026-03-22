/**
 * Capacitor Driver (iOS / Android)
 *
 * Uses Capacitor plugins for native capabilities:
 * - @capacitor-community/sqlite for the database
 * - @capacitor/filesystem for file storage
 *
 * This is just the thin driver — all business logic is in Engine.
 */

import type { Driver, DbDriver, DbRow, DbRunResult, FsDriver, CryptoDriver } from "../driver";
import { createWebRtcNetworkDriver } from "./webrtc";

// These modules are only available when running as a Capacitor app.
// Dynamic imports ensure they don't break the web build.
// @ts-ignore — optional native dependency
type CapacitorSQLitePlugin = any;
// @ts-ignore — optional native dependency
type FilesystemPlugin = any;

// =============================================================================
// Capacitor SQLite Driver
// =============================================================================

class CapacitorDbDriver implements DbDriver {
  private db: any = null;
  private initPromise: Promise<void> | null = null;
  private inTransaction = false;

  private ensureDb(): Promise<void> {
    if (this.db) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._openDb().catch((e) => {
      this.initPromise = null;
      throw e;
    });
    return this.initPromise;
  }

  private async _openDb(): Promise<void> {
    // Dynamic import — only loaded on native
    // @ts-ignore — optional native dependency, only available in Capacitor builds
    const { CapacitorSQLite } = await import("@capacitor-community/sqlite");
    // Connection may already exist after a page reload
    try {
      await CapacitorSQLite.createConnection({
        database: "cypher",
        version: 1,
        encrypted: false,
        mode: "no-encryption",
      });
    } catch {
      // Already exists — that's fine
    }
    await CapacitorSQLite.open({ database: "cypher" });
    // Store without returning — CapacitorSQLite is a thenable proxy
    // and must never be the resolved value of a promise.
    this.db = CapacitorSQLite;
  }

  async execute<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    await this.ensureDb();
    const result = await this.db.query({
      database: "cypher",
      statement: sql,
      values: params ?? [],
    });
    const rows = result.values ?? [];
    // iOS returns an ios_columns metadata row as the first element — skip it
    if (rows.length > 0 && rows[0].ios_columns) {
      return rows.slice(1) as T[];
    }
    return rows as T[];
  }

  async run(sql: string, params?: unknown[]): Promise<DbRunResult> {
    await this.ensureDb();
    const result = await this.db.run({
      database: "cypher",
      statement: sql,
      values: params ?? [],
      // The plugin auto-wraps each run() in a transaction by default.
      // Disable that when we're already inside an explicit transaction.
      transaction: !this.inTransaction,
    });
    return {
      changes: result.changes?.changes ?? 0,
      lastInsertRowId: result.changes?.lastId,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.ensureDb();
    await this.db.execute({
      database: "cypher",
      statements: sql,
      transaction: !this.inTransaction,
    });
  }

  private txQueue: Promise<any> = Promise.resolve();

  async transaction<T>(fn: (db: DbDriver) => Promise<T>): Promise<T> {
    // Serialize transactions to prevent interleaving
    const prev = this.txQueue;
    let resolve!: () => void;
    this.txQueue = new Promise<void>((r) => { resolve = r; });

    await prev;
    try {
      await this.ensureDb();
      await this.db.beginTransaction({ database: "cypher" });
      this.inTransaction = true;
      const result = await fn(this);
      await this.db.commitTransaction({ database: "cypher" });
      return result;
    } catch (e) {
      try {
        await this.db.rollbackTransaction({ database: "cypher" });
      } catch {
        // Rollback may fail if transaction was never started
      }
      throw e;
    } finally {
      this.inTransaction = false;
      resolve();
    }
  }
}

// =============================================================================
// Capacitor Filesystem Driver
// =============================================================================

class CapacitorFsDriver implements FsDriver {
  private fs: any = null;
  private fsPromise: Promise<any> | null = null;

  private getFs(): Promise<any> {
    if (this.fs) return Promise.resolve(this.fs);
    if (this.fsPromise) return this.fsPromise;

    this.fsPromise = this._loadFs().catch((e) => {
      this.fsPromise = null;
      throw e;
    });
    return this.fsPromise;
  }

  private async _loadFs(): Promise<any> {
    // @ts-ignore — optional native dependency, only available in Capacitor builds
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    this.fs = { Filesystem, Directory };
    return this.fs;
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      const { Filesystem, Directory } = await this.getFs();
      const result = await Filesystem.readFile({
        path,
        directory: Directory.Data,
      });
      // Capacitor returns base64
      const binary = atob(result.data as string);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return null;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const { Filesystem, Directory } = await this.getFs();
    // Convert to base64
    let binary = "";
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    const base64 = btoa(binary);

    await Filesystem.writeFile({
      path,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });
  }

  async delete(path: string): Promise<void> {
    try {
      const { Filesystem, Directory } = await this.getFs();
      await Filesystem.deleteFile({ path, directory: Directory.Data });
    } catch {
      // No-op if doesn't exist
    }
  }

  async list(dir: string): Promise<string[]> {
    try {
      const { Filesystem, Directory } = await this.getFs();
      const result = await Filesystem.readdir({
        path: dir,
        directory: Directory.Data,
      });
      return result.files.map((f: any) => f.name);
    } catch {
      return [];
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { Filesystem, Directory } = await this.getFs();
      await Filesystem.stat({ path, directory: Directory.Data });
      return true;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// Create Capacitor Driver
// =============================================================================

// =============================================================================
// WebCrypto Driver (same as web — WebCrypto is available in WebView)
// =============================================================================

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
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

  async sign(privateKey: string, message: Uint8Array): Promise<string> {
    const keyData = hexToBytes(privateKey);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      keyData.buffer as ArrayBuffer,
      { name: "Ed25519" } as any,
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("Ed25519" as any, key, message.buffer as ArrayBuffer);
    return bytesToHex(new Uint8Array(signature));
  }

  async verify(publicKey: string, signature: string, message: Uint8Array): Promise<boolean> {
    const keyData = hexToBytes(publicKey);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData.buffer as ArrayBuffer,
      { name: "Ed25519" } as any,
      false,
      ["verify"],
    );
    const sig = hexToBytes(signature);
    return crypto.subtle.verify("Ed25519" as any, key, sig.buffer as ArrayBuffer, message.buffer as ArrayBuffer);
  }
}

// =============================================================================
// Create Capacitor Driver
// =============================================================================

export function createCapacitorDriver(signalUrl: string): Driver {
  return {
    db: new CapacitorDbDriver(),
    fs: new CapacitorFsDriver(),
    crypto: new WebCryptoDriver(),
    network: createWebRtcNetworkDriver(signalUrl),
    basePath: "cypher",
  };
}
