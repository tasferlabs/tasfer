/**
 * idb — thin, dependency-free Promise wrappers over the raw IndexedDB API.
 *
 * The browser's IndexedDB surface is event-based (`onsuccess`/`onerror`) and
 * famously awkward to compose. These helpers each adapt a single request or
 * transaction into a Promise so the provider can read like ordinary async code.
 * Everything here is stateless — callers own the `IDBDatabase` handle and pass
 * it in, so nothing is shared across editor instances (no module-level state).
 *
 * Storage scheme
 * --------------
 * One IndexedDB database per document, named `tasfer:${name}`, holding a single
 * object store {@link OPLOG_STORE} with an auto-increment key. Each record is a
 * *batch* of ops (the op array delivered by one `Doc` update, or one compacted
 * snapshot of the whole log). Appending is therefore O(1); reading the log back
 * is a single cursor-free `getAll`. Isolating each doc in its own database makes
 * {@link clearStore} / deletion trivial and keeps unrelated docs from sharing a
 * version-upgrade lifecycle.
 */

/** The sole object store name inside every per-doc database. */
export const OPLOG_STORE = "oplog";

/** Database name for a given logical document `name`. */
export function dbNameFor(name: string): string {
  return `tasfer:${name}`;
}

/** Adapt a single `IDBRequest` into a Promise of its result. */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Adapt a transaction's completion into a Promise (resolves on `complete`). */
function txnDone(txn: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    txn.oncomplete = () => resolve();
    txn.onerror = () => reject(txn.error);
    txn.onabort = () => reject(txn.error);
  });
}

/**
 * Open (creating/upgrading as needed) the per-doc database for `name`,
 * ensuring the {@link OPLOG_STORE} object store exists.
 */
export function openDB(name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbNameFor(name), 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OPLOG_STORE)) {
        db.createObjectStore(OPLOG_STORE, { autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error(`IndexedDB open blocked for "${dbNameFor(name)}"`));
  });
}

/**
 * Append one batch of values under a fresh auto-increment key.
 * Returns once the write transaction has committed.
 */
export async function append<T>(db: IDBDatabase, batch: T): Promise<void> {
  const txn = db.transaction(OPLOG_STORE, "readwrite");
  txn.objectStore(OPLOG_STORE).add(batch);
  await txnDone(txn);
}

/**
 * Read every stored batch back, in insertion order. The provider flattens the
 * returned batches into a single op array to replay into the doc.
 */
export async function readAll<T>(db: IDBDatabase): Promise<T[]> {
  const txn = db.transaction(OPLOG_STORE, "readonly");
  const result = await requestToPromise(txn.objectStore(OPLOG_STORE).getAll());
  await txnDone(txn);
  return result as T[];
}

/** Remove every batch from the store (the document's persisted log). */
export async function clearStore(db: IDBDatabase): Promise<void> {
  const txn = db.transaction(OPLOG_STORE, "readwrite");
  txn.objectStore(OPLOG_STORE).clear();
  await txnDone(txn);
}

/**
 * Atomically replace the entire store with a single batch: clear, then add,
 * inside one readwrite transaction. Used by compaction so a reload never sees a
 * half-rewritten log — the transaction either commits whole or aborts whole.
 */
export async function replaceAll<T>(db: IDBDatabase, batch: T): Promise<void> {
  const txn = db.transaction(OPLOG_STORE, "readwrite");
  const store = txn.objectStore(OPLOG_STORE);
  store.clear();
  store.add(batch);
  await txnDone(txn);
}
