# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cypher is a canvas-based markdown text editor combining Google Docs-like editing with Notion-style block architecture. Text is rendered directly on HTML5 canvas (not DOM-based). Features real-time collaborative editing with offline-first CRDT synchronization.

## Monorepo Structure

```
apps/
├── web/      # Main React SPA (Vite + React 19 + TypeScript)
├── api/      # Express 5 backend (PostgreSQL + Drizzle ORM + Redis)
├── live/     # WebSocket signaling server for CRDT sync
├── ios/      # iOS native WebView wrapper (Capacitor)
└── android/  # Android native WebView wrapper (Capacitor)
shared/       # Shared TypeScript types and utilities
cdn/          # Local asset storage (images/, snapshots/)
```

## Development Commands

### Web App (root or `apps/web`) — uses npm
```bash
npm run dev          # Start Vite dev server (port 4000)
npm run dev:host     # Dev server accessible from network (for mobile testing)
npm run build        # TypeScript check + production build
```

### API Server (`apps/api`) — uses Bun
```bash
npm run dev          # Watch mode with tsx + env-cmd
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Execute migrations
npm run db:push      # Push schema changes directly
npm run db:studio    # Drizzle Studio UI
```

### Live Server (`apps/live`) — uses Bun
```bash
npm run dev          # Watch mode with tsx
```

### Mobile (Capacitor)
```bash
npm run cap:sync           # Sync web build to native projects
npm run cap:open:ios       # Open iOS project in Xcode
npm run cap:open:android   # Open Android project in Android Studio
```

No linting, formatting, or test tooling is configured.

## Architecture

### Canvas Rendering Engine (`apps/web/src/editor/`)
- Custom text rendering directly on HTML5 Canvas — not DOM-based
- Manual event handling for keyboard (`keysEvents.ts`), mouse (`mouseEvents.ts`), touch (`touchEvents.ts`), and IME composition (`compositionEvents.ts`)
- Key files: `editor.ts` (orchestration), `renderer.ts` (canvas rendering), `fonts.ts` (font loading/measurement), `selection.ts` (cursor/selection), `layers.ts` (canvas layers)
- RTL text (Arabic, Hebrew) supported via `rtl.ts`
- Undo/redo is CRDT-aware: converts between index-based positions and CRDT ID-based positions (`undo.ts`, `inverse.ts`)

### CRDT System (`apps/web/src/editor/sync/`)
Operation-log CRDT for offline-first collaborative editing:
- `types.ts` — Operation types: `text_insert`, `text_delete`, `format_set`, `block_insert`, `block_delete`, `block_set`
- `hlc.ts` — Hybrid Logical Clock (pure Lamport clock: counter + peerId, no wall clock). Ordering: counter → peerId (lexicographic)
- `char-runs.ts` — RGA-style character-level CRDT using runs (`{peerId, startCounter, text, deletedMask}`)
- `conflicts.ts` — RGA insertion position resolution with HLC-based ordering
- `oplog.ts` — Operation log management
- `reducer.ts` — Applies operations to document state
- `sync.ts` — Public CRDT API + version vector tracking
- `websocket.ts` — WebSocket sync protocol
- `awareness.ts` — Peer cursors/selections/presence
- Character IDs use `${peerId}:${counter}` format

### State Management (`apps/web/src/editor/state.ts`)
Three-layer state architecture:
1. **DocumentState** — Content (page, cursor, selection) — persisted in undo/redo
2. **UIState** — UI interactions (menus, composition modes)
3. **ViewState** — Ephemeral viewport info (scroll position)

### Web App (`apps/web/src/`)
- Entry point: `main.tsx` (React Query with offline-first network mode, PWA service worker registration)
- Path aliases: `@/*` → `./src/*`, `@shared/*` → `../../shared/*`
- `app/MountedEditor.tsx` — Main editor mount component
- `app/api/` — API client functions
- `app/contexts/` — Auth, Version, Theme contexts
- `deserializer/` — Page loading (`loadPage.ts`), markdown parsing (`parser.ts`, `tokenizer.ts`), serialization (`serializer.ts`)
- `offline/` — Offline support
- `sw.ts` / `sw-router.ts` — Service Worker (PWA via workbox/VitePWA injectManifest)
- i18n via i18next

### API Server (`apps/api/src/`)
- `index.ts` — Express 5 server, CORS, basic auth gate (via `TRAEFIK_AUTH`), 10MB body limit
- Routes: `/api/auth`, `/api/pages`, `/api/images`, `/api/spaces`, `/api/version`, `/health`
- `/api/internal/check-access` — Internal endpoint for live server (requires `X-Internal-Key` header)
- `middleware/auth.ts` — Session-based auth (90-day expiry, cookie or `x-session-id` header)
- `lib/permissions.ts` — Access control (owner/editor hierarchy, space membership)
- `lib/snapshot.ts` — Snapshot encoding/decoding
- `services/email.ts` — Nodemailer SMTP integration (verification, password reset)
- Redis pub/sub on channel `cypher:page-events` for real-time page event broadcasting

### WebSocket Server (`apps/live/src/server.ts`)
Room-based peer synchronization:
- Peers join rooms (one room per document)
- Operations relayed in real-time (no server-side operation storage)
- Message types: `join`, `leave`, `sync-request`, `sync-response`, `operations`, `awareness`, `peer-joined`, `peer-left`, `room-peers`, `update-available`, `server-shutdown`
- Validates page access via internal API call to `apps/api`
- Subscribes to Redis `cypher:page-events` channel to broadcast API-originated page events
- Client-server version negotiation via `version.json`

## Database Schema (PostgreSQL)

Tables: `users`, `spaces`, `space_members`, `pages`, `snapshots`, `images`, `pageShares`, `sessions`
- Schema defined in `apps/api/src/db/schema.ts` using Drizzle ORM
- Migrations in `apps/api/drizzle/`
- Snapshots store compressed page state with HLC timestamps (clockWall, clockLogical, clockPeerId)
- Max 50 snapshots per page (garbage collected)
- Pages support scheduling fields (scheduledAt, duration, allDay, recurrenceId) and task/color properties

## Key Patterns

- Block types: `paragraph`, `heading1-3`, `bullet_list`, `numbered_list`, `todo_list`, `image`, `line`
- Text format types: `bold`, `italic`, `strikethrough`, `code`, `link`
- Image blocks support width (`number | "full"`), height, objectFit (`"cover" | "contain"`), alt text
- RTL text (Arabic, Hebrew) supported with bidirectional rendering
- IME/composition input handled specially for CJK languages

## Deployment

- Docker: `Dockerfile.web` (Node 22 → nginx, port 4000), `Dockerfile.api` (Bun, port 3000), `Dockerfile.live` (Bun, port 8080)
- Orchestration: Nomad (`cypher.nomad.hcl`)
- Deploy script: `deploy.sh` (rsync + Docker build + Nomad deploy)
- Version management: `version.json` at project root (version number, minVersion, update URLs)

## Ports

- Web dev server: 4000
- API server: 3000
- WebSocket server: 8080
- Web production (Docker): 4000
