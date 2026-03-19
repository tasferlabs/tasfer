# Transition Plan: Decentralized Cypher

Strip the server. Keep the editor. Own the data.

## What Changes

| Now                                    | After                                        |
| -------------------------------------- | -------------------------------------------- | --- |
| PostgreSQL + Express API               | SQLite on device                             |
| Session-based auth (email/password)    | No auth — your device is your identity       |
| Server stores pages, snapshots, images | Everything lives as markdown files on disk   |
| WebSocket server for sync              | P2P sync via thin relay, connect any backend | Ø   |
| Internet depedent app                  | indepndence                                  |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  your device                    │
│                                                 │
│   ┌─────────┐  ┌─────────┐  ┌──────────────┐   │
│   │ mobile  │  │ desktop │  │ CLI (optional)│   │
│   │  app    │  │ PWA/app │  │              │   │
│   └────┬────┘  └────┬────┘  └──────┬───────┘   │
│        └─────────┬──┘              │           │
│                  ▼                 ▼           │
│        ┌─────────────────────────────┐         │
│        │      cypher engine          │         │
│        │  ├── canvas renderer        │         │
│        │  ├── CRDT sync              │         │
│        │  ├── SQLite (ops + index)   │         │
│        │  └── P2P connection manager │         │
│        └──────────────┬──────────────┘         │
│                       │                        │
│   ~/cypher/           │                        │
│   ├── pages/*.md      │                        │
│   ├── images/         │                        │
│   └── cypher.db       │                        │
└───────────────────────┬────────────────────────┘
                        │ optional
                        ▼
          ┌───────────────────────┐
          │   backup backend(s)   │
          │   - home server       │
          │   - friend's server   │
          │   - S3-compatible     │
          │   - daisy-chain many  │
          └───────────────────────┘
```

## Two Doors, Same Room

Cypher has two interfaces. Both use the same engine, same data, same sync.

### For everyone: the app

Download it. Open it. Start writing. No account, no setup, no terminal.

- **Mobile** — iOS / Android (App Store / Play Store)
- **Desktop** — PWA installs from browser, or native download
- **Web** — open in any browser, data stays in browser storage

Sync between devices? Tap "connect" and scan a QR code. Add a backup? Paste a link in settings. That is it.

The app hides every technical detail. You see pages, you write, it works.

### For power users: the CLI

Same engine exposed to the terminal.

```bash
cypher init ~/notes        # init a workspace
cypher open                # opens editor in browser
cypher sync                # sync to remotes
cypher remote add home ssh://pi@192.168.1.50:~/backup
cypher peer connect <id>   # direct P2P
cypher status
```

Edit files in vim, pipe them, script them, automate backups with cron. The CLI is optional — nobody needs it to use Cypher.

## Storage: SQLite

One file: `cypher.db`

```sql
-- CRDT operation log
CREATE TABLE ops (
  id        INTEGER PRIMARY KEY,
  page_id   TEXT NOT NULL,
  peer_id   TEXT NOT NULL,
  counter   INTEGER NOT NULL,
  type      TEXT NOT NULL,     -- text_insert, text_delete, format_set, block_*
  data      BLOB NOT NULL,
  timestamp INTEGER NOT NULL
);

-- File index (maps markdown files to CRDT state)
CREATE TABLE pages (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  title      TEXT,
  updated_at INTEGER NOT NULL
);

-- Peer identity
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Remote backends
CREATE TABLE remotes (
  name TEXT PRIMARY KEY,
  url  TEXT NOT NULL,
  type TEXT NOT NULL  -- ssh, https, s3
);
```

## Files Are Markdown

Every page is a `.md` file. Open it in vim, VS Code, whatever. Cypher watches for changes and syncs the CRDT state.

```markdown
---
id: abc123
created: 2026-03-17T10:00:00Z
tags: [project, ideas]
color: "#22C55E"
---

# My Document

Regular markdown. **Bold**, _italic_, `code`.

- [ ] Task one
- [x] Task two
```

The `.crdt/` directory holds the operation log per file — invisible to the user, used for sync.

## Daisy-Chain Backends

Remotes are dumb storage. They hold encrypted snapshots. Any backend that can store and retrieve blobs works.

```bash
# Add multiple backends — they all get the same data
cypher remote add home ssh://pi@home:~/backup
cypher remote add vps  https://vps.example.com/cypher
cypher remote add s3   s3://my-bucket/cypher

# Sync pushes to all, pulls from first available
cypher sync
```

A backend is just an endpoint that implements:

- `PUT /blob/{id}` — store
- `GET /blob/{id}` — retrieve
- `LIST /blobs?since={timestamp}` — list changes

That's it. No auth logic, no user management, no permissions. The data is encrypted client-side. The backend is a dumb pipe.

## Fork & Contribute

```bash
git clone https://github.com/user/cypher
cd cypher

# The entire editor is one package
# No monorepo, no workspace config, no 47 dependencies
npm install
npm run dev

# Build the binary
npm run build
```

### What makes it easy to fork:

- **No accounts** — remove the #1 barrier to self-hosting
- **Markdown files** — readable without cypher, no vendor lock-in
- **SQLite** — single file database, copy it anywhere
- **Thin protocol** — backend is 4 endpoints, implement in any language
- **No build system maze** — one package.json, one build command

## What Gets Removed

- `apps/api/` — gone. No server.
- `apps/live/` — replaced by P2P sync in the binary.
- PostgreSQL, Redis — replaced by SQLite.
- Session auth, email verification — replaced by nothing. Your device is your key.
- `Dockerfile.*`, `nomad.hcl`, `deploy.sh` — no deployment. It runs on your machine.

## What Stays

- Canvas rendering engine — the core.
- CRDT engine — the sync brain. Already built for this.
- Offline-first architecture — becomes the only architecture.
- The web UI — served locally by the CLI binary.
