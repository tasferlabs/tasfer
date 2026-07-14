/**
 * Persistent-storage protection for the web build.
 *
 * Browser storage is "best-effort" by default: under disk pressure the
 * browser may evict this origin's IndexedDB/OPFS wholesale — and for a web
 * user that storage holds the only replica of their documents, so eviction
 * is permanent data loss. `navigator.storage.persist()` upgrades the origin
 * to persistent storage, which only an explicit "clear site data" removes.
 *
 * The grant is origin-wide, so requesting it from the window protects the
 * SQLite database written by the device-node SharedWorker too.
 *
 * Electron and Capacitor store data in real files outside the browser quota
 * system; there the status is "native" and nothing is requested.
 */

import { detectAdapter } from "@/platform";

export type PersistentStorageStatus =
  | "protected"
  | "unprotected"
  | "unsupported"
  | "native";

/** Current protection status, without prompting the user. */
export async function getPersistentStorageStatus(): Promise<PersistentStorageStatus> {
  if (detectAdapter() !== "web") return "native";
  if (!navigator.storage?.persisted) return "unsupported";
  try {
    return (await navigator.storage.persisted()) ? "protected" : "unprotected";
  } catch {
    return "unsupported";
  }
}

/**
 * Ask the browser to protect this origin's storage from eviction. Idempotent;
 * some browsers (Firefox) may show a permission prompt. Returns the resulting
 * status.
 */
export async function requestPersistentStorage(): Promise<PersistentStorageStatus> {
  if (detectAdapter() !== "web") return "native";
  if (!navigator.storage?.persist) return "unsupported";
  try {
    if (await navigator.storage.persisted()) return "protected";
    return (await navigator.storage.persist()) ? "protected" : "unprotected";
  } catch {
    return "unsupported";
  }
}
