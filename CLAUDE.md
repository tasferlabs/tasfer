# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important: Root Cause Analysis

Do NOT jump to the first solution that comes to mind. Before implementing a fix or change, take a step back and consider:
- What is the **actual root cause**, not just the surface symptom?
- Are there **other scenarios** or edge cases affected by this issue?
- Could the fix introduce problems elsewhere?
- Is there a more fundamental solution that addresses multiple related issues at once?

Think through the problem more broadly before writing code. The first idea is often a band-aid — dig deeper.

## Project Overview

Cypher is a canvas-based markdown text editor combining Google Docs-like editing with Notion-style block architecture. Text is rendered directly on HTML5 canvas (not DOM-based). Fully peer-to-peer and local-first — no central server, no accounts, no cloud dependency. Data lives on your device, collaboration happens directly between peers over WebRTC, and everything works offline.

## Monorepo Structure

```
apps/
├── web/      # Main React SPA (Vite + React 19 + TypeScript)
├── desktop/  # Electron app wrapper with native IPC layer
├── live/     # Stateless WebRTC signaling relay (port 8080)
├── ios/      # iOS native WebView wrapper (Capacitor)
└── android/  # Android native WebView wrapper (Capacitor)
shared/       # Shared TypeScript types and utilities
```

## Development Commands

### Web App (root or `apps/web`) — uses npm
```bash
npm run dev          # Start Vite dev server (port 4000)
npm run dev:host     # Dev server accessible from network (for mobile testing)
npm run build        # TypeScript check + production build
```

### Signaling Server (`apps/live`) — uses Bun
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

### Platform Layer (`apps/web/src/platform/`)
Cross-platform abstraction — one implementation, three runtimes (Web, Electron, Capacitor).

- `types.ts` — Platform interface contract: identity, peers, spaces, pages, sync events, storage
- `engine.ts` — Shared business logic: SQLite schema, CRDT space operations, identity/keypair management, pairing protocol, peer trust, asset management
- `sync.ts` — Replicator: pull-based P2P replication over WebRTC DataChannels, version vector sync, awareness routing, lazy asset pull
- `driver.ts` — Minimal platform contract: `DbDriver`, `FsDriver`, `CryptoDriver`
- `bridge.ts` — Native bridge definition injected by iOS/Android (clipboard, haptics, navigation, storage)
- `index.ts` — Platform detection and initialization (detects Web/Electron/Capacitor, creates appropriate drivers)

### Platform Adapters (`apps/web/src/platform/adapters/`)
- `web.ts` — Browser: OPFS (Origin Private File System) + wa-sqlite (WebAssembly SQLite in Web Worker)
- `electron.ts` — Desktop: IPC proxy to Electron main process (better-sqlite3 + node:fs + node:crypto)
- `capacitor.ts` — Mobile: native SQLite plugin + Capacitor filesystem + TweetNaCl.js for Ed25519
- `webrtc.ts` — Shared WebRTC network driver (all platforms): signaling via WebSocket to `apps/live`, then direct P2P DataChannels

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
- `awareness.ts` — Peer cursors/selections/presence
- Character IDs use `${peerId}:${counter}` format

### State Management (`apps/web/src/editor/state.ts`)
Three-layer state architecture:
1. **DocumentState** — Content (page, cursor, selection) — persisted in undo/redo
2. **UIState** — UI interactions (menus, composition modes)
3. **ViewState** — Ephemeral viewport info (scroll position)

### Web App (`apps/web/src/`)
- Entry point: `main.tsx` — calls `initPlatform()` to set up Engine + Replicator, starts P2P sync before rendering
- Path aliases: `@/*` → `./src/*`, `@shared/*` → `../../shared/*`
- `app/MountedEditor.tsx` — Main editor mount component, uses `useP2PRoom` hook for real-time sync
- `app/hooks/useP2PRoom.ts` — Page-level P2P room subscription (operations, awareness, peer presence)
- `deserializer/` — Page loading (`loadPage.ts`), markdown parsing (`parser.ts`, `tokenizer.ts`), serialization (`serializer.ts`)
- `sw.ts` / `sw-router.ts` — Service Worker (PWA via workbox/VitePWA injectManifest)
- i18n via i18next

