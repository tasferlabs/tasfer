# design-sync notes — Tasfer UI kit

Repo-specific gotchas for re-syncing `apps/web/src/components/ui` (a shadcn-style
kit, Tailwind v4) to the **Tasfer Design System** claude.ai/design project.

## Source shape & why it's non-standard

`apps/web` is an APP, not a component library — there is no `dist/` exporting the
components, and no `.storybook/`. So the sync is driven by:

- **`apps/web/.design-sync.entry.tsx`** — a hand-maintained barrel that
  `export *`s the 29 synced `ui/*` files (committed; regenerate by hand if the
  file set changes). Passed as `--entry`. `LoadingScreen` is excluded (see below).
  Carries `@ts-nocheck` (it's outside the app tsconfig's `include:["src"]`,
  so the IDE can't resolve its `@/` aliases — esbuild resolves them via the
  minimal tsconfig below; the app's own `tsc` never sees this file).
- **`.design-sync/tsconfig.dssync.json`** — minimal path map (`@/*`, `@shared/*`)
  for the esbuild bundle. Deliberately OMITS the app tsconfig's `"*": ["./*"]`
  and `"react": [...]` mappings — those would redirect bare deps and `react`
  into `@types`, breaking the bundle. `cfg.tsconfig` points at it.
- **`componentSrcMap`** in config pins all 29 components to their src paths
  (discovery has no `.d.ts` barrel to read, so the map IS the component list).

## Tailwind v4 CSS — MUST recompile before building

Tailwind v4 generates utilities on demand, so component classes only exist once
compiled. **`.design-sync/compile-css.mjs`** compiles `apps/web/styles.css` →
`apps/web/.design-sync.compiled.css` (gitignored, `cfg.cssEntry`). It also injects
the brand `@font-face` rules (fontsource woff2) and a real `--font-sans` value
(`styles.css` leaves it self-referential; the app sets body faces via JS, which
the design context has no equivalent for — Poppins is the product body face).

**Re-sync order (from repo root):**
```
cd apps/web && node ../../.design-sync/compile-css.mjs && cd ..
node .ds-sync/package-build.mjs --config .design-sync/config.json \
  --node-modules ./apps/web/node_modules --entry ./apps/web/.design-sync.entry.tsx --out ./ds-bundle
```
Always recompile the CSS first if any component's classes changed, else new
utilities are missing from the bundle. (Previews use inline-style layout glue +
component-provided classes, so authoring a preview does NOT require a CSS recompile.)

## Render check / capture

Chromium is provided by the repo's run-web skill (playwright 1.61.1, build 1228).
`playwright@1.61.1` is installed in `.ds-sync/`. Set for all render/capture runs:
```
export DS_CHROMIUM_PATH="/Users/hamza/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
```
(If the run-web skill's playwright version changes, re-point DS_CHROMIUM_PATH and
reinstall a matching `playwright@X` in `.ds-sync/`.)

## Overlay components render OPEN

Dialog, AlertDialog, Drawer, Sheet, Popover, DropdownMenu, Select, Combobox,
Tooltip, BottomSheet use `cfg.overrides.<Name> = {cardMode:"single", viewport, primaryStory:"Open"}`.
Their previews render the surface OPEN (`defaultOpen`) so the card shows the
content, not just a trigger. Tooltip additionally needs a `<TooltipProvider>` wrapper.
The open content portals to body = the card iframe, so it fills the card.

## Known render warns (triaged as legitimate — not new issues)

- `[FONT_MISSING] "Cambria"` — Cambria/Georgia/Times are the system-serif fallback
  stack in Tailwind's default `--font-serif`; not a brand font, nothing to ship.
  The brand serif (Libre Baskerville) IS shipped.
- `bottom-sheet` → `useKeyboardInset` → `@tasfer/editor/internal` pulls
  `packages/editor/src/env.ts` into the graph (tiny `isAndroid` helper); the
  guarded `import.meta` esbuild warning is harmless.

## Deliberate decisions

- `guidelinesGlob: []` — the app's only `docs/*.md` is an internal engineering QA
  checklist (multi-tab-validation), not a design guideline; excluded from upload.
- `--font-sans` defined as Poppins (the product's body face) so DS cards render
  in the brand font rather than browser default.
- **LoadingScreen is EXCLUDED** (removed from the barrel entry and
  `componentSrcMap`; user decision). It's the app's full-screen boot spinner —
  app chrome, not a reusable UI primitive — and its bundled
  `<img src={`${import.meta.env.BASE_URL}spinner.png`}>` uses an ABSOLUTE path
  (BASE_URL=`/`) that won't resolve in the design render context (server root,
  not the project), so a meaningful card is impossible without an upstream change
  (relative/inlined spinner). To re-include later: restore the barrel export and
  the `componentSrcMap` entry, and give the component a resolvable spinner.
  Synced set is 29 components.

## Preview authoring idiom (folded from wave learnings)

- Import every component/sub-part from `'tasfer'` (→ `window.TasferUI`) — no deep
  imports. `lucide-react`, `react-hook-form` (`useForm`), and named `react`
  imports (`useState`/`useRef`/`useEffect`) all resolve in previews; only default
  `import React` is disallowed (jsx automatic).
- Layout glue = INLINE styles with CSS-var tokens (`var(--border)`,
  `var(--muted-foreground)`, `var(--radius)`) — never invent Tailwind utility
  class names in wrappers (only classes already used by components are compiled).
  Component-provided classes are fine.
- Cell export names must not collide with imported identifiers (e.g. a `Search`
  icon import vs. a `Search` cell — rename the cell).
- **Date-driven previews** (RelativeDate): derive example dates as PAST offsets
  from `Date.now()`; the capture machine clock ≠ the session date, so fixed
  future-ish literals read as "in N years".
- **Overlays** render open: radix `defaultOpen` (Dialog/AlertDialog/Sheet/Popover/
  DropdownMenu/Select/Tooltip), vaul `defaultOpen` (Drawer). **BottomSheet** is
  controlled — render `<BottomSheet open onOpenChange={()=>{}} variant="sheet">`.
  **Combobox** has NO open prop — opened via a mount-time effect that clicks
  `[data-slot="combobox-trigger"]`. **Tooltip** needs a `<TooltipProvider>` wrapper.
- **i18n**: the preview bundle has no i18n provider, but the kit's `t()` calls all
  use the default-value form (`t("k","fallback")`), so text degrades gracefully.
  Any FUTURE component with default-less `t()` calls would need `cfg.provider`
  wired to an i18n instance.
- **ScrollArea** exposes only `ScrollArea`+`ScrollBar` and always injects the
  vertical bar; there's no slot for a horizontal scrollbar.
- **Accordion** preview passes `className="h-auto"` to `AccordionContent`. The
  component fixes the content wrapper to `h-(--radix-accordion-content-height)`
  under `overflow-hidden`; in a STATIC open render (no collapse animation) that
  fixed height clips the component's own `pb-4`, so the open answer looks flush
  against the divider. `h-auto` (merged into the inner div via `className`) lets
  the natural height + padding render. Safe only because previews are static —
  don't port this to the app component (it would break the collapse animation).
  This is the one place a preview legitimately uses a utility class (`h-auto`)
  rather than inline glue — it must reach an inner element props can't. `h-auto`
  is now in the frozen CSS because this preview is scanned.
- **Select** open content defaults to `position="item-aligned"` (listbox overlays
  the trigger — expected Radix behavior). `position="popper"` separates them.

## Re-sync risks — check these before the next sync

Nothing here is auto-maintained. On any change to the `ui/*` set or their props:

1. **Recompile Tailwind first.** New/changed component classes are missing from
   the bundle unless `compile-css.mjs` runs before the package build (see order
   above). Silent failure mode: components render unstyled.
2. **Barrel + `componentSrcMap` are hand-kept.** Add/remove a `ui/*` file →
   update BOTH `.design-sync.entry.tsx` and `config.json.componentSrcMap` (the
   map is the component list — a missing entry silently drops the component).
3. **`dtsPropsFor` is hand-authored, not extracted.** If a component's props
   change, its `.d.ts`/`.prompt.md` will be STALE until you re-edit the entry in
   `config.json` — the build won't warn. Re-check any component you touched.
   Editing `dtsPropsFor` does not invalidate render grades (doesn't affect the card).
4. **Frozen utility set.** The shipped CSS only contains classes present at
   compile time. New arbitrary values (`w-[360px]`) or utilities used only in the
   design context won't resolve — use inline styles for one-offs (conventions.md).
5. **Chromium is pinned** to run-web skill's playwright build (currently 1228).
   If that skill upgrades, re-point `DS_CHROMIUM_PATH` and reinstall a matching
   `playwright@X` in `.ds-sync/` before any render/capture run.
6. **Only latin + arabic font subsets ship.** A component rendering other scripts
   (cyrillic/greek/vietnamese) would fall back — add the subset to compile-css.mjs.
7. **LoadingScreen stays excluded** until it has a resolvable spinner (see above).
8. **`@tasfer/editor/internal` is in the graph** via bottom-sheet's
   `useKeyboardInset`. If that import path moves, the bundle build breaks.
