# TitleEditor / view-windows — remaining work

Status snapshot for the "windowed title editor over a shared doc" feature.
The **engine + React + reusable component are done and verified**; what's left is
app wiring and the (deferred) full component decomposition.

## Done (shipped + verified)

- **Engine (`packages/editor`)**
  - View windows: `ViewWindow` type + `window` option on
    `mountEditor`/`createEditor`; builders `titleBlockWindow()`,
    `blockIdWindow(id)`, `titleBlockIndex(blocks)` (`src/view-window.ts`).
  - `getVisibleBlocks(page, window?)` copy-on-window (never mutates the shared
    block instances two editors on one `Doc` share).
  - Single-block authoring gate (`ViewWindow.singleBlock`): split, Backspace-merge
    (`deleteText`), Delete-merge (`deleteForward`), the JOIN boundary, and
    multi-block paste (`insertBlocksAtCursor` → inline text) are all inert; caret
    is clamped inside the window (`Editor.clampToWindow`, applied on local commit
    and remote sync).
  - Tests: `src/view-window.test.ts` (14) — 614 total pass, lint clean.
- **React (`packages/react`)** — `window` flows through `useEditor`/`<Editor>`
  via `MountEditorOptions` inheritance (no code change; typecheck verified).
- **apps/web — shared EditorCore**
  - `src/app/editorCore.ts` (was `editorSurface.ts`) — the shared editing
    primitive: `useEditorCore` (the mount hook) plus `editorStrings`,
    `editorNodeStrings`, `appEditorTheme`, `useLiveEditorTheme`. `useEditorCore`
    wraps `@cypherkit/react`'s `useEditor`, defaulting the app theme + strings and
    wiring live dark-mode/font re-theming, so every surface mounts identically.
  - `src/app/MountedEditor.tsx` — the inner `EditorSurface` is renamed
    **`PageEditor`** (the full-page WYSIWYG editor) and now mounts through
    `useEditorCore`; the duplicated theme/font-registry wiring was removed from its
    big effect (the core owns it now; only native-menu icon prewarming stays). The
    public `MountedEditor` wrapper still keys/remounts it per page.
  - `src/app/TitleEditor.tsx` — reusable component built on the **same**
    `useEditorCore`, adding only the title-specific options: `titleBlockWindow()` +
    `appSchema.restrict({ blocks: ["heading1"], marks:
    ["strong","emphasis","strike","code"] })`, single-line, Enter=submit /
    Escape=cancel, read-only mode.
  - `npm run build` passes (tsc + vite); Prettier clean.
- **apps/web — doc-ownership relocation (uniform hoist)**
  - `src/app/useCollaborativeDoc.ts` (NEW) — owns the page's `Doc` and ALL of its
    collaboration/persistence, hoisted ABOVE the editor: creates the doc (peer id,
    schema, HMR live-blocks reuse), joins the room via `useP2PRoom`, and wires ops
    broadcast/apply + SQLite persistence + FS snapshot + sync-on-join **once**.
    Exposes `{ doc, awareness, localUser, peerId, opsLoaded }`; `awareness` is a
    `broadcast` + `connect(handlers)` transport the primary surface publishes /
    subscribes through. Doc destroyed after the child editor (parent cleanup runs
    last); `isApplyingRemoteOpsRef` dropped (was dead/write-only).
  - `src/app/MountedEditor.tsx` — `MountedEditor` now keys a new
    `CollaborativeEditor` wrapper (calls the hook), which renders `PageEditor` with
    a `collab` prop. `PageEditor` is now a **pure view**: it never creates a doc or
    wires sync — it renders `collab.doc` and wires only editor-scoped work
    (subscriptions, toolbar, overlays, cursor restore) + presence via
    `collab.awareness`. All existing call sites (EditorPage + the 3 readonly
    previews) are unchanged.
  - `npm run build` passes (tsc + vite); Prettier clean. **Not build-verifiable:**
    real-time sync, presence, persistence, HMR, and page-switch teardown are
    runtime-only — needs a manual smoke test (edit, second-tab sync, cursors,
    page switch, reload).
