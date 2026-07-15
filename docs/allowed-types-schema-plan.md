# Plan: ProseMirror-style allowed block/mark types (schema whitelist)

Status: **implemented.** `packages/editor` tests (622) + lint pass; `apps/web`
build (tsc + vite) and `apps/site` docs build pass. The `apps/web` toolbar/slash
hiding is intentionally deferred — it is a no-op while the body editor is
unrestricted; the hook (`schema.data.isBlockAllowed` / `isMarkAllowed`) is ready
for whenever a restricted editor (e.g. a title field) is added.

## What shipped

- `DataSchema.restrict()` + `Schema.restrict()` with `allowedBlocks`/
  `allowedMarks`, `isBlockAllowed`/`isMarkAllowed`/`coerceCreatable`/
  `fallbackBlockType`; `SchemaRestriction` exported from the package entry.
- `EditorState.schema` threaded through `createInitialState` → `mount` → `create`.
- Pure `serlization/normalize.ts` (`normalizeBlocks`), applied at paste
  (`clipboard.insertBlocksAtCursor`) and import (`loadPage`, `setMarkdown`);
  no-op when unrestricted.
- Authoring gates: `convertBlockAtCursor`, `applyMarkdownPrefix`, `splitBlock`
  (coerced continuation in the emitted op), `convertToList`,
  `detectAndApplyInlineMarkdown`, `toggleFormat`, `setMarkRangeAction`,
  `insertBlockAction`, `setBlockAction`, plus link autodetect + image paste.
- Reducer/oplog left agnostic with loud guard comments; new
  `schema.restrict.test.ts` (22 tests) incl. a convergence check.
- Docs: `api-schema.mdx` (Restricting section), `collaboration.mdx`,
  `custom-nodes.mdx`, `api-commands.mdx`.

---

## Original plan (for reference)

Decisions locked (see "Decisions").

## Context

Tasfer's `Schema` today is a **registry** — it defines which block/mark types
*exist* and how they render, validate, and serialize. It has no notion of which
types are *permitted* to be authored. There is no way to say "this editor only
allows paragraphs and bullet lists" (a title field, a comment box, a constrained
note). ProseMirror expresses this in its schema; Tasfer can't.

Goal: add a ProseMirror-style **allow-list** to the schema. Because Tasfer is a
flat block list (not a nested tree), PM "content expressions" don't apply — the
relevant concept is simply *whitelisting which registered types may be created*.

**Intent / who this is for.** The main document (body) editor is **always
unrestricted** and stays that way — this feature adds no restriction to it. The
allow-list is an **opt-in capability** built into the editor package for:

- **Future internal callers** — e.g. a single-field title input that should only
  hold one heading, a comment box, etc.
- **External / third-party embedders** consuming the editor package, who need to
  constrain their own editor instances.

Nothing restricts the current editor until a caller explicitly calls `restrict()`.
Because external parties are a target consumer, the **public API surface and docs
are first-class deliverables** (export from `packages/editor/src/index.ts`,
document in `api-schema.mdx`), not afterthoughts.

## Decisions

- **Default is unrestricted.** `allowedBlocks`/`allowedMarks` are `undefined`
  unless `restrict()` is called; the helpers return `true` for every type when
  unset. The body editor calls nothing new and behaves identically.
- **Scope:** blocks **and** marks (faithful to ProseMirror). Includes gating mark
  toggles and hiding disallowed formatting controls in `apps/web` — but see
  below: that gating is a no-op for the unrestricted main editor.
- **Existing content:** the registry stays **full**. A restricted editor still
  *renders* a disallowed block that arrives via sync or an older snapshot; it only
  gates *new* authoring. `normalizeBlocks` runs on **paste and non-synced import**,
  never as a rewrite of a collaboratively-synced document.
- **Enforcement tier:** authoring-time only. The reducer/oplog is left untouched.

## Key architectural decision: authoring-time, not CRDT-level

The whitelist gates **local authoring only**. The reducer/oplog stays completely
schema-agnostic about it. This is forced by the local-first / P2P model:

- `packages/editor/src/sync/__fuzz__/forward-compat.test.ts` pins the rule: an op
  the reducer can't model is **kept in the log + version vector** but not
  materialized — peers never diverge because the *log* is identical.
