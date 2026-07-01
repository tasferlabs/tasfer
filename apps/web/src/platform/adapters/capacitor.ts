/**
 * Capacitor Driver (iOS / Android)
 *
 * Uses Capacitor plugins for native capabilities:
 * - @capacitor-community/sqlite for the database
 * - @capacitor/filesystem for file storage
 *
 * This is just the thin driver — all business logic is in Engine.
 */

import type { Driver, DbDriver, DbRow, DbRunResult, FsDriver } from "../driver";
import { WebCryptoDriver } from "./web-crypto";
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

  // CapacitorSQLite doesn't support Uint8Array bind params — encode as base64
  // with a sentinel prefix so we can decode transparently on reads.
  private static readonly BLOB_PREFIX = "__blob__:";

  private encodeParam(v: unknown): unknown {
    if (v === undefined) return null;
    if (v instanceof Uint8Array) {
      return CapacitorDbDriver.BLOB_PREFIX + btoa(String.fromCharCode(...v));
    }
    return v;
  }

  private decodeRow<T extends DbRow>(row: T): T {
    const keys = Object.keys(row);
    const rowRec = row as Record<string, unknown>;
    if (!keys.some((k) => typeof rowRec[k] === "string" && (rowRec[k] as string).startsWith(CapacitorDbDriver.BLOB_PREFIX))) {
      return row;
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const val = rowRec[key];
      if (typeof val === "string" && val.startsWith(CapacitorDbDriver.BLOB_PREFIX)) {
        const binary = atob(val.slice(CapacitorDbDriver.BLOB_PREFIX.length));
        out[key] = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      } else {
        out[key] = val;
      }
    }
    return out as T;
  }

  async execute<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    await this.ensureDb();
    const result = await this.db.query({
      database: "cypher",
      statement: sql,
      values: params ? params.map((v) => this.encodeParam(v)) : [],
    });
    const rows = result.values ?? [];
    // iOS returns an ios_columns metadata row as the first element — skip it
    const data = rows.length > 0 && rows[0].ios_columns ? rows.slice(1) : rows;
    return data.map((r: DbRow) => this.decodeRow(r as T));
  }

  async run(sql: string, params?: unknown[]): Promise<DbRunResult> {
    await this.ensureDb();
    const result = await this.db.run({
      database: "cypher",
      statement: sql,
      values: params ? params.map((v) => this.encodeParam(v)) : [],
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
//
// The WebCrypto (Ed25519) driver is shared with the web adapter — `crypto.subtle`
// is available in the WebView as long as it runs in a secure context (the app's
// own scheme, HTTPS, or localhost). Live-reload dev must therefore be served over
// HTTPS; a plain-HTTP LAN origin is an insecure context and WebCrypto is undefined.
// The shared driver also carries a JS Ed25519 fallback for older Android System
// WebViews that expose crypto.subtle but not the Ed25519 curve.
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
