# P2P Offline-Tolerant Live Updates Implementation Plan

## Overview

Add peer-to-peer collaborative editing with full offline support to Cypher editor using a **custom operation-log CRDT** for automatic conflict resolution.

**Requirements:**

- Multi-user real-time collaboration
- Cross-device sync for single users
- Full offline editing (create/edit/delete)
- Auto-merge conflicts via CRDT
- Self-hosted signaling server

**Why Custom Instead of Yjs:**

- Full control over data structures and conflict resolution
- Optimized for block-based editor (not generic CRDT)
- Easier debugging (our code, not opaque library)
- Smaller bundle (~2-4KB vs ~8KB)
- Built-in undo/redo via operation replay
- Free version history / time travel

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      User Device                            │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────────┐   │
│  │EditorState│◄──►│ OpLog CRDT   │◄──►│  IndexedDB     │   │
│  └──────────┘    └──────────────┘    └─────────────────┘   │
│                         │                                   │
│                         │ Operations                        │
│                         ▼                                   │
│                  ┌─────────────┐                           │
│                  │ SyncManager │                           │
│                  └──────┬──────┘                           │
│                         │                                   │
└─────────────────────────│───────────────────────────────────┘
                          │ WebRTC
               ┌──────────┴──────────┐
               │                     │
    ┌──────────▼──────────┐   ┌──────▼──────┐
    │  Signaling Server   │   │   Peers     │
    │  (/apps/signaling)  │   │  (WebRTC)   │
    └──────────┬──────────┘   └─────────────┘
               │
    ┌──────────▼──────────┐
    │    PostgreSQL       │
    │  (Server Backup)    │
    └─────────────────────┘
```

---

## Core CRDT Design

### Hybrid Logical Clock (HLC)

Every operation is timestamped with an HLC for total ordering:

```typescript
interface HLC {
  wall: number; // Date.now()
  logical: number; // Increment when wall time equals previous
  peerId: string; // Tie-breaker for concurrent ops
}

// Comparison: wall → logical → peerId (lexicographic)
function compareHLC(a: HLC, b: HLC): number {
  if (a.wall !== b.wall) return a.wall - b.wall;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.peerId.localeCompare(b.peerId);
}
```

### The 6 Minimal Operations

Every editor mutation reduces to these 6 operations:

```typescript
interface BaseOp {
  id: string; // Unique: `${peerId}:${counter}`
  clock: HLC; // When it happened
  pageId: string; // Which page
}

// Text operations (within a block)
type TextInsert = BaseOp & {
  op: "text_insert";
  blockId: string;
  afterCharId: string | null; // Insert after this char (null = start)
  chars: CharData[]; // Characters to insert
};

type TextDelete = BaseOp & {
  op: "text_delete";
  blockId: string;
  charIds: string[]; // Characters to delete (tombstone)
};

type FormatSet = BaseOp & {
  op: "format_set";
  blockId: string;
  charIds: string[]; // Characters to format
  format: FormatType; // bold, italic, code, strikethrough, link
  value: boolean | string; // true/false or URL for links
};

// Block operations
type BlockInsert = BaseOp & {
  op: "block_insert";
  afterBlockId: string | null; // Insert after this block (null = start)
  blockId: string; // New block's ID
  blockType: BlockType;
  initialProps?: BlockProps; // indent, checked, url, alt
};

type BlockDelete = BaseOp & {
  op: "block_delete";
  blockId: string; // Block to delete (tombstone)
};

type BlockSet = BaseOp & {
  op: "block_set";
  blockId: string;
  field: string; // type, indent, checked, url, alt
  value: unknown;
};

type Operation =
  | TextInsert
  | TextDelete
  | FormatSet
  | BlockInsert
  | BlockDelete
  | BlockSet;
```

### Character-Level CRDT (RGA-style)

Each character has a unique ID for conflict-free concurrent edits:

```typescript
interface CharData {
  id: string; // Unique: `${peerId}:${counter}`
  char: string; // The actual character
}

