# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cypher is a canvas-based markdown text editor combining Google Docs-like editing with Notion-style block architecture. Text is rendered directly on HTML5 canvas (not DOM-based). Features real-time collaborative editing with offline-first CRDT synchronization.

## Monorepo Structure

```
apps/
├── web/    # Main React web application (Vite + TypeScript)
├── api/    # Express backend server (PostgreSQL + Drizzle ORM)
├── live/   # WebSocket signaling server for CRDT sync
├── ios/    # iOS native WebView wrapper
└── android/ # Android native WebView wrapper
cdn/        # Local asset storage (images, snapshots)
```

## Development Commands

### Web App (`apps/web`)
```bash
npm run dev          # Start Vite dev server with hot reload
npm run dev:host     # Dev server accessible from network (for mobile testing)
npm run build        # TypeScript check + production build
```

### API Server (`apps/api`)
```bash
npm run dev          # Watch mode with tsx
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Execute migrations
npm run db:studio    # Drizzle Studio UI
```

### Live Server (`apps/live`)
```bash
npm run dev          # Watch mode with tsx
```

## Architecture

### Canvas Rendering Engine (`apps/web/src/editor/`)
- Custom text rendering directly on HTML5 Canvas
- Manual event handling for keyboard, mouse, touch, and composition events
- Located in `renderer.ts`, `fonts.ts`, `events/`

### CRDT System (`apps/web/src/editor/sync/`)
Core operation-log CRDT for offline-first collaborative editing:
- `types.ts` - Operation types: `text_insert`, `text_delete`, `format_set`, `block_insert`, `block_delete`, `block_set`
- `hlc.ts` - Hybrid Logical Clock for operation ordering
- `char-runs.ts` - RGA-style character-level CRDT
- `awareness.ts` - Peer cursors/selections
- `oplog.ts` - Operation log management
- `reducer.ts` - Applies operations to document state

### State Management (`apps/web/src/editor/state.ts`)
Three-layer state architecture:
1. **DocumentState** - Content (page, cursor, selection) - persisted in undo/redo
2. **UIState** - UI interactions (menus, composition modes)
3. **ViewState** - Ephemeral viewport info (scroll position)

### WebSocket Sync (`apps/live/src/server.ts`)
Room-based peer synchronization:
- Peers join rooms per document
- Operations relayed in real-time (no server-side storage)
- Message types: `join`, `leave`, `sync-request`, `sync-response`, `operations`, `awareness`

### Serialization (`apps/web/src/deserializer/`)
- `loadPage.ts` - Load page from backend
- `parser.ts` / `tokenizer.ts` - Parse document structure
- `serializer.ts` - Serialize to storage format

## Database Schema (PostgreSQL)

Tables: `pages`, `snapshots`, `images`
- Snapshots store compressed page state with HLC timestamps
- Max 50 snapshots per page (garbage collected)

## Key Patterns

- Block types: `paragraph`, `heading1-3`, `bullet_list`, `numbered_list`, `todo_list`, `image`, `line`
- Operations use `${peerId}:${counter}` format for unique IDs
- RTL text (Arabic, Hebrew) is supported with bidirectional rendering
- IME/composition input is handled specially for CJK languages

## Ports

- Web dev server: 5173 (default Vite)
- API server: 3000
- WebSocket server: 8080
