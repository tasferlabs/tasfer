# CRDT Operation Compaction

## Overview

The CRDT sync engine stores operations in memory to enable real-time collaboration between peers. Without compaction, this operation log would grow unbounded during long editing sessions, causing memory issues.

This document explains the compaction mechanism and the race conditions it must handle safely.

## The Problem: Memory Growth

In a long editing session:
1. User makes edits continuously
2. Each edit creates CRDT operations stored in `SyncEngine.opLog`
3. Operations accumulate: 100, 1000, 10000+ operations
4. Memory usage grows without bound

## The Solution: Compaction After Save

When the user's changes are saved to the server:
1. The snapshot (Block[]) is saved, reflecting all operations up to a certain clock
2. Operations up to that clock are "baked into" the snapshot
3. We can remove those operations from memory since they're persisted

```
Before Save:
  Memory: [op1, op2, op3, ..., op100]
  Server: snapshot at clock 0

After Save (clock=100):
  Memory: [] (compacted)
  Server: snapshot at clock 100
```

## Race Condition 1: Save Timing

### Problem
If we compact immediately when triggering a save (before it completes), and the save fails, we lose operations.

```
t=100: Edit, trigger save, compact ops 1-100 immediately
t=200: Save FAILS (network error)
       Ops 1-100 are gone from memory AND not on server!
```

### Solution
Only compact AFTER save succeeds. The clock that was actually saved is passed through the save chain:

```typescript
// MountedEditor passes clock with content change
onContentChange(snapshot, operations, clock)

// EditorPage includes clock in save payload
debouncedSave({ snapshot, operations, clock })

// Only compact after successful save, using the saved clock
await updatePage({ id, snapshot, operations });
editorRef.current?.compactOperations(clock);
```

## Race Condition 2: Clock Advancement

### Problem
Between triggering a save and it completing, more edits may occur:

```
t=100: Edit, snapshotClockRef=100, trigger save
t=150: Edit, snapshotClockRef=150
t=200: Edit, snapshotClockRef=200
t=250: Save from t=100 completes (saved clock=100)
       If we compact to snapshotClockRef.current (200), we lose ops 101-200!
```

### Solution
Track which clock was actually saved. The clock travels with the save payload, so we compact only to that specific clock, not the current `snapshotClockRef`:

```typescript
const handleSave = async ({ snapshot, operations, clock }) => {
  await updatePage({ id, snapshot, operations });
  // Use the clock that was saved, not the current one
  if (clock) {
    editorRef.current?.compactOperations(clock);
  }
};
```

## Race Condition 3: Late-Joining Peers

### Problem
A peer joins right as another peer's save completes:

```
Timeline:
t=0:    User A has ops 1-100 in memory
t=100:  User A save starts (async HTTP)
t=101:  User B starts loading page (HTTP GET)
t=102:  User A save completes, compacts ops 1-100
t=103:  User B GET returns OLD snapshot (before A's save committed)
t=104:  User B joins room, sends sync-request
t=105:  User A has NO ops to send (already compacted)
        User B is missing ops 1-100!
```

The window is small but real: between when User A's save commits on the server and when User B's GET request hits the server, User B might get stale data.

### Solution: Grace Period

Keep operations in memory for a grace period after save, even if they're older than the snapshot clock:

```typescript
// constants.ts
export const COMPACTION_GRACE_PERIOD_MS = 10000; // 10 seconds

// SyncEngine.compactOperations()
this.opLog.operations = this.opLog.operations.filter((op) => {
  // Keep ops within grace period regardless of clock
  if (now - op.clock.wall < COMPACTION_GRACE_PERIOD_MS) {
    return true;
  }

  // Otherwise, only keep ops after snapshot clock
  return isAfterClock(op.clock, snapshotClock);
});
```

This ensures:
- Late-joining peers have 10 seconds to sync with existing peers
- After 10 seconds, ops are safe to remove (they're definitely on server by then)
- Memory still gets cleaned up, just with a small delay

## Configuration

The grace period is configurable in `src/editor/constants.ts`:

```typescript
export const COMPACTION_GRACE_PERIOD_MS = 10000; // 10 seconds
```

Considerations for tuning:
- **Too short**: Late joiners may miss operations
- **Too long**: Memory isn't freed as aggressively
- **10 seconds**: Good balance for typical network conditions

## Flow Diagram

```
User A (existing peer)              Server                User B (late joiner)
        |                              |                         |
        |-- ops 1-100 in memory        |                         |
        |                              |                         |
        |------ save request --------->|                         |
        |                              |                         |
        |                              |<---- GET page ----------|
        |                              |                         |
        |<----- save success ----------|                         |
        |                              |                         |
        | compactOperations()          |                         |
        | (keeps ops < 10s old)        |                         |
        |                              |                         |
        |                              |----- old snapshot ----->|
        |                              |                         |
        |<---------------- sync-request (joins room) ------------|
        |                              |                         |
        |----------------- ops 1-100 (still in grace period) --->|
        |                              |                         |
        | (10 seconds later)           |                         |
        | ops 1-100 finally removed    |                         |
```

## Summary

The compaction system uses three safeguards:

1. **Compact only after save succeeds** - Prevents data loss on failed saves
2. **Use the saved clock, not current clock** - Handles concurrent edits during save
3. **Grace period before removal** - Handles late-joining peers

These ensure memory is managed efficiently while maintaining data consistency across all peers.
