# Transition Plan: Decentralized Cypher

Strip the server. Keep the editor. Own the data.

## What Changes

| Now                                 | After                                      |
| ----------------------------------- | ------------------------------------------ |
| PostgreSQL + Express API            | SQLite on device                           |
| Session-based auth (email/password) | Cryptographic identity (keypair per device) |
| Server stores pages, snapshots      | Markdown files on disk + SQLite for CRDT   |
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
│   ├── pages/*.md                             │
│   ├── assets/{hash}.png                      │
│   └── .cypher/                               │
│       ├── db.sqlite                          │
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

### Files are markdown
Every page is a `.md` file with YAML frontmatter. Open in any editor.

```markdown
---
id: abc123
created: 2026-03-17T10:00:00Z
tags: [project, ideas]
---

# My Document

Regular markdown. **Bold**, _italic_, `code`.

- [ ] Task one
- [x] Task two
```

### Assets — content-addressed
- Images/files stored as `assets/{content-hash}.{ext}`
- Markdown references them: `![alt](assets/a1b2c3.png)`
- **CRDT ops sync eagerly** (tiny) — **assets sync lazily** (pulled when document is opened)
- Deduplication for free via content hashing
- Your own assets always kept; remote assets cached with LRU eviction

### SQLite — `.cypher/db.sqlite`

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

-- Page index
CREATE TABLE pages (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  title      TEXT,
  updated_at INTEGER NOT NULL
);

-- Snapshots for fast loading
CREATE TABLE snapshots (
  id        INTEGER PRIMARY KEY,
  page_id   TEXT NOT NULL,
  data      BLOB NOT NULL,
  clock     TEXT NOT NULL,
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
