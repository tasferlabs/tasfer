# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important: Root Cause Analysis

Do NOT jump to the first solution that comes to mind. Before implementing a fix or change, take a step back and consider:
- What is the **actual root cause**, not just the surface symptom?
- Are there **other scenarios** or edge cases affected by this issue?
- Could the fix introduce problems elsewhere?
- Is there a more fundamental solution that addresses multiple related issues at once?

Think through the problem more broadly before writing code. The first idea is often a band-aid — dig deeper.

## Important: No Global Variables

Do NOT use global variables (module-level mutable state, singletons holding mutable data, globals on `window`/`globalThis`, etc.). The key reason: the editor must support **multiple editor instances on the same page**, and global state is shared across all of them — so any two editors would clobber each other's state and break. Keep all state per-instance: pass it explicitly through function arguments, instance fields, or scoped context objects.

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
packages/
└── editor/   # @cypherkit/editor — headless canvas+CRDT editor engine (extracted core)
```

There is **no root `package.json`** and no workspace tool — each app/package manages its own
dependencies and is built/run from its own directory. The `@cypherkit/editor` package is consumed
by `apps/web` as raw TypeScript source via path aliases (see below), not as a built artifact.

> Note: the `@shared/*` path alias is still configured in `apps/web` but the `shared/` directory
> does not currently exist; treat shared types as living inside the relevant package.

## Development Commands

All commands run from the relevant directory — there is no root `package.json`.

### Web App (`apps/web`) — uses npm
```bash
npm run dev          # Start Vite dev server (port 4000)
npm run dev:host     # Dev server accessible from network (for mobile testing)
npm run build        # TypeScript check (tsc) + production build (vite build)
```
The `build` script is the canonical typecheck. It compiles both `apps/web/src` and the aliased
`@cypherkit/editor` source, so type errors in `packages/editor` will fail the web build.

### Editor Package (`packages/editor`)
```bash
npm test             # vitest run — CRDT fuzz/regression tests in src/sync/__fuzz__/*.test.ts
npm run test:watch   # vitest watch mode
npm run lint         # eslint (incl. custom rules in eslint-rules/)
npm run lint:fix     # eslint --fix
npm run format       # prettier --write
npm run format:check # prettier --check
```
No standalone build step — the package ships TS source consumed directly by `apps/web`.
The convergence fuzz accepts `FUZZ_SEED` / `FUZZ_PEERS` / `FUZZ_OPS` env vars to reproduce
or scale a run (failing random seeds are printed).

### Signaling Server (`apps/live`) — uses Bun
```bash
npm run dev          # Watch mode with tsx
```

### Mobile (Capacitor) — from `apps/web`
```bash
npm run cap:sync           # Sync web build to native projects
npm run cap:open:ios       # Open iOS project in Xcode
npm run cap:open:android   # Open Android project in Android Studio
```

`apps/web` has no test runner configured. `packages/editor` uses vitest (`npm test`); the CRDT
fuzz/regression tests live in `packages/editor/src/sync/__fuzz__/*.test.ts`.

## Architecture

### Platform Layer (`apps/web/src/platform/`)
Cross-platform abstraction — one implementation, three runtimes (Web, Electron, Capacitor).

- `types.ts` — Platform interface contract: identity, peers, spaces, pages, sync events, storage
- `engine.ts` — Shared business logic: SQLite schema, CRDT space operations, identity/keypair management, pairing protocol, peer trust, asset management
- `sync.ts` — Replicator: pull-based P2P replication over WebRTC DataChannels, version vector sync, awareness routing, lazy asset pull
- `driver.ts` — Minimal platform contract: `DbDriver`, `FsDriver`, `CryptoDriver`
- `bridge.ts` — Native bridge definition injected by iOS/Android (clipboard, haptics, navigation, storage)
- `wire-codec.ts` — Encode/decode for the P2P wire format (ops/awareness/asset messages over DataChannels)
- `devlog.ts` — Scoped dev logging
- `index.ts` — Platform detection and initialization (detects Web/Electron/Capacitor, creates appropriate drivers)

### Platform Adapters (`apps/web/src/platform/adapters/`)
- `web.ts` — Browser: OPFS (Origin Private File System) + wa-sqlite (WebAssembly SQLite in Web Worker); the worker itself is `sqlite.worker.ts`
- `electron.ts` — Desktop: IPC proxy to Electron main process (better-sqlite3 + node:fs + node:crypto)
- `capacitor.ts` — Mobile: native SQLite plugin + Capacitor filesystem + TweetNaCl.js for Ed25519
- `webrtc.ts` — Shared WebRTC network driver (all platforms): signaling via WebSocket to `apps/live`, then direct P2P DataChannels

### Canvas Rendering Engine (`packages/editor/src/` — `@cypherkit/editor`)
The headless editor core was extracted from the web app into the `@cypherkit/editor` package.
It is framework-agnostic (canvas + CRDT + DOM events); the host app supplies fonts, asset
resolution, and React UI chrome. Public surface is `packages/editor/src/index.ts`; deep subpath
imports (e.g. `@cypherkit/editor/sync/awareness`) are also currently allowed (the package
`exports` map exposes both `.` and `./*`).

- Custom text rendering directly on HTML5 Canvas — not DOM-based
- `entries/` — lifecycle/orchestration: `mount.ts` (`mountEditor`: attach the engine to a canvas; low-level lifecycle), `editor.ts` (the `Editor` instance API — commands, command chains, change transactions, marks), `create.ts` (`createEditor`: parse Markdown + mount in one call, returning a `CypherEditor` that merges the command API with the mount lifecycle), `layers.ts` (stacked canvas layers)
- `doc.ts` — **Doc abstraction**: the CRDT document as a first-class, editor-independent object. `createDoc` (from markdown / blocks / persisted bytes), sync via `applyUpdate` + `on("update")`, persist via `encodeState()`. An editor without an explicit `doc` gets a private one (`editor.doc`). The Doc is the source of truth; the editor is a view over it.
- `schema.ts` + `sync/schema.ts` — **Extensible schema**: declare custom block types (`defineNode`) and inline marks (`defineMark`), bundle them via `baseSchema.extend(...)`, pass to `createEditor({ schema })`. Split in two halves so the sync/fuzz import graph never pulls in canvas code: `sync/schema.ts` is the canvas-free `DataSchema` (CRDT + serialization facets — per-type descriptors + codecs; `baseDataSchema`); `schema.ts` adds the rendering `NodeRegistry` (the full `Schema`). Schemas are immutable per-instance values — `extend()` returns a new one, nothing is mutated in place.
- `rendering/` — `renderer.ts` (canvas rendering), `scrollbar.ts`, and `nodes/` — the **per-instance node registry** (the former "BlockView", renamed to `Node`). Each block type is a `Node` subclass (`TextNode`, `ListNode`, `ImageNode`, `LineNode`, `MathNode`, `BoxNode`, `AtomicNode`, `UnknownNode`) that owns its own layout, painting, hit-testing, and geometry-only `NodeHitRegion`s. `node-shared.ts` holds leaf helpers shared by the node views (kept out of `state-utils` to avoid an import cycle).
- `events/` — manual input handling: keyboard (`keysEvents.ts`), mouse (`mouseEvents.ts`), touch (`touchEvents.ts`), IME composition (`compositionEvents.ts`), plus `events.ts`/`genericEvents.ts`/`eventUtils.ts`. **Region-based input**: interactive areas are modeled as hit regions (`regions.ts`) — `chromeRegions.ts` (built-in chrome: scrollbar thumb/track, touch selection handles, off-screen peer indicators) and `blockRegions.ts` (behavior bound by id to the geometry-only regions a `Node` declares, e.g. `todo-checkbox`, `image-resize`). `session.ts` holds per-instance pointer-interaction state (formerly module-level globals); `autoScroll.ts` is the shared edge-of-viewport scroll curve; `haptics.ts` bridges native vibration.
- `actions/` — `commands.ts` (editor commands), `clipboard.ts`
- `math.ts` / `inline-math.ts` — MathJax rendering for `math` blocks and inline-math chips (runs of LaTeX characters tagged with the `math` mark); `composition.ts` (IME state), `cjk.ts` (CJK word-boundary detection), `constants.ts` (interaction thresholds)
- `fonts.ts` — font loading/measurement (host registers font families via the per-instance theme and loads the faces, then notifies via `notifyFontsLoaded`/`notifyFontsChanged`); `selection.ts` — cursor/selection; `styles.ts` — per-instance theme resolution (`resolveTheme`/`mergeTheme`, `DEFAULT_TOKENS`)
- RTL text (Arabic, Hebrew) supported via `rtl.ts`
- Undo/redo is CRDT-aware: converts between index-based positions and CRDT ID-based positions (`inverse.ts`, `sync/crdt-undo.ts`)
- Host integration points are per-instance (no module globals): asset resolution is a `resolveAsset` function passed at mount (`MountEditorOptions.resolveAsset`, stored on `EditorState.resolveAsset`), and slash commands are routed through the command bus (`SLASH_NAVIGATE`/`SLASH_CONFIRM` in `command-bus.ts`)

### CRDT System (`packages/editor/src/sync/`)
Operation-log CRDT for offline-first collaborative editing:
- Operation types (`text_insert`, `text_delete`, `format_set`, `block_insert`, `block_delete`, `block_set`) are the `Operation` union defined in `../state-types.ts` — not under `sync/`
- `hlc.ts` — Hybrid Logical Clock (pure Lamport clock: counter + peerId, no wall clock). Ordering: counter → peerId (lexicographic)
- `char-runs.ts` — RGA-style character-level CRDT using runs (`{peerId, startCounter, text, deletedMask}`); character IDs are `${peerId}:${startCounter + offset}`
- `oplog.ts` — Operation log management; `reducer.ts` — applies operations to document state, resolving concurrent-insert ordering via HLC (there is no separate `conflicts.ts` module)
- `sync.ts` — Public CRDT API + version vector tracking. The per-instance `CRDTbinding` (id/clock/peer identity) is created here (`createCRDTbinding`) and shared between `mountEditor` and `createSyncEngine`
- `schema.ts` — canvas-free `DataSchema` (block/mark descriptors + serialization codecs); see the Schema bullet under the rendering engine above
- `awareness.ts` — Peer cursors/selections/presence
- `crdt-undo.ts` — CRDT-aware undo/redo; `snapshot-diff.ts`, `block-registry.ts`, `id.ts`, `crdt-utils.ts` — supporting utilities
- `__fuzz__/` — convergence + regression fuzz tests (vitest; `npm test` from `packages/editor`)
- Character IDs use `${peerId}:${counter}` format

### State Management (`packages/editor/src/state-types.ts`, `state-utils.ts`)
`state-types.ts` is also where the CRDT `Operation` union and core type aliases (`HLC`, `VersionVector`, `EditorState`, `EditorTheme`, …) live.
Three-layer state architecture:
1. **DocumentState** — Content (page, cursor, selection) — persisted in undo/redo
2. **UIState** — UI interactions (menus, composition modes)
3. **ViewState** — Ephemeral viewport info (scroll position)

### Web App (`apps/web/src/`)
- Entry point: `main.tsx` — calls `initPlatform()` to set up Engine + Replicator, registers fonts, starts P2P sync before rendering (the editor's asset resolver is wired per-instance at mount in `MountedEditor`, not here)
- Path aliases (`apps/web/tsconfig.json` + `vite.config.ts`): `@/*` → `./src/*`, `@cypherkit/editor` → `../../packages/editor/src`, `@shared/*` → `../../shared/*` (shared dir currently absent)
- `app/MountedEditor.tsx` — Main editor mount component (calls `mountEditor` from `@cypherkit/editor`), uses `useP2PRoom` hook for real-time sync
- `app/hooks/useP2PRoom.ts` — Page-level P2P room subscription (operations, awareness, peer presence); `useP2PPageEvents.ts` — page-event wiring on top of it
- `editor/` — **React UI chrome only** (no engine code): `ContextMenu.tsx`, `SlashCommandMenu.tsx`, `FindBar.tsx`, link/image popovers, `MathBlockEditor.tsx`
- `fonts.ts` — host-side font registration; the engine's markdown parsing/serialization lives in the editor package (`packages/editor/src/serlization/`: `loadPage.ts`, `parser.ts`, `tokenizer.ts`, `serializer.ts`, `htmlSerializer.ts`, `textSerializer.ts`, plus per-block-type `codecs/`)
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

- Built-in block types (`sync/block-registry.ts`): `paragraph`, `heading1`/`heading2`/`heading3`, `bullet_list`, `numbered_list`, `todo_list`, `image`, `line`, `math`. Custom block types are added via the schema (`defineNode`)
- Built-in inline mark types (`sync/schema.ts` → `BUILTIN_MARK_TYPES`): `strong`, `emphasis`, `strike`, `code`, `link`, `math`. (Note: these are the CRDT mark names — `strong`/`emphasis`/`strike`, not `bold`/`italic`/`strikethrough`.) Custom marks are added via the schema (`defineMark`)
- Image blocks support width (`number | "full"`), height, objectFit (`"cover" | "contain"`), alt text
- Inline math is a run of LaTeX characters carrying the `math` mark (rendered as a chip); block math is the `math` block type
- RTL text (Arabic, Hebrew) supported with bidirectional rendering
- IME/composition input handled specially for CJK languages

## Ports

- Web dev server: 4000
- Signaling server: 8080
