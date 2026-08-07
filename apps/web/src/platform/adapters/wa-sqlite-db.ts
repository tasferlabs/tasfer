/**
 * wa-sqlite DbDriver backed by IndexedDB (IDBBatchAtomicVFS).
 *
 * Runs SQLite *inside the caller's context* and exposes it as a {@link DbDriver}.
 * This is the single web SQLite backend: it lives in the device-node SharedWorker
 * engine host, where the `Engine` runs in the SharedWorker and talks to SQLite
 * directly rather than proxying every statement over a message port.
 *
 * Why IndexedDB and not OPFS: the faster OPFS VFS (AccessHandlePoolVFS) needs
 * `FileSystemFileHandle.createSyncAccessHandle()`, which is exposed *only* in a
 * DedicatedWorkerGlobalScope. A SharedWorker can neither call it nor spawn a
 * nested dedicated `Worker` to do so (Chromium doesn't expose `Worker` in
 * SharedWorkerGlobalScope). IndexedDB is reachable from every worker context, so
 * the SharedWorker stores the database there. IDBBatchAtomicVFS is an async VFS,
 * hence the Asyncify ("-async") wasm build.
 */

import { Factory } from "wa-sqlite";
// @ts-ignore — untyped module
import moduleFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
// @ts-ignore — untyped module
import { IDBBatchAtomicVFS } from "wa-sqlite/src/examples/IDBBatchAtomicVFS.js";

import type { DbDriver, DbRow, DbRunResult } from "../driver";

const SQLITE_ROW = 100;

export class WaSqliteDb implements DbDriver {
  private sqlite3: any;
  private db!: number;
  private ready: Promise<void>;
  /**
   * Serializes *every* SQLite API call. The Asyncify ("-async") wasm build the
   * IndexedDB VFS requires keeps a single suspended call stack, so two operations
   * in flight at once corrupt its rewind state and trap ("memory access out of
   * bounds"), poisoning the connection so later calls fail with "unable to open
   * database file". One queue = at most one operation in flight.
   */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Called once if the lock is already held, before we start waiting for it.
   * Lets the host tell connected tabs why startup is stalled.
   */
  private onLockContended?: () => void;

  constructor(opts: { acquireLock: boolean; onLockContended?: () => void }) {
    this.onLockContended = opts.onLockContended;
    this.ready = this.init(opts.acquireLock);
  }

  /** Resolve once the database is open and migrated-ready. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async init(acquireLock: boolean): Promise<void> {
    if (acquireLock) await this.acquireDbLock();

    const module = await moduleFactory();
    this.sqlite3 = Factory(module);

    // IndexedDB-backed VFS: works in any worker context (including this
    // SharedWorker), unlike the OPFS sync-access-handle VFS.
    const vfs = new IDBBatchAtomicVFS("tasfer-vfs");
    this.sqlite3.vfs_register(vfs, true);
    this.db = await this.sqlite3.open_v2("tasfer.db");
  }

  /**
   * Hold the `tasfer-app` lock for the lifetime of this worker, so two builds
   * never open the same database at once.
   *
   * A SharedWorker is keyed by its script URL, and ours is content-hashed, so a
   * deploy produces a *second* worker: tabs opened before it keep the old one
   * alive, tabs opened after start the new one. The new worker therefore finds
   * the lock held and must wait — the previous build releases it as soon as its
   * last tab closes or reloads. We probe first only to report the contention;
   * the wait itself is an ordinary queued request that lands on its own.
   */
  private async acquireDbLock(): Promise<void> {
    const locks = (self as any).navigator?.locks;
    if (!locks) return;
    if (await this.holdDbLock(locks, { ifAvailable: true })) return;
    this.onLockContended?.();
    await this.holdDbLock(locks, {});
  }

  /**
   * Take `tasfer-app` and never give it back. Resolves true once held; with
   * `ifAvailable` it resolves false instead of waiting when someone else holds
   * it. A Web Locks failure resolves true so a broken lock API can't wedge
   * startup — a single worker per origin is the common case regardless.
   */
  private holdDbLock(locks: any, opts: object): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      locks
        .request("tasfer-app", opts, (lock: unknown) => {
          if (!lock) {
            resolve(false);
            return;
          }
          resolve(true);
          // Never resolve — holds the lock until the worker dies.
          return new Promise(() => {});
        })
        .catch(() => resolve(true));
    });
  }

  /**
   * Run `fn` with exclusive access to the connection: it starts only after every
   * previously enqueued operation settles, so no two ever overlap inside the
   * single-stack Asyncify runtime. See {@link queue}.
   */
  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async query<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    await this.ready;
    return this.enqueue(() => this.rawQuery<T>(sql, params));
  }

  async mutate(sql: string, params?: unknown[]): Promise<DbRunResult> {
    await this.ready;
    return this.enqueue(() => this.rawMutate(sql, params));
  }

  async exec(sql: string): Promise<void> {
    await this.ready;
    await this.enqueue(() => this.sqlite3.exec(this.db, sql));
  }

  async transaction<T>(fn: (db: DbDriver) => Promise<T>): Promise<T> {
    await this.ready;
    // Hold the queue for the whole transaction; `fn` gets a view that calls the
    // raw (unlocked) primitives directly, since re-entering the queue here would
    // deadlock against the slot this transaction already holds.
    return this.enqueue(async () => {
      await this.sqlite3.exec(this.db, "BEGIN");
      try {
        const result = await fn(this.rawView);
        await this.sqlite3.exec(this.db, "COMMIT");
        return result;
      } catch (e) {
        await this.sqlite3.exec(this.db, "ROLLBACK");
        throw e;
      }
    });
  }

  /** Lock-free primitives. Only call while holding the queue (see {@link enqueue}). */
  private async rawQuery<T extends DbRow = DbRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const rows: DbRow[] = [];
    for await (const stmt of this.sqlite3.statements(this.db, sql)) {
      if (params) this.sqlite3.bind_collection(stmt, params);
      const columns: string[] = this.sqlite3.column_names(stmt);
      while ((await this.sqlite3.step(stmt)) === SQLITE_ROW) {
        const values = this.sqlite3.row(stmt);
        const obj: DbRow = {};
        for (let i = 0; i < columns.length; i++) obj[columns[i]] = values[i];
        rows.push(obj);
      }
    }
    return rows as T[];
  }

  private async rawMutate(sql: string, params?: unknown[]): Promise<DbRunResult> {
    for await (const stmt of this.sqlite3.statements(this.db, sql)) {
      if (params) this.sqlite3.bind_collection(stmt, params);
      await this.sqlite3.step(stmt);
    }
    return { changes: this.sqlite3.changes(this.db) };
  }

  /** Unlocked DbDriver view handed to {@link transaction} callbacks. */
  private rawView: DbDriver = {
    query: (sql, params) => this.rawQuery(sql, params),
    mutate: (sql, params) => this.rawMutate(sql, params),
    exec: (sql) => this.sqlite3.exec(this.db, sql),
    transaction: () => {
      throw new Error("nested transactions are not supported");
    },
  };
}