### Desktop App (`apps/desktop/`)
Thin Electron wrapper — IPC layer to native APIs:
- `src/main/index.ts` — Entry point, creates browser window, registers IPC handlers
- `src/main/handlers/db.ts` — SQL execution via better-sqlite3
- `src/main/handlers/fs.ts` — Filesystem operations via node:fs
- `src/main/handlers/crypto.ts` — Ed25519 keypair generation/signing/verification via node:crypto

### Signaling Server (`apps/live/src/server.ts`)
Stateless WebRTC signaling relay (~200 lines):
- Handles topic-based peer discovery and SDP/ICE exchange
- Message types: `join`, `leave`, `signal`, `peers`, `peer-join`
- No operation storage, no auth, no business logic
- Peers establish direct P2P connections once signaling completes

## Identity & Cryptography

- Each device generates an **Ed25519 keypair** on first launch, stored in local SQLite
- Public key = peer identity (hex-encoded 32-byte key)
- Peer trust established via one-time pairing invites (random topic + secret + mutual Ed25519 signature proof)
- No passwords, no accounts, no central auth server

## Storage

All data stored locally on each device — no central database.

### SQLite Schema (local, per-device)
Tables: `identity`, `peers`, `spaces`, `space_members`, `pages`, `operations`, `snapshots`, `assets`
- Defined in `apps/web/src/platform/engine.ts`
- Per-platform SQLite implementation: wa-sqlite (Web), better-sqlite3 (Electron), @capacitor-community/sqlite (Mobile)

### Per-Platform Storage
- **Web**: OPFS (Origin Private File System) + wa-sqlite in Web Worker
- **Electron**: `~/.cypher/` directory + better-sqlite3
- **Mobile**: App sandbox + native SQLite plugin

### CRDT State is Source of Truth
Pages are not stored as files. The CRDT operation log + snapshots are the authoritative representation. Markdown export is optional (one-way derived view).

### Assets
Content-addressed (`assets/{content-hash}.{ext}`). CRDT ops sync eagerly, assets sync lazily (pulled when document is opened).

## Sync — P2P, CRDT-powered

- **WebRTC DataChannels** for direct peer-to-peer data transfer
- **Deterministic topics**: SHA-256(sorted public keys) for peer discovery
- **Pull-based replication**: version vector exchange, then missing ops sent
- **Real-time push**: after catch-up, new ops broadcast immediately
- **Awareness**: cursor/selection updates for collaborative editing
- **Lazy asset pull**: images requested from connected peers on demand
- **Offline**: edit freely, sync merges automatically when peers reconnect
- **No conflicts**: CRDT guarantees convergence

### Space Operations (CRDT)
Spaces are CRDT-replicated collections: `space_set`, `member_add`, `member_remove`, `page_add`, `page_remove`, `page_set` — all HLC-stamped, no central authority.

## Internationalization (i18n)

The app is fully internationalized using i18next + react-i18next. **All user-facing strings MUST use the `t()` function** — never hardcode raw text strings in UI components.

- Setup: `apps/web/src/i18n.ts` (i18next with HTTP backend + browser language detection)
- Translation files: `apps/web/public/locales/{lang}/translation.json`
- In React components: use the `useTranslation()` hook → `const { t } = useTranslation()`
- Outside React (plain TS): import `i18next` directly and call `i18next.t("key")`
- When adding new UI text, always add the key to the translation JSON files and reference it via `t("key")`

## Key Patterns

- Block types: `paragraph`, `heading1-3`, `bullet_list`, `numbered_list`, `todo_list`, `image`, `line`
- Text format types: `bold`, `italic`, `strikethrough`, `code`, `link`
- Image blocks support width (`number | "full"`), height, objectFit (`"cover" | "contain"`), alt text
- RTL text (Arabic, Hebrew) supported with bidirectional rendering
- IME/composition input handled specially for CJK languages

## Ports

- Web dev server: 4000
- Signaling server: 8080
