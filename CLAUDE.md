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

### Verifying editor changes (preview is hard right now)

Browser-preview / automated UI verification of editor behavior is currently difficult **because of
the nature of the app**: the editor renders text directly onto an HTML5 `<canvas>` (not DOM), and
all input flows through a hidden 1px contenteditable surface driven by `keydown` / `input`
(`inputType: "insertText"`) events. So preview tools that rely on DOM selectors, accessibility
snapshots, or synthetic clicks/typing can't reliably see or drive the document:
- The visible content is pixels on a canvas — `preview_snapshot` / DOM queries return almost nothing.
- Pasting markdown into an existing text block inserts it as literal text (it does **not** re-parse
  into new blocks), and a fresh page's first click often lands in the title, not the body.
- Creating a block means driving the slash menu via synthetic `input`/`keydown` on the hidden
  contenteditable, which is fiddly and flaky.

Prefer **unit tests** (`npm test` in `packages/editor`) plus the **web build** (`npm run build` in
`apps/web`, the canonical typecheck) to verify editor work. Only the host-rendered React chrome
(overlays, popovers, menus, toolbars) is reliably inspectable via the browser preview, since that
part is real DOM. When a visual check is needed, expect to fall back to a manual screenshot.

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
- `entries/` — lifecycle/orchestration: `mount.ts` (`mountEditor`: attach the engine to a canvas; low-level lifecycle), `editor.ts` (the `Editor` instance API — actions, action chains, change transactions, marks), `create.ts` (`createEditor`: parse Markdown + mount in one call, returning a `CypherEditor` that merges the action API with the mount lifecycle), `layers.ts` (stacked canvas layers)
- `doc.ts` — **Doc abstraction**: the CRDT document as a first-class, editor-independent object. `createDoc` (from markdown / blocks / persisted bytes), sync via `applyUpdate` + `on("update")`, persist via `encodeState()`. An editor without an explicit `doc` gets a private one (`editor.doc`). The Doc is the source of truth; the editor is a view over it.
- `schema.ts` + `sync/schema.ts` — **Extensible schema**: declare custom block types (`defineNode`) and inline marks (`defineMark`), bundle them via `baseSchema.extend(...)`, pass to `createEditor({ schema })`. Split in two halves so the sync/fuzz import graph never pulls in canvas code: `sync/schema.ts` is the canvas-free `DataSchema` (CRDT + serialization facets — per-type descriptors + codecs; `baseDataSchema`); `schema.ts` adds the rendering `NodeRegistry` (the full `Schema`). Schemas are immutable per-instance values — `extend()` returns a new one, nothing is mutated in place.
- `rendering/` — `renderer.ts` (canvas rendering), `scrollbar.ts`, and `nodes/` — the **per-instance node registry** (the former "BlockView", renamed to `Node`). Each block type is a `Node` subclass (`TextNode`, `ListNode`, `ImageNode`, `LineNode`, `MathNode`, `BoxNode`, `AtomicNode`, `UnknownNode`) that owns its own layout, painting, hit-testing, and `NodeHitRegion`s. A `NodeHitRegion` is geometry by default but may **carry its own behavior** (`priority`/`onTap`/`drag`) — e.g. `ImageNode`'s resize handle owns its drag — in which case the event layer binds it directly instead of by id. Nodes **and marks** contribute pointer/cursor behavior the same way every other extension does — by registering action-bus handlers in `registerActions(bus)` (there are no `onPointerMove`/`onTextClick` virtual methods; see the Action Bus section). `node-shared.ts` holds leaf helpers shared by the node views (kept out of `state-utils` to avoid an import cycle).
- `events/` — manual input handling: keyboard (`keysEvents.ts`), mouse (`mouseEvents.ts`), touch (`touchEvents.ts`), IME composition (`compositionEvents.ts`), plus `events.ts`/`genericEvents.ts`/`eventUtils.ts`. **Region-based input**: interactive areas are modeled as hit regions (`regions.ts`) — `chromeRegions.ts` (built-in chrome: scrollbar thumb/track, touch selection handles, off-screen peer indicators) and `blockRegions.ts` (adapts the regions a `Node` declares into event-layer regions: a region that carries its own behavior — e.g. `ImageNode`'s `image-resize` drag — is bound directly, while a geometry-only region is bound by id, the remaining built-in case being `todo-checkbox`). `session.ts` holds per-instance pointer-interaction state (formerly module-level globals); `autoScroll.ts` is the shared edge-of-viewport scroll curve; `haptics.ts` bridges native vibration.
- `actions/` — `actions.ts` (editor actions as pure `(state) => { state, ops }` transform functions), `clipboard.ts`, and the named, dispatchable `StateAction` modules migrated out of the `events/` handlers (see the Action Bus section below): `keyboard-actions.ts` (cursor moves + selection extension), `edit-actions.ts` (insert/delete/split/clear/select-all), `mouse-actions.ts` (click/selection/generic hover + overlays), `touch-actions.ts` (tap/long-press/visual-block), `input-actions.ts` (IME composition / paste / copy / cut). **Node- and mark-specific actions live with their node/mark**, not here: the built-in mark toggles (`TOGGLE_BOLD`/`TOGGLE_ITALIC`/`TOGGLE_CODE`/`TOGGLE_STRIKE`) sit in `rendering/marks/toggle-actions.ts` — beside the marks but deliberately NOT on the `Mark` subclasses, so constructing a mark (as `defaultMarks()` does when assembling `baseDataSchema`) stays free of the renderer/reducer import graph; and block-type actions in `nodes/*` (`INDENT_LIST_ITEM`/`OUTDENT_LIST_ITEM`/`TOGGLE_TODO_CHECKED`→`ListNode`; `*_IMAGE_HANDLE_DRAG`/`SET_IMAGE_HOVER`/`CREATE_PARAGRAPH_BELOW_IMAGE`→`ImageNode`; `OPEN_INLINE_MATH_OVERLAY`/`SET_MATH_BLOCK_HOVER`/`SET_INLINE_MATH_HOVER`→`MathNode`). **The interaction glue is itself dispatched through the bus**: the event layer resolves generic geometry and dispatches three generic pointer/cursor actions — `TEXT_CLICK`, `POINTER_MOVE`, `CURSOR_MOVED` (`actions/pointer-actions.ts`) — and nodes **and marks** register handlers on them in `registerActions(bus)`. So image/math hover + inline-math chip-click live in `ImageNode`/`MathNode` handlers; link Ctrl/Cmd+click open + link-hover tooltip live in `LinkMark` handlers; the inline-math arrow-cross overlay lives in a `MathMark` handler. Claim priority: link open at `100` (pre-empts caret), node click claims at `50`, hover/observe at `0`; an unclaimed `TEXT_CLICK` (`dispatchState(...).claimed === false`) lets the dispatching handler place the caret (desktop `PLACE_CURSOR_AT_POINT` / touch `TAP_PLACE_CURSOR`). Geometry the handlers need (caret→doc coords) is passed in via a `resolveCoords` payload callback so mark files stay free of the `selection`→`state-utils` import chain (marks are constructed by `state-utils`, so importing it would be a load-order cycle — the same reason inline-math span detection lives in the leaf `inline-math-spans.ts`). Genuinely cross-node actions (`SELECT_VISUAL_BLOCK`, `OPEN_BLOCK_OVERLAY`, `OPEN_NODE_OVERLAY`) stay in the `mouse`/`touch` modules.
- `math.ts` / `inline-math.ts` — MathJax rendering for `math` blocks and inline-math chips (runs of LaTeX characters tagged with the `math` mark); `composition.ts` (IME state), `cjk.ts` (CJK word-boundary detection), `constants.ts` (interaction thresholds)
- `fonts.ts` — font loading/measurement (host registers font families via the per-instance theme and loads the faces, then notifies via `notifyFontsLoaded`/`notifyFontsChanged`); `selection.ts` — cursor/selection; `styles.ts` — per-instance theme resolution (`resolveTheme`/`mergeTheme`, `DEFAULT_TOKENS`)
- RTL text (Arabic, Hebrew) supported via `rtl.ts`
- Undo/redo is CRDT-aware: converts between index-based positions and CRDT ID-based positions (`inverse.ts`, `sync/crdt-undo.ts`)
- Host integration points are per-instance (no module globals): asset resolution lives on the image node — the engine treats `block.url` as a plain loadable URL, and a host whose images are content-addressed subclasses `ImageNode` and overrides the protected `resolveUrl(url)` hook, registering the subclass in its schema (see `apps/web/src/editorSchema.ts` → `CypherImageNode`). Slash-menu navigation is routed through the action bus (`SLASH_NAVIGATE`/`SLASH_CONFIRM` in `action-bus.ts`)

### Action Bus (`packages/editor/src/action-bus.ts`)
A small, Lexical-style dispatch primitive — a third extension primitive alongside the schema's `defineNode`/`defineMark`. An `action(name)` declares a typed action identified **by reference** (the `name` is debug-only), so actions are safe as shared module-level constants. The handler registry is **per-instance** (`createActionBus`, carried on `EditorState.actionBus` like `nodes`/`marks`) — never a module global — so two editors on a page keep independent listeners. Handlers register with a priority (host default `0`, built-in defaults at `-Infinity`); higher runs first, and returning `true` **overrides** (claims the action, stops propagation) while `false`/`void` **observes**.

There are **three action kinds**, layered:
- **Plain `Action<P>`** (`action(name)`) — a pure signal with no default behavior; `editor.dispatch` walks handlers and returns whether one claimed it. Used for observe/override hooks like `OPEN_LINK`, `COPY`, `SLASH_NAVIGATE`, the touch-gesture milestones (`CURSOR_DRAG_*`, `REGION_DRAG_START`).
- **`MutationAction<P>`** (`action(name, mutate)`) — its default is a **document mutation** expressed against the `ChangeApi` (the doc-mutating surface: `insertText`, `toggleMark`, `deleteNode`, …, all of which emit CRDT ops). `editor.dispatch` runs the default plus every observer inside ONE `change()` — one undo entry, one broadcast, one `on("change")`. This is the high-level, ergonomic form for content edits.
- **`StateAction<P>`** (`stateAction(name, transform)`) — the **lower-level** form: its default is a pure `(state) => { state, ops }` transform, the same currency the event pipeline already trades in. It can express things `ChangeApi` can't — notably **cursor/selection moves that emit no ops**. Dispatched via `state.actionBus.dispatchState(action, state, …)` from *inside* the pure event handlers (which return `{ state, ops }` for their caller to commit), not through the live `Editor` instance. `dispatchState` threads `{ state, ops }` through observers high→low (`handled: true` overrides) then the default transform, mirroring `dispatch`. Conceptually `MutationAction` is sugar layered above this — `editor.change()`/`makeChangeApi` is itself a state-action runner internally.

The `StateAction` kind exists to migrate the imperative logic scattered across the `events/` switch statements (move cursor, extend selection, insert/delete text, click/tap to place the caret, IME composition, etc.) into named, dispatchable, hookable actions. The bulk of that logic now lives in dedicated `actions/*-actions.ts` modules — `keyboard-actions.ts`, `edit-actions.ts`, `mouse-actions.ts`, `touch-actions.ts`, `input-actions.ts` — plus the node/mark-specific actions co-located with their node/mark (see the `actions/` bullet above). Each action is dispatched from its handler via `state.actionBus.dispatchState(...)`, which threads the `{ state, ops }` the handlers already trade in. A handful of genuinely entangled cases (the slash-menu, undo/redo, viewport/momentum scrolling tied to per-instance `session` state) remain inline by design. (Link hover/open and inline-math click/cross — formerly inline — now live on `LinkMark`/`MathMark` via `registerActions`; see the `actions/` bullet and the Mark section.) Actions keep their transforms pure over `EditorState`: any event-derived data (a resolved hit-test position, the composed string, clipboard data) is computed in the handler and passed in via the action payload.

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
- `editor/` — **React UI chrome only** (no engine code): `ContextMenu.tsx`, `SlashActionMenu.tsx`, `FindBar.tsx`, link/image popovers, `MathBlockEditor.tsx`
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
Spaces are CRDT-replicated collections: `space_set`, `member_add`, `member_remove`, `page_add`, `page_remove`, `page_set` — all HLC-stamped, no central authority. The `SpaceOperation` union (`types.ts`) is **append-only** for the same cross-peer reason as the page-level `Operation` union: `engine.storeSpaceOp` persists every received op (type-agnostically) to the log + version vector *before* `applySpaceOp` materializes it, so an unknown space op type from a newer peer survives, advances the VV, and propagates — `applySpaceOp`'s `default` case just declines to materialize what it can't model. Never reshape an existing space op type.

### Backwards compatibility (cross-peer)

Because the app is P2P and local-first there is **no central server to migrate and no flag day** — at any moment peers running different app versions sync with each other (an offline device can deliver months-old ops to a freshly-updated peer, and vice-versa). So compatibility must be *bidirectional*: old code must tolerate new data **and** new code must tolerate old data. These are hard invariants, not guidelines:

- **The `Operation` union (`state-types.ts`) is append-only.** Never reshape, rename a field on, or repurpose an existing op type — an old peer would mis-parse or silently drop it. Add capability as new *fields* on existing ops (old peers ignore unknown fields), or as new *block/mark types* (which degrade gracefully), in preference to new op types.
- **Received unknown data is preserved, never rejected.** Unknown op types no-op in `reducer.applyOp`'s `default` case but stay in the log + version vector; unknown block types stay in the log and render as `UnknownNode` ("Unsupported block"); unknown marks are dropped from *display/export* only. A v1 peer must carry a v2 peer's content through a `Doc.encodeState()` round-trip untouched — never drop unknown ops from the log, or re-saving silently deletes the newer peer's content. (Rule of thumb: reject only data you wrote locally — e.g. the `PersistedDocV1` envelope in `doc.ts`, whose `PERSISTED_DOC_VERSION` check throws a typed, catchable `IncompatibleDocVersionError` so a host can degrade gracefully rather than crash; tolerate everything from the network.)
- **Never change CRDT merge semantics in place.** Convergence holds only if every peer runs the same merge function. A different concurrent-insert ordering = permanent divergence. Gate any semantic change behind a protocol-version bump.
- **Versions are negotiated in the `hello` handshake.** `PROTOCOL_VERSION` (sync.ts — message/op/CRDT semantics) and `WIRE_VERSION` (wire-codec.ts — byte-level op encoding) are exchanged on connect; `Replicator.onPeerVersionMismatch` surfaces a mismatch to the host. A **wire-incompatible** peer (different `WIRE_VERSION`) is *refused* — the replicator exchanges no ops/awareness with it in either direction, since its ops can't be reliably decoded (`PeerConnection.wireIncompatible`). A **protocol-only** mismatch (same wire) still syncs — that's forward-compat by design. Bump `WIRE_VERSION` only when `compressOp`/`expandOp` change incompatibly; bump `PROTOCOL_VERSION` on any protocol-level change, and only emit new-protocol ops to peers whose negotiated version supports them.
- **Snapshots are derived, never authoritative.** The op log is the source of truth; a snapshot is a rebuildable cache (`opCount` staleness check). Snapshot-format changes are low-risk *as long as the op-log format stays stable* — spend the compatibility budget on ops, not snapshots.
- **Local storage migration is the separate, easy half.** Per-device SQLite schema changes use the `PRAGMA user_version` scaffolding in `engine.ts` (`SCHEMA_VERSION` / `getPendingMigrations` / `applyMigrations`) — one-directional, classic, unrelated to the cross-peer wire concerns above.

The forward-compat guarantee is covered by `sync/__fuzz__/forward-compat.test.ts` (a future op type + unknown block type fed through `Doc.applyUpdate`, asserting no crash, known content intact, unknown ops surviving an `encodeState` round-trip and converging across peers).

## Internationalization (i18n)

The app is fully internationalized using i18next + react-i18next. **All user-facing strings MUST use the `t()` function** — never hardcode raw text strings in UI components.

- Setup: `apps/web/src/i18n.ts` (i18next with HTTP backend + browser language detection)
- Translation files: `apps/web/public/locales/{lang}/translation.json`
- In React components: use the `useTranslation()` hook → `const { t } = useTranslation()`
- Outside React (plain TS): import `i18next` directly and call `i18next.t("key")`
- When adding new UI text, always add the key to the translation JSON files and reference it via `t("key")`

## Key Patterns

- Built-in block types (`sync/block-registry.ts`): `paragraph`, `heading1`/`heading2`/`heading3`, `bullet_list`, `numbered_list`, `todo_list`, `image`, `line`, `math`. Custom block types are added via the schema (`defineNode`)
- Built-in inline mark types: `strong`, `emphasis`, `strike`, `code`, `link`, `math` — each is a `Mark` subclass in `rendering/marks/*` that owns ALL its facets, including its serialization `codec` (the inline analogue of a node owning its codec). There is **no central enumeration of mark types or codecs**: `baseDataSchema` derives the schema's marks from `defaultMarks()`, and `defaultMarks()`/`defaultNodes()` are the single source of truth for the built-in set (`baseSchema` is built straight from them, never a hand-listed copy). (Note: these are the CRDT mark names — `strong`/`emphasis`/`strike`, not `bold`/`italic`/`strikethrough`.) Custom marks are added via the schema (`defineMark`)
- Image blocks support width (`number | "full"`), height, objectFit (`"cover" | "contain"`), alt text
- Inline math is a run of LaTeX characters carrying the `math` mark (rendered as a chip); block math is the `math` block type
- RTL text (Arabic, Hebrew) supported with bidirectional rendering
- IME/composition input handled specially for CJK languages

## Ports

- Web dev server: 4000
- Signaling server: 8080