// In-memory representation (after applying ops)
interface Char {
  id: string;
  char: string;
  deleted: boolean; // Tombstone - not actually removed
}
```

**Why character IDs?** Numeric positions break with concurrent edits:

- User A inserts "X" at position 5
- User B inserts "Y" at position 5
- Without IDs: conflict! With IDs: both succeed, deterministic order

### Block Ordering

Blocks use a **linked list with tombstones**:

```typescript
interface BlockState {
  id: string;
  afterId: string | null; // Which block this comes after
  deleted: boolean; // Tombstone
  type: BlockType;
  props: BlockProps; // indent, checked, url, alt
  chars: Char[]; // Text content with char IDs
  formats: FormatSpan[]; // Format ranges
}

interface FormatSpan {
  startCharId: string;
  endCharId: string;
  format: FormatType;
  value: boolean | string;
  clock: HLC; // LWW for same span conflicts
}
```

**Ordering algorithm:**

1. Build adjacency map: `afterId → blockId[]`
2. Walk from `null` (start) following links
3. Multiple blocks with same `afterId`? Sort by block ID (deterministic)
4. Skip deleted blocks in final output

---

## Command → Operation Mapping

| Editor Command                     | Operations Emitted                             |
| ---------------------------------- | ---------------------------------------------- |
| `insertText("ab")`                 | `text_insert` (2 chars)                        |
| `deleteText` (backspace)           | `text_delete` (1 char)                         |
| `deleteSelectedText` (range)       | `text_delete` (N chars)                        |
| `deleteSelectedText` (multi-block) | `text_delete` + `block_delete` × N             |
| `toggleBold` on selection          | `format_set` (bold, toggle)                    |
| `updateLinkInBlock`                | `format_set` (link, url)                       |
| `clearLinkInBlock`                 | `format_set` (link, null)                      |
| `splitBlock` at pos                | `block_insert` + `text_delete` + `text_insert` |
| `convertBlockType`                 | `block_set` (type)                             |
| `indentListItem`                   | `block_set` (indent, +1)                       |
| `outdentListItem`                  | `block_set` (indent, -1)                       |
| `toggleTodoChecked`                | `block_set` (checked, toggle)                  |
| `updateImageBlock`                 | `block_set` (url), `block_set` (alt)           |
| `applySlashCommand`                | `text_delete` + `block_set` (type)             |

### Example: splitBlock

```typescript
function splitBlock(state: EditorState, position: number): Operation[] {
  const block = getCurrentBlock(state);
  const charsToMove = block.chars.slice(position);
  const newBlockId = generateId();

  return [
    // 1. Insert new block after current
    {
      op: "block_insert",
      afterBlockId: block.id,
      blockId: newBlockId,
      blockType: "paragraph",
      ...baseOp(),
    },
    // 2. Delete chars from current block
    {
      op: "text_delete",
      blockId: block.id,
      charIds: charsToMove.map((c) => c.id),
      ...baseOp(),
    },
    // 3. Insert chars into new block
    {
      op: "text_insert",
      blockId: newBlockId,
      afterCharId: null,
      chars: charsToMove.map((c) => ({ id: generateId(), char: c.char })),
      ...baseOp(),
    },
  ];
}
```

---

## State Management

### Operation Log

```typescript
interface OpLog {
  // All operations for a page, ordered by HLC
  operations: Operation[];

  // Version vector: what we've seen from each peer
  versionVector: Map<string, number>; // peerId → highest op counter

  // Computed state (rebuilt from ops)
  state: PageState;
}

interface PageState {
  blocks: BlockState[];
  title: string;
}
```

### Applying Operations

```typescript
function applyOp(state: PageState, op: Operation): PageState {
  switch (op.op) {
    case "text_insert":
      return applyTextInsert(state, op);
    case "text_delete":
      return applyTextDelete(state, op);
    case "format_set":
      return applyFormatSet(state, op);
    case "block_insert":
      return applyBlockInsert(state, op);
    case "block_delete":
      return applyBlockDelete(state, op);
    case "block_set":
      return applyBlockSet(state, op);
  }
}