- If a restricted peer's reducer *dropped* a permissive peer's heading, two peers
  with different allow-lists would produce **different documents from the same
  log** → divergence.

So: a restricted editor keeps the full registry (still *renders* a heading that
arrives via sync or an old snapshot), but the local user can't *create* one. The
allow-list is a subset of the registered set, checked only at authoring
boundaries.

## Public API (schema-level, immutable)

A new `restrict()` on the immutable `Schema`, mirroring `extend()`:

```ts
const bodySchema  = baseSchema.extend({ nodes: [...] });   // full editor
const titleSchema = bodySchema.restrict({ blocks: ["heading1"], marks: [] });
const titleEditor = createEditor({ element, schema: titleSchema });
// Enter/slash/markdown/paste can only ever produce heading1 (paragraph auto-allowed
// as fallback); bold/italic/link no-op; a pasted or remote heading2 still RENDERS.
```

- `restrict({ blocks?, marks? })` — omit a key = unrestricted; `marks: []` = a
  format-free field.
- Stored as `allowedBlocks?/allowedMarks?: ReadonlySet<string>` on the canvas-free
  `DataSchema` (`undefined` = unrestricted, so every existing 2-arg
  `new DataSchema(...)` call site is untouched).
- **Mandatory-fallback invariant:** `restrict()` always unions `paragraph` into
  `allowedBlocks` — it can never be excluded, so a document can never become
  unrepresentable (`paragraph` is already the universal fallback:
  `getFallbackCodec`, delete-replacement, `loadPage`'s ≥1-block guarantee).
- Rejects an unregistered name with an `invariant` (same precedent as
  `resolveMarkCodec` at extend time).
- Helpers on `DataSchema`: `isBlockAllowed`, `isMarkAllowed`,
  `coerceCreatable(type) → allowed type or paragraph`, `fallbackBlockType()`.
  Exposed publicly so host chrome can hide disallowed controls.

## Enforcement points (all local authoring)

`EditorState` gains a per-instance `schema: DataSchema` reference (threaded through
`state-utils.createInitialState` → `entries/mount.ts` → `entries/create.ts`,
mirroring how `nodes`/`marks` already flow). Then every authoring path consults it:

| Path | File · symbol | Change |
| --- | --- | --- |
| Slash / command convert | `actions/actions.ts` · `convertBlockAtCursor` (~3257) | no-op if `!isBlockAllowed(type)` — one check covers textual + void branches (already fully generic via `createDefaultBlock`) |
| Markdown input rules (`# `, `- `, fenced code, `> `) | `actions/actions.ts` · `applyMarkdownPrefix` (~290) | if target disallowed, don't morph and **leave the literal prefix** |
| Enter split continuation | `actions/actions.ts` · `splitBlock` | `coerceCreatable` the continuation type and emit the **coerced** `blockType` in the op (not just local state) |
| List convert | `actions/actions.ts` · `convertToList` (~3740) | no-op if list type disallowed (builds literals, bypasses `createDefaultBlock`) |
| Inline auto-format (`**x**`) | `actions/actions.ts` · `detectAndApplyInlineMarkdown` | skip patterns whose mark is disallowed |
| Change API | `entries/editor.ts` · `setBlock` / `insertBlock` / `setMark` / `canToggleMark` | `coerceCreatable` / no-op for disallowed types & marks |
| **Paste** (single boundary) | `actions/clipboard.ts` · `insertBlocksAtCursor` (~883) | `blocks = normalizeBlocks(blocks, schema)` before the emit loop |
| Direct clipboard inserts | `clipboard.ts` · image insert, atomic insert, `autoLinkInRange` | skip when the block/mark is disallowed |
| Load / import / setMarkdown | `serlization/loadPage.ts` · `loadPage` | `normalizeBlocks(page.blocks, schema)` for non-synced imports |
| **Reducer / oplog** | `sync/reducer.ts`, `sync/oplog.ts` | **Deliberately UNCHANGED** + a loud guard comment; a fuzz test asserts reducer output is identical with/without an allow-list |

### `normalizeBlocks(blocks, schema)`

One pure helper (new `serlization/normalize.ts`) shared by paste and load:

1. allowed → keep;
2. text-bearing & coercible (`canMorphTo(type, paragraph)`) → coerce to paragraph,
   **preserving id / orderKey / charRuns** (drop type-specific fields; a disallowed
   math block keeps its LaTeX as plain text);
3. void/atomic that can't coerce (image, line, disallowed code) → drop;
4. filter surviving `block.formats` to `isMarkAllowed` (covers the parser's link
   special-case + autolink);
5. never return empty — emit one paragraph if everything dropped.

Determinism: pure function of `(block, schema)`, no randomness — identical input
yields identical output, so peers converge.

## Convergence safety

Registry stays full ⇒ the reducer's materialize decision depends only on
`hasBlock` (identical across peers sharing the base registry), never on the
allow-list. Peers with **different** allow-lists still converge: the allow-list
governs only what a peer can *mint*, not how it *projects* the shared log. Coercion
is pure and preserves char IDs + orderKeys, so CRDT identity is stable. Undo/redo
inverses are recorded after coercion, so a replayed inverse can only recreate a
registered type.

## Testing

- `sync/schema.test`: allow-list predicates, `coerceCreatable`, paragraph always
  included & non-excludable, `restrict()` immutability, unregistered-name
  invariant, registry stays full after `restrict`.
- Action tests: disallowed markdown prefix stays literal; `convertBlockAtCursor` /
  `convertToList` no-op; split coerces the **emitted op** payload; `setMark` /
  `canToggleMark` no-op.
- `clipboard.test` / `loadPage.test`: `normalizeBlocks` coerces heading→paragraph
  preserving text, drops void, strips disallowed marks, honors empty-doc
  invariant; purity (same input twice → deep-equal).
- **New fuzz test** (mirroring `forward-compat.test.ts`, ops-only seeding):
  restricted peer + permissive peer → both converge, restricted peer *renders* the
  heading but can't author one; reducer byte-identical with/without an allow-list.
- `apps/web` build with a title editor using `restrict`.

## apps/web integration (marks scope)

The body editor is unrestricted, so this gating is a **no-op for it** —
`isBlockAllowed` / `isMarkAllowed` return `true` for everything when the schema
carries no allow-list. The gating only takes effect for a future restricted
instance (e.g. the title input). Wiring it now just makes the chrome
allow-list-aware ahead of the first restricted caller.

- `apps/web/src/app/MountedEditor.tsx` — hide bold/italic/code/strike/link/math
  buttons (desktop + mobile bars) via `isMarkAllowed`.
- `apps/web/src/editor/SlashActionMenu.tsx` — filter items via `isBlockAllowed`.
- The motivating first caller (a future title editor) consumes
  `appSchema.restrict({ blocks: ["heading1"], marks: [] })`.

## Public API export (external parties)

Because third-party embedders are a target consumer, ensure the surface is
exported and stable:

- `packages/editor/src/index.ts` — export `restrict`'s types (`SchemaRestriction`)
  alongside the existing `Schema` / `SchemaExtension` exports; `restrict()` rides
  on the already-exported `Schema`. Confirm `packages/react` passes `schema`
  through unchanged (no new prop needed).

## Docs to update

- `apps/site/src/views/DocsPage/pages/editor/api-schema.mdx` — new "Restricting
  types" section (`restrict`, allowedBlocks/allowedMarks, mandatory paragraph
  fallback, create-vs-render distinction).
- `api-editor.mdx` — register-vs-restrict distinction.
- `custom-nodes.mdx` — restricted peers still render remote/pasted disallowed
  blocks.
- `api-commands.mdx` — `setMark` / `setBlock` / `insertBlock` no-op / normalize
  semantics.
- `collaboration.mdx` — peers with differing allow-lists still converge.

## Verification

- `packages/editor`: `npm test` and `npm run lint` (schema, actions, clipboard,
  loadPage, new fuzz test).
- `apps/web`: `npm run build` (typecheck + toolbar/slash gating).
- `apps/site`: `npm run build` (docs).

## Notes / hazards

- Widest mechanical change: threading `DataSchema` onto `EditorState` and adding a
  `schema` param to `applyMarkdownPrefix` (~10 call sites in `actions.ts`).
- Subtle correctness point: the `splitBlock` fix must write the coerced
  continuation type into the **emitted `block_insert` op**, not just local state.
- Correctness hazard: never add the allow-list check into
  `applyBlockInsert` / `applyBlockSet` / oplog — it silently diverges peers. Guard
  with a loud comment and the fuzz test.
