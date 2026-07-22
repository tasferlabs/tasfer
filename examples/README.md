# Tasfer editor examples

Two complete, runnable product shells built around the **same** headless canvas
editor — [`@tasfer/editor`](../packages/editor) wired up through its React
bindings, [`@tasfer/react`](../packages/react). The engine only paints
glyphs; everything around it (sidebars, toolbars, status bars, theming) is the
host's to invent. These two examples show how different that "everything around
it" can look while the core stays identical.

| Example | What it is | Vibe | Dev port |
| --- | --- | --- | --- |
| [`foolscap`](./foolscap) | A distraction-free **writing studio** | Warm paper, serif, typewriter focus | `4010` |
| [`tasfer-studio`](./tasfer-studio) | A dark **markdown IDE** | File tree, live outline, peers | `4020` |

Both mount a real editor (type into it — markdown shortcuts, `**bold**`, `⌘B`,
`# `, `- `, `> ` all work) and drive their chrome from live editor state
(`useEditorMarkdown` / `useEditorState`): the word counters, the writing-goal
ring, and the document outline are all derived from what you type.

## Running an example

Each example is a self-contained Vite + React 19 app with its own
`package.json` — there is no workspace tool, so install and run from inside the
example directory:

```bash
cd examples/foolscap      # or examples/tasfer-studio
npm install
npm run dev
```

> The apps consume `@tasfer/editor`, `@tasfer/react`, and `@tasfer/tex`
> as **raw TypeScript source** via Vite/TS path aliases (exactly like
> `apps/web`), so there is no build step for the packages. The engine's own
> transitive dependencies (`defuddle`, `lowlight`, `katex`) resolve from each
> package's local `node_modules`, so make sure the packages have been installed
> at least once (`npm install` inside `packages/editor` and `packages/tex`).

## How the editor is wired in

The integration is deliberately tiny — three pieces in every example:

1. **Fonts** (`src/fonts.ts`) — the host loads its own faces (here via a Google
   Fonts `<link>` in `index.html`) and calls `notifyFontsLoaded()` so the
   engine flushes its metric cache and re-measures with the real glyphs.
2. **Theme** (`src/theme.ts`) — a plain `EditorTheme` object: semantic color
   `tokens`, a deep-partial `styles` override (font sizes, padding), and the
   `fonts` registry. No CSS selectors reach into the canvas; the look is data.
3. **Mount** — `<Editor markdown={…} theme={foolscapTheme} autofocus />` from
   `@tasfer/react`, with the surrounding shell reading live state through
   `useEditorMarkdown(editor)`.

That's the whole contract. Swap the theme and the chrome, keep the engine.
