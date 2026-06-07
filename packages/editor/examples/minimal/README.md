# Minimal `@cypherkit/editor` example

A zero-framework (plain TypeScript + Vite) host for the canvas editor — the
smallest real setup: parse Markdown, mount the editor, drive it from a toolbar,
and serialize back to Markdown.

:::tabs key:pm
== pnpm
```bash
pnpm install
pnpm dev      # http://localhost:4100
```
== npm
```bash
npm install
npm run dev      # http://localhost:4100
```
== yarn
```bash
yarn
yarn dev      # http://localhost:4100
```
== bun
```bash
bun install
bun dev      # http://localhost:4100
```
:::

What it shows:

- **No build step.** `vite.config.ts` / `tsconfig.json` alias `@cypherkit/editor`
  straight to the package's `src` folder — it's consumed as raw TypeScript,
  exactly like `apps/web` does.
- **Create & mount.** `src/main.ts` uses the `createEditor({ element, value, … })`
  facade — parse Markdown and mount the canvas editor in a single call.
- **Fonts.** `src/fonts.ts` registers font stacks and calls `notifyFontsLoaded`.
  The engine ships no fonts — it measures glyphs against the CSS stacks the host
  gives it.
- **Toolbar.** The buttons in `index.html` drive `editor.toggleBold/undo/redo`,
  and `editor.subscribe` reflects the active format back onto the bold button.
- **Round-trip Markdown.** "Save&nbsp;.md" logs `editor.getMarkdown()`; "Clear"
  calls `editor.setMarkdown("")` — a single undoable step, so Undo restores it.
- **Auto-save.** `editor.on("change", …)` persists a draft to `localStorage` on
  every edit and restores it on reload.

> The example depends only on `vite`, `typescript`, and the editor's runtime
> dependencies (`i18next`, `nanoid`).
