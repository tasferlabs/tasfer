/** Test-only: an offline engine over in-memory SQLite. */

import { DatabaseSync } from "node:sqlite";
import type { DbDriver, DbRow, Driver } from "./driver";
import { WebCryptoDriver } from "./adapters/web-crypto";
import { Engine } from "./engine";

function memoryDb(): DbDriver {
  const db = new DatabaseSync(":memory:");
  const bind = (params: unknown[] = []) =>
    params.map((p) => (typeof p === "boolean" ? Number(p) : p)) as never[];
  const driver: DbDriver = {
    query: async <T extends DbRow = DbRow>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...bind(params)) as T[],
    mutate: async (sql, params) => {
      const r = db.prepare(sql).run(...bind(params));
      return {
        changes: Number(r.changes),
        lastInsertRowId: Number(r.lastInsertRowid),
      };
    },
    exec: async (sql) => {
      db.exec(sql);
    },
    transaction: async (fn) => {
      db.exec("BEGIN");
      try {
        const out = await fn(driver);
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return driver;
}

/**
 * A real `Engine` on an in-memory SQLite database, offline: for tests that need
 * the engine's own storage and merge rules rather than a fake of them.
 */
export async function memoryEngine(): Promise<{
  engine: Engine;
  publicKey: string;
  driver: Driver;
}> {
  const driver: Driver = {
    db: memoryDb(),
    fs: {
      read: async () => null,
      write: async () => {},
      delete: async () => {},
      list: async () => [],
      exists: async () => false,
    },
    crypto: new WebCryptoDriver(),
    network: {
      setLocalId: () => {},
      registerTopicKey: () => {},
      unregisterTopicKey: () => {},
      join: async () => {
        throw new Error("offline");
      },
      destroy: async () => {},
    },
    basePath: "test",
  };
  const engine = new Engine(driver);
  await engine.init();
  const { publicKey } = await engine.identity.get();
  return { engine, publicKey, driver };
}
