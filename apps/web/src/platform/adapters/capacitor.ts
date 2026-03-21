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
  private dbPromise: Promise<any> | null = null;

  private ensureDb(): Promise<any> {
    if (this.db) return Promise.resolve(this.db);
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = this._openDb().catch((e) => {
      this.dbPromise = null;
      throw e;
    });
    return this.dbPromise;
  }

  private async _openDb(): Promise<any> {
    // Dynamic import — only loaded on native
    // @ts-ignore — optional native dependency, only available in Capacitor builds
    const { CapacitorSQLite } = await import("@capacitor-community/sqlite");
    await CapacitorSQLite.createConnection({
      database: "cypher",
      version: 1,
      encrypted: false,
      mode: "no-encryption",
    });
    await CapacitorSQLite.open({ database: "cypher" });
    this.db = CapacitorSQLite;
    return this.db;
  }

  async execute<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const db = await this.ensureDb();
    const result = await db.query({
      database: "cypher",
      statement: sql,
      values: params ?? [],
    });
    return (result.values ?? []) as T[];
  }

  async run(sql: string, params?: unknown[]): Promise<DbRunResult> {
    const db = await this.ensureDb();
    const result = await db.run({
      database: "cypher",
      statement: sql,
      values: params ?? [],
    });
    return {
      changes: result.changes?.changes ?? 0,
      lastInsertRowId: result.changes?.lastId,
    };
  }

  async exec(sql: string): Promise<void> {
    const db = await this.ensureDb();
    await db.execute({ database: "cypher", statements: sql });
  }

  private txQueue: Promise<any> = Promise.resolve();

  async transaction<T>(fn: (db: DbDriver) => Promise<T>): Promise<T> {
    // Serialize transactions to prevent nested BEGIN statements
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

export function createCapacitorDriver(): Driver {
  return {
    db: new CapacitorDbDriver(),
    fs: new CapacitorFsDriver(),
    basePath: "cypher",
  };
}
