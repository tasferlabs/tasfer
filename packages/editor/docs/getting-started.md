# Getting started with `@cypherkit/editor`

A step-by-step tutorial that takes you from an empty `<div>` to a working,
CRDT-collaborative block editor — and explains the one concept that makes the
whole thing tick along the way.

`@cypherkit/editor` is a **headless** editor engine: it renders text and blocks
directly onto an HTML5 `<canvas>` (not the DOM), keeps document state as an
operation-log CRDT, and handles keyboard / mouse / touch / IME input itself. It
knows nothing about React, your fonts, your asset storage, or your network. The
**host** (your app) wires those in. That separation is what this tutorial walks
through.

> **Runnable companion code.** Every step below maps to the boilerplate in
> [`examples/minimal/`](./examples/minimal). To run it:
>
> ```bash
> cd packages/editor/docs/examples/minimal
> npm install
> npm run dev          # http://localhost:4100
> ```
>
> The example aliases `@cypherkit/editor` straight to the package's TypeScript
> source — there is no build step (see Step 1).

---

## The mental model (read this first)

Three ideas you'll lean on the whole way through:

1. **Headless core, host adapters.** The engine is platform-agnostic. Anything
   that reaches outside it — fonts, asset URLs, the slash-command list, the
   network — is injected by you. Defaults are safe no-ops, so it runs standalone.

2. **No global state.** The engine is built so you can mount **multiple editor
   instances on one page** without them clobbering each other. Each instance
   owns its own CRDT clock, block registry, and style overrides. (You'll see this
   pay off in the collaboration step, where two editors converge in a single
   tab.)

3. **State, not the DOM, is the source of truth.** A page is a list of `Block`s
   backed by a CRDT operation log. Markdown is just an optional, one-way *view*
   you can derive from it. You drive the editor through an imperative `Editor`
   API and observe it via `subscribe`.

---

## Step 1 — Set up the project

The package ships **raw `.ts` source** and is consumed via a path alias, exactly
like `apps/web` does. There's no compiled artifact to import.

**Vite** (`vite.config.ts`):

```ts
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      // Point the bare specifier at the package's src folder.
      "@cypherkit/editor": resolve(__dirname, "../../../src"),
    },
  },
});
```

**TypeScript** (`tsconfig.json`) — mirror the alias so `tsc` resolves it too:

```jsonc
{
  "compilerOptions": {
    "paths": {
      "@cypherkit/editor": ["../../../src/index.ts"],
      "@cypherkit/editor/*": ["../../../src/*"]
    }
  }
}
```

The package's runtime dependencies are `i18next` and `nanoid`; install those in
your host too so the aliased source resolves them. React is only a **peer**
dependency — you need it for the optional React UI chrome (slash menu, popovers),
but the core editor in this tutorial is plain TypeScript.

> **Two import styles.** The curated public API lives at `@cypherkit/editor`
> (`mountEditor`, `createEditor`, block views, font helpers, core types). Deep
> subpath imports like `@cypherkit/editor/serlization/serializer` are also
> allowed for anything not yet re-exported. (Yes — the folder is spelled
> `serlization` in the source tree.)

---

## Step 2 — Mount your first editor

`mountEditor(container, blocks, options)` creates the canvas layers, wires up all
input handling, starts the render loop, and returns a `MountedEditor` handle.

```ts
import { mountEditor } from "@cypherkit/editor";

const container = document.getElementById("editor")!; // any sized element
const mounted = mountEditor(container, [], { pageId: "my-page" });

// Drop a caret in and focus so typing works right away.
mounted.refocus();
mounted.editor.setInitialCursor();
```

`blocks` is the initial document (`Block[]`). Passing `[]` gives you a blank
page. The container should have a real size — the editor fills it and watches it
with a `ResizeObserver`.

The handle you get back:

```ts
interface MountedEditor {
  editor: Editor;              // the imperative command + state API (Step 5)
  portalContainer: HTMLDivElement; // mount React popovers here, if you use them
  refocus(): void;             // refocus the hidden input
  blurInput(): void;           // dismiss the soft keyboard
  setKeyboardHeight(px): void; // feed it the soft-keyboard height on mobile
  destroy(): void;             // ALWAYS call this on teardown
}
```

> **Always `destroy()`.** It removes global listeners (`window` keydown/paste,
> resize, focus), cancels the render loop, and detaches the canvases. Skipping it
> leaks listeners and leaves a zombie `requestAnimationFrame` running.

---

## Step 3 — Load content from Markdown

You rarely start blank. `loadPage(markdown)` tokenizes + parses Markdown into a
`Page`, and you hand its `blocks` to `mountEditor`.

```ts
import { mountEditor } from "@cypherkit/editor";
import { loadPage } from "@cypherkit/editor/serlization/loadPage";

const { blocks } = loadPage(`# Hello