// Rebuild state from scratch (used after sync)
function rebuildState(ops: Operation[]): PageState {
  const sorted = ops.sort((a, b) => compareHLC(a.clock, b.clock));
  return sorted.reduce(applyOp, emptyPageState());
}
```

### Conflict Resolution Rules

| Conflict                                  | Resolution                                        |
| ----------------------------------------- | ------------------------------------------------- |
| Concurrent text inserts at same position  | Order by char ID (deterministic)                  |
| Concurrent text deletes                   | Both succeed (idempotent)                         |
| Concurrent format on same chars           | LWW by HLC                                        |
| Concurrent block inserts after same block | Order by block ID                                 |
| Concurrent block deletes                  | Both succeed (idempotent)                         |
| Concurrent block property updates         | LWW by HLC                                        |
| Edit deleted block                        | Op applies to tombstone (can resurrect if needed) |
| Delete block being edited                 | Edits silently ignored (block stays deleted)      |

---

## Sync Protocol

### Version Vectors

Each peer tracks what operations it has seen:

```typescript
// "I have ops from peer1 up to #42, peer2 up to #17"
type VersionVector = Map<string, number>;

function mergeVersionVectors(
  a: VersionVector,
  b: VersionVector
): VersionVector {
  const result = new Map(a);
  for (const [peer, counter] of b) {
    result.set(peer, Math.max(result.get(peer) ?? 0, counter));
  }
  return result;
}
```

### Sync Messages

```typescript
type SyncMessage =
  | { type: "sync_request"; versionVector: VersionVector }
  | { type: "sync_response"; ops: Operation[]; versionVector: VersionVector }
  | { type: "op"; op: Operation }; // Real-time broadcast
```

### Sync Flow

```
Peer A                              Peer B
   │                                   │
   │◄─── sync_request { v: {B:5} } ────│  "What do you have?"
   │                                   │
   │── sync_response ─────────────────►│  "Here's ops you're missing"
   │   { ops: [...], v: {A:10,B:5} }   │
   │                                   │
   │◄── sync_response ─────────────────│  "Here's ops you're missing"
   │   { ops: [...], v: {A:10,B:8} }   │
   │                                   │
   [Both now have all ops]             │
   │                                   │
   │◄───────── op { ... } ─────────────│  Real-time updates
   │────────── op { ... } ────────────►│
```

---

## Snapshots & Compaction

Operation logs grow forever. Mitigate with periodic snapshots:

```typescript
interface Snapshot {
  pageId: string;
  state: PageState; // Full computed state
  versionVector: VersionVector; // Ops included
  timestamp: number;
}

// On load:
// 1. Load latest snapshot
// 2. Load ops after snapshot's versionVector
// 3. Apply ops to snapshot state
```

**Compaction strategy:**

- Snapshot every ~100 ops or ~5 minutes of edits
- Keep last 3 snapshots + all ops after oldest kept snapshot
- On sync, can send snapshot + recent ops instead of full history

---

## Implementation Phases

### Phase 1: Core CRDT Engine

**Goal:** Build the operation log and state reducer

**New Files:**

```
/apps/web/src/sync/
├── types.ts           # Operation, HLC, PageState types
├── hlc.ts             # Hybrid Logical Clock implementation
├── oplog.ts           # Operation log storage and queries
├── reducer.ts         # Apply operations to state
├── conflicts.ts       # Conflict resolution logic
└── index.ts           # Public API
```

**Key Implementation:**

```typescript
// sync/index.ts
export class SyncEngine {
  private opLog: OpLog;
  private hlc: HLC;
  private peerId: string;

  // Called by editor commands
  emit(ops: Operation[]): void;

  // Called when receiving remote ops
  apply(ops: Operation[]): void;

  // Get current state
  getState(): PageState;

