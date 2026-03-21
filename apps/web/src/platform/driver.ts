/**
 * Driver Interface
 *
 * The minimal contract each platform must implement.
 * Everything else (queries, snapshot logic, identity management)
 * lives in the shared Engine and is written ONCE.
 *
 * - Electron:  better-sqlite3 (via IPC) + node:fs
 * - Capacitor: @capacitor-community/sqlite + @capacitor/filesystem
 * - Web:       sql.js (WASM) + OPFS / Cache API
 */

// =============================================================================
// Database
// =============================================================================

export interface DbRow {
  [column: string]: unknown;
}

export interface DbRunResult {
  /** Number of rows affected */
  changes: number;
  /** Last inserted row ID (if applicable) */
  lastInsertRowId?: number;
}

export interface DbDriver {
  /** Execute a SELECT query and return rows */
  execute<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;

  /** Execute an INSERT / UPDATE / DELETE statement */
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;

  /** Execute a raw SQL statement (DDL, pragma, etc.) */
  exec(sql: string): Promise<void>;

  /** Run multiple statements inside a transaction */
  transaction<T>(fn: (db: DbDriver) => Promise<T>): Promise<T>;
}

// =============================================================================
// Filesystem
// =============================================================================

export interface FsDriver {
  /** Read a file as bytes. Returns null if not found. */
  read(path: string): Promise<Uint8Array | null>;

  /** Write bytes to a file, creating parent directories as needed. */
  write(path: string, data: Uint8Array): Promise<void>;

  /** Delete a file. No-op if it doesn't exist. */
  delete(path: string): Promise<void>;

  /** List filenames in a directory. Returns [] if directory doesn't exist. */
  list(dir: string): Promise<string[]>;

  /** Check if a path exists. */
  exists(path: string): Promise<boolean>;
}

// =============================================================================
// Combined Driver
// =============================================================================

export interface Driver {
  db: DbDriver;
  fs: FsDriver;

  /**
   * Base path for the cypher workspace.
   * e.g. "~/cypher-workspace/.cypher" on desktop,
   * or an app-scoped path on mobile.
   */
  basePath: string;
}
