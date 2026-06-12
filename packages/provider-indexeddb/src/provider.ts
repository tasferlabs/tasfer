/**
 * createIndexedDBProvider — local-first persistence for a {@link Doc}.
 *
 * This is a *persistence* provider, not a network transport. It mirrors a
 * document's CRDT operation log into IndexedDB so that reopening the page is
 * instant and fully offline: on construction it replays the stored log back
 * into the doc, and from then on it appends every fresh op batch as it happens.
 *
 *   const persistence = createIndexedDBProvider({ doc: editor.doc, name: "notes/today" });
 *   await persistence.whenSynced; // doc now reflects what's on disk
 *
 * Echo control (why this stacks with a network provider)
 * ------------------------------------------------------
 * Every batch we replay from disk is applied with our private {@link IDB}
 * origin symbol, and our `doc.on("update")` handler skips updates carrying that
 * origin — so we never re-persist what we just loaded. Crucially the guard is
 * scoped to *our own* origin only:
 *
 *   - Ops a network provider applies arrive with *its* origin → not `IDB` →
 *     we persist them. Good: remote edits reach the disk.
 *   - Ops we load arrive with `IDB` → the network provider's guard (keyed to
 *     *its* symbol, not ours) sees "not mine" → it broadcasts them. Good: a
 *     freshly-restored doc catches peers up.
 *
 * The two guards compose precisely because each ignores only its own origin.
 * Mounting an IndexedDB provider and a WebRTC provider on the same doc needs no
 * coordination between them.
 *
 * Storage layout & compaction
 * ----------------------------
 * The log lives in a per-doc IndexedDB database (`cypher:${name}`) as a sequence
 * of appended op batches — see {@link ./idb}. Appends are O(1), but an unbounded
 * batch count would slow the initial `readAll`. So once {@link COMPACTION_THRESHOLD}
 * batches have accumulated, the store is rewritten in a single atomic transaction
 * to one compacted entry holding `doc.getOperations()` (the full deduped log).
 * Correctness is preserved either way — the CRDT log replays to the same state
 * regardless of how it was chunked.
 */

import type { Doc, Operation } from "@cypherkit/editor";

import { append, clearStore, openDB, readAll, replaceAll } from "./idb";

/**
 * Batch-count threshold at which the store is compacted into a single entry.
 * Chosen as a balance: high enough that compaction is rare on a normal editing
 * session, low enough that the initial-load `readAll` never fans out over a huge
 * number of records.
 */
export const COMPACTION_THRESHOLD = 200;

export interface CreateIndexedDBProviderOptions {
  /** The document to persist. Its op log is mirrored to IndexedDB. */
  doc: Doc;
  /**
   * Logical document name — the IndexedDB database key (`cypher:${name}`). Use
   * a stable, per-document string (e.g. a path like `"notes/today"`); two docs
   * sharing a name share a store.
   */
  name: string;
}

export interface IndexedDBProvider {
  /**
   * Resolves once the initial load from IndexedDB has been replayed into the
   * doc. Await it to guarantee the first paint reflects what's on disk. Never
   * rejects on a read error — it resolves regardless so a corrupt/empty store
   * can't deadlock the host; load failures surface as a fresh (empty) doc.
   */
  readonly whenSynced: Promise<void>;
  /** Wipe this document's persisted log. The in-memory doc is untouched. */
  clearData(): Promise<void>;
  /**
   * Detach from the doc and close the IndexedDB connection. Does NOT delete
   * data — use {@link clearData} for that. Idempotent.
   */
  destroy(): void;
}

export function createIndexedDBProvider(
  options: CreateIndexedDBProviderOptions,
): IndexedDBProvider {
  const { doc, name } = options;

  /** Origin stamped on batches we replay from disk — our echo guard. */
  const IDB = Symbol("cypher-idb");

  /** Resolved once the open handle is ready (for clearData/destroy ordering). */
  let db: IDBDatabase | null = null;
  /** How many batches are currently stored — drives compaction. */
  let batchCount = 0;
  /** Pending writes are chained here so they commit in op-arrival order. */
  let writeChain: Promise<void> = Promise.resolve();
  let destroyed = false;

  /** Append a batch (or compact), serialized after any in-flight write. */
  const enqueueWrite = (ops: Operation[]): void => {
    writeChain = writeChain
      .then(async () => {
        if (destroyed || !db || ops.length === 0) return;
        if (batchCount + 1 >= COMPACTION_THRESHOLD) {
          // Fold everything (including this batch, already in the doc's log)
          // into one entry, atomically.
          await replaceAll(db, doc.getOperations());
          batchCount = 1;
        } else {
          await append(db, ops);
          batchCount += 1;
        }
      })
      .catch(() => {
        // Swallow write errors: a failed persist must not break editing, and
        // must not poison the chain for subsequent writes.
      });
  };

  // ── Persist on change ─────────────────────────────────────────────────────
  // Skip our own loaded batches (origin === IDB); persist everything else —
  // local editor edits and ops a stacked network provider applied alike.
  const offDoc = doc.on("update", (update) => {
    if (update.origin === IDB) return;
    if (update.ops.length === 0) return;
    enqueueWrite(update.ops);
  });

  // ── Initial load ──────────────────────────────────────────────────────────
  const whenSynced = (async () => {
    try {
      const opened = await openDB(name);
      if (destroyed) {
        // Raced with destroy(): close the just-opened handle and bail.
        opened.close();
        return;
      }
      db = opened;
      const batches = await readAll<Operation[]>(db);
      batchCount = batches.length;
      const ops = batches.flat();
      if (ops.length > 0) {
        doc.applyUpdate(ops, IDB);
      }
    } catch {
      // A read/open failure resolves to an empty load rather than rejecting,
      // so the host still gets a usable (in-memory) doc.
    }
  })();

  return {
    whenSynced,

    async clearData(): Promise<void> {
      // Wait out the initial load + any queued writes so we don't clear a
      // store that's mid-write, then reset the batch counter.
      await whenSynced;
      await writeChain;
      if (db) await clearStore(db);
      batchCount = 0;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      offDoc();
      if (db) {
        db.close();
        db = null;
      }
    },
  };
}