  // Subscribe to state changes
  onStateChange(callback: (state: PageState) => void): void;
}
```

### Phase 2: Editor Integration

**Goal:** Connect SyncEngine to EditorState

**New Files:**

```
/apps/web/src/sync/
├── binding.ts         # EditorState ↔ SyncEngine bridge
├── commands.ts        # Wrap editor commands to emit ops
└── converter.ts       # PageState ↔ Page conversion
```

**Modifications:**

- `/apps/web/src/editor/editor.ts` - Initialize SyncEngine, handle remote updates
- `/apps/web/src/editor/commands.ts` - Emit operations instead of direct mutations

**Key Pattern:**

```typescript
// In editor - intercept commands
function executeCommand(cmd: Command) {
  const ops = commandToOps(cmd, currentState);
  syncEngine.emit(ops); // Persists + broadcasts
  // State updates via syncEngine.onStateChange
}

// Handle remote updates
syncEngine.onStateChange((pageState) => {
  const editorState = convertToEditorState(pageState);
  render(editorState);
});
```

### Phase 3: Offline Persistence

**Goal:** Persist operations to IndexedDB

**New Files:**

```
/apps/web/src/sync/
├── storage.ts         # IndexedDB operations store
├── snapshot.ts        # Snapshot management
└── imageCache.ts      # Offline image caching (Cache API)
```

**IndexedDB Schema:**

```typescript
// Database: cypher-sync
// Object stores:
//   operations: { pageId, opId } → Operation
//   snapshots: { pageId, timestamp } → Snapshot
//   versionVectors: { pageId } → VersionVector
//   metadata: { key } → value
```

**Loading Flow:**

```
1. Load snapshot from IndexedDB (instant)
2. Load ops after snapshot
3. Apply ops → show content
4. Connect to peers (background)
5. Sync missing ops
6. Show sync status
```

### Phase 4: Signaling Server

**Goal:** WebRTC peer discovery

**New Files:**

```
/apps/signaling/
├── src/
│   ├── index.ts       # Express + Socket.IO server
│   ├── rooms.ts       # Room management (per page)
│   └── auth.ts        # Token validation
├── package.json
└── Dockerfile
```

**Protocol:**

```typescript
// Client → Server
'join': (pageId: string) => void
'leave': (pageId: string) => void
'signal': (targetPeerId: string, signal: RTCSignalData) => void

// Server → Client
'peers': (peerIds: string[]) => void
'peer_joined': (peerId: string) => void
'peer_left': (peerId: string) => void
'signal': (fromPeerId: string, signal: RTCSignalData) => void
```

### Phase 5: P2P Synchronization

**Goal:** Real-time sync via WebRTC

**New Files:**

```
/apps/web/src/sync/
├── transport.ts       # WebRTC data channel wrapper
├── peerManager.ts     # Manage peer connections
├── syncProtocol.ts    # Sync message handling
└── awareness.ts       # Cursor/presence (optional)
```

**Connection Flow:**

```
1. Connect to signaling server
2. Join room for pageId
3. Receive list of peers
4. Establish WebRTC connection to each peer
5. Exchange version vectors
6. Send/receive missing ops
7. Subscribe to real-time op broadcasts
```

### Phase 6: Server Backup

**Goal:** Persist to PostgreSQL for cross-device access

**Database Changes:**

```sql
ALTER TABLE pages ADD COLUMN ops_log JSONB DEFAULT '[]';
ALTER TABLE pages ADD COLUMN version_vector JSONB DEFAULT '{}';
ALTER TABLE pages ADD COLUMN snapshot JSONB;
ALTER TABLE pages ADD COLUMN snapshot_version JSONB;
```

**New API Endpoints:**

```
POST /api/pages/:id/sync
  Body: { versionVector, ops[] }
  Response: { ops[], versionVector }

GET /api/pages/:id/state
  Response: { snapshot, ops[], versionVector }
