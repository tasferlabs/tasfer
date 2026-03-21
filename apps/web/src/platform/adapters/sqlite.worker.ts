/**
 * SQLite Web Worker
 *
 * Runs wa-sqlite with AccessHandlePoolVFS inside a dedicated worker
 * so createSyncAccessHandle() is available and all DB work is off
 * the main thread.
 */

import { Factory } from "wa-sqlite";
// @ts-ignore — untyped module
import moduleFactory from "wa-sqlite/dist/wa-sqlite.mjs";
// @ts-ignore — untyped module
import { AccessHandlePoolVFS } from "wa-sqlite/src/examples/AccessHandlePoolVFS.js";

type WorkerRequest =
  | { id: number; type: "execute"; sql: string; params?: unknown[] }
  | { id: number; type: "run"; sql: string; params?: unknown[] }
  | { id: number; type: "exec"; sql: string };

type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

let sqlite3: any;
let db: number;

async function init() {
  const module = await moduleFactory({
    locateFile: (file: string) => `/${file}`,
  });
  sqlite3 = Factory(module);

  const vfs = new AccessHandlePoolVFS("cypher-vfs");
  await vfs.isReady;

  // Ensure exactly TARGET_CAPACITY pool slots — previous versions
  // accidentally called addCapacity() on every load, accumulating
  // hundreds of OPFS access handles and slowing down init.
  const TARGET_CAPACITY = 10;
  const current = vfs.getCapacity();
  if (current < TARGET_CAPACITY) {
    await vfs.addCapacity(TARGET_CAPACITY - current);
  } else if (current > TARGET_CAPACITY) {
    await vfs.removeCapacity(current - TARGET_CAPACITY);
  }

  sqlite3.vfs_register(vfs, true);
  db = await sqlite3.open_v2("cypher.db");
}

async function execute(
  sql: string,
  params?: unknown[],
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];

  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params) {
      sqlite3.bind_collection(stmt, params);
    }
    const columns: string[] = sqlite3.column_names(stmt);
    while ((await sqlite3.step(stmt)) === /* SQLITE_ROW */ 100) {
      const values = sqlite3.row(stmt);
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = values[i];
      }
      rows.push(obj);
    }
  }

  return rows;
}

async function run(
  sql: string,
  params?: unknown[],
): Promise<{ changes: number }> {
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params) {
      sqlite3.bind_collection(stmt, params);
    }
    await sqlite3.step(stmt);
  }

  return { changes: sqlite3.changes(db) };
}

async function exec(sql: string): Promise<void> {
  await sqlite3.exec(db, sql);
}

const ready = init();

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  await ready;

  const msg = e.data;
  let response: WorkerResponse;

  try {
    switch (msg.type) {
      case "execute":
        response = {
          id: msg.id,
          ok: true,
          result: await execute(msg.sql, msg.params),
        };
        break;
      case "run":
        response = {
          id: msg.id,
          ok: true,
          result: await run(msg.sql, msg.params),
        };
        break;
      case "exec":
        await exec(msg.sql);
        response = { id: msg.id, ok: true, result: null };
        break;
      // default:
      //   response = { id: msg.id, ok: false, error: `Unknown message type: ${(msg as any).type}` };
      //   break;
    }
  } catch (err: any) {
    response = { id: msg.id, ok: false, error: err?.message ?? String(err) };
  }

  self.postMessage(response);
};
