# Engineering Reference

Read this document only when working in the relevant subsystem. The operational
rules that apply to every task live in the repository root `AGENTS.md`.

## Editor package

`packages/editor` is the product core and a standalone library. Its public entry
point is `packages/editor/src/index.ts`; the package also exposes deep subpath
imports. `apps/web` consumes its TypeScript source through path aliases.

Important areas:

- `entries/`: editor creation, mounting, lifecycle, and layered canvases
- `doc.ts`: editor-independent CRDT document API
- `schema.ts`, `sync/schema.ts`: rendering and canvas-free data schemas
- `rendering/`: layout, painting, nodes, marks, fonts, and selection
- `events/`: keyboard, mouse, touch, IME, hit regions, and interaction sessions
- `actions/`: generic state transforms and input actions
- `sync/`: operation log, reducer, version vectors, awareness, and fuzz tests
- `serlization/`: markdown and other serialization codecs

The built-in nodes and marks are customers of the extension machinery, not
special cases in the engine. Prefer, in order:

1. Existing node, mark, action-bus, schema-facet, or hit-region extension points.
2. A new general extension point usable by custom implementations.
3. Never a block-type or mark-name branch in generic engine code.

Host-specific asset resolution belongs in a host node subclass registered in
the host schema. Slash-menu and other host UI behavior should cross the boundary
through actions rather than imports from the host.

## Action bus

The action bus is per instance and identifies actions by object reference.
Handlers run from higher to lower priority.

- Plain actions are signals that handlers may observe or claim.
- Mutation actions run document changes through the editor change API.
- State actions are pure state transforms and may represent selection or UI
  changes that emit no document operations.

Node- and mark-specific actions live beside their implementation. Generic
pointer, keyboard, clipboard, and selection actions may live in shared action
modules. Event-derived data should be resolved by the event layer and passed in
the action payload so action transforms remain pure.

## Math editing

Math content has exactly one representation: a structured `MathDocument` in
the block's `structuredContent`, created eagerly by every authoring/import
path. A display equation is a `math` block with EMPTY flat text and a
block-authority document; an inline equation is a `math` mark anchored on a
single U+FFFC placeholder character whose `attrs.contentId` references a
supplemental document. No LaTeX is ever stored in block characters, there is
no lazy migration, and flat offsets never address formula content — all
formula editing flows through the tree controller and nested content
selections. LaTeX is derived by printing the tree (canonicalized — e.g. `x^2`
prints as `{x}^{2}`) for rendering, markdown/HTML export, and clipboard.

The historical flat-string edit model and its corruption class are documented
in [`math-editing-corruption.md`](math-editing-corruption.md); the structured
model above is the resolution of that plan.

## CRDT and persistence

The operation log is authoritative. Reducers materialize document state from
operations, and snapshots are disposable acceleration structures.

Current document operation families include text insertion/deletion, format
changes, and block insertion/deletion/property changes. Space metadata uses a
separate operation union in the web platform layer.

Preserve these properties:

- Every peer applying the same operations reaches the same state.
- Character and block ordering is deterministic.
- Undo and redo produce CRDT operations rather than bypassing the log.
- Unknown network data should not cause crashes or silent loss.
- Persisted state and wire encoding changes update every internal reader,
  writer, fixture, and test while the project remains unreleased.

CRDT tests live under `packages/editor/src/sync/__fuzz__/`. Random failures print
a seed; always retain it for deterministic reproduction.

The future cross-version design is documented in
`apps/site/src/views/InternalsPage/pages/compatibility.mdx`. Until release,
internal consistency takes priority over backward compatibility.

## Web platform

`apps/web/src/platform/` contains shared product logic:

- `types.ts`: platform contract
- `engine.ts`: SQLite schema, identity, spaces, pairing, and assets
- `sync.ts`: peer replication, version-vector exchange, awareness, and assets
- `driver.ts`: database, filesystem, and cryptography driver contracts
- `wire-codec.ts`: peer wire encoding
- `bridge.ts`: native mobile bridge
- `adapters/`: browser, Electron, Capacitor, and WebRTC implementations

Storage implementations:

- Web: OPFS and wa-sqlite in a worker
- Electron: local filesystem and better-sqlite3
- Mobile: application sandbox and native SQLite

Pages are not authoritative markdown files. Their CRDT operation logs and
snapshots are stored locally. Assets are content-addressed, and replication may
fetch them lazily.

## Identity and networking

Each device owns an Ed25519 identity. Pairing establishes peer trust. WebRTC data
channels carry direct peer traffic after discovery and signaling through the
stateless `apps/live` relay.

The relay must not own document state, accounts, authentication, or business
logic. Collaboration and persistence must continue to work without a central
data service.

## Web host and UI

`apps/web/src/main.tsx` initializes the platform and fonts before rendering.
`app/MountedEditor.tsx` mounts the editor. Hooks under `app/hooks/` connect page
state, peer events, and synchronization.

`apps/web/src/editor/` is React chrome around the canvas engine: menus, popovers,
find UI, and overlays. Reusable editing semantics belong in `packages/editor`,
while host presentation and platform integration belong in `apps/web`.

All visible strings use `useTranslation()` in React or `i18next.t()` in plain
TypeScript. Translation files live under
`apps/web/public/app/locales/{lang}/translation.json`.

## Public documentation

The public editor docs under
`apps/site/src/views/DocsPage/pages/editor/` are the human-readable API
specification. Consult them before changing public behavior and update them in
the same change.

Internal design notes under `apps/site/src/views/InternalsPage/pages/` are
background material, not necessarily current runtime contracts. Confirm their
claims against source and tests.