```

### Phase 7: UI/UX

**Goal:** Collaboration indicators

**New Files:**

```
/apps/web/src/app/components/
├── SyncStatus.tsx         # Online/offline/syncing indicator
└── CollaboratorCursors.tsx # Remote cursor display (if awareness enabled)

/apps/web/src/editor/
└── remoteCursors.ts       # Render cursors on canvas
```

---

## Undo/Redo Integration

The operation log gives us undo/redo for free:

```typescript
interface UndoManager {
  // Stack of operation groups (one per user action)
  undoStack: Operation[][]
  redoStack: Operation[][]
}

function undo(): Operation[] {
  const ops = undoStack.pop()
  const inverseOps = ops.map(invertOp).reverse()
  redoStack.push(ops)
  return inverseOps  // Emit these
}

function invertOp(op: Operation): Operation {
  switch (op.op) {
    case 'text_insert':
      return { op: 'text_delete', charIds: op.chars.map(c => c.id), ... }
    case 'text_delete':
      return { op: 'text_insert', chars: getDeletedChars(op.charIds), ... }
    case 'block_set':
      return { op: 'block_set', value: getPreviousValue(op), ... }
    // etc.
  }
}
```

---

## Key Files Summary

### New Files

| Path                                 | Purpose                    |
| ------------------------------------ | -------------------------- |
| `/apps/web/src/sync/types.ts`        | All type definitions       |
| `/apps/web/src/sync/hlc.ts`          | Hybrid Logical Clock       |
| `/apps/web/src/sync/oplog.ts`        | Operation log management   |
| `/apps/web/src/sync/reducer.ts`      | State computation from ops |
| `/apps/web/src/sync/binding.ts`      | Editor ↔ Sync bridge       |
| `/apps/web/src/sync/storage.ts`      | IndexedDB persistence      |
| `/apps/web/src/sync/transport.ts`    | WebRTC wrapper             |
| `/apps/web/src/sync/syncProtocol.ts` | Sync message handling      |
| `/apps/signaling/src/index.ts`       | Signaling server           |

### Modified Files

| Path                               | Changes                             |
| ---------------------------------- | ----------------------------------- |
| `/apps/web/src/editor/editor.ts`   | Initialize SyncEngine               |
| `/apps/web/src/editor/commands.ts` | Emit ops instead of direct mutation |
| `/apps/web/src/editor/undo.ts`     | Use operation-based undo            |
| `/apps/api/src/db/schema.ts`       | Add sync columns                    |

---

## Verification Checklist

### Phase 1-2 (Core)

- [ ] Insert text → operation emitted → state updated
- [ ] Delete text → tombstone applied → renders correctly
- [ ] Split block → 3 operations → both blocks render
- [ ] Format text → format spans correct → styling applies

### Phase 3 (Offline)

- [ ] Edit → close browser → reopen → content persists
- [ ] Edit offline → content saved locally
- [ ] Snapshots created periodically

### Phase 4-5 (P2P)

- [ ] Two browsers → both see each other's edits
- [ ] Concurrent edits → merge correctly
- [ ] Offline edit → come online → syncs

### Phase 6 (Server)

- [ ] Edit on device A → syncs to server → device B sees it
- [ ] Server has backup of all ops

---

## Bundle Size Estimate

| Component           | Estimated Size (minified) |
| ------------------- | ------------------------- |
| HLC + types         | ~0.5KB                    |
| OpLog + reducer     | ~1.5KB                    |
| Storage (IndexedDB) | ~1KB                      |
| WebRTC transport    | ~1KB                      |
| Sync protocol       | ~0.5KB                    |
| **Total**           | **~4.5KB**                |

Compare to Yjs (~8KB) + y-indexeddb (~2KB) + y-webrtc (~4KB) = ~14KB

---

## Open Questions

1. **Awareness (cursors)?** - Do we want real-time cursor positions? Adds complexity.
2. **TURN server?** - For peers behind strict NATs. Can add later.
3. **Conflict UI?** - Show users when conflicts were auto-resolved?
4. **Compression?** - Compress ops in storage/transit?
