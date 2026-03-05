# Calendar — Pages as Events

## Core Concept

There is no "event" entity. Every calendar entry is a Cypher page. The calendar is a time-filtered view of your pages.

A page becomes scheduled the moment you give it a time:

```ts
// additions to existing page model
scheduledAt?: number    // unix timestamp
duration?: number       // minutes, optional
allDay?: boolean
recurrenceId?: string   // links to the recurrence rule that spawned this page
```

Any page can be scheduled. Any scheduled page appears on the calendar.

---

## Page Tree — Daily Notes

Daily notes are the root page for each day. Scheduled pages are its children.

```
March 3, 2026 (daily note)
├── Team Sync (9:00)
├── API Design (11:00)
├── Lunch with Ali (1:00)
└── inline journal text...
```

The daily note is just a recurring page with `frequency: 'daily'`. Open your day and everything is there — meetings, tasks, and your own writing, in one tree.

Over time this builds a navigable archive:

```
2026/
├── March/
│   ├── March 3
│   │   ├── Standup
│   │   ├── Team Sync
│   │   └── Blog draft session
│   ├── March 4
│   │   ├── Standup
│   │   └── 1-on-1 with Sara
│   ...
├── Weekly Reviews/
│   ├── Week of March 3
│   ├── Week of March 10
```

The calendar is the **time view** of this tree. The sidebar is the **structure view** of the same tree.

---

## Virtualized Recurrence

Recurring pages don't exist until you interact with them. The calendar renders virtual entries computed from recurrence rules. A real page is only materialized when the user opens or edits the entry.

```
User sees:          What's in the DB:

Mon  Standup        Nothing
Tue  Standup        Nothing
Wed  Standup  <--   Page created NOW (user opened it)
Thu  Standup        Nothing
Fri  Standup        Nothing
```

### Recurrence Rule

```ts
type RecurrenceRule = {
  id: string
  frequency: 'daily' | 'weekly' | 'monthly'
  templatePageId: string   // the page to clone from
  days?: number[]          // e.g. [1,3,5] for Mon/Wed/Fri
}
```

### Rendering

At render time, merge real pages with virtual entries — no DB queries for unmaterialized instances:

```ts
function getEntriesForDay(day: Date, recurrences: RecurrenceRule[]): Entry[] {
  const real = pages.filter(p => p.scheduledAt falls on day)
  const virtual = recurrences
    .filter(r => r.matches(day))
    .filter(r => !real.some(p => p.recurrenceId === r.id))
    .map(r => ({ virtual: true, templateId: r.templatePageId, ...r }))

  return [...real, ...virtual]
}
```

### Materialization

Only when the user interacts:

```ts
function materialize(entry: VirtualEntry): Page {
  const page = cloneFromTemplate(entry.templateId)
  page.scheduledAt = entry.date
  page.recurrenceId = entry.recurrenceId
  return savePage(page)
}
```

Daily notes, standups, weekly reviews, recurring meetings — all use the same mechanism. The database only stores pages you actually touched.

---

## Rendering — DOM, Not Canvas

The editor uses canvas for pixel-level text control. A calendar is a grid layout problem — DOM with CSS Grid handles it natively. Benefits: free accessibility, hit testing, scrolling, animations, responsive layout.

---

## Views

| View      | Desktop                                | Mobile                                 |
| --------- | -------------------------------------- | -------------------------------------- |
| **Month** | Full grid, density dots per day        | Compact grid, tap day to expand        |
| **Week**  | 7-column time grid                     | Horizontal swipeable days              |
| **Day**   | Single column timeline with page previews | Full screen timeline                |
| **Agenda**| Scrollable list of pages               | Same, native-feeling scroll            |

Transition between views with pinch gesture (mobile) or keyboard shortcuts (desktop).

### Day View

The primary view. Shows a timeline of that day's pages with inline previews of their content:

```
┌─────────────────────────────────────┐
│  Tuesday, March 3                   │
│                                     │
│  9:00  ┌─ Team Sync ─────────────┐  │
│        │  □ Review Q2 roadmap    │  │
│        │  □ Discuss hiring...    │  │
│        └─────────────────────────┘  │
│                                     │
│ 11:00  ┌─ API Design ────────────┐  │
│        │  We decided to go with  │  │
│        │  REST over GraphQL...   │  │
│        └─────────────────────────┘  │
│                                     │
│  1:00  ┌─ Lunch ─────────────────┐  │
│        └─────────────────────────┘  │
│                                     │
│         ── unscheduled ──           │
│        ┌─ Blog post draft ───────┐  │
│        ┌─ Fix auth bug ──────────┐  │
└─────────────────────────────────────┘
```

Unscheduled pages appear as a backlog at the bottom. Drag onto a time slot to schedule.

### Month View

Minimal — density dots instead of cramming event titles into cells:

```
     March 2026
 Mo  Tu  We  Th  Fr  Sa  Su
                          1
  2   3   4   5   6   7   8
  .  ... ..  .       .
  9  10  11  12  13  14  15
  .   .  ..  ...      .
```

Tap a day to see page previews.

---

## Interactions

### Desktop Shortcuts

```
Navigation:
  h / l           previous / next day
  j / k           previous / next time slot
  [ / ]           previous / next week
  t               jump to today
  1 / 2 / 3       switch to day / week / month view

Actions:
  n               new page at focused time slot
  Enter           expand focused page inline (preview → full)
  Escape          collapse / close overlay
  d               delete
  /               command palette
```

### Command Palette

From anywhere in Cypher — `/schedule Blog post draft friday 2pm` schedules an existing page. No context switch.

### Mobile

- Swipe left/right — navigate days
- Pinch — zoom between day/week/month views
- Long press time slot — new page
- Long press + drag — reschedule page
- Tap page — inline expand, tap again — full editor
- Pull up bottom sheet for unscheduled backlog

---

## Data Flow

```
┌──────────────┐
│  Cypher Page  │  ← existing page, full CRDT document
│               │
│  + scheduledAt: 1709474400
│  + duration: 60
│  + recurrenceId: "abc"
└──────┬───────┘
       │
       │  WHERE scheduledAt BETWEEN day_start AND day_end
       │
┌──────▼───────┐
│   Calendar    │  ← filtered, time-ordered view
│    View       │
└──────────────┘
```

No new tables. No new sync protocol. No new CRDT types. Existing page infrastructure handles creation, editing, offline sync, and collaboration. The only new database work is an index on `scheduledAt` for range queries.

---

## Recurrence Templates

Examples of recurring page templates:

**Daily note** — `frequency: 'daily'`, blank or templated page. Your journal and daily workspace.

**Standup** — `frequency: 'weekly'`, `days: [1,2,3,4,5]`:
```
Standup
───────
□ Yesterday
□ Today
□ Blockers
```

**Weekly review** — `frequency: 'weekly'`, `days: [5]`:
```
Weekly Review
─────────────
□ What went well?
□ What didn't?
□ Priorities for next week
```

Edit the template, future virtual instances reflect the change. Materialized pages (past instances you wrote in) stay as they were.

---

## Build Order

1. Add `scheduledAt` / `duration` fields to pages — schema + API
2. Day view — query pages by date, render as timeline
3. Inline page preview — show first few blocks in each slot
4. New page at time slot — `n` creates page with `scheduledAt` pre-filled
5. Drag to reschedule — update `scheduledAt` on drop
6. Month view — density dots, tap to expand day
7. Recurrence rules + virtualized rendering
8. `/schedule` command — schedule existing pages from anywhere
9. Unscheduled backlog — pages without time, shown at bottom
10. Mobile gestures — swipe, pinch, long press