This is **bold** and this is *italic*.

- a bullet
- another bullet
`);

const mounted = mountEditor(container, blocks, { pageId: "my-page" });
```

`loadPage` always returns **at least one block** (an empty paragraph for empty
input), so the result is always safe to mount. It also understands YAML
frontmatter — `parseFrontmatter` peels off page metadata (color, schedule, etc.)
before parsing the body.

---

## Step 4 — Register fonts

Because text is measured and painted onto a canvas, the engine needs to know
**which CSS font-stacks to measure against**, and it needs the faces to actually
be loaded. The engine bundles **no fonts** — this is the host's job, in three
moves:

```ts
import { setFontStyles } from "@cypherkit/editor/styles";
import { notifyFontsLoaded } from "@cypherkit/editor/fonts";

// 1. Register family keys -> CSS font-stacks.
setFontStyles({
  families: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    serif: 'Georgia, "Times New Roman", Times, serif',
  },
  defaultFamily: "sans",
});

// 2. Load the actual faces. System fonts need no download; for a web font you'd
//    `await new FontFace(...).load()` and add it to document.fonts here.
await document.fonts?.ready;

// 3. Tell the editor — it flushes its metrics cache and repaints.
notifyFontsLoaded();
```

If you skip this entirely, the editor falls back to a neutral system-font stack
so text still renders. Call `notifyFontsChanged()` (instead of `notifyFontsLoaded`)
whenever you swap stacks at runtime — e.g. prepending an Arabic face once it
loads — and `setCurrentFontFamily(key)` to switch the active family.

See [`examples/minimal/src/fonts.ts`](./examples/minimal/src/fonts.ts) for the
whole flow in one file.

---

## Step 5 — Drive the editor (commands + state)

The `editor` handle is your imperative API. A representative slice:

```ts
const { editor } = mounted;

// Formatting (operate on the current selection / pending format).
editor.toggleBold();
editor.toggleItalic();
editor.toggleCode();
editor.toggleStrikethrough();

// Block-level.
editor.setBlockType("heading1"); // paragraph | heading1-3 | bullet_list | ...
editor.selectAll();

// History (CRDT-aware — these emit inverse operations, not text diffs).
editor.undo();
editor.redo();

// Clipboard (async; uses the native Clipboard API).
await editor.copy();
await editor.cut();
await editor.paste();

// Read current state at any time.
const state = editor.getState(); // EditorState | null
```

To **react** to changes, subscribe. The callback fires on every state change —
content edits, selection moves, menu open/close, focus:

```ts
const unsubscribe = editor.subscribe((state) => {
  // e.g. reflect the active block type in your toolbar
  const i = state.document.cursor?.position.blockIndex;
  const block = i != null ? state.document.page.blocks[i] : null;
  console.log("block type:", block?.type);
});

// later…
unsubscribe();
```

> **Focus gotcha.** Clicking your own toolbar buttons moves DOM focus off the
> editor's hidden input, which collapses the selection. Two fixes the example
> uses: call `e.preventDefault()` on the button's `mousedown` (keeps the
> selection), and put a `data-editor-overlay` attribute on overlay UI so the
> editor's focus tracking won't treat it as "clicked outside."

---

## Step 6 — Choose your blocks (the view registry)

Each editor instance owns a **block view registry** — the set of block types it
can render. This is per-instance, so different editors on the same page can
support different block sets.

```ts
import {
  mountEditor,
  textBlockView,
  listBlockView,
  imageBlockView,
  lineBlockView,
} from "@cypherkit/editor";

// An editor that supports text + lists, but NOT images or lines:
mountEditor(container, blocks, {
  blockViews: [textBlockView, listBlockView],
});
```

Omit `blockViews` and you get the built-in default set
(`createDefaultBlockViewRegistry()`), which includes text, lists, images, lines,
and math. Built-in block types: `paragraph`, `heading1`–`heading3`,
`bullet_list`, `numbered_list`, `todo_list`, `image`, `line` (plus math). A
`BlockView` is the seam where you'd later teach the editor to render a *custom*
block.

---

## Step 7 — Save: serialize back to Markdown

Markdown is a derived view — generate it from the live blocks whenever you need
to persist or export:

```ts
import { serializeToMarkdown } from "@cypherkit/editor/serlization/serializer";

const state = editor.getState();
if (state) {
  const markdown = serializeToMarkdown(state.document.page.blocks);
  // write to disk, download, POST somewhere, …
}
```

Pass optional `PageMetadata` as the second argument to emit YAML frontmatter.
Deleted blocks (CRDT tombstones) are filtered out automatically.

