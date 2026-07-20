/**
 * @tasfer/provider-indexeddb — local-first persistence for the editor.
 *
 * Attach to any `@tasfer/editor` Doc to mirror its CRDT op log into
 * IndexedDB, so reloads are instant and edits survive offline:
 *
 *   import { createIndexedDBProvider } from "@tasfer/provider-indexeddb";
 *   const persistence = createIndexedDBProvider({ doc: editor.doc, name: "notes/today" });
 *   await persistence.whenSynced; // doc now reflects what's on disk
 *
 * This is persistence, not a transport — it stores ops locally and replays them
 * on load. It stacks cleanly with a network provider (e.g.
 * `@tasfer/provider-webrtc`) on the same doc: each ignores only its own
 * echoes, so disk and peers stay in sync without coordinating.
 */

export {
  COMPACTION_THRESHOLD,
  createIndexedDBProvider,
  type CreateIndexedDBProviderOptions,
  type IndexedDBProvider,
} from "./provider";
