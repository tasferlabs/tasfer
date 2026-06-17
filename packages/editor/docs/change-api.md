# ChangeApi redesign — design note

Status: **implemented** (pre-publish). The surface below now lives in
`entries/editor.ts` (`DocPoint`/`DocRange`/`DocNode`, the reworked `ChangeApi`,
and the `getNode`/`getNodes`/`getSelection`/`getMarks` read methods), exported
from `index.ts`. All in-repo call sites (the slash menu's `CONVERT_BLOCK`, the
link/image/math/code overlays, the toolbar) were migrated to it.

## Goal

A minimal, uniform mutation surface that a host can use without ever touching the
internals. Today the only sanctioned read path is `getState()` (the "escape
hatch") + the loose `getSelectionRange`/`getFormatsAtPosition` helpers, both of
which hand back the raw `EditorState`. So the moment anyone writes a real plugin
(toolbar, slash command, link editor) they're in the internals. That is the leak
we're closing.

Two principles drive the design:

1. **Extend atomic functions with an optional target; don't add focus-based
   siblings.** Every mutation defaults to the current caret/selection and takes an
   optional position/range to act elsewhere. This is what collapses today's nine
   methods toward ~7 and removes the "some methods are caret-based, some are
   id+offset-based" split.
2. **Read and write share one position vocabulary.** A `Position` is only useful
   if the host can construct one — which means it had to read the doc first. So the
   type the write methods *accept* is the same type the read methods *return*.
   Design it once; both halves consume it.

## The position vocabulary (the keystone)

Do **not** use ProseMirror-style flat integer positions. In a CRDT a global
integer offset is not stable under concurrent edits — a remote insert above shifts
every number. That is the whole reason the ops are id-addressed. So:

```ts
/** A single point in the document. */
type Point =
  | "caret"                                          // current caret (relative)
  | "start"                                          // document start (relative)
  | "end"                                            // document end (relative)
  | { block: string; offset?: number }              // absolute: inline offset in a block
  | { block: string; side: "before" | "after" };    // absolute: a block edge (for block ops)

/** A span. Defaults to the live selection everywhere it's accepted. */
type Range =
  | "selection"           // the live selection / collapsed caret (default)
  | Point                 // a collapsed range at a point
  | { from: Point; to: Point };
```

- **relative** = the string anchors (`"caret"`, `"start"`, `"end"`) and
  `side: "before" | "after"`.
- **absolute** = `{ block, offset }` — stable, because `block` is a CRDT identity
  and `offset` is local to one block's text.
- **default** everywhere = `"selection"` / `"caret"`, so the ergonomic caret-based
  case never regresses. The optional target is purely additive.

## The mutation surface

```ts
interface ChangeApi {
  // ── inline ──────────────────────────────────────────────────────────────
  /** Insert text, replacing `range`. `range` defaults to the live selection — so
   *  the common "type at caret" case is `insertText("x")`, and replace is the same
   *  method with a range. Folds today's insertText + replaceInlineRange. */
  insertText(text: string, range?: Range, mark?: Mark): this;

  /** Delete `range` (default: the live selection). The named counterpart to
   *  `insertText` — kept as its own verb for DX rather than folding delete into
   *  `insertText("", range)`. Folds today's deleteInlineRange. */
  deleteRange(range?: Range): this;

  /** Apply / remove / toggle an inline mark over `range` (default: selection).
   *  `active` omitted = toggle; attrs-carrying marks (link, math) pass `attrs`.
   *  Folds today's toggleMark + setMarkRange. */
  setMark(name: MarkName, opts?: { active?: boolean; attrs?: Mark["attrs"]; range?: Range }): this;

  // ── block ───────────────────────────────────────────────────────────────
  /** Insert a block at `at` (a block-edge Point; default: after the caret block). */
  insertNode(block: Block, at?: Point): this;

  /** Reconcile the block at `at` (default: caret block) toward `attrs`.
   *  `type` is just the attr whose presence also triggers the structural
   *  transition (void blocks clear text + get a trailing paragraph; "heading"
   *  sugar → heading1–3). Other attrs are validated and set, one block_set per
   *  field. Folds today's setBlock + setNodeAttrs. */
  setNode(attrs: { type?: Block["type"] | "heading"; level?: number } & Record<string, unknown>, at?: Point): this;

  /** Delete the block at `at` (default: caret block). Tombstoned, so undo can
   *  restore it; an empty paragraph replaces the last visible block. */
  deleteNode(at?: Point): this;

  // ── selection ─────────────────────────────────────────────────────────────
  /** Position the caret/selection as part of this change (PM's tr.setSelection).
   *  Composes: c.insertText("x").select("end"). The single sanctioned way to
   *  move the caret inside a transaction — not an arg on every method.
   *  "Select all" is just select({from:"start", to:"end"}); no dedicated method. */
  select(target: Range): this;
}
```

### Mapping from today

| today | becomes |
| --- | --- |
| `insertText(text)` | `insertText(text)` (range defaults to selection) |
| `replaceInlineRange(id, s, e, text, mark?)` | `insertText(text, {from:{block:id,offset:s}, to:{block:id,offset:e}}, mark?)` |
| `deleteInlineRange(id, s, e)` | `deleteRange({from:…, to:…})` |
| `toggleMark(name)` | `setMark(name)` |
| `setMarkRange(id, s, e, mark, active?)` | `setMark(name, {active, attrs, range})` |
| `setBlock(type, {level, deleteFrom, deleteTo})` | `setNode({type, level})` — the `deleteFrom/deleteTo` strip becomes a composed `deleteRange(range)` (see below) |
| `setNodeAttrs(id, attrs)` | `setNode(attrs, {block:id})` |
| `deleteNode(id)` | `deleteNode({block:id})` |
| `selectAll()` | `select({from:"start", to:"end"})` |
| — (missing) | `insertNode(block, at?)` |
| — (missing) | `deleteRange(range?)` |
| — (missing) | `select(target)` |

`deleteFrom`/`deleteTo` on the old `setBlock` were an inline deletion smuggled
into a block op (the slash menu stripping its `/filter` range before converting).
With `deleteRange`, that's just composition and `setNode` stays purely about block
attrs:

```ts
c.deleteRange({ from, to }).setNode({ type: "heading2" });
```

## Block reorder — deferred

A Notion-style block move (`moveNode(from, to)`) is **out of scope for this pass.**
When we do add it, the constraint to remember: it must **not** be implemented as
delete+insert — that mints a new block id and discards the moved block's inline
CRDT history, so a concurrent edit to it from a peer would be lost or orphaned. A
correct move needs either a real reorder op or a position-change on the existing
block, and because the `Operation` union is append-only (old peers must tolerate
it) that's a deliberate cross-peer / protocol-version decision. Noted here so it's
a conscious choice when the time comes, not an accident.

## The read side (same vocabulary)

The write surface above is only usable if the host can build a `Point`/`Range`
without `getState()`. So the read API returns exactly those types. Sketch (to be
fleshed out):

```ts
interface ReadApi {
  /** Plain-data view of a block (type, attrs, text) — never the internal node. */
  getNode(at?: Point): { id: string; type: string; attrs: Record<string, unknown>; text: string } | null;
  /** All blocks, in document order, as plain data. */
  getNodes(): ReadonlyArray<{ id: string; type: string; attrs: Record<string, unknown>; text: string }>;
  /** The current selection as a Range (the same type write methods accept). */
  getSelection(): Range;
  /** Inline marks active over a range (default: selection). */
  getMarks(range?: Range): ReadonlySet<MarkName>;
}
```

This is what lets a plugin author work cold: read a `Range`/`Point`, hand it
straight back to a mutation, never grok `EditorState`.

## Net surface

- **inline:** `insertText` · `deleteRange` · `setMark`
- **block:** `insertNode` · `setNode` · `deleteNode`
- **selection:** `select`
- **read:** `getNode` · `getNodes` · `getSelection` · `getMarks`

Seven write methods, uniform under one `Point`/`Range` type, the Block/Node naming
split gone, and the `getState()` escape hatch no longer on the critical path for
any normal plugin. Block reorder is deferred (see above).

## Decisions settled

- **`deleteRange` is its own verb** (not folded into `insertText("", range)`) —
  better DX, reads clearly cold.
- **No `selectAll`** — it's just `select({from:"start", to:"end"})`.
- **Reorder deferred** — `moveNode` is out of scope for this pass.
