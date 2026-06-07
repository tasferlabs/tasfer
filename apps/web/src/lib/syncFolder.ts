/**
 * syncFolder.ts — persists the on-disk folder the user picks for one-way export.
 *
 * Cypher's source of truth is the in-app CRDT; this folder is the *destination*
 * of a one-way mirror (pages → plain markdown). We persist the picked directory
 * so a later session can write to it without re-prompting:
 *   - the FileSystemDirectoryHandle is stored in IndexedDB (handles aren't JSON,
 *     but are structured-cloneable) inside a tiny key/value store;
 *   - the human-readable folder name is mirrored to localStorage so the UI can
 *     render it synchronously on first paint.
 *
 * The actual file-writing (the one-way sync) lives elsewhere — this module only
 * owns picking, persisting, and re-granting permission on the folder. There is
 * no module-level mutable state: every call opens its own IndexedDB connection.
 */

// Minimal typings for the File System Access API bits TS's lib.dom omits.
type FsPermissionMode = "read" | "readwrite";
interface FsPermissionHandle {
  queryPermission?(opts: { mode: FsPermissionMode }): Promise<PermissionState>;
  requestPermission?(opts: { mode: FsPermissionMode }): Promise<PermissionState>;
}
interface DirectoryPickerWindow {
  showDirectoryPicker?(opts?: {
    id?: string;
    mode?: FsPermissionMode;
    startIn?: string;
  }): Promise<FileSystemDirectoryHandle>;
}

const DB_NAME = "cypher-prefs";
const DB_VERSION = 1;
const STORE = "kv";
const HANDLE_KEY = "syncFolderHandle"; // IndexedDB
const NAME_KEY = "syncFolderName"; // localStorage

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Whether this runtime can pick a real directory (File System Access API). */
export function isSyncFolderSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function"
  );
}

/** Last-picked folder name, for synchronous UI rendering (may be stale). */
export function getSyncFolderName(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(NAME_KEY);
}

/**
 * Prompt for a folder and persist it. Returns the chosen folder name, or null if
 * unsupported or the user cancelled the picker.
 */
export async function pickSyncFolder(): Promise<{ name: string } | null> {
  const w = window as DirectoryPickerWindow;
  if (typeof w.showDirectoryPicker !== "function") return null;
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await w.showDirectoryPicker({
      id: "cypher-sync-folder",
      mode: "readwrite",
      startIn: "documents",
    });
  } catch {
    return null; // user dismissed the picker
  }
  await idbSet(HANDLE_KEY, handle);
  localStorage.setItem(NAME_KEY, handle.name);
  return { name: handle.name };
}

/** The persisted directory handle, or null if none has been saved. */
export async function getSyncFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY);
  return handle ?? null;
}

/**
 * Ensure read/write permission on the saved folder, re-prompting if the grant
 * has lapsed (handles persist across sessions, but permission may not). Returns
 * true once the folder is writable. Call this from sync code before writing.
 */
export async function ensureSyncFolderPermission(): Promise<boolean> {
  const handle = (await getSyncFolderHandle()) as
    | (FileSystemDirectoryHandle & FsPermissionHandle)
    | null;
  if (!handle) return false;
  const opts = { mode: "readwrite" as FsPermissionMode };
  if ((await handle.queryPermission?.(opts)) === "granted") return true;
  return (await handle.requestPermission?.(opts)) === "granted";
}

/** Forget the saved folder. */
export async function clearSyncFolder(): Promise<void> {
  await idbDelete(HANDLE_KEY);
  if (typeof window !== "undefined") localStorage.removeItem(NAME_KEY);
}
