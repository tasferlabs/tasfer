# @tasfer/provider-indexeddb

**Local-first persistence** for [`@tasfer/editor`](https://www.npmjs.com/package/@tasfer/editor).
Attach it to a document and its CRDT operation log is mirrored into IndexedDB —
reloads are instant and edits survive offline.

This is persistence, not a transport: it stores operations locally and replays
them on load.

## Install

```bash
npm install @tasfer/editor @tasfer/provider-indexeddb
```

## Usage

```ts
import { createIndexedDBProvider } from "@tasfer/provider-indexeddb";

const persistence = createIndexedDBProvider({
  doc: editor.doc,
  name: "notes/today",
});

await persistence.whenSynced; // the doc now reflects what's on disk
```

`name` is the logical document name and becomes the IndexedDB database key
(`tasfer:${name}`).

## Stacking with a network provider

It composes with a transport on the same doc — each ignores only its own echoes,
so disk and peers stay in sync without coordinating:

```ts
import { createIndexedDBProvider } from "@tasfer/provider-indexeddb";
import { createRelayProvider } from "@tasfer/provider-relay";

createIndexedDBProvider({ doc: editor.doc, name: "notes/today" });
createRelayProvider({ doc: editor.doc, room, relay, secret });
```

Disconnect, edit for an hour on a plane, reconnect — the CRDT merges your
changes with everyone else's deterministically. There is no "resolve conflicts"
dialog, because there are no conflicts to resolve.

The log is compacted automatically once it grows past `COMPACTION_THRESHOLD`,
which is exported if you want to tune around it.

## Documentation

[tasfer.app/docs/editor/collaboration](https://www.tasfer.app/docs/editor/collaboration)

## License

MIT
