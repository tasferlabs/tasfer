# @tasfer/editor

The headless, framework-agnostic **canvas editor engine** behind
[Tasfer](https://www.tasfer.app). It paints text directly onto an HTML5
`<canvas>` instead of the DOM, runs with no backend at all, and stores the
document in a **CRDT** — so several people can edit it at once, offline and out
of order, and their changes still merge without conflicts.

The structure underneath is a replicated data type; the API just looks like an
editor.

## Install

```bash
npm install @tasfer/editor
```

One small runtime dependency (`turndown`, for HTML→markdown paste). The CRDT and
the canvas renderer ship inside the package. ESM and CommonJS builds with types
bundled — no `@types` package to install.

## Usage

```ts
import { createEditor } from "@tasfer/editor";

const editor = createEditor({
  element: document.querySelector("#editor")!,
  markdown: "# Hello\n\nStart typing — *markdown* shortcuts just work.",
  autofocus: true,
});

editor.on("change", () => {
  localStorage.setItem("draft", editor.getMarkdown());
});
```

Four things make up the whole surface: the **value** you put in (`markdown`,
`blocks`, or an existing `doc`), the **state** you read out (`editor.state` —
selection, active marks), the **changes** you dispatch, and the **events** you
listen to.

```ts
// Edits are transactional; one callback commits as one undoable step.
editor.change((c) => c.setMark("strong").insertText(" ✶"));

const { selection, activeMarks } = editor.state;
activeMarks.has("strong"); // is bold active at the cursor?
```

## What's in the box

- `createEditor` / `mountEditor` — mount an editor into an element you own.
- `createDoc` — the CRDT document. Editors are views over a `Doc`; sync and
  persistence go through it (`applyUpdate`, `on("update")`, `encodeState()`).
- `baseSchema` / `baseDataSchema`, `defineNode`, `defineMark` — the block and
  mark types an editor understands. The engine is node- and mark-agnostic:
  you opt in to what you need.
- Built-in nodes and marks (`TextNode`, `ListNode`, `ImageNode`, `QuoteNode`,
  `LineNode`, `StrongMark`, `LinkMark`, …), each subclassable.
- Markdown and HTML serialization (`serializeToMarkdown`, `serializeToHTML`,
  `parsePage`), theming (`resolveTheme`, `DEFAULT_TOKENS`), and an action bus.

The document model runs without a DOM, so you can build, read, and persist a
document in Node.

## Companion packages

| Package                                                                                  | What it adds                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| [`@tasfer/editor-binding`](https://www.npmjs.com/package/@tasfer/editor-binding)                           | React 19 bindings — `useEditor`, `<Editor>` |
| [`@tasfer/math`](https://www.npmjs.com/package/@tasfer/math)                             | Opt-in LaTeX math node and mark             |
| [`@tasfer/code`](https://www.npmjs.com/package/@tasfer/code)                             | Opt-in syntax-highlighted code block        |
| [`@tasfer/provider-indexeddb`](https://www.npmjs.com/package/@tasfer/provider-indexeddb) | Local persistence                           |
| [`@tasfer/provider-webrtc`](https://www.npmjs.com/package/@tasfer/provider-webrtc)       | Peer-to-peer sync                           |
| [`@tasfer/provider-relay`](https://www.npmjs.com/package/@tasfer/provider-relay)         | Relay-forwarded sync                        |

Optional features are never re-exported from this package, so a host that
installs none never resolves them.

## Requirements

A browser with a 2D `<canvas>` context and `ResizeObserver` — every evergreen
browser since ~2020. No server, no `.wasm`, no bundler plugin, no polyfills.
Node 22+ for the tooling.

## Documentation

[tasfer.app/docs/editor/install](https://www.tasfer.app/docs/editor/install) —
installation, your first editor, custom nodes, theming, collaboration, and the
full API reference.

## License

MIT. Use it in commercial and closed-source products, fork it, rebrand it.
(The Tasfer _app_ is AGPL-3.0; this package is deliberately permissive.)