To persist *and* reload across sessions you'd typically store the **operation
log** (the CRDT source of truth) rather than Markdown — which is exactly what the
next step is about.

---

## Step 8 (the concept) — Real-time collaboration with the CRDT

Here's the idea that ties everything together. Every edit produces one or more
**operations** (`text_insert`, `text_delete`, `format_set`, `block_insert`, …),
each stamped with a Hybrid Logical Clock. Operations **commute**: apply the same
set in any order, on any peer, and every replica converges to the same document.
No locks, no central authority, no merge conflicts.

The editor exposes two halves of this:

- **Outbound:** `editor.setBroadcast(fn)` — `fn` receives every batch of ops your
  edits produce. Send them to peers and/or persist them.
- **Inbound:** `editor.applyRemoteOperations(ops)` (or
  `updatePageFromSync(page)`) — feed in ops that arrived from elsewhere.

Two bookkeeping calls keep causality correct when you ingest external ops, so
your *next* local op sorts after them:

```ts
import { maxOpIdCounter } from "@cypherkit/editor/sync/sync";

function ingest(ops) {
  for (const op of ops) editor.advanceClock(op.clock); // bump the HLC
  editor.advanceIdCounter(maxOpIdCounter(ops));         // bump the id counter
  editor.applyRemoteOperations(ops);
}
```

### A self-contained demo: two editors converging in one tab

Because there are **no globals**, you can mount two independent editors and wire
their broadcasts to each other. Type in either one and watch both converge — the
same machinery that powers P2P sync, minus the network:

```ts
import { mountEditor } from "@cypherkit/editor";
import { loadPage } from "@cypherkit/editor/serlization/loadPage";
import { maxOpIdCounter } from "@cypherkit/editor/sync/sync";

const { blocks } = loadPage("# Shared document\n\nEdit me from either side.\n");

const a = mountEditor(document.getElementById("left")!,  blocks, { pageId: "shared" });
const b = mountEditor(document.getElementById("right")!, blocks, { pageId: "shared" });

function pipe(from, to) {
  from.editor.setBroadcast((ops) => {
    for (const op of ops) to.editor.advanceClock(op.clock);
    to.editor.advanceIdCounter(maxOpIdCounter(ops));
    to.editor.applyRemoteOperations(ops);
  });
}

pipe(a, b);
pipe(b, a);
```

Each `mountEditor` call generates its own peer id, so the two replicas are
genuinely distinct CRDT participants — which is why they converge rather than
fight.

### Going over the wire

In a real app you wouldn't apply ops directly editor-to-editor — you'd route them
through a `SyncEngine` (version-vector tracking + persistence) and a transport.
The shape, lifted from how `apps/web` wires it:

```ts
import { SyncEngine, serializeVV } from "@cypherkit/editor/sync/sync";

const sync = new SyncEngine("page-id", myPeerId);

// Outbound: log it, ship it, store it.
editor.setBroadcast((ops) => {
  sync.emit(ops);          // add to the local op-log + version vector
  transport.send(ops);     // your WebRTC/WebSocket/etc.
  persist(ops);            // save to disk so it survives a reload
});

// Inbound from a peer.
transport.onOps((ops) => {
  sync.apply(ops);
  editor.updatePageFromSync(sync.getState()); // rebuilt Page -> editor
});

// On (re)connect, exchange version vectors so peers only send what you're missing.
transport.onConnect(() => transport.requestSync(serializeVV(sync.getVersionVector())));
```

**Awareness** (live cursors / selections / presence) rides alongside, as a
separate ephemeral channel:

```ts
editor.setAwarenessBroadcast((state) => transport.sendAwareness(state), localUser);
transport.onAwareness((peerId, state) => editor.setRemoteAwareness(peerId, state));
```

That's the whole concept: local edits emit commuting ops; you fan them out and
fold remote ones back in; the CRDT guarantees everyone lands on the same
document. Persisting the op-log (not the Markdown) is what makes the editor
offline-first — edit disconnected, and the logs merge cleanly when you reconnect.

---

## Where to go next

- **`packages/editor/src/index.ts`** — the curated public surface in one place.
- **`entries/editor.ts`** — the full `Editor` interface (links, images, math,
  search, scroll, every command).
- **`sync/`** — the CRDT internals: `hlc.ts`, `char-runs.ts`, `oplog.ts`,
  `reducer.ts`, `sync.ts`, plus convergence fuzz tests in `__fuzz__/`.
- **`apps/web/src/app/MountedEditor.tsx`** — a production host: P2P sync,
  persistence, awareness, React chrome, mobile keyboard handling.
- **`examples/minimal/`** — the runnable scaffold for Steps 1–7.

You now have the arc: mount → load → render with fonts → drive → pick blocks →
save → collaborate. Everything else in the engine is a refinement of one of those
seven moves.
