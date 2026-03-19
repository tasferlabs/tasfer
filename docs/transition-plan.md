# Transition Plan: Decentralized Cypher

Strip the server. Keep the editor. Own the data.

## What Changes

| Now                                 | After                                      |
| ----------------------------------- | ------------------------------------------ |
| PostgreSQL + Express API            | SQLite on device                           |
| Session-based auth (email/password) | Cryptographic identity (keypair per device) |
| Server stores pages, snapshots      | SQLite (metadata + ops) + file snapshots   |
| WebSocket server for sync           | P2P sync, relay as fallback                |
| Internet dependent                  | Fully offline, sync when you choose        |

## Architecture

```
┌──────────────────────────────────────────────┐
│                 your device                  │
│                                              │
│   ┌──────────┐  ┌───────────┐                │
│   │  mobile  │  │  desktop  │                │
│   │   app    │  │ Electron  │                │
│   └────┬─────┘  └─────┬─────┘                │
│        └──────┬───────┘                      │
│               ▼                              │
│     ┌──────────────────────────┐             │
│     │     cypher engine        │             │
│     │  ├── canvas renderer     │             │
│     │  ├── CRDT sync           │             │
│     │  ├── SQLite (ops + meta) │             │
│     │  └── P2P connection mgr  │             │
│     └────────────┬─────────────┘             │
│                  │                           │
│   ~/cypher-workspace/                        │
│   ├── assets/{hash}.ext                      │
│   └── .cypher/                               │
│       ├── db.sqlite                          │
│       ├── snapshots/{pageId}/{id}.bin        │
│       ├── identity.key                       │
│       └── peers.json                         │
└──────────────────┬───────────────────────────┘
                   │ optional
                   ▼
     ┌───────────────────────┐
     │   backup backend(s)   │
     │   - home server       │
     │   - friend's server   │
     │   - S3-compatible     │
     └───────────────────────┘
```

## Clients

### Desktop — Electron app
Download and run. No account, no terminal, no setup. The app is both the editor and the local server. Linux users can also install via package manager or run the binary directly.

### Mobile — iOS / Android
Connects to your desktop instance on the same network, or syncs P2P. Can also work standalone with local storage.

### Web — browser
Opens from the Electron app's local server. Data stays on device.

Sync between devices? Scan a QR code or paste a connection string.

## Identity — Cryptographic Keys

- Each instance generates a **keypair** on first run
- Your **public key is your identity** — no central authority
- Trust peers by exchanging public keys (QR code, paste, etc.)
- The CRDT `peerId` = public key hash — ties every operation to a verifiable identity
- Sync traffic is **encrypted** between known peers
- Human-friendly display names on top, but the key is what matters
- Short fingerprint for verification ("is this really you?")

Stored in `.cypher/identity.key` (private) and `.cypher/peers.json` (trusted peers).

## Storage

### CRDT state is the source of truth
Pages are not stored as markdown files. The CRDT state — operation log, snapshots with tombstones, character IDs, clock metadata — is the authoritative representation. This preserves full collaboration history and guarantees correct merge on sync.

**Markdown export is optional.** Users can export any page as `.md` for portability, but it's a one-way derived view, not the storage format.

### Snapshots — protobuf + brotli (same as current server)
- Stored as binary files: `.cypher/snapshots/{pageId}/{id}.bin`
- Protobuf-encoded, Brotli-compressed — same pipeline as the current `apps/api` snapshot system
- Preserve full CRDT metadata: character runs (peerId, startCounter, text, deletedMask), format spans, HLC clock state
- Max 50 snapshots per page, old versions garbage collected
- Used for fast page loading — apply only ops newer than the latest snapshot

### Assets — content-addressed
- Images/files stored as `assets/{content-hash}.{ext}`
- **CRDT ops sync eagerly** (tiny) — **assets sync lazily** (pulled when document is opened)
- Deduplication for free via content hashing
- Your own assets always kept; remote assets cached with LRU eviction

### SQLite — `.cypher/db.sqlite`
Metadata, op-log, and indexes. Not the page content itself — that lives in snapshot files.

```sql
-- CRDT operation log
CREATE TABLE ops (
  id        INTEGER PRIMARY KEY,
  page_id   TEXT NOT NULL,
  peer_id   TEXT NOT NULL,
  counter   INTEGER NOT NULL,
  type      TEXT NOT NULL,
  data      BLOB NOT NULL,
  timestamp INTEGER NOT NULL
);

-- Page index (no file path — pages live in snapshots, not on disk as files)
CREATE TABLE pages (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  parent_id  TEXT,
  space_id   TEXT,
  "order"    REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Snapshot index (points to .bin files on disk)
CREATE TABLE snapshots (
  id         INTEGER PRIMARY KEY,
  page_id    TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  size       INTEGER NOT NULL,
  clock_counter  INTEGER NOT NULL,
  clock_peer_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Known peers
CREATE TABLE peers (
  public_key TEXT PRIMARY KEY,
  name       TEXT,
  trusted    INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER
);

-- Backup remotes
CREATE TABLE remotes (
  name TEXT PRIMARY KEY,
  url  TEXT NOT NULL,
  type TEXT NOT NULL  -- ssh, https, s3
);
```

## Sync — Git-like, CRDT-powered

- **Clone** a project or specific files from a peer — you get full history
- **Live editing** works over P2P when both peers are online (CRDT handles merging)
- **Offline** — edit freely, sync merges automatically when you reconnect
- **No conflicts** — CRDT guarantees convergence, unlike Git

### Transport
1. **P2P direct** (primary) — devices discover each other on LAN or connect via known address
2. **Relay** (fallback) — when P2P fails (NAT, firewalls), a lightweight relay forwards encrypted traffic. The relay sees nothing.

### Backend protocol (for backups)
Remotes are dumb encrypted blob storage:
- `PUT /blob/{id}` — store
- `GET /blob/{id}` — retrieve
- `LIST /blobs?since={timestamp}` — list changes

No auth logic on the backend. Data is encrypted client-side.

## What Gets Removed

- `apps/api/` — gone
- `apps/live/` — replaced by P2P in the app
- PostgreSQL, Redis — replaced by SQLite
- Session auth, email verification — replaced by cryptographic identity
- `Dockerfile.*`, `nomad.hcl`, `deploy.sh` — no deployment, it runs on your machine

## What Stays

- Canvas rendering engine — the core
- CRDT engine — already built for this
- Offline-first architecture — becomes the only architecture
- Snapshot encoding pipeline (protobuf + brotli) — same format, just local instead of server
- Hybrid storage model — SQLite for metadata/ops, files for snapshots/assets
