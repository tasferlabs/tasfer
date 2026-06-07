# Minimal `@cypherkit/editor` example

A zero-framework (plain TypeScript + Vite) host for the canvas editor. It's the
runnable companion to [`../../getting-started.md`](../../getting-started.md) —
the code maps 1:1 to Steps 1–7 of that tutorial.

```bash
npm install
npm run dev      # http://localhost:4100
```

What it shows:

- **Step 1** — `vite.config.ts` / `tsconfig.json` alias `@cypherkit/editor` to the
  package source (no build step).
- **Steps 2–3** — `src/main.ts` parses Markdown with `loadPage` and mounts it.
- **Step 4** — `src/fonts.ts` registers font stacks and calls `notifyFontsLoaded`.
- **Step 5** — the toolbar (`index.html`) drives `editor.toggleBold/undo/redo` and
  `subscribe` reflects the active format.
- **Step 7** — the "Save .md" button serializes back to Markdown (logged to the
  console).

For the collaboration concept (Step 8 — two editors converging via the CRDT),
see the tutorial; it's a short extension of this same setup.

> No `package-lock.json` is committed here — run `npm install` to generate one.
> The example depends only on `vite`, `typescript`, and the editor's runtime deps
> (`i18next`, `nanoid`).
