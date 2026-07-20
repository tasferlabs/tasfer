/**
 * Capacitor Driver (iOS / Android)
 *
 * Uses Capacitor plugins for native capabilities:
 * - TasferSqlite (own plugin, system SQLite, no SQLCipher) for the database
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
type FilesystemPlugin = any;

// =============================================================================
// Capacitor SQLite Driver
//
// Backed by the app's own `TasferSqlite` Capacitor plugin (iOS
// SqliteBridgePlugin / Android SqlitePlugin), which links the OS's system
// SQLite — plain SQLite, no bundled SQLCipher, so the app ships no encryption
// code. The plugin's wire shape matches what this driver expects: `{ values }`
// from query, `{ changes: { changes, lastId } }` from mutate.
// =============================================================================

class CapacitorDbDriver implements DbDriver {
  private plugin: any = null;
  private initPromise: Promise<void> | null = null;

  private ensureDb(): Promise<void> {
    if (this.plugin) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._openDb().catch((e) => {
      this.initPromise = null;
      throw e;
    });
    return this.initPromise;
  }

  private async _openDb(): Promise<void> {
    // registerPlugin only builds a JS proxy, so it's safe to load lazily and
    // keep native code out of the web build. The native TasferSqlite plugin
    // opens a plain (unencrypted) system-SQLite database.
    // @ts-ignore — optional native dependency, only available in Capacitor builds
    const { registerPlugin } = await import("@capacitor/core");
    const plugin = registerPlugin("TasferSqlite");
    await plugin.open({ database: "tasfer" });
    this.plugin = plugin;
  }

  // Uint8Array bind params can't cross the JSON bridge as bytes — encode as
  // base64 with a sentinel prefix so we can decode transparently on reads.
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

  async query<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    await this.ensureDb();
    const result = await this.plugin.query({
      statement: sql,
      values: params ? params.map((v) => this.encodeParam(v)) : [],
    });
    const rows = result.values ?? [];
    return rows.map((r: DbRow) => this.decodeRow(r as T));
  }

  async mutate(sql: string, params?: unknown[]): Promise<DbRunResult> {
    await this.ensureDb();
    const result = await this.plugin.mutate({
      statement: sql,
      values: params ? params.map((v) => this.encodeParam(v)) : [],
    });
    return {
      changes: result.changes?.changes ?? 0,
      lastInsertRowId: result.changes?.lastId,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.ensureDb();
    await this.plugin.exec({ statements: sql });
  }

  private txQueue: Promise<any> = Promise.resolve();

  async transaction<T>(fn: (db: DbDriver) => Promise<T>): Promise<T> {
    // Serialize transactions to prevent interleaving. mutate()/exec() never
    // auto-wrap on our native side, so a transaction is just begin/…/commit.
    const prev = this.txQueue;
    let resolve!: () => void;
    this.txQueue = new Promise<void>((r) => { resolve = r; });

    await prev;
    try {
      await this.ensureDb();
      await this.plugin.beginTransaction();
      const result = await fn(this);
      await this.plugin.commitTransaction();
      return result;
    } catch (e) {
      try {
        await this.plugin.rollbackTransaction();
      } catch {
        // Rollback may fail if transaction was never started
      }
      throw e;
    } finally {
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
    basePath: "tasfer",
  };
}
