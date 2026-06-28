# Multi-tab validation — checklist

How to exercise the "device-node SharedWorker" architecture (Engine in a
SharedWorker, tabs as thin RPC clients, one elected WebRTC connection), which is
now the **default** web path.

On web, the Engine + Replicator run in the SharedWorker; tabs are RPC clients;
the `RoomHub` fans ops/awareness across tabs; one tab is elected (`cypher-net`
lock) to host the single WebRTC connection. This is the only web path and
requires `SharedWorker` (Chrome/Edge/Firefox; Safari 16.4+). A browser without
`SharedWorker` is unsupported and surfaces an init error rather than falling
back.

---

## How to run

From `apps/web`:

```bash
npm run dev
```

Dev server runs on **http://localhost:4000**. "Two tabs" means two tabs of that
same origin (same port). For P2P tests, "two devices" means two separate
browser **profiles** (or two machines) so they have distinct identities — two
tabs of one profile are the *same* device.

### Inspecting state in DevTools

- **SharedWorker is alive:** `chrome://inspect/#workers`, or DevTools →
  Application → Service Workers / Shared Workers. You should see exactly one
  `node.sharedworker` for the origin.
- **Console markers:**
  - `[platform] device-node SharedWorker active` — worker path engaged (per tab).
  - `[node] …` — worker-side logs (open the SharedWorker's own DevTools via
    `chrome://inspect`).
- **Web Locks:** DevTools → Application → Background Services isn't it; use the
  console: `await navigator.locks.query()` and look for `cypher-app` (held once,
  by the worker) and `cypher-net` (held by exactly one tab).

> Canvas content is not visible to DOM inspection. Verify editor text by reading
> the rendered canvas visually; verify chrome (sidebar, menus) via the DOM.

---

## Device node + operation bus

Network is exercised below; here, focus on single-device, multi-tab.

### Single tab sanity
- [ ] App boots; console shows the device-node marker; one `node.sharedworker`
      in DevTools.
- [ ] CRUD, editing, assets, and persistence all work (create/rename/delete a
      page; create/rename/archive a space; type and reload; insert an image and
      reload; open the pairing dialog and produce an invite).
- [ ] `await navigator.locks.query()` shows `cypher-app` held (by the worker),
      and the tab itself does **not** hold `cypher-app`.

### Two tabs — page list (problem #1)
Open tab A and tab B on the app.
- [ ] Create a page in A → it appears in B's sidebar **without reload**.
- [ ] Rename a page in A → B's sidebar reflects the new title live.
- [ ] Delete a page in A → it disappears from B; if B had it open, B navigates
      away.
- [ ] Create / rename a space in A → reflected in B live.

### Two tabs — same page, live convergence (problem #2)
Open the **same page** in A and B.
- [ ] Type in A → text appears in B within a moment (and vice-versa).
- [ ] Rapid simultaneous typing in both → both converge to the same text, no
      duplication or lost characters.
- [ ] A's caret/selection shows as a remote cursor in B (awareness), and moves
      as A moves.
- [ ] Close A → B drops A's cursor (peer-left); B keeps editing fine.
- [ ] Reopen A on the same page → cursors re-appear in both directions.
- [ ] Open the page in a **third** tab → it converges with both; closing any one
      doesn't disturb the others.

### Persistence / no corruption
- [ ] After heavy two-tab editing, reload both → identical, correct content.
- [ ] Open the page fresh in a new tab → matches (DB is the single source of
      truth).

---

## Single WebRTC connection + failover

Needs **two devices** (two profiles/machines), paired.

### Setup
- [ ] On device 1, both tabs running: exactly one tab holds `cypher-net`
      (`navigator.locks.query()` in each tab — only one lists it).
- [ ] Pair device 1 and device 2 (Pairing dialog → invite/accept).
- [ ] Console shows the peer connecting; edits sync device-to-device.

### One identity, one connection (problems #3/#4)
- [ ] With **two tabs** open on device 1, device 2 sees **one** connection /
      one peer for device 1 (not two).
- [ ] Edit from device 1 tab A and tab B → device 2 receives each change once
      (no duplicate ops).
- [ ] Edit from device 2 → appears in **both** device-1 tabs live.

### Transport-host failover (the critical, least-tested path)
- [ ] Note which device-1 tab holds `cypher-net`. Edit across devices to confirm
      sync is live.
- [ ] **Close the host tab.** Within a second or two, another device-1 tab
      acquires `cypher-net` (`navigator.locks.query()` confirms) and sync
      resumes — edits flow device-to-device again.
- [ ] The surviving tabs never lost local editing during the handover.
- [ ] Re-open a tab; close a non-host tab → no effect on sync.

### Assets over the network
- [ ] Insert an image on device 1; open that page on device 2 → image loads
      (asset fetched peer-to-peer, then rendered from tab-local bytes).

---

## Known limitations to expect (not bugs)

- **Imported content** (`ops.writeBlocks`) persists and pushes to peers but does
  not flow through a room, so it won't appear in *other already-open* tabs until
  they reload. New page-opens are fine.
- **No `navigator.locks`** → no transport host → P2P sync is off, but
  local/cross-tab still works (graceful degradation).
- **No `SharedWorker`** (older Safari) → unsupported; init throws and the app
  surfaces the error instead of loading.
- Version vectors still grow one origin per tab-session — by design (see the
  rewrite notes); not a correctness issue.

---

## If something fails

- Capture the **console of all tabs and the SharedWorker** (`chrome://inspect`).
- Note `await navigator.locks.query()` from each tab at the moment of failure.
- For convergence bugs, record the exact interleaving (who typed what, when) —
  CRDT issues are reproducible from op order.