- **Docs** — `api-schema.mdx` "View windows" section + `window` row in
  `api-editor.mdx`; site build passes.

## Remaining — consumer wiring

`TitleEditor` takes a `doc` prop. Each use needs a `Doc` to pass in.

1. **Edit-title dialog — DONE.** `apps/web/src/app/components/PageSettings.tsx`
   `RenameDialog` now renders
   `<TitleEditor doc={…} editable autoFocus onSubmit={close} onCancel={close} />`
   over the open page's live doc (read as
   `(useActiveEditor().editor as CypherEditor).doc`). The plain `<Input>` is gone;
   the footer is a single **Done** button (editing is live through the CRDT, so
   there is no discardable draft).
   - **Product decision (RESOLVED):** picked the block-editing model — the title
     IS the doc's first heading, always auto-derived. The **manual-override
     concept is dropped**: the `autoTitle` page-record flag and its `auto_title`
     SQLite column / `page_set` sync field were removed
     (`platform/{engine,types}.ts`, `api/pages.api.ts`), `EditorPage` now always
     derives `page.title` from content, and the sidebar `PageLink` rename is a
     soft record-string edit (re-derived on next content edit).
   - **Denormalized `page.title` sync:** the dialog edits the shared doc, which
     the body editor sees as *remote*, so its local-save title derivation does
     not run. `RenameDialog` re-derives `page.title` via
     `extractTitleFromBlocks(doc.getRawBlocks())` on close.
   - **Constraint (still true):** this works because the dialog is only reachable
     on the open page, whose `Doc` is live via the active editor.

2. **Draft / card preview** — `apps/web/src/app/pages/CalendarPage/EventPreview.tsx`.
   `<TitleEditor doc={…} editable={false} />` for the title line. Read-only,
   purely additive, zero regression risk. Safest first wiring.

3. **(Optional) live title bar** above the body in `EditorPage`/`MountedEditor`
   — a second live view of the title block on the same doc. Note: the body still
   renders the heading too (we intentionally do NOT hide the first block).

## Remaining — doc access (for the wiring above)

Doc ownership is now hoisted (see the relocation entry in "Done"). How a consumer
gets a `Doc` to hand `TitleEditor` depends on where it lives:

- **A live title bar / preview beside the body** — the clean path now exists:
  `CollaborativeEditor` (`MountedEditor.tsx`) owns `collab` and already renders
  `PageEditor` with it, so it can render a sibling `<TitleEditor doc={collab.doc}
  … />` on the very same doc with sync wired once. This is what the relocation
  unlocked.
- **The edit-title dialog (a separate surface, body may be unmounted)** — it needs
  its own doc for the target page. Either read the open page's doc from the active
  editor (`(useActiveEditor().editor as CypherEditor | null)?.doc`, a localized
  cast — the context is typed `EditorApi` but the runtime object is the
  `CypherEditor`), or spin up a short-lived `useCollaborativeDoc(pageId, …)` for
  the dialog. Still gated on the product decision below.

## Remaining — polish / follow-ups

- **i18n keys:** `TitleEditor` uses `i18next.t("editor.titleAriaLabel", "Page
  title")` and `i18next.t("common.title", "Title")` with English fallbacks. Add
  real keys to `apps/web/public/app/locales/{en,ar}/translation.json`
  (`editor.titleAriaLabel`; confirm `common.title` exists).
- **Single-line sizing:** the container defaults to `height: 3rem`; tune to the
  heading1 line height, and decide wrap behavior for long titles (clip vs. grow).
- **Caret on autoFocus:** currently `editor.focus()` (the public `focus` type is
  `() => void`). If caret-at-end is wanted, use the `setCaret` surface.
- **Title marks:** currently allows `strong/emphasis/strike/code`. Revisit
  whether a title should allow any inline marks at all.
