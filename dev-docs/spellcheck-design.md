# Spellcheck design

Spellcheck ships as an opt-in, React-free package (`packages/spell`, `@tasfer/spell`) that talks to the editor only through the public `@tasfer/editor` root, plus host code in `apps/web/src/spell/`. Real Hunspell 1.7 compiled to WebAssembly checks every language (English and Arabic now) inside one dedicated module Worker per app. The core gains three small generic additions: an underline `style` on `RangeDecoration` painted per line and per bidi run through an exported `paintDecorationRects`, an internal per-block decoration index so `TextNode.paint` stops walking every decoration for every visible block, and a `DocRange` form of `query.marks`. Squiggles are anchored as CRDT char-id points, so they ride along concurrent edits and vanish the instant their word is edited; the word under the caret is hidden while typing and shown after a boundary keystroke or 500 ms idle. Fixing is one gesture everywhere: right-click or long-press adds suggestions to the existing host context menu, Cmd/Ctrl+. is fix-or-next on desktop, and on phones tapping a red word docks a suggestion strip above the keyboard. The personal dictionary is one synced `own_prefs` key per word, dictionaries are lazy-loaded and cached, and imported Hunspell pairs live per device through the existing `FsDriver`. There is no local LLM and no next-word prediction in this design.

**Status (2026-09-02):** phases P0a, P0b, P1, P2 and P3 are implemented in the working tree (uncommitted, pending review); measurements so far are in [spellcheck-measurements.md](./spellcheck-measurements.md). P4 to P7 are later work. The sidebar shortcut moved from Cmd/Ctrl+. to Cmd/Ctrl+; to free the period chord for spelling.

**Line numbers:** every `file:line` reference in this document was verified against the working tree at commit `ab72b7cc` unless a different commit is named next to it. Files are being edited concurrently, so treat line numbers as "where to look", not as exact addresses.

**Sources:** the research brief, the three proposals, three judge reports and ten adversarial code verifications that produced this document are not in the repository. Measurements from P0a will be recorded in `dev-docs/spellcheck-measurements.md`.

---

## 1. Goals and non-goals

### Goals

- Red wavy underlines on misspelled words in the canvas editor, correct on wrapped lines, RTL text and mixed Arabic/Latin lines.
- Good suggestion UX on every platform Tasfer ships: desktop web (Chrome, Safari, Firefox), Electron (macOS, Windows, Linux), Capacitor iOS and Android.
- Loadable dictionaries: Firefox-style Hunspell `.dic`/`.aff` pairs and cspell-style plain word lists. Users can add their own dictionaries.
- Arabic and English now; more languages later by dropping a dictionary pair into the catalogue.
- A personal dictionary that follows the person to every device.
- All UI strings i18n'd in English and Arabic.
- `packages/editor` stays spelling-agnostic. Most code lives in the opt-in package and `apps/web`.
- The product goal: make typos hard to leave in.

### Non-goals

- **No local LLM for word or next-word suggestion.** The honest answer is below.
- **No next-word prediction** of any kind in the committed roadmap.
- **No silent autocorrect.** A desktop-only, default-off autocorrect is a possible P7 extra, never part of the core feature. On phones the OS keyboard already owns autocorrect and prediction through Tasfer's hidden input surface, and Tasfer must not duplicate it.
- **No OS spellcheck as a source of truth** (Electron `webFrame`, iOS `UITextChecker`, Android `SpellCheckerSession`). Reasons in Q6.
- **No grammar checking.** The underline style union is designed so a later grammar layer can use a different pattern (WCAG 1.4.1), nothing more.
- **Nothing spelling-related enters the document CRDT, the op log, undo, `encodeState()` or the SQLite schema.** Decorations are the only runtime representation; `compatibility.mdx` is untouched.

### The local-LLM question, answered

Hamza asked whether a lightweight local LLM running on low-end devices could suggest words, or at least the next word. The answer is no, not for this feature on these targets, and this section records why so the question does not come back every quarter.

Engineering evidence:

- The smallest usable models (SmolLM2-135M q4, Gemma 3 270M) are a 70 to 120 MB download, need 300 to 800 MB of RAM, cold-start in seconds and run at low single-digit tokens per second on CPU-WASM on a 2 to 3 GB phone (extrapolated from native llama.cpp at about 4 tok/s for a 1B model on a Snapdragon 480, plus the WASM penalty).
- Capacitor WebViews have no WebGPU before iOS 26 (the Capacitor issue was closed "not planned"), Android WebView coverage is partial, and iOS Safari tabs are memory-capped. Acceleration is unavailable exactly where "low-end devices" matter.
- Every shipping phone keyboard meets its 20 ms per-keystroke budget with n-gram or trie models of 10 MB or less (Gboard: 5-gram, 1.25M n-grams, 164k unigrams, under 5 to 10 MB, 20 ms per keystroke; the federated LSTM add-on is 1.4 MB; SwiftKey's transformer is about 6 MB). That is the technology class this problem wants. An LLM is two orders of magnitude outside the 60 to 100 ms budget a suggestion has.

UX evidence:

- Desktop typists ignore next-word prediction: fewer than 0.9 suggestions used per phrase and about 5% of keystrokes saved even at 0.9 accuracy (TOCHI 2025; CHI 2021 found the same).
- On mobile, word prediction correlates negatively with typing speed, while autocorrect correlates positively (Palin 2019, 37k users).
- Ghost text beats a suggestion bar but is "more distracting"; Apple had to add a separate off switch for inline predictions in iOS 17.2. Gmail's Smart Compose only works because it shows a single confidence-gated suggestion at p90 under 60 ms.
- On phones the OS keyboard already predicts and autocorrects through Tasfer's hidden input, which stays enabled on touch. Duplicating it is noise.

Where an LLM could genuinely help later (phrase rewriting, grammar, Arabic diacritisation) it would be a desktop-only, user-downloaded, on-pause feature (500 ms or more after typing stops) gated on `navigator.gpu` and 8 GB or more of RAM, never per keystroke, and not part of this design. Recommendation: do not plan for it.

If word completion is ever requested, section 8.10 records the shape it would take: an opt-in prefix-trie "complete long words" ghost, desktop and hardware keyboard only, zero core change. It is P7(c), an explicit product decision, and nothing in the architecture anticipates it.

---

## 2. Decisions

### Q1. Engine: real Hunspell in WASM for every language

**Decision.** Hunspell 1.7.x compiled to WebAssembly checks all languages (English and Arabic now, every later language), behind a `SpellEngine` interface, inside one dedicated ES-module Worker per app. The adapter is built on `hunspell-wasm` 0.3.0 (rotemdan) as a pinned npm dependency under its LGPL option. cspell-style word lists are an import format converted to a trivial `.dic`/`.aff` pair by `wordListToDic` and loaded into the same engine, not a second engine. `suggest()` runs only on demand (menu open or prefetch), never inside the checking pass.

**Why.** Arabic is a hard requirement and only Hunspell runs Ayaspell correctly. Measured on Apple Silicon in Node 22:

| Engine | English | Arabic |
| --- | --- | --- |
| Hunspell WASM (hunspell-wasm 0.3.0) | load 22 to 39 ms, +17 MB, 1.3 µs per check, suggest 5 to 14 ms | load 255 to 337 ms, +46 to 48 MB, 4.6 µs per check, suggest about 40 ms median, 80 ms max |
| nspell / typo-js (pure JS) | fine (nspell 0.3 µs check, 1 ms suggest, 13 KB) | broken: reject الكتاب and وبالكتاب, no `IGNORE` so diacritised words are flagged, +501 false positives per 10k, garbage suggestions; typo-js suggest 130 to 900 ms |
| cspell-trie-lib 10.2 | en_US trie 297 KB gz, 36 to 39 ms decode, 1 to 4 MB, suggest 1 to 9 ms | `@cspell/dict-ar` is 7.9 MB decoded, 2.5 MB gz, +100 MB, 350 ms, about 89M enumerated forms with dubious entries, and cspell's tokenizer splits stacked diacritics |

User-loadable Firefox-style `.dic`/`.aff` needs Hunspell regardless, so the WASM engine exists in every possible design. A second engine for English (the "low-end-first" proposal) would save about 13 to 16 MB of heap and a 374 KB gz fetch for English-only users, but costs a second suggester with different ranking, a second case and personal-dictionary path, two import formats, and a "bundled English on trie, imported English on Hunspell" mismatch. That is a permanent tax on one maintainer. All three judges converged on one engine.

**Rejected alternatives.**

- hunspell-asm 4.0.2: MIT wrapper, but the engine is pinned to January 2020, base64-inlined (780 KB JS), unmaintained.
- nuspell-wasm: bigger (1.07 MB), slower suggest, no add-word API.
- harper.js: English only, 15.6 MB wasm, 300 MB RSS.
- spellchecker-wasm (SymSpell): no morphology, so no Arabic clitics.
- spellbook (Rust): alpha, no bindings.
- OS engines: see Q6.
- Two engines (trie for bundled Latin lists, Hunspell for everything else): kept only as a measured fallback (section 7.2) if P0a shows Hunspell English missing the phone budget (over 150 ms to ready or over 25 MB).

### Q2. Placement: `packages/spell` plus `apps/web/src/spell`

**Decision.** A new opt-in package `packages/spell` (`@tasfer/spell`, MIT like `packages/code`, peer-dep `@tasfer/editor`, React-free, DOM-optional) holds the engine-facing half. It imports only the public `@tasfer/editor` root, never a subpath, and a vitest boundary test (`src/boundary.test.ts`) enforces it. Subpaths: `.` (tokenizer, script rules, `SpellEngine` contract, protocol types, `SpellChecker` controller, `charAnchor`, `REPLACE_WORD`), `./worker` (worker-side dispatcher), `./hunspell` (Hunspell WASM adapter; the package ships no binary). `apps/web/src/spell/` holds the Vite worker entry, `SpellService` (worker lifecycle, dictionary registry, request correlation), storage adapters (own_prefs, localStorage, `FsDriver`), dictionary assets and the service-worker route, all React UI (layer component, popover, mobile bar, sheet, settings, context-menu items), platform adapters and i18n. A second vitest boundary test asserts that `apps/web/src/platform/engine.ts` and `apps/web/src/lib/spaceExport.ts` import nothing under `spell/` (the CLI is a headless host replica and must not pull a worker or a WASM module).

**Why.** The controller, tokenizer, anchoring and worker need unit tests without React or a browser (Arabic tokenizer tables, anchoring under interleaved local and remote ops, fake-worker controller tests), and the worker needs its own bundle entry. That is exactly the `packages/code` and `packages/math` shape, about a day of scaffolding with `packages/code` as the template (tsdown, eslint and vitest configs, README, the aliases in `apps/web/vite.config.ts:167-175` and tsconfig paths). The package boundary is what forces the engine-facing code onto the public API: written in `apps/web` against `@tasfer/editor/internal`, the later extraction is a rewrite. `packages/editor/src/internal.ts:11-13` says the `./*` wildcard exists to be dropped, so deep imports are the wrong way to build a second published package. Hamza explicitly allowed a package; `apps/web/src/editor/` stays host chrome per AGENTS.md.

Note on declarations: `packages/spell/tsdown.config.ts` points `dtsTsconfig` at the repo-root `tsconfig.dts.json` because the package resolves `@tasfer/editor` from source during declaration emit.

**Rejected alternatives.**

- Everything in `apps/web` on `@tasfer/editor/internal` (the "ux-first" proposal): fastest first ship, but the internal surface carries no semver guarantee and the "extract later if a second consumer appears" phase is the kind that never happens for a solo maintainer.
- Package with deep imports through the `./*` wildcard (the "low-end-first" proposal): the wildcard is documented as temporary; freezing `@tasfer/editor/mark-runs` into a published package works against the stated direction of the core.

### Q3. Minimal core changes

**Decision.** Required, in P0b, one PR, all generic:

1. `RangeDecoration.style?: RangeDecorationStyle` as a discriminated union (`{ type: "fill" }` default, `{ type: "underline", line, thickness? }`), a `baseline` on the internal selection rect, and an exported `paintDecorationRects(ctx, rects, deco, styles)` used by every painter of range decorations.
2. An internal per-block decoration index `decorationsForBlock(layers, blockId)` so `TextNode.paint` iterates only decorations that can touch the block.
3. `query.marks(at?: DocPoint | DocRange)`: the point read accepts a range and returns intersecting runs.

Recommended, P2: `OPEN_CONTEXT_MENU.point?: DocPoint`. Recommended, P3: `RangeDecoration.a11y?: { invalid: "spelling" | "grammar" | "true" }` projected by `DomMirror` as `<span aria-invalid>`. Optional, later: `view.posAtCoords(client)` only if a hover tooltip is built; composition-aware decoration index shift in `TextNode.paint` (cosmetic).

Not done, because a host-side path was verified: `view.stableRange` or a block-offset to char-id export (public `Block.charRuns` and `deletedMask` plus provider-core's `pointToCharacterAnchor` at `packages/provider-core/src/cursors.ts:301-331` is the template; `charAnchor()` lives in the package), `isComposing` on the snapshot (composition text never reaches the doc and sits at the caret, which is excluded anyway), visible block ids (checking costs microseconds per word; the index fixes paint), rects-for-range (the popover anchors on two `coordsAtPos` calls), exported word helpers (`Intl.Segmenter` is the tokenizer), a runtime `nativeAutocomplete` toggle (pass `isTouchDevice()` at mount; a settings flip remounts), a `spellcheck` schema facet (the host skip lists `{code, math}` blocks and `{code, link, math}` marks are all the schema has today).

**Why.** Only (1) is physically impossible from the host: nothing outside the engine can draw on the content canvas with the per-line, per-bidi-run rects the selection already produces, and that geometry is what makes wrapped and mixed Arabic/Latin squiggles correct for free. (2) is a verified low-end hazard independent of spelling: every visible block currently walks `allDecorations()` three times and resolves char-id anchors with an O(runs) walk per anchor; with hundreds of squiggles that is per-keystroke repaint cost, and find, presence and any comment layer benefit too. (3) is the promotion `internal.ts` asks for and avoids O(tokens × runs) point reads or a deep import. (4) is cheaper than a facet and solves right-click on a flagged word while a selection is held (the engine deliberately does not move the caret then). (5) cannot be done host-side because the mirror re-serialises blocks on flush. Every item uses generic vocabulary (stroke pattern, ARIA token, `DocRange`, `DocPoint`) and none names spelling.

**Rejected alternatives.** Seven core changes at once (ux-first): several were redundant with each other (`point` on the payload versus `posAtCoords`; a `setNativeAutocomplete` toggle versus a remount) and each needs an `api-editor.mdx` row. Zero core changes with a flag cap instead of the index (core-purist): the cap does not fix the O(all flags × visible blocks) paint cost; it just bounds it at a number that is still too high on a slow phone.

### Q4. Completion, prediction and a local LLM

**Decision.** Nothing predictive in P0 to P6, and no LLM for this feature on these targets. The evidence is in section 1. If completion is ever requested it is P7(c): opt-in, default off, desktop plus hardware-keyboard iPad only, a single grey ghost word as a DOM overlay at `view.coordsAtPos("caret")`, document vocabulary first then a bundled top-50k CC BY list, shown after 3 typed letters when it adds 3 or more, Tab or the right arrow to accept via a capture-phase keydown while visible, Esc or any other key dismisses, never in code, math or links, never on touch, never next-word, never a silent replacement. Zero core change.

**Why.** All three proposals, all three judges and the brief's research agree on both the engineering and the UX evidence. Squiggle, suggest, and one-click synced Add already deliver "make typos hard to leave in". Prediction is a separate product decision with weak evidence, and it would compete with the OS keyboard on phones.

### Q5. Personal dictionary, ignore lists, dictionary storage

**Decision.**

Synced (own_prefs LWW register via `OwnPrefsStore`, one key per entry, no wire or schema change):

- `spell.word.<NFC word>` = `{ added: <ms> }`; removal writes `null` (tombstone; `OwnPrefsStore.get` treats null as absent, verified at `apps/web/src/app/contexts/OwnPrefsContext.tsx:117-120`).
- Settings as single keys: `spell.enabled`, `spell.languages` (string[]), `spell.lenientArabic`, `spell.flagAllCaps`, `spell.highContrast`. Later `spell.nocorrect.<from>` only if autocorrect ships.
- Personal-dictionary imports are capped at about 5k words; larger lists go to per-device "Additional dictionaries".

Per device:

- Per-page ignores in `localStorage["tasfer.spell.ignored.<pageId>"]` (string[], cap 200). Promotable to per-word own_prefs keys `spell.ignore.<pageId>.<word>` later if sync is wanted.
- "Ignore once" in memory, keyed by char anchor.
- Imported dictionaries (a Hunspell pair or a `.txt` list) through the platform `FsDriver` (`read`, `write`, `delete`, `list`, `exists` exist on the web OPFS adapter, Electron `fs:*` IPC and Capacitor) under `spell/dicts/<id>/{index.aff,index.dic|words.txt,meta.json}` with descriptors in `localStorage["tasfer.spell.dicts"]`. This is P4.

Dictionary bytes: bundled under `apps/web/public/app/spell/<lang>/index.aff.txt` and `index.dic.txt` with `LICENSE.txt` beside them, resolved by `publicAssetUrl` (the path locales already use), excluded from the Workbox precache and cached at runtime by a `CacheFirst` route. The `.txt` suffix was chosen up front so the CDN compresses them on the wire as `text/plain`; the synthesis had proposed verifying Vercel's compression of bare `.dic`/`.aff` first and renaming only if needed, and the rename was done immediately instead to avoid the check and any inflate code path on the device. `hunspell.wasm` is copied from `packages/spell/node_modules/hunspell-wasm/wasm/hunspell.wasm` into `apps/web/public/app/spell/` by a script and is not committed.

Import and export: UTF-8, one word per line, `!word` forbidden, `#` comments (Firefox persdict, cspell and macOS LocalDictionary compatible).

**Why.** own_prefs is whole-value LWW per key (`apps/web/src/platform/engine.ts:1970-2043`), so one key per word makes concurrent adds on two devices commutative with zero new merge code, and the register tolerates unknown keys. Users hate macOS-style non-syncing word lists. Per-page ignores are low stakes: session-only makes people re-ignore on every reopen; a synced `string[]` per page loses concurrent adds and grows the register; localStorage survives reload at no cost and can be promoted. Dictionary bytes are megabytes and device-local by nature; `FsDriver` already abstracts the three platforms. Uncompressed assets drop the `DecompressionStream` plus fflate branch that iOS 15 WebViews would otherwise need.

Verified caveats of own_prefs that shaped this (section 9.4 has the details): there is no delete primitive, null tombstone rows live forever, every own-device handshake ships every row, and ordering is per-device wall-clock time.

### Q6. Native OS providers: none as a source of truth

**Decision.** The bundled Hunspell worker is the only source of "is this misspelled" on every platform. No Electron `webFrame.isWordMisspelled` / `getWordSuggestions`, no Android `SpellCheckerSession`, never OS `learnWord` or `addWordToSpellCheckerDictionary` as a source of truth, no acceptance enrichment anywhere. At most, as P7(a): an iOS `UITextChecker.guesses` Capacitor plugin (about 30 lines of Swift, `TasferSpell.suggest({ word, language })`), exposed as an optional `bridge.spell?.suggest`, merged and de-duplicated after Hunspell's suggestions, capped at 5, 150 ms timeout, feature-detected so older shells degrade.

**Why.** Browsers expose nothing readable (w3c/editing#36 closed; `::spelling-error` is style-only), the canvas swallows `contextmenu` and native squiggles on the opacity-0 surface are invisible, so a bundled engine is unavoidable on the web and must therefore exist everywhere. A synced personal dictionary only makes sense if the same word is flagged the same way on the phone and the laptop, which rules out an iOS acceptance enricher. Suggestion-only enrichment on iOS is the one place OS knowledge (learned names, strong Arabic guesses) adds value without breaking consistency.

Verified facts about the rejected providers:

- Electron `webFrame.isWordMisspelled(word)` and `webFrame.getWordSuggestions(word)` exist in Electron 43.1.1 (installed at `apps/desktop`; typings at `apps/desktop/node_modules/electron/electron.d.ts:18727-18756`), are synchronous renderer calls, use the OS spellchecker on macOS and Hunspell on Windows and Linux. They are broken on Windows en-US: electron/electron#28684 was still open on 2026-09-01 (last comment 2026-07-06; a January 2026 comment recommends not using the webFrame API). The preload at `apps/desktop/src/preload/index.ts:6-35` could expose them on the `tasfer` bridge without IPC, and `session.setSpellCheckerLanguages` is a no-op on macOS. Little gain over Hunspell on macOS and Linux, broken on Windows: not worth a platform fork.
- Android `TextServicesManager` / `SpellCheckerSession`: async, per-sentence offsets, null when no service is enabled, no client learn-word API since API 23.
- iOS `UITextChecker`: synchronous, `rangeOfMisspelledWord`, `guesses`, `completions`, `learnWord` (device-global, unsynced), `availableLanguages`.

---

## 3. Core changes to `packages/editor`

All changes use generic vocabulary. Nothing in the core names spelling.

### 3.1 `RangeDecoration.style`, `DecorationRect.baseline`, exported `paintDecorationRects` (P0b, required)

**Files.** `packages/editor/src/rendering/decorations.ts:64-73` (`RangeDecoration`: today only `color`, `opacity`, `gutter`; the header comment at lines 12-13 calls a range decoration "a translucent fill"). `packages/editor/src/nodes/TextNode.ts:1164-1169` (the internal `Rect` type returned by `computeSelectionRects` at 1176; no baseline). `TextNode.ts:1359-1497` (rect emission per line at 1360 and per bidi run at 1409-1446; flat rects use the full line box at 1492-1497). `TextNode.ts:2790-2829` (the three range-decoration passes: remote, flat at 2799-2811, structured at 2814-2827). `TextNode.ts:2922-2941` (`fillRects`, fill and `globalAlpha` only; folds into the helper). `TextNode.ts:2758-2767` (structured rects are computed from `baselineY` and then the baseline is discarded). `TextNode.ts:1266-1322` (an LTR-only early path for a selection inside one inline-math chip, also drops the baseline). `TextNode.ts:790-849` and `1114-1128` (IME composition and link underline y placement to mirror). `packages/editor/src/index.ts:557-567` (type re-exports). `packages/editor/src/rendering/decorations.test.ts`.

Verified correction to the synthesis: range decorations are painted by **four** painters, not one, and all of them do plain fills today, so they would silently ignore a new field:

- `TextNode.paint` (flat and structured passes above). `CodeNode` (`packages/code/src/CodeNode.ts:405`) and `QuoteNode` (`packages/editor/src/nodes/QuoteNode.ts:158`) delegate to `super.paint`, so they are covered.
- `AtomicNode.paintRangeDecorations` at `packages/editor/src/rendering/nodes/AtomicNode.ts:128-158`.
- `MathNode.paint` at `packages/math/src/MathNode.ts:1407-1420` (flat) and 1424-1455 (structured via `texSelectionRects`).
- `TableNode.paintDecorations` at `packages/table/src/TableNode.ts:346-374` (the comment at 332-334 says a table "has to paint for itself the way every other node does").

`MathMark` needs no change: `MathMark.contentSelectionRects` at `packages/math/src/MathMark.ts:211-240` already returns baseline-relative rects (`MarkReplacementSelectionRect` at `packages/editor/src/rendering/marks/Mark.ts:161-170` is "relative to the text baseline"), and the conversion to absolute rects where an underline y is computed lives in `TextNode.ts:2758-2767`. The public doc `custom-nodes.mdx:77` tells third-party nodes to paint range decorations themselves by filling their own selection rects, so a style option is part of that contract and the doc must say what nodes are expected to do with it.

**Signature.**

```ts
export type RangeDecorationStyle =
  | { readonly type: "fill" }
  | {
      readonly type: "underline";
      readonly line: "solid" | "wavy" | "dotted" | "dashed";
      /** CSS px, default 1. */
      readonly thickness?: number;
    };

export interface RangeDecoration {
  readonly kind: "range";
  readonly range: DecorationRange;
  readonly color: string;
  /** fill: default styles.selection.remoteOpacity; underline: default 1 */
  readonly opacity?: number;
  readonly gutter?: boolean;
  /** default { type: "fill" }: today's behaviour unchanged */
  readonly style?: RangeDecorationStyle;
}

export interface DecorationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Absolute y of the text baseline for this fragment, when the painter knows it. */
  readonly baseline?: number;
}

export function paintDecorationRects(
  ctx: CanvasRenderingContext2D,
  rects: readonly DecorationRect[],
  deco: RangeDecoration,
  styles: EditorStyles,
): void;
```

Painting rules inside the helper: underline y = `(rect.baseline ?? rect.y + rect.height * 0.8) + thickness + 2`, just below the link underline so a misspelled link shows both; wavy uses amplitude = thickness and period = 4 × thickness via `quadraticCurveTo`, with the phase anchored at `rect.x` so adjacent bidi-run rects tile, and y snapped to a half pixel; dotted uses `setLineDash([t, 2t])`, dashed `[3t, 2t]`; one stroke per rect (one per line × bidi run), so wrapping and RTL need no logical-to-visual math in any caller.

Baseline plumbing: the flat pass needs a baseline per line because `computeSelectionRects` drops it; the cleanest route is to have `computeSelectionRects` (or a sibling) return the per-line baseline alongside each rect, computed as `blockTopY + line.y + (line.baselineOffset ?? fontMetrics.ascent)`, rather than recomputing it in `paint`. The structured pass already has `baselineY` in hand at 2758-2767.

What the other three painters do with an underline is a design choice that must be made explicitly: the recommendation is that `AtomicNode` and the table's whole-grid wash keep filling (an underline under an image makes no sense), while `MathNode`'s tex rects and the table's in-cell content band call the helper so a future styled decoration renders consistently. Either way, every painter calls `paintDecorationRects` so a new style is never silently ignored.

**Why.** The only change nothing outside the engine can emulate. Generic by construction: find can dotted-underline inactive matches, grammar gets blue dotted, comments solid, presence "peer is editing here". The discriminated union keeps fill and underline fields typed separately and is what the helper switches on. Core learns only "stroke pattern X in colour Y".

**Docs.** `apps/site/src/views/DocsPage/pages/editor/api-editor.mdx` (around line 129: a new Decorations table with the kinds, the three point forms, `RangeDecorationStyle`, `paintDecorationRects`, layer semantics; fix the `focus(at?)` drift around line 112 while there, the code is `focus()`), `custom-nodes.mdx:77` (paint range decorations through `paintDecorationRects`, not a bare fill), `collaboration.mdx:53-65` (the presence section links to the Decorations table).

### 3.2 Per-block decoration index (P0b, internal)

**Files.** `packages/editor/src/rendering/decorations.ts:131-165` (`setDecorationLayer`, `allDecorations`), `decorations.ts:174-203` (`resolveDecorationPoint`, an O(runs) walk per char-id anchor), `TextNode.ts:2790-2829` (three `allDecorations` loops per painted block), `packages/editor/src/sync/block-lookup.ts` (`findBlockIndex`, the WeakMap-per-array-identity precedent).

**Signature.**

```ts
/**
 * Decorations that can touch `blockId`: range decorations whose from/to block
 * is `blockId` or that span blocks, plus block and caret decorations on it.
 * Derived lazily once per DecorationLayers identity (WeakMap), like
 * findBlockIndex; layer insertion order preserved.
 */
export function decorationsForBlock(
  layers: DecorationLayers,
  blockId: string,
): readonly Decoration[];
```

`TextNode.paint` replaces `for (const deco of allDecorations(state.ui.decorations))` with `decorationsForBlock(state.ui.decorations, block.id)` in all three passes; the other three painters do the same. Multi-block ranges go in an "any block" bucket every lookup includes.

**Why.** Verified: every painted block iterates every decoration three times and resolves each char-id anchor by walking that block's runs, then clips. With hundreds of squiggles (a normal long note) that is the dominant per-keystroke repaint cost on a slow phone, and it grows with total flags × visible blocks. About 40 lines, no public API, and it removes any need for a visible-block-ids API: the host can publish every flag. Do not ship P1 without it.

### 3.3 `query.marks` accepts a `DocRange` (P0b, public)

**Files.** `packages/editor/src/entries/editor.ts:748-753` and `:779` (`QueryApi.marks(at?: DocPoint)`), `packages/editor/src/positions.ts:435-456` (`queryMarkInfos`, a single-point read that filters `resolveMarkRuns(block)` to runs containing the offset), `packages/editor/src/mark-runs.ts:32-51` (`resolveMarkRuns`).

Verified correction: `resolveMarkRuns` is **not** exported from `@tasfer/editor/internal` (`internal.ts:79-83` exports only `extractTitleFromBlocks`, `findTitleBlock`, `getVisibleTextFromRuns` from `./sync/char-runs`). It is reachable only through the package's `"./*"` wildcard subpath export (`packages/editor/package.json:77-84`) as `@tasfer/editor/mark-runs`, which `packages/math/src/spans.ts:16` and `input-rules.ts:27` use. `getVisibleTextFromRuns` lives in `sync/char-runs.ts:179`, not `mark-runs.ts`. `apps/web/src/editor/findMatches.ts:7-10` imports only `getVisibleTextFromRuns` and `isTextualBlock` from the internal entry and never touches `resolveMarkRuns`. If the wildcard is dropped, `@tasfer/math`'s two imports also need a new home.

**Signature.**

```ts
interface QueryApi<S> {
  /**
   * Point form: runs containing the point (today's behaviour).
   * Range form: every run whose [from, to) intersects the range, in document
   * order; a cross-block range yields each block's runs in order; an
   * unresolved target yields [].
   */
  marks(at?: DocPoint | DocRange): MarkInfo<S>[];
}
```

**Why.** The checker must skip code, link and math runs block-wide before tokenising; `BlockData` (`positions.ts:63-68`: `id`, `type`, `text`, `attrs`) carries no runs and the point read costs O(tokens × runs) per block. `internal.ts` asks to promote curated APIs to the root rather than widen the internal surface, and `block(point)` / `blocks(range)` is the exact precedent for a point/range pair. Avoidable only via the deep import a published package must not make.

**Docs.** `api-editor.mdx` Reading state table: the `query.marks` row; add the missing `query.content` row while there.

### 3.4 `OPEN_CONTEXT_MENU.point` (P2, recommended, avoidable)

**Files.** `packages/editor/src/action-bus.ts:558-562` (payload `{ x, y, hasSelection }`, canvas coordinates). `packages/editor/src/events/keysEvents.ts:1205-1275` (`handleContextMenu`; `position` is already computed by `getTextPositionFromViewport` at 1223-1228; the dispatch is at 1268-1272). `packages/editor/src/actions/touch-actions.ts:271-285` (`OPEN_CONTEXT_MENU_AT`, a state action for the touch path that forwards `{ x, y, hasSelection }` without moving the caret). `keysEvents.ts:1296-1355` (`openContextMenuAtCaret`, the keyboard path).

Verified behaviour of the pointer path: when no flat selection and no nested (structured) range is held, `handleContextMenu` first tries `getContentSelectionFromViewport` (a nested caret) and only then falls back to `updateCursor(state, position)` (1241-1254); it also clears `ui.isHoveringLinkWithModifier` before dispatching. With a selection held, the caret is deliberately not moved.

**Signature.**

```ts
export const OPEN_CONTEXT_MENU = action<{
  x: number;
  y: number;
  hasSelection: boolean;
  /** Document point under the pointer (or the caret for keyboard/touch opens), when one resolved. */
  point?: DocPoint;
}>("open-context-menu");
```

**Why.** With a held selection the host cannot tell which word was right-clicked; the handler already has the position and passing it is about five lines. P1 works without it: right-click with no selection moves the caret to the pointer, and touch long-press places the caret or holds a selection first (`touchEvents.ts:940-946`, `691-700`), so "word under the caret" is the target; P1 shows spelling items with a held selection only when the selection is exactly one flagged word.

There is no public pointer-to-`DocPoint` API. `EditorViewApi` (`editor.ts:560-660`) has `showDropIndicator` and `edgeScrollForDrag`, which take client coordinates but return a block-edge gap (`"start"` or `{ block, side: "after" }`), not a text offset. `getTextPositionFromViewport` (`selection.ts:739-747`) is importable through the wildcard as `@tasfer/editor/selection` but returns the engine-internal index-based `Position`, and the package does not use it.

**Docs.** `api-editor.mdx` `OPEN_CONTEXT_MENU` payload row (around line 105).

### 3.5 `RangeDecoration.a11y` projected into the DOM mirror (P3, recommended)

**Files.** `decorations.ts:64-72`; `packages/editor/src/a11y/dom-mirror.ts:134-143` (`DomMirrorOptions`, add `getDecorations`), `dom-mirror.ts:183-231` (`applyChange` / `scheduleFlush` / `flush`; add `applyDecorations` coalesced into the same rAF flush), `dom-mirror.ts:266-318` (`renderBlockEl`, wrap resolved ranges); `editor.ts:1287-1291` (mirror construction) and `6102-6129` (`setDecorations`: notify the mirror with old ∪ new block ids).

**Signature.**

```ts
export interface RangeDecoration {
  /* ... */
  readonly a11y?: { readonly invalid: "spelling" | "grammar" | "true" };
}
// DomMirrorOptions gains `getDecorations: () => DecorationLayers`.
// DomMirror.applyDecorations(blockIds: Iterable<string>): void
//   marks blocks dirty and flushes with applyChange's rAF.
// renderBlockEl post-pass: TreeWalker over text nodes accumulating visible
//   offsets, split at resolved [from, to), wrap in <span aria-invalid=...>;
//   skip a block whose mirror text length differs from the visible char
//   length (alignment lost to a replacement run).
```

**Why.** Screen readers only see the mirror; NVDA says "spelling error" and VoiceOver "misspelled" from `aria-invalid` on the text itself. The host cannot do this: the container's children are owned by the mirror and rebuilt on flush. The vocabulary is ARIA's, not Tasfer's; grammar reuses it. A host live region (P2) covers navigation announcements without it.

**Docs.** `api-editor.mdx` Decorations table, `a11y` column.

### 3.6 `view.posAtCoords` (optional, only for a hover tooltip)

**Files.** `editor.ts:560-582` (`EditorViewApi`, next to `coordsAtPos`), `selection.ts:739` (`getTextPositionFromViewport`).

```ts
/** Client viewport CSS px like showDropIndicator; null outside the canvas or on a non-textual block. */
posAtCoords: (client: { x: number; y: number }) => DocPoint | null;
```

Deferred until a resting-pointer hint on a squiggle is wanted (P5). Right-click, tap and keyboard paths are covered by the caret and `OPEN_CONTEXT_MENU.point`.

### 3.7 Composition-aware decoration indices (optional, internal, cosmetic)

**Files.** `TextNode.ts:2560-2564` (`getContentWithComposition`), `2799-2812`. When composition text is folded into the layout, shift resolved range-decoration indices at or after the composition start by `composition.text.length` before `selectionRects()`. Today any range decoration after the caret in the block being composed paints N chars early while an IME session is open (pre-existing for find highlights and remote selections). The checker excludes the caret word anyway, so the common case is invisible.

### 3.8 Host-only, no core change: mount with `nativeAutocomplete: isTouchDevice()`

**Files.** `packages/editor/src/entries/mount.ts:451-457` (sets `autocapitalize`, `autocorrect`, `spellcheck` from the option; defaults to on; no `lang` attribute anywhere in `packages/editor/src`), `editor.ts:1055` (readonly field) and `:1273` (constructor assignment, the only two writes repo-wide), `editor.ts:2970-2980` (`applyAutosuggestForCaret`, the only later attribute writer, gated on the caret entering or leaving verbatim source), `apps/web/src/app/MountedEditor.tsx` (mount options currently omit `nativeAutocomplete`), `packages/editor/src/internal.ts:75` (`isTouchDevice`).

```ts
useEditor(..., { nativeAutocomplete: isTouchDevice() })
```

**Why.** Verified: desktop today runs the browser's spellcheck on the hidden contenteditable for squiggles nobody can see (wasted CPU on old laptops; Chrome's Enhanced spell check can send text to Google), and Safari or macOS autocorrect could rewrite words Tasfer also flags. Phones keep it on because the OS suggestion strip depends on it. A settings flip remounts, so no runtime toggle API is needed. `autocorrect="off"` is now standard on contenteditable (Safari, Firefox, Chrome 152; WebKit since 2016; maps to Android `TYPE_TEXT_FLAG_AUTO_CORRECT`).

### 3.9 Verified gotchas that shaped the design

These are facts about the current code that the package works around. They are recorded here so nobody re-derives them.

**Explicit-range `insertText` drops marks.** `makeChangeApi.insertText` (`editor.ts:4743-4761`) sends any explicit range to `replaceInlineRangeAction` (`editor.ts:5672-5744`), which is a raw delete plus insert with at most one explicit mark. It never reads `ui.activeMarksMode` (the pending caret format is applied only by the free path at `actions.ts:1794`), never calls `moveCursorToPosition` (the caret is not moved; contrast `deleteInlineRangeAction` at 5746-5779), and `insertCharsAtPosition` (`sync/crdt-utils.ts:361-408`) creates a bare char run. Whether the new text looks formatted is an accident of id-anchored span resolution (`mark-runs.ts:84-97`): new chars land right after `afterCharId` (`sync/char-runs.ts:96-115`), before the tombstoned first char of the replaced word. An empirical probe (7 cases, one `change()` each) showed: a whole bold word replaced loses bold; a whole linked word loses the link; a word at the start of a longer bold span comes out unformatted and the span shrinks; a word strictly inside or at the end of a span keeps bold; passing `{ type: "strong" }` as the third argument keeps it. One undo group per `change()` is confirmed (`commitChange` at `editor.ts:5164-5185` records one `UndoGroup`). Consequence: `REPLACE_WORD` does a minimal-diff insert and, when the diff touches the first or last char, re-applies every mark that covered the whole word with `c.setMark(...)` per mark in the same batch (section 6.8).

**`isTextualBlock` is true for code and math.** `packages/editor/src/sync/block-registry.ts:545-547`; `CODE_CAPS` at 263 and `MATH_CAPS` at 280 have `hasText: true` and `hasFormats: false`. The checker skips by block type, not by `isTextualBlock`.

**Space and Tab.** Space dispatches `INSERT_TEXT` with `" "` at `keysEvents.ts:1130-1137` and never fires `TEXT_INPUT` (that is only dispatched in the `default:` branch at 1156 and 1169). Soft-keyboard spaces reach the same branch via `queueSyntheticKey` (`editor.ts:3218-3230`, `3339-3343`). Tab is fully consumed at `keysEvents.ts:393-482`: every branch returns before the switch, so an input rule never sees `"\t"`; inside a preformatted block Tab dispatches `INSERT_TAB`, which is `insertText(state, "  ")` (`edit-actions.ts:117-120`), so rules run there with two spaces as input. An `after-insert` `FeatureInputRule` does run inside `insertText` (`actions.ts:1963-1969`) with `{ state, input }`, so an autocorrect-on-space rule is expressible (P7(b)), with the caveat that the phase is skipped on several early exits (a `before-insert` rule returned `handled`, caret inside a structured mark, non-textual block, `wrapSelection` wrapped a selection, invalid cursor, a node's `transformTypedInput` swallowed the input). `EditorApi.registerAction` (`editor.ts:863-878`) has only the `MutationAction` and `Action` overloads; there is no typed `registerState` on the public API.

**Hidden surface replacements.** OS autocorrect, predictive-text and suggestion-strip replacements arrive as plain `InputEvent`s and are diffed by `applySurfaceReplacement` (managed strategy, `editor.ts:3235-3289`, using `computeSurfaceDelta` at `input-diff.ts:225-250`) or `handleFaithfulInput` (faithful strategy, default on iOS, `editor.ts:3346-3356`), and committed as one `change()`, one undo step each, with no host hook before commit. Genuine IME composition is explicitly skipped by that handler (`editor.ts:3382-3383`) and committed through `compositionend` and the events queue (`editor.ts:3960-3969`). The spell checker sees these as ordinary local ops.

**The context menu is host-owned.** `OPEN_CONTEXT_MENU` is dispatched by right-click, long-press (`OPEN_CONTEXT_MENU_AT`), Cmd/Ctrl+Enter, Shift+F10 and the Menu key (`keysEvents.ts:150-156`, `357-362`; also allowed in readonly at 195-198; swallowed while a host menu is up at 208-210). The host builds items in `apps/web/src/app/MountedEditor.tsx` (`getContextMenuItems` at 3433; rendered at 3860) with stable ids that the native menu bridge (`apps/web/src/app/nativeContextMenu.ts`; `ICON_BY_ID` at 42, `MENU_ICON_COMPONENTS` at 64) maps to iOS, Android and Electron menus.

**Shortcut collisions.** The engine's Cmd chords, all matched on `event.code`, are Z/Y/Shift+Z (undo, redo), A (select all), C/F in readonly, B/I/E and Shift+X (`TOGGLE_STRIKE`, `keysEvents.ts:374-390`), plus the bare-Ctrl macOS emacs set A/E/B/F/P/N/H/D/K (314-340). Unmatched modifier chords fall through untouched (1138-1143). Host chords: Cmd/Ctrl+F (find, `MountedEditor.tsx:3294`), Cmd/Ctrl+K (`ActionCenter.tsx:466`), the sidebar toggle in `Layout.tsx` (section 8.3), Cmd/Ctrl+Enter in three inputs (calendar draft save, link drawer, DevToolbar SQL). Electron's menus are role menus only; no accelerators in `apps/desktop`. `Period`, `Semicolon`, `Quote` and `F7` are bound nowhere in the engine or the opt-in packages.

**Assets and shells.** `publicAssetUrl` (`apps/web/src/lib/publicAssetUrl.ts:1-5`) prefixes `BASE_URL`; non-Vercel builds use `base: "./"` (`vite.config.ts:156`). Electron loads the bundle via `win.loadFile` from `file://` (`apps/desktop/src/main/index.ts:352-353`; navigation policy at 274). Capacitor does **not** use `file://`: `apps/web/capacitor.config.js` sets `hostname: "tasfer.app"`, `androidScheme: "https"` and `ios.scheme: "https"`, so the bundled `dist` is served by the WebView's scheme handler at `https://tasfer.app` (or a `CAP_SERVER_URL` dev server), and `fetch` works there. The Workbox precache is configured at `vite.config.ts:131-137` (`maximumFileSizeToCacheInBytes` 4 MiB, `globIgnores: ["**/heic-to-*.js"]`); the `CacheFirst` route template is `apps/web/src/sw.ts:95-103`. Vite `worker.format` is `"es"` (`vite.config.ts:160`). There is no app-authored dedicated Worker entry today, only `node.sharedworker.ts` (`apps/web/src/platform/index.ts:21`, `184`); `browser-image-compression` spawns a library-internal worker (`images.api.ts:19`). The OPFS `FsDriver` is `apps/web/src/platform/adapters/opfs-fs.ts:11`.

---

## 4. Architecture

### 4.1 `packages/spell` (`@tasfer/spell`)

MIT, `type: module`, peer-dep `@tasfer/editor`, dependency `hunspell-wasm` 0.3.0 (`LGPL-2.0 OR GPL-2.0 OR MPL-1.1`; taken under LGPL). Exports `.`, `./worker`, `./hunspell` (see `packages/spell/package.json`). Scaffolded from `packages/code` (tsdown, eslint, vitest, prettier). An eslint `no-restricted-imports` rule forbids `@tasfer/editor/*` subpaths and `react`; `src/boundary.test.ts` asserts the same from the import graph.

`src/index.ts` today:

```ts
export * from "./engine";
export * from "./protocol";
export * from "./script";
export * from "./tokenizer";
export * from "./checker";
export * from "./anchor";
export * from "./actions";
```

#### `src/protocol.ts` (exists)

The main-thread to worker contract, dictionary sources, per-check options and the shared `Flag` shape. Everything is structured-cloneable. Requests are correlated by `id`; `cancel` names the id to drop; blocks are versioned by the caller so a stale `checked` result can be discarded on arrival.

```ts
export type Script = "latn" | "arab" | "other" | "mixed";

/** One misspelling in a block's visible text (UTF-16 offsets, `to` exclusive). */
export interface Flag {
  readonly from: number;
  readonly to: number;
  /** The token exactly as it appears in the text (display form). */
  readonly word: string;
  readonly script: Script;
}

export type DictionarySource =
  | { readonly kind: "url"; readonly aff: string; readonly dic: string }
  | { readonly kind: "bytes"; readonly aff: ArrayBuffer; readonly dic: ArrayBuffer };

export type ExtraDictionarySource =
  | { readonly kind: "url"; readonly dic: string }
  | { readonly kind: "bytes"; readonly dic: ArrayBuffer };

export interface CheckOptions {
  readonly flagAllCaps: boolean;
  readonly lenientArabic: boolean;
  /** Words ignored for this document (already normalised for lookup). */
  readonly ignored: readonly string[];
}

export interface CheckBlock {
  readonly blockId: string;
  readonly version: number;
  readonly text: string;
  /** Offset spans the checker must not tokenise (code/link/math runs). */
  readonly skip: ReadonlyArray<readonly [number, number]>;
}

export type CheckPriority = "caret" | "local" | "remote" | "initial";

export type SpellRequest =
  | {
      readonly type: "init";
      readonly id: number;
      /** Engine binary: a URL the worker fetches, raw bytes, or a compiled module. */
      readonly wasm: string | ArrayBuffer | WebAssembly.Module;
    }
  | {
      readonly type: "loadDictionary";
      readonly id: number;
      readonly lang: string;
      readonly script: Script;
      readonly source: DictionarySource;
      readonly extras?: readonly ExtraDictionarySource[];
    }
  | { readonly type: "unloadDictionary"; readonly id: number; readonly lang: string }
  | {
      readonly type: "setUserWords";
      readonly id: number;
      readonly words: readonly string[];
      /** `!word` entries: always flagged even if a dictionary has them. */
      readonly forbidden: readonly string[];
    }
  | {
      readonly type: "check";
      readonly id: number;
      readonly docId: string;
      readonly blocks: readonly CheckBlock[];
      readonly options: CheckOptions;
      readonly priority: CheckPriority;
    }
  | {
      readonly type: "suggest";
      readonly id: number;
      readonly word: string;
      readonly script: Script;
      readonly limit: number;
    }
  | { readonly type: "cancel"; readonly id: number };

export interface CheckedBlock {
  readonly blockId: string;
  readonly version: number;
  readonly flags: readonly Flag[];
  /**
   * Scripts present in the block whose dictionaries were not loaded yet:
   * those tokens were NOT flagged and the block should be re-checked once a
   * dictionary lands.
   */
  readonly deferredScripts?: readonly Script[];
}

export type SpellResponse =
  | { readonly type: "ready"; readonly id: number }
  | { readonly type: "dictionaryLoaded"; readonly id: number; readonly lang: string; readonly ms: number; readonly bytes: number }
  | { readonly type: "dictionaryError"; readonly id: number; readonly lang: string; readonly message: string }
  | { readonly type: "checked"; readonly id: number; readonly docId: string; readonly results: readonly CheckedBlock[] }
  | { readonly type: "suggestions"; readonly id: number; readonly word: string; readonly suggestions: readonly string[] }
  | { readonly type: "error"; readonly id: number; readonly message: string };
```

The `url` source lets the worker fetch the bytes itself (the service worker's `CacheFirst` route intercepts worker fetches). The `bytes` source is for hosts that must read on the main thread (Electron's `file://` renderer, imported dictionaries read through `FsDriver`); the buffers are transferred, never cloned. `mixed` tokens (Arabic letters joined to Latin letters, `الـWiFi`) and `other` scripts are never flagged.

#### `src/engine.ts` (exists)

The contract every backend implements. One `SpellEngine` per loaded dictionary; the worker host owns the instances and routes tokens to every engine of the token's script (union rule). A backend never touches the DOM and never holds module-level state.

```ts
export interface SpellEngine {
  readonly lang: string;
  readonly script: Script;
  /** True when `word` (already normalised for lookup) is spelled correctly. */
  spell(word: string): boolean;
  /** Best first, at most `limit`. Slow by nature: call only on demand, never inside a checking pass. */
  suggest(word: string, limit: number): string[];
  /** Personal-dictionary word: accepted from now on (session only). */
  add(word: string): void;
  remove(word: string): void;
  /** Merge an extra word list (a `.dic` body: optional count line, one entry per line). */
  addDictionary(dic: string): void;
  dispose(): void;
}

export interface CreateEngineOptions {
  readonly lang: string;
  readonly script: Script;
  /** Affix rules (`.aff`), raw bytes in the encoding the file declares. */
  readonly aff: Uint8Array;
  /** Dictionary (`.dic`), raw bytes. */
  readonly dic: Uint8Array;
  /** Extra `.dic` bodies merged after load (accept-lists, imports). */
  readonly extras?: readonly Uint8Array[];
}

export interface SpellEngineFactory {
  create(opts: CreateEngineOptions): Promise<SpellEngine>;
}

/**
 * Plain word list (one word per line, `#` comments, cspell prefixes: `!word`
 * forbidden, `~word` case-insensitive, `+`/`*` compound markers) to a
 * Hunspell `.aff`/`.dic` pair. Forbidden words are returned separately so the
 * host can keep flagging them.
 */
export function wordListToDic(words: Iterable<string>): {
  aff: Uint8Array;
  dic: Uint8Array;
  forbidden: string[];
};

/** Test double: a set-backed engine with edit-distance-1 suggestions. */
export function createMemoryEngine(
  lang: string,
  script: Script,
  words: Iterable<string>,
): SpellEngine;
```

`wordListToDic` emits `SET UTF-8\n` as the affix file and `<count>\n<words>` as the dictionary, NFC-normalised and de-duplicated, dropping any entry containing whitespace. `createMemoryEngine` is what the worker-host and checker tests use so they never need the WASM binary.

#### `src/hunspell/index.ts` (subpath `@tasfer/spell/hunspell`)

Adapter over `hunspell-wasm` 0.3.0. The package's own loader (`getWasmModule()` in `hunspell-wasm/src/Hunspell.ts:348-358`) is a module-level singleton that dynamically imports the glue and lets Emscripten locate the binary itself; the adapter does not use it, because the binary must come from the host and module singletons are forbidden. Instead the adapter:

1. Imports the Emscripten glue `hunspell-wasm/wasm/hunspell.js` (its default export is a `Module` factory, typed `initializer(): any` in `wasm/hunspell.d.ts`) and calls it with `wasmBinary` set to bytes the host supplied. The host can hand over a URL (the adapter fetches it, in the worker), an `ArrayBuffer`, or a compiled `WebAssembly.Module` (the adapter supplies it through Emscripten's `instantiateWasm` hook instead of `wasmBinary`). The instantiated module object is cached per factory instance for the worker's lifetime.
2. Decodes `aff` and `dic` bytes to strings. The `Hunspell` class constructor takes the module object plus the affix and dictionary contents as **strings** (`new Hunspell(wasmModule, affixes, dictionary, key?)`, `Hunspell.ts:29`; it writes them into the Emscripten virtual FS under random names and unlinks them after `Hunspell_create`). A dictionary whose `SET` line names a non-UTF-8 charset (`ISO8859-1`, `KOI8-R`, and so on) is transcoded from that charset to UTF-8 with `TextDecoder` and the `SET` line rewritten to `SET UTF-8`, so the class's UTF-8 string path is always correct.
3. Maps the contract: `spell` to `testSpelling`, `suggest` to `getSpellingSuggestions` (sliced to `limit`), `add` to `addWord`, `remove` to `removeWord`, `addDictionary` to `addDictionaryFromString`, `dispose` to `dispose`. `extras` from `CreateEngineOptions` are applied through `addDictionaryFromString` after construction.
4. Runs in a browser Worker or Node `worker_threads` (a future `tasfer spell` CLI command).

```ts
export interface HunspellFactoryOptions {
  /** URL the worker fetches, raw bytes, or a compiled module. */
  readonly wasm: string | ArrayBuffer | WebAssembly.Module;
}
export function createHunspellFactory(opts: HunspellFactoryOptions): SpellEngineFactory;
```

The file is being written concurrently; if its exported shape differs from the above, the file wins and this section should be updated. If the wrapper stagnates (one author, unstated Hunspell version) or P0a needs a different memory profile, the replacement is an owned emcc build of Hunspell 1.7.3 (`-O3 MODULARIZE EXPORT_ES6 ALLOW_MEMORY_GROWTH`, exports create/spell/suggest/add/remove/add_dic/destroy) under `packages/spell/wasm/` with a reproducible Makefile. The adapter is the only file that changes.

#### `src/tokenizer.ts`

Prose tokenisation. A protected-span pre-pass (URLs, `www.` and `domain.tld`, emails, `@mentions`, `#hashtags` including Arabic, file paths, hex ids) merged with host-supplied skip spans (mark runs); `Intl.Segmenter("und", { granularity: "word" })` created per instance, no module singleton; post-filters: `isWordLike` only, trim U+0027 and U+2019 and quotes, split hyphen parts, drop tokens with `\p{Nd}` (including Arabic-Indic digits), single letters, mixed-script tokens, tatweel- or tashkeel-only tokens, camelCase and underscore identifiers, tokens over 100 chars, ALL-CAPS Latin (setting). A `\p{L}\p{M}*` regex fallback if `Segmenter` is missing. Pure; unit-tested with Arabic and English fixtures.

`Intl.Segmenter` is available on every target (Chrome 87+, Safari 14.1+, Firefox 125+, Electron 43, Android WebView 87+). It keeps tashkeel, tatweel and ZWNJ inside words, keeps "don't", splits hyphens, glues digits, and shreds URLs, emails, `@` and `#` (hence the pre-pass). It costs 0.12 ms per 2,000-char paragraph, and the "ar" and "und" locales behave identically.

```ts
export interface Token {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly normalized: string;
  readonly script: Script;
}
export interface TokenizeOptions {
  readonly skip: ReadonlyArray<readonly [number, number]>;
  readonly flagAllCaps: boolean;
}
export function tokenize(text: string, opts: TokenizeOptions, seg: Intl.Segmenter): Token[];
/** segments.containing(offset); also matches offset === to. */
export function wordAt(text: string, offset: number, seg: Intl.Segmenter): { from: number; to: number } | null;
export function protectedSpans(text: string): Array<[number, number]>;
```

#### `src/script.ts`

Script classification (Arabic blocks 0600-06FF, 0750-077F, 08A0-08FF, FB50-FDFF, FE70-FEFF; Latin; other; mixed) and lookup normalisation: NFC; strip bidi controls (200E/F, 202A-202E, 2066-2069), ZWNJ/ZWJ, soft hyphen; Arabic: strip tashkeel (064B-065F, 0670, 0610-061A, 06D6-06ED) and tatweel 0640, fold presentation forms FB50-FEFF; **never** fold hamza, ta-marbuta or alif-maqsura. Lenient-Arabic variant probes (initial ا to أ/إ/آ, final ه to ة, final ى to ي, at most 16 forms) and repeated-letter collapse ("sooo" to "soo" and "so"). Latin case rules for sentence-initial capitals.

```ts
export function scriptOf(word: string): Script;
export function normalizeForLookup(word: string, script: Script): string;
export function arabicVariants(word: string): string[];
/** "Hello" -> ["Hello", "hello"]; ALL-CAPS handled by the tokenizer setting. */
export function caseVariants(word: string): string[];
```

#### `src/worker-host.ts` (subpath `@tasfer/spell/worker`)

Worker-side dispatcher, no DOM. Engines per language; a forbidden `Set`; a per-language LRU word-to-accepted cache (100k) in front of Hunspell; a priority queue keyed by `(docId, blockId)` where a newer request replaces an older one for the same block; 8 ms slices with `MessageChannel` yields so `suggest` and `cancel` interleave; tokenises each block, routes tokens by script to every enabled engine of that script (union rule), lenient-Arabic variant probes, never flags a token whose script has no loaded dictionary (`deferredScripts`, re-queued when the dictionary lands); answers `suggest` on demand (at most `limit`, de-duplicated, casing restored from the original token; skips auto-suggest for Arabic tokens over 14 letters unless requested from a menu).

```ts
export function createWorkerHost(
  post: (msg: SpellResponse, transfer?: Transferable[]) => void,
  factory: SpellEngineFactory,
  fetchBytes?: (url: string) => Promise<ArrayBuffer>,
): (msg: SpellRequest) => Promise<void>;
```

#### `src/checker.ts`

Per-editor controller (one per mounted editor, no shared state). Subscribes `editor.on("change")` and `on("selectionchange")`, keeps `Map<blockId, { version, flags, checkedVersion }>`, debounce classes, batches check requests through a host-supplied transport, drops stale results, filters the caret word at publish time, anchors flags as `CharacterDecorationPoint`s, publishes one layer per animation frame, and exposes lookups for the UI (flag at caret, next and previous, suggest with LRU and prefetch, ignore once).

```ts
export interface SpellTransport {
  check(
    req: Omit<Extract<SpellRequest, { type: "check" }>, "id" | "type">,
  ): Promise<readonly CheckedBlock[]>;
  suggest(word: string, script: Script, limit: number): Promise<string[]>;
  onInvalidate(cb: (words?: string[]) => void): () => void;
}

export interface SpellCheckerOptions {
  editor: Editor;
  doc: Doc;
  docId: string;
  transport: SpellTransport;
  layer?: string;                       // "spell"
  skipBlockTypes?: ReadonlySet<string>; // code, math, table, image, line
  skipMarks?: ReadonlySet<string>;      // code, link, math
  color: () => string;
  style?: () => RangeDecorationStyle;
  caretGraceMs?: number;                // 500
  debounceMs?: { caret: number; local: number; remote: number }; // 120 / 250 / 300
  maxFlagsPerBlock?: number;            // 200
  maxFlags?: number;                    // 2000
  isEnabled: () => boolean;
  ignoredInDocument: () => ReadonlySet<string>;
  flagAllCaps: () => boolean;
  lenientArabic: () => boolean;
}

export interface FlagRef extends Flag {
  blockId: string;
  version: number;
  range: DecorationRange; // char-id anchored
}

export class SpellChecker {
  constructor(o: SpellCheckerOptions);
  start(): void;
  stop(): void;
  dispose(): void;
  invalidateAll(): void;
  /** Synchronous removal across blocks on Add. */
  dropWord(word: string): void;
  flagAt(p: DocPoint): FlagRef | null;
  flags(): FlagRef[];
  count(): number;
  next(from: DocPoint, wrap?: boolean): FlagRef | null;
  prev(from: DocPoint, wrap?: boolean): FlagRef | null;
  suggest(f: FlagRef, limit?: number): Promise<string[]>;
  ignoreOnce(f: FlagRef): void;
  onFlagsChange(cb: (count: number) => void): () => void;
}
```

#### `src/anchor.ts`

```ts
/**
 * Walks block.charRuns skipping deletedMask; id = `${run.peerId}:${run.startCounter + i}`.
 * The provider-core cursors.ts:301-331 pattern over the public Block type.
 */
export function charAnchor(block: Block, offset: number): CharacterDecorationPoint;
```

#### `src/actions.ts`

One bus `MutationAction` so native shells and hosts dispatch by id and undo is one group. Minimal-diff replacement (strip the common prefix and suffix, insert only the middle so most fixes stay strictly inside a formatted run) and, when the diff touches the word's first or last char, re-apply every mark that covered the whole word (see 3.9). Mandatory tests: bold-only misspelled word, misspelled link, RTL word.

```ts
// c.insertText(mid, { from, to }) then c.setMark(name, { active: true, attrs, range })
// per full-cover mark from query.marks({ from, to }); c.select({ block, offset: from + text.length })
export const REPLACE_WORD: MutationAction<{ block: string; from: number; to: number; text: string }>;
export function replaceWord(editor: Editor, f: FlagRef, text: string): boolean;
```

### 4.2 `apps/web/src/spell/`

#### `spell.worker.ts`

Vite ES-module worker entry: `createWorkerHost(postMessage, createHunspellFactory({ wasm }), fetch)` wired to `self.onmessage`. Loaded with `new Worker(new URL("./spell.worker.ts", import.meta.url), { type: "module" })`. P0a decides whether Electron's `file://` renderer needs the `?worker&inline` Blob-URL form instead.

#### `SpellService.ts` and `SpellProvider.tsx`

One per app, owned by a React context provider (never module-global). Lazy worker start on the first enabled editor; terminate after 10 minutes with no mounted editor; request correlation; dictionary registry and loader (`url` source on web and Capacitor via `publicAssetUrl`; `bytes` source via `FsDriver` for imported dictionaries and, if P0a says so, for Electron); pushes personal words to the worker; hands each editor a `SpellTransport`; emits `invalidate` on dictionary, word or settings change; suggestion cache (500). Status per language for Settings.

```ts
export interface DictionaryDescriptor {
  id: string;
  lang: string;
  script: Script;
  labelKey: string;
  sizeBytes: number;
  license: string;
  source:
    | { kind: "bundled"; aff: string; dic: string; extras?: string[] }
    | { kind: "imported"; dir: string };
}

export class SpellService {
  constructor(deps: { prefs: OwnPrefsStore; fs: FsDriver; wasmUrl: string; dictionaries: DictionaryDescriptor[] });
  transportFor(editor: Editor, docId: string): SpellTransport;
  enableLanguage(lang: string): Promise<void>;
  disableLanguage(lang: string): Promise<void>;
  status(lang: string): "missing" | "downloading" | "ready" | "error";
  importDictionary(files: { aff?: File; dic?: File; list?: File }, meta: { label: string; lang?: string }): Promise<DictionaryDescriptor>; // P4
  removeImported(id: string): Promise<void>;   // P4
  removeFromDevice(lang: string): Promise<void>; // P4
  addWord(w: string): Promise<void>;
  removeWord(w: string): Promise<void>;
  words(): string[];
  exportWords(): string;
  importWords(text: string): Promise<number>;
  subscribe(cb: () => void): () => void;
  dispose(): void;
}
export function SpellProvider({ children }): JSX.Element;
export function useSpellService(): SpellService | null;
```

#### `dictionaries.ts` and `apps/web/public/app/spell/**`

The bundled catalogue and assets. Today the tree holds `en/index.aff.txt`, `en/index.dic.txt`, `en/LICENSE.txt` (SCOWL via `dictionary-en`, MIT AND BSD, 552 KB dic, 3 KB aff) and `ar/index.aff.txt`, `ar/index.dic.txt`, `ar/LICENSE.txt`, `ar/AUTHORS.txt`, `ar/README.txt` (Ayaspell 3.5 as packaged for OpenOffice by Ahmad Farghal, GPL 2.0 / LGPL 2.1 / MPL 1.1 tri-licence, 7.2 MB dic, 87 KB aff). `hunspell.wasm` is copied in by a script and not committed. `ar/supplement.dic.txt` (a repo-maintained accept-list) is P4. Sizes shown in Settings as on-the-wire estimates (en about 0.2 MB, ar about 1.5 MB).

```ts
export const BUNDLED_DICTIONARIES: DictionaryDescriptor[];
/** publicAssetUrl("app/spell/<lang>/...") */
export function dictionaryUrls(d: DictionaryDescriptor): { aff: string; dic: string; extras: string[] };
```

#### `personalDictionary.ts`

own_prefs adapter: per-word keys, tombstones, prefix scan of the `OwnPrefsStore` snapshot, subscribe with diffs, import and export one word per line with `!` and `#`, settings keys added to `OWN_PREF_KEYS`.

```ts
export const SPELL_PREF_KEYS = {
  enabled: "spell.enabled",
  languages: "spell.languages",
  lenientArabic: "spell.lenientArabic",
  flagAllCaps: "spell.flagAllCaps",
  highContrast: "spell.highContrast",
  wordPrefix: "spell.word.",
  noCorrectPrefix: "spell.nocorrect.",
} as const;

export class PersonalDictionary {
  constructor(store: OwnPrefsStore);
  has(w: string): boolean;
  words(): string[];
  forbidden(): string[];
  add(w: string): void;
  remove(w: string): void;
  importText(text: string, cap?: number): { added: number; skipped: number };
  exportText(): string;
  subscribe(cb: (diff: { added: string[]; removed: string[] }) => void): () => void;
}
```

#### `documentIgnores.ts` and `userDictionaries.ts` (the latter is P4)

Per-device state: the per-page ignore list in localStorage (`tasfer.spell.ignored.<pageId>`, cap 200) via the existing `useLocalStorage` hook; imported dictionary files through `FsDriver` under `spell/dicts/<id>/` with descriptors in `localStorage["tasfer.spell.dicts"]`. Validation: `.dic` first line is an integer count, `.aff` has `SET`; language and script inferred from `LANG` or the first 200 words, editable.

```ts
export function useDocumentIgnores(pageId: string): {
  ignored: ReadonlySet<string>;
  add(w: string): void;
  remove(w: string): void;
  clear(): void;
};

export class UserDictionaryStore { // P4
  constructor(fs: FsDriver);
  list(): DictionaryDescriptor[];
  importPair(aff: File, dic: File, meta: { label: string; lang: string; script: Script }): Promise<DictionaryDescriptor>;
  importList(txt: File, meta: { label: string; script: Script }): Promise<DictionaryDescriptor>;
  read(id: string): Promise<{ aff: Uint8Array; dic: Uint8Array }>;
  remove(id: string): Promise<void>;
  subscribe(cb: () => void): () => void;
}
```

#### `SpellcheckLayer.tsx`

Self-contained component mounted from `PageEditor` next to `SlashActionMenu` (`MountedEditor.tsx:3837`). Creates the `SpellChecker` for this editor, owns the `spell` layer colour (`--editor-spell-underline`, fallback `#e5484d`; high contrast means thickness 2), the desktop shortcuts (capture-phase window keydown, the same mechanism as the find shortcut at `MountedEditor.tsx:3294`), the `SuggestionPopover`, the polite live region, the mobile `SuggestionBar` on coarse pointers, suggestion prefetch when the caret enters a flagged word by a move, and the footer count. Exposes an imperative handle for the context-menu builder.

```ts
export interface SpellcheckLayerHandle {
  flagAtCaret(): FlagRef | null;
  suggest(f: FlagRef): Promise<string[]>;
  apply(f: FlagRef, text: string): void;
  addToDictionary(f: FlagRef): void;
  ignoreOnce(f: FlagRef): void;
  ignoreInDocument(f: FlagRef): void;
  fixOrNext(): void;
  next(): void;
  prev(): void;
  count(): number;
}
export const SpellcheckLayer: React.ForwardRefExoticComponent<
  { editor: Editor; doc: Doc; pageId: string; readonly: boolean; getContainerRect: () => DOMRect | undefined }
  & React.RefAttributes<SpellcheckLayerHandle>
>;
```

#### `spellContextMenuItems.tsx`

Builds the spelling group prepended to `getContextMenuItems` (`MountedEditor.tsx:3433`): up to 5 suggestions (`spell-suggest-0` to `spell-suggest-4`, `dir="auto"`), `spell-add`, `spell-ignore`, `spell-ignore-page`, disabled `spell-looking-up` / `spell-none`, separator. The web Radix menu renders immediately and fills in; native presenters (Electron, iOS, Android cannot update after presentation) await cached or prefetched suggestions for up to 150 ms, then present. Icons registered in `nativeContextMenu.ts` (`ICON_BY_ID` at 42, `MENU_ICON_COMPONENTS` at 64): SF `textformat.abc`, `text.book.closed`, `eye.slash`; lucide `SpellCheck`, `BookPlus`, `EyeOff`.

```ts
// ContextMenuItem from apps/web/src/editor/ContextMenu.tsx:12
export async function spellMenuItems(
  handle: SpellcheckLayerHandle,
  t: TFunction,
  opts: { awaitSuggestionsMs: number | null },
): Promise<ContextMenuItem[]>;
```

#### `SuggestionPopover.tsx`, `SuggestionBar.tsx`, `SpellingSheet.tsx` (the sheet is P5)

Popover (desktop and hardware keyboard): Radix Popover on a 1×1 anchor at `x = min(coordsAtPos(from).x, coordsAtPos(to).x)` (RTL-correct), `y = coords.y + height`, side bottom, align start (logical); `role="listbox"` with `aria-activedescendant`; focus stays on the hidden input (capture-phase keydown, `onOpenAutoFocus` prevented, mousedown `preventDefault`, the `ContextMenu` / `SlashActionMenu` pattern). Bar (touch): docked in the `MobileKeyboardToolbar` slot with 3 suggestions plus Add, Ignore and dismiss; shown when the caret enters a flagged word by a move, hidden when it leaves; light haptic on apply. Sheet (P5): bottom sheet on touch, side sheet on desktop; rows are the word in context plus chips; Change / Change all / Ignore / Ignore all / Add; "n of m"; the ignored-in-page list with Clear.

```ts
export function SuggestionPopover(p: {
  flag: FlagRef; suggestions: string[] | null; x: number; y: number;
  onApply(s: string): void; onAdd(): void; onIgnore(): void; onClose(): void;
  container?: HTMLElement | null;
}): JSX.Element;
export function SuggestionBar(p: {
  flag: FlagRef; suggestions: string[] | null;
  onApply(s: string): void; onAdd(): void; onIgnore(): void; onDismiss(): void;
}): JSX.Element | null;
export function SpellingSheet(p: {
  checker: SpellChecker; editor: Editor; open: boolean; onOpenChange(o: boolean): void;
}): JSX.Element;
```

#### `apps/web/src/app/pages/SettingsPage/PreferencesTab/SpellingSettings.tsx` (plus `PersonalDictionaryDialog.tsx`, `ImportDictionaryDialog.tsx`)

Settings › Preferences › "Spelling" using the existing `Section` (`AppearanceSettings.tsx:15`). Section 8.7 lists the controls.

#### `apps/web/vite.config.ts`, `apps/web/src/sw.ts`, `apps/web/tsconfig.json`, `apps/web/src/dev/SpellBench.tsx`

Aliases `@tasfer/spell` to `../../packages/spell/src`; `globIgnores: ["**/heic-to-*.js", "**/app/spell/**"]`; a `CacheFirst` route for `/app/spell/` (`spell-dictionaries`, `maxEntries: 12`, `purgeOnQuotaError: true`). `SpellBench.tsx` is the dev-only bench page for P0a (section 12).

#### `apps/ios/App/App/SpellPlugin.swift` (P7(a), optional)

Capacitor plugin `TasferSpell.suggest({ word, language })` over `UITextChecker.guesses`, exposed as optional `bridge.spell?.suggest`, merged after Hunspell's list. Android: none.

```ts
spell?: { suggest(req: { word: string; language: string }): Promise<string[]> }; // optional member on TasferBridge
```

---

## 5. Checker pipeline

### 5.1 Triggers

1. **`editor.on("change", tx)`.** Every op carries `blockId`, so the dirty set is exact; bump `version[blockId]`. Local ops (`!tx.isRemote`): the caret block is queued at priority `caret` after 120 ms, other dirty blocks at `local` after 250 ms; remote ops at `remote` after 300 ms (remote collaborators' typos are flagged too, the Docs behaviour). If a local insert ends with a boundary char (space, punctuation, newline) flush the caret block immediately. Record `lastLocalInputAt`.
2. **`editor.on("selectionchange")`.** If the caret left the word it was in (another block, or outside `[from, to]` of the previously excluded word), republish that block from cache. No worker round-trip: the flag was already computed and only hidden.
3. **Idle.** 500 ms after the last local input with the caret still inside a word, republish including the caret word, so the last word of a note gets flagged.
4. **Mount, doc swap, `restoreFromSnapshot`.** Full pass over all live textual blocks not in `skipBlockTypes`: the caret block first, then blocks whose `coordsAtPos({ block, offset: 0 }).y` lies within `[-h, viewport.height]`, then the rest, 20 blocks per message, priority `initial`, `setTimeout(0)` between chunks on the main side.
5. **`transport.onInvalidate`.** Dictionary loaded or unloaded, settings changed: clear the cache and rescan. "Add to dictionary" additionally calls `dropWord(word)` synchronously in every open editor so the squiggle disappears everywhere before the rescan lands. The worker re-queues blocks that had `deferredScripts` when a dictionary becomes ready.

### 5.2 Main thread (budget 0.5 ms per keystroke)

Per dirty block: `editor.query.block({ block: id })` gives `type` and `text` (skip when type is in `{code, math, table, image, line}`, not via `isTextualBlock`); `editor.query.marks({ from: { block, offset: 0 }, to: { block, offset: text.length } })` gives runs; runs whose name is in `skipMarks` `{code, link, math}` become `skip` spans. Post one `check` per debounce tick with all its blocks (text, skip, version). On a local text op in block B also drop, synchronously, any cached flag in B whose `[from, to]` intersects `caretOffset - 1 .. caretOffset` (instant squiggle removal while typing into a flagged word; covers "recieve" to "recieved" where every old char survives). Caret-word exclusion is a filter at publish time, so the worker always checks the whole block and nothing is re-sent when the caret leaves a word.

### 5.3 Worker

Queue keyed by `(docId, blockId)`; a newer request replaces an older one for the same block; highest priority first. Per block: `protectedSpans(text)` ∪ `skip`, then `tokenize` outside them, then `scriptOf` per token, then the engines of that script. A token is correct if any enabled engine of its script accepts `normalizeForLookup(token)` or a case variant, or it is in the user `Set`, the document `ignored` list, or the supplement accept-list; `!word` forbidden entries force a flag; if no engine of that script is loaded yet the block result carries `deferredScripts`, the token is not flagged (never a squiggle the engine cannot justify), and `loadDictionary` is kicked off. Lenient Arabic: on a miss, probe `arabicVariants()` (at most 16 `spell()` lookups, about 80 µs), never `suggest()` in the checking pass. Repeated letters: collapse 3+ to 2 and 1. Slice budget 8 ms of `performance.now()` then yield via `MessageChannel`; results posted per slice as one `checked` batch. Throughput of 1.3 to 4.6 µs per lookup on M-series means a 10k-word page is about 50 to 100 ms of worker time, 0.3 to 0.5 s on the target phone, spread over slices; the main thread never waits. A per-language LRU word-to-accepted cache (100k) sits in front of Hunspell.

### 5.4 Results to decorations

On `checked`: discard any result whose `version` differs from the current `version[blockId]` (a newer check is pending). Store flags. Anchor each flag with one pass over `block.charRuns` from `doc.getRawBlocks()` (sorted offsets, batched): `from = charAnchor(block, start)` (`{ blockId, afterCharId: id of the char at start - 1, or null at 0 }`), `to = charAnchor(block, end)` (id of the word's last char). Build:

```ts
{
  kind: "range",
  range,
  color,
  opacity: 1,
  style: { type: "underline", line: "wavy", thickness: highContrast ? 2 : 1 },
  a11y: { invalid: "spelling" }, // P3
}
```

Cap 200 flags per block, 2000 per document (drop the farthest from the caret in document order). Publish coalesced per animation frame, and at most about 4 frames per second during the `initial` pass because `setDecorations` (`editor.ts:620-630`, implementation at 6102-6129) repaints the whole visible viewport with no dirty rects. Flatten `Map<blockId, Decoration[]>` into one `editor.view.setDecorations("spell", all)`: one layer replaced wholesale. With the per-block index the paint cost is proportional to flags in painted blocks only.

### 5.5 Anchoring under concurrent edits

Endpoints are CRDT char ids resolved by the core at paint time. A local or remote insertion before the word shifts the squiggle with the text with no re-check; an insertion inside the word stretches it until the re-check within 300 ms; deleting the word's last char (or the char before its start) makes `resolveDecorationPoint` return null so the decoration vanishes instantly, which is exactly "remove the squiggle the instant the word is edited", and the re-check restores a correct flag if one remains. Stale results are additionally guarded by the version stamp. Decorations never enter the CRDT, ops, undo or `encodeState`.

### 5.6 Caret-word exclusion

At publish time (and on every `selectionchange`, coalesced per frame) drop flags whose `[from, to]` contains the collapsed caret offset (inclusive at `to`, so the word being extended stays unflagged) while `now - lastLocalInputAt < caretGraceMs` (500) and the caret entered the word by typing rather than by a move. A tap, click or arrow into a flagged word must show it, since that is how the mobile bar appears. After the grace period the flag shows even under the caret. IME: composition text never reaches the doc until commit and sits at the caret, so it is inside the excluded word by construction; no `isComposing` is needed, and the commit arrives as ops and is checked normally. Nothing is ever excluded for remote edits.

### 5.7 Suggestions

Never computed during checking.

- **Prefetch.** When `selectionchange` reports the caret inside or adjacent to a flagged word, post `suggest` after 100 ms and cache it (LRU 500 in the service, per word).
- **On demand** when a menu, popover or bar opens (cache miss means a `suggest` post). The web Radix menu and the popover open immediately with a disabled "Looking up…" row and fill in place (under 20 ms for English, under 100 ms for Arabic on desktop).
- **Native menus** (iOS `UIMenu`, Android `PopupMenu`, Electron `Menu.popup`) cannot update after presentation, so the `OPEN_CONTEXT_MENU` handler awaits the cached or pending suggestions with a 150 ms cap. English always makes it; Arabic usually does thanks to the prefetch (the long-press itself gives about 500 ms of lead); otherwise the menu shows Add and Ignore with a disabled "No suggestions".
- Hunspell has no timeout, so the worker skips auto-suggest for Arabic tokens over 14 letters (50 ms or more each) unless explicitly requested. Cap 5 in menus, 3 in the mobile bar; casing restored from the original token.

### 5.8 Apply

`REPLACE_WORD` (one undo group): minimal-diff insert of the changed middle; when the diff touches the first or last char, re-apply every mark that covered the whole word; the caret lands after the word; the block is re-queued at `caret`.

### 5.9 Budgets

Target phone: Snapdragon 4xx/6xx, 2 to 3 GB, WebView 87 or later. Old laptop: 2015 dual-core.

| Budget | Value |
| --- | --- |
| Main-thread spell work per keystroke | 0.5 ms or less |
| Worker slice | 8 ms or less |
| Boundary keystroke to squiggle | 300 ms or less (goal 150 ms; p50 about 60 ms on desktop) |
| English engine ready after first enable, on the phone | 150 ms or less, 25 MB or less (else the trie fallback is considered) |
| Arabic ready | 1.5 s or less, 55 MB or less of worker heap; loaded once per session on the first Arabic token; disposed after 10 idle minutes on touch devices |
| Suggest p95 on the phone | 50 ms or less for English, 400 ms or less for Arabic |
| Repaint with 500 visible flags, on the phone | 4 ms or less extra (index plus one stroke per rect) |
| Download | only when a language is first needed; nothing in the PWA precache |

`navigator.deviceMemory` is Chromium-only, so the Arabic disposal trigger is touch plus idle, not memory.

---

## 6. Engine and dictionaries

### 6.1 Engine

Hunspell 1.7.x compiled to WebAssembly for every language. P1 depends on `hunspell-wasm` 0.3.0 (812 KB wasm, 374 KB gz, plus 67 KB of ES-module glue; worker-capable; `testSpelling`, `getSpellingSuggestions`, `addWord`, `removeWord`, `addDictionaryFromString`, `dispose`).

**Licence.** `apps/web` is `AGPL-3.0-or-later` (`apps/web/package.json:3`). Hunspell, `hunspell-wasm` (`LGPL-2.0 OR GPL-2.0 OR MPL-1.1` per its `package.json`) and Ayaspell (GPL 2.0 / LGPL 2.1 / MPL 1.1) are all taken under their LGPL option. MPL 1.1 is the GPL-incompatible member of the tri-licence and must not be the one recorded. `packages/spell` stays MIT: it depends on the LGPL library and loads the binary at runtime; it does not vendor it. Licence texts ship next to the assets (`LICENSE.txt` in each dictionary folder; `COPYING.LESSER` from `hunspell-wasm` beside the wasm) and all of them go on the third-party licences page.

The wasm binary is copied by a script from `packages/spell/node_modules/hunspell-wasm/wasm/hunspell.wasm` to `apps/web/public/app/spell/hunspell.wasm` and is not committed. It is loaded by URL inside the worker; `@tasfer/spell` ships no binary.

### 6.2 Trie fallback (measured option, not a deliverable)

If P0a shows Hunspell English exceeding the phone budget (over 150 ms to ready or over 25 MB), add a `TrieEngine` over `cspell-trie-lib` 10.x (MIT; en_US trie 297 KB gz, 36 to 39 ms decode, 1 to 4 MB, suggest 1 to 9 ms with a timeout) behind the same `SpellEngine` interface for bundled Latin lists only; imported `.dic`/`.aff` still run on Hunspell. Accept the two-ranking cost only if the numbers force it. This is P6.

### 6.3 Dictionaries shipped

| Language | Source | Licence | Size on disk | On the wire | Path |
| --- | --- | --- | --- | --- | --- |
| `en` | SCOWL en_US via `dictionary-en` 4.x | MIT AND BSD | 552 KB dic, 3 KB aff | about 191 KB | `apps/web/public/app/spell/en/index.{aff,dic}.txt` |
| `ar` | Ayaspell 3.5 (LibreOffice/dictionaries; the OpenOffice packaging) | LGPL option of the tri-licence | 7.2 MB dic, 87 KB aff | about 1.52 MB | `apps/web/public/app/spell/ar/index.{aff,dic}.txt` |

Ayaspell facts: 465,928 entries; `IGNORE` strips tashkeel and tatweel; 221 `PFX` and 1609 `SFX` clitic rules; 81 `REP` and 17 `MAP` entries for hamza, ta-marbuta and ya. Quality: strict on initial hamza (flags انشاء, الى, اذا with the correct top-1 إنشاء, إلى, إذا), silently accepts ta-marbuta to ha (مدرسه) and some ya and alif-maqsura variants, rejects loanwords and brands (فيسبوك, تويتر, واتساب, إنستغرام, إيميل, انترنت) and some clitic stacks (فسيكتبونها). A repo-maintained `ar/supplement.dic.txt` accept-list (loaded as an extra dictionary into the same engine; seeded offline from CAMeL MSA frequency counts filtered by "rejected by Ayaspell and count above threshold", reviewed by an Arabic-speaking subagent) is P4.

More languages later means dropping a pair into the catalogue (fr is MPL/LGPL, es is tri-licensed; de is GPL-only, which is fine for the AGPL app but must be flagged). There is no npm Arabic package; the Ayaspell files were vendored by hand.

### 6.4 Load strategy

Enabled per person (`spell.languages`, default both `en` and `ar`; see the open questions) but loaded lazily by script: a language loads the first time a token of its script is checked, or on Settings › Download. English costs 22 to 39 ms; Arabic about 300 ms on desktop with a 1.5 s budget on the phone, off the main thread; while a dictionary is loading, tokens of that script are deferred, never flagged.

Bytes come from `publicAssetUrl("app/spell/<lang>/...")`, the exact path `i18next-http-backend` already uses for locales (`apps/web/src/i18n.ts:31`), so the Electron `file://` case follows a mechanism already proven for locales. The worker fetches them itself where it can (the service worker's `CacheFirst` route intercepts worker fetches); otherwise the main thread fetches and transfers a `bytes` source (zero-copy). Capacitor serves the bundle over `https://tasfer.app`, so `fetch` works there too. Transferred, never JSON-cloned. On touch devices the Arabic engine is disposed after 10 idle minutes and reloaded on demand from cache.

### 6.5 Caching

Web: a Workbox `CacheFirst` route for `/app/spell/` (`spell-dictionaries`, `ExpirationPlugin({ maxEntries: 12, purgeOnQuotaError: true })`), excluded from the install precache via `globIgnores` (the heic-to pattern at `vite.config.ts:136` and `sw.ts:95-103`); the 4 MiB single-file precache cap is irrelevant for runtime-cached assets. `hunspell.wasm` is runtime-cached the same way, not precached: readers who never type should not download it. Settings reads `caches.match()` for Downloaded / Download / Remove from this device (`cache.delete`). Electron and Capacitor: bundled, always "Downloaded" (about 8 MB uncompressed in the package for en plus ar; APK and IPA compress at rest). The compiled `WebAssembly.Module` is cached in-worker for the session.

Files ship uncompressed with a `.txt` suffix so they are served as `text/plain`, which every CDN compresses on the wire. There is no inflate code on the device and no iOS 15 `DecompressionStream` special case.

### 6.6 Arabic specifics

Lookup key: NFC, strip bidi controls, ZWNJ/ZWJ and soft hyphen, strip tatweel, strip tashkeel, fold presentation forms. The range keeps the original characters so the squiggle covers the vocalised word. Never fold hamza (أإآ to ا), ta-marbuta to ha or alif-maqsura to ya before lookup: those are 30%, 5% and 3% of real Arabic errors (QALB corpus; merges 5%, splits 3%, punctuation about 40%), and Ayaspell's `REP` and `MAP` rules already return the right form as top-1. "Lenient Arabic spelling" (Settings, default off): accept a token if any of its at most 16 orthographic variants is accepted, using cheap `spell()` probes, no `suggest()`. Suggestions are Hunspell-ordered, at most 5, 40 to 80 ms on desktop, on demand plus prefetch only; auto-suggest is skipped above 14 letters. The tokenizer keeps tashkeel, tatweel and ZWNJ inside words (cspell's regex would split مُحَمَّد); Arabic-Indic digits, tatweel-only tokens and Arabic plus Latin mixed tokens (الـWiFi) are skipped. There is no proper-noun heuristic (no capitalisation signal); the synced personal dictionary is the mechanism. Known Ayaspell gaps are documented above; the supplement list and one-click Add cover them. Squiggles per (line × bidi run) rect come from the core geometry, so mixed Arabic/Latin lines are correct without logical-to-visual math in the package (never compute x from logical offsets; Firefox bug 349352). Suggestion rows render with `dir="auto"`; the dictionary editor sorts per script with `Intl.Collator`.

### 6.7 Memory diet (P6, measurement-gated)

If the phone misses 1.5 s or 55 MB for Arabic: a build script that keeps only the Ayaspell stems needed to cover the CAMeL or OpenSubtitles top-N surface forms (target 1.5 MB dic or less, 15 MB heap or less). Trimming stems against 221 `PFX` and 1609 `SFX` rules while preserving coverage is research-grade work, not a script, so it is optional and last.

### 6.8 User-supplied dictionaries (P4)

1. **Hunspell pair.** The user picks `.aff` plus `.dic` (`<input type="file" multiple>`; validate the count header and `SET`; the adapter transcodes non-UTF-8 charsets); stored via `FsDriver` under `spell/dicts/<id>/`; language and script inferred from `LANG` or the first 200 words, editable; loaded as an additional engine of that script (union rule).
2. **Word list `.txt`.** One word per line, `#` comments, cspell prefixes (`!word` forbidden means always flagged; `~` case-insensitive; `+` and `*` ignored), converted by `wordListToDic()` and loaded as an extra dictionary into every engine of its script; or, if the user chooses "add to my personal dictionary" and the list has 5k words or fewer, merged into own_prefs.
3. `.oxt` and `.xpi` zips are out of scope (users extract the two files; add an fflate-based unzip only if asked).

Personal words are replayed with `add()` into every engine of the matching script after each load and on every change (50k words is about 50 ms).

---

## 7. UX spec

### 7.1 Flagging (all platforms)

Red wavy underline (`--editor-spell-underline`, fallback `#e5484d`; 1 CSS px thick, 1 px amplitude, 4 px period; the "High-contrast underline" setting makes it 2 px thick and 1.5 px in amplitude), drawn just below the link underline so a misspelled link shows both. Future grammar would be blue dotted and an autocorrect cue grey dashed (the pattern differs, WCAG 1.4.1). The word containing the caret is never flagged while typing; it appears within about 150 to 300 ms after the space, punctuation or arrow that leaves it, or after 500 ms idle, and disappears the instant the word is edited again (anchor deletion plus instant local removal).

Not flagged: code, math, table, image and line blocks; code, link and math runs; URLs, emails, `@`, `#` and paths; numbers; single letters; mixed-script tokens; ALL-CAPS Latin (setting, default skip); personal-dictionary words; words ignored on this page; tokens of a script whose dictionary is still loading. Remote collaborators' typos are flagged.

Tables are a documented v1 gap: cell text is structured content, and `packages/table` does not implement `contentSelectionRects` (only `MathMark.ts:211` does). P5 can close it.

### 7.2 Desktop pointer

Right-click or Ctrl-click a red word with no selection held: the engine moves the caret there and dispatches `OPEN_CONTEXT_MENU`; the host context menu gains, on top: up to 5 suggestions (`dir="auto"`), "Add to dictionary", "Ignore", "Ignore all on this page", a separator, then Select All, Copy, Cut, Paste and Format as today. The web Radix menu opens at once with a disabled "Looking up…" row that swaps in when suggestions land; Electron presents natively after a wait of at most 150 ms (usually already prefetched). With a ranged selection held: P1 shows spelling items only if the selection is exactly one flagged word (a double-click selection); P2 resolves the pointer word from `OPEN_CONTEXT_MENU.point`. Choosing a suggestion dispatches `REPLACE_WORD` (one undo step, marks preserved, caret after the word). No hover tooltip in v1 (unbidden popovers are the anti-pattern; a resting-pointer hint "Misspelled: press ⌘. for suggestions" is a P5 option needing `posAtCoords`).

### 7.3 Desktop keyboard (final shortcuts)

All bindings are matched on `event.code` so Arabic layouts work.

| Chord | Action |
| --- | --- |
| Cmd/Ctrl+. (`Period`) | **Fix-or-next.** With the caret in or right after a flagged word: open the `SuggestionPopover` under the word. Otherwise: jump to the next flagged word (wrapping), select it, scroll it into view (`view.scrollToPosition`) and open the popover. So ". Enter . Enter" cleans a page. |
| Shift+Cmd/Ctrl+. | Previous flagged word, same behaviour. |
| Inside the popover: Up/Down | Move (wrap). |
| Enter or Tab | Apply the active suggestion. |
| 1 to 5 | Apply the nth suggestion. |
| A | Add to dictionary. |
| I | Ignore. |
| Esc | Close. |
| Any other key | Closes and passes through to the editor (a fast typist is never trapped). |
| Cmd/Ctrl+Enter, Shift+F10, Menu key | Already open the context menu at the caret (core, `keysEvents.ts:150-156`, `357-362`) with the spelling group on top. |
| F7 | Spelling sheet (P5), only if Firefox's caret-browsing prompt proves suppressible; the footer count and Action Center entry are the guaranteed path. |

Popover keys (Tab, Enter, arrows, digits) are swallowed only while the popover is open, via a capture-phase document listener (the `ContextMenu.tsx` pattern), so the core's Tab indent and `CLEAR_SELECTION` never fire underneath. Mnemonics are shown as trailing hints. The chord is the one VS Code users already reach for (quick fix), and it sits unshifted on every layout.

**The sidebar move.** Cmd/Ctrl+. was the sidebar toggle (`apps/web/src/app/layout/Layout.tsx:168` at the time the synthesis was verified; `Layout.tsx:182` at HEAD `62594fdd`), matched on `code === "Period"` from anywhere including mid-sentence. That binding has already been moved to Cmd/Ctrl+; (`code === "Semicolon"`) in `Layout.tsx`, and the tooltips in `SidebarContent.tsx` (three `ShortcutTooltip commandKey` sites) and `TopActionBar.tsx` now show `;`; the doc comment in `ShortcutTooltip.tsx` was updated to match. Semicolon also sits unshifted on every layout and is bound by neither the engine nor the browser. One thing to test by hand: Safari binds ⌘; to Edit › Spelling › Check Document Now, and `preventDefault` on keydown is expected to win because it is not a reserved chord, but that now concerns the sidebar toggle and should be checked on a Mac.

Collision check (verified at `ab72b7cc`): the core `keysEvents.ts` binds no `Period`, `Semicolon`, `Quote` or `F7` chord (section 3.9 lists its Cmd set). `apps/web` binds Cmd/Ctrl+F (find, `MountedEditor.tsx:3294`), Cmd/Ctrl+K (`ActionCenter.tsx:466`), Cmd/Ctrl+Enter inside a few inputs, and now Cmd/Ctrl+; for the sidebar. Electron's menus use role menus only. Cmd/Ctrl+Shift+X is strikethrough (`keysEvents.ts:374-390`) and was rejected as a "context menu" chord for that reason.

### 7.4 Mobile (Capacitor iOS and Android, coarse pointer)

Squiggles identical. The OS keyboard keeps autocorrect and prediction (`nativeAutocomplete` stays true on touch); Tasfer adds no autocorrect or completion. Tap a red word: the caret lands in it (existing tap), the controller sees the caret enter a flagged word by a move (not typing), and the `SuggestionBar` docks in the `MobileKeyboardToolbar` slot: `[s1] [s2] [s3] [Add] [Ignore] [×]`. A chip applies with a light haptic and the bar hides; it also hides when the caret leaves the word. Long-press: the existing native menu (`toNativeMenu` via `nativeContextMenu.ts`) with the same `spell-*` items on top (prefetched suggestions; at most a 150 ms wait). The toolbar "Spelling" button (P5) opens the bottom-sheet walk-through. An iPad with a hardware keyboard gets the desktop shortcuts and popover (`shouldOpenKeyboardMenu`).

### 7.5 RTL and Arabic

Squiggles per bidi run from the core geometry; the popover is anchored at the visual start (min x of the word's start and end) with logical alignment; suggestion rows use `dir="auto"` so Arabic suggestions render RTL inside an English UI; the personal dictionary editor mixes scripts and sorts per script; announcements carry a `lang` attribute per word.

### 7.6 Settings

Settings › Preferences › "Spelling" `Section` (search keywords: spelling, spellcheck, dictionary, typo).

- "Check spelling as you type" (default on, synced).
- "Languages": English (about 0.2 MB) and Arabic (about 1.5 MB) checkboxes with state text: Downloads when first needed / Downloading… / Downloaded / Couldn't download, Retry / Remove from this device.
- "Lenient Arabic spelling: accept common hamza, ة/ه and ى/ي variants" (off).
- "Flag words in ALL CAPS" (off).
- "High-contrast underline" (off).
- "Personal dictionary: {{count}} words, synced to your devices" with Manage, opening a dialog with search, an add field (Enter), per-row remove, Import (`.txt` or `.dic`), Export (`.txt`).
- "Additional dictionaries (this device)" with Remove and "Add a dictionary… (.dic and .aff pair, or a .txt word list)" (P4).
- Page-level "Ignored words" with Clear live in the popover footer, the Spelling sheet and PageSettings.

The download and failure states, Retry, and Remove from this device are P4; P1 to P3 show the language checkboxes with a plain Downloaded / Downloads when first needed state.

### 7.7 Footer and sheet (P2, P5)

The word-count footer (`WordCountOverlay`) gains a clickable "Spelling: {{count}}" so leftovers are noticed; clicking runs fix-or-next on desktop and opens the sheet on touch. `SpellingSheet` (P5): bottom sheet on touch, side sheet on desktop; rows are the word in a sentence excerpt with suggestion chips; Change / Change all / Ignore / Ignore all / Add; header "{{current}} of {{total}}"; footer "Ignored on this page ({{count}}), Clear"; "Nothing to fix here." when empty.

### 7.8 Accessibility

P2, host: a polite `role="status"` live region announces on next and previous and on popover open ("{{word}}: misspelled, {{count}} suggestions", plural keys, `lang` on the word span), the active suggestion as it changes, "Changed to {{word}}", "Added {{word}} to your dictionary", "No spelling errors found". The popover is `role="listbox"` with `role="option"` and `aria-selected`, and `aria-activedescendant` is mirrored on the hidden input's `aria-controls`. All menu items have visible labels; colours come from theme CSS variables.

P3, core: `RangeDecoration.a11y = { invalid: "spelling" }` makes the DOM mirror wrap ranges in `<span aria-invalid="spelling">` so NVDA says "spelling error" and VoiceOver and Narrator say "misspelled" while reading. Pattern-distinct underlines per category and the high-contrast toggle cover low vision. The Spelling sheet is the reliable screen-reader path on mobile. A manual VoiceOver plus NVDA pass happens in P3.

### 7.9 Desktop autocorrect (P7(b), optional, default off)

Boundary-triggered, only when Hunspell returns exactly one edit-distance-1 candidate or one adjacent transposition, not in the do-not-correct list, block version unchanged; a host `change()` in its own undo group; a grey dashed cue on a `spell:autocorrect` layer for 5 s; Backspace right after reverts and adds `spell.nocorrect.<from>`; right-click offers "Change back to …" and "Stop correcting …"; never in code, math or links, never on mobile. Expressible as an `after-insert` `FeatureInputRule` or a host `change()` on the boundary keystroke (section 3.9 lists the early exits that skip the rule phase).

### 7.10 Word completion (P7(c), optional, explicit product decision)

"Complete long words": opt-in, default off, desktop web plus Electron plus hardware-keyboard iPad only, hidden in code, math and links and while any menu is open. Source: a prefix trie over the current space's own vocabulary (words of 6 letters or more seen twice or more, refreshed from `on("change")`, ranked first) plus a bundled top-50k frequency list (200 to 350 KB; Leipzig CC BY 4.0 preferred over hermitdave's CC-BY-SA to avoid share-alike on the derived blob); Arabic keyed on the normalised stem with proclitics stripped, display form preserved, only after the Arabic accept-list has matured. Gate: 3 or more typed letters, the completion adds 3 or more chars, the top candidate is at least twice the runner-up. Rendering: one grey ghost word as a DOM overlay in the portal container anchored at `view.coordsAtPos("caret")` (decorations cannot add glyphs, and a short single-word ghost needs no layout participation, so zero core change); Tab or the right arrow accepts via a capture-phase window keydown active only while the ghost is visible (Tab is otherwise consumed at `keysEvents.ts:393-482`); Esc or any other key dismisses. Budget under 1 ms per keystroke on the main thread, 5 MB or less. Never a silent replacement, never on the soft keyboard, never next-word prediction on desktop. A pruned bigram table (1 to 3 MB) for touch-only next-word is explicitly not planned.

---

## 8. Storage

### 8.1 Synced (follows the person)

The own_prefs LWW register via `OwnPrefsStore` (`apps/web/src/app/contexts/OwnPrefsContext.tsx`). Verified properties:

- Replicates to the person's own devices only, never to a co-member (`apps/web/src/platform/types.ts:737-772`; `sync.ts:1369-1373` `pushOwnState` filters by `getOwnDeviceKeys`; `sync.ts:2064-2070` drops own-state from a non-own device; tests at `sync.own-device.test.ts:356-399`).
- Whole-value LWW per key, ordered by `(stamp, by)` (`engine.ts:119-125` `decisionWins`; table at `engine.ts:299-304`; `applyOwnPrefs` at `engine.ts:2077-2090` replaces the whole JSON string; doc at `sync.ts:293-296`).
- Unknown keys are stored, not dropped (`engine.ts:2061-2067`), values are opaque JSON (`engine.ts:1965-1968`), unparseable values are skipped but kept (`engine.ts:1977-1981`), and adding keys is not a `PROTOCOL_VERSION` bump (`sync.ts:316-324`). The device-link bootstrap also carries prefs (`engine.ts:2508`, `2662`).

Personal dictionary: **one key per word**, `spell.word.<NFC word>` = `{ added: <ms> }`; removal writes `null` (a tombstone; a later removal outranks an earlier add by stamp; concurrent adds on two devices both survive, whereas a single `string[]` register would drop one of them). Word key normalisation: NFC, bidi, ZWNJ and ZWJ stripped, tashkeel and tatweel stripped for Arabic, Latin case kept (lowercase entries match case-insensitively, capitalised ones exactly, as Hunspell does); one global list applied to every language of the word's script (script routing makes clashes impossible). Read path: `getAll()` snapshot plus a prefix scan of `spell.word.` (hundreds to low thousands of rows; measure at 5k in P2). Change path: `subscribe` diff, then `SpellService.setUserWords`, then every open editor runs `dropWord` and a rescan. Import merges (never wipes) and is capped at about 5k words; larger lists are routed to per-device "Additional dictionaries" to keep the register and own-state sync small.

Settings as single keys added to `OWN_PREF_KEYS` with doc comments: `spell.enabled` (boolean, default true), `spell.languages` (string[] of dictionary ids; whole-value LWW is right for a deliberate setting), `spell.lenientArabic`, `spell.flagAllCaps`, `spell.highContrast`. Later, only if autocorrect ships: `spell.autocorrect`, `spell.nocorrect.<from>` = `<to>`.

### 8.2 Per device

- Per-page ignore list: `localStorage["tasfer.spell.ignored.<pageId>"]` = string[] (cap 200; `useLocalStorage` hook; shown with Clear in the sheet and popover footer and in PageSettings). Survives reload, no register growth, no LWW loss; promotable to per-word own_prefs keys `spell.ignore.<pageId>.<word>` later if sync is wanted.
- "Ignore once": an in-memory `Set` keyed by `blockId + afterCharId` per `SpellChecker`, cleared when the word changes.
- Imported dictionaries (P4): bytes through the platform `FsDriver` under `spell/dicts/<id>/{index.aff,index.dic|words.txt,meta.json}`; descriptors `{ id, label, lang, script, kind, bytes, importedAt }` in `localStorage["tasfer.spell.dicts"]`; labelled "(this device)" in Settings.
- Download state: presence in Cache Storage `spell-dictionaries` on the web (mirrored in React state); always "Downloaded" in native shells.
- Completion vocabulary (if ever): IndexedDB, clearable.

### 8.3 Dictionary and engine bytes

Bundled under `apps/web/public/app/spell/` as `hunspell.wasm` (script-copied, not committed), `en/index.aff.txt`, `en/index.dic.txt`, `en/LICENSE.txt`, `ar/index.aff.txt`, `ar/index.dic.txt`, `ar/LICENSE.txt` (plus `ar/AUTHORS.txt` and `ar/README.txt` from the upstream packaging), later `ar/supplement.dic.txt`. Resolved with `publicAssetUrl()`, excluded from the Workbox precache via `injectManifest.globIgnores: ["**/heic-to-*.js", "**/app/spell/**"]` (`vite.config.ts:136`), and cached at first use by:

```ts
registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.includes("/app/spell/"),
  new CacheFirst({
    cacheName: "spell-dictionaries",
    plugins: [new ExpirationPlugin({ maxEntries: 12, purgeOnQuotaError: true })],
  }),
);
```

next to the heic route at `sw.ts:95-103`. Electron and Capacitor read them from the bundled tree (about 8 MB uncompressed); no service worker is involved. If P0a shows the Electron worker cannot fetch `file://` URLs, the main thread reads the bytes via the same `publicAssetUrl` fetch the locales use (or an `fs:read` of the resources path) and transfers them as a `bytes` source.

### 8.4 own_prefs caveats (verified)

These do not change the decision but must be known before the personal dictionary grows:

1. There is no delete primitive: `prefs.set(key, null)` stores the JSON string `null` (`engine.ts:1987`) and the row lives forever. `OwnPrefsStore.get` maps null to the fallback (`OwnPrefsContext.tsx:117-120`). Removing a word is a tombstone row.
2. Every own-device handshake ships every row with `stamp > 0` in full (`engine.ts:2051`; `sync.ts:1811-1822`, "no version vector covers it"), so the hello payload grows with dictionary size including tombstones. This is why bulk import is capped at about 5k and larger lists go per device.
3. Ordering is wall-clock `Date.now()` per device (`engine.ts:1986`); a device with a skewed clock can win or lose a per-key conflict regardless of real order.
4. Older builds that predate `prefs` simply do not receive the field (`sync.ts:2073-2075`).

### 8.5 Formats

Personal dictionary export: UTF-8, LF, one word per line, sorted with `Intl.Collator` per script (the Hunspell personal, cspell, Firefox persdict and macOS LocalDictionary convention). Import: `.txt` (same; `#` comments; `!word` forbidden; `~`, `+` and `*` cspell prefixes honoured or ignored) or a Hunspell `.dic` (numeric first line skipped, `/FLAGS` stripped); NFC; de-duplicated; tokens with whitespace rejected. Full dictionaries: an `.aff` plus `.dic` pair.

### 8.6 Never stored

Nothing spelling-related enters the Doc CRDT, ops, undo, `encodeState()` or a SQLite schema; decorations are the only runtime representation; `compatibility.mdx` is untouched. CLI: nothing under `apps/web/src/spell/` or `@tasfer/spell` is imported by `platform/engine.ts` or `lib/spaceExport.ts` (guarded by a vitest import-graph test); unknown `spell.*` prefs replicate as opaque JSON as they do today.

---

## 9. Rollout

| Phase | Scope | Effort | After | Status |
| --- | --- | --- | --- | --- |
| P0a | Measurement and platform spike, no user-visible change. `apps/web/src/dev/SpellBench.tsx` plus a throwaway worker: load `hunspell-wasm` 0.3.0 with SCOWL en and Ayaspell ar; record fetch, compile and parse ms, heap, check throughput, suggest p50 and p95, `Intl.Segmenter` in the worker, repaint cost at 0/500/2000 flags, keystroke-to-squiggle on a real 2 to 3 GB Android WebView, an old laptop, an iPhone and M-series; verify the Electron `file://` renderer can construct the module Worker and fetch bundle assets from inside it (fallbacks: `?worker&inline`, main-thread fetch plus transfer); write `dev-docs/spellcheck-measurements.md` with go/no-go against the budgets (decides Hunspell-only versus the trie fallback for English, Arabic eager versus lazy, the Electron worker form). Licence notes for the LGPL option. | 2 d | none | in progress (2026-09-01) |
| P0b | Core: `RangeDecoration.style` union, `DecorationRect.baseline`, exported `paintDecorationRects` used by all four painters; internal `decorationsForBlock` index used by `TextNode.paint`; `query.marks(DocPoint | DocRange)`; tests (`decorations.test.ts` styles, a `TextNode` paint test asserting one stroke per rect on a wrapped RTL line, index correctness including multi-block ranges, a 2000-decoration paint benchmark before and after); docs (`api-editor.mdx` Decorations table, marks row, `focus()` drift fix, `query.content` row; `custom-nodes.mdx:77`; `collaboration.mdx` presence link). Independently useful. | 3 d | none | in progress (2026-09-01) |
| P1 | `packages/spell` (tokenizer, script rules, protocol, engine contract, Hunspell adapter, worker host, `SpellChecker` with dirty set, versions, char anchors, caret filter, instant removal and prefetch, `REPLACE_WORD` with mark re-application; tests: Arabic and English tokenizer tables, anchoring under interleaved local and remote ops, fake-worker controller, bold and link replacement, boundary test for the CLI). `apps/web`: `spell.worker.ts`, `SpellProvider` and `SpellService`, bundled en and ar assets with licences, the SW `CacheFirst` route, `globIgnores` and aliases, `PersonalDictionary` on own_prefs, per-page ignores in localStorage, `SpellcheckLayer` mounted in `PageEditor`, the spelling group in `getContextMenuItems` for the web menu and the three native presenters (150 ms wait, icon registrations), Settings › Spelling with enable, languages and the personal-dictionary count, `nativeAutocomplete: isTouchDevice()` at mount, en and ar strings, the package README. Manual verification on Chrome, Safari, Firefox, Electron (macOS and Windows), iOS and Android. | 12 d | P0a, P0b | in progress (2026-09-01) |
| P2 | Keyboard and pointer flow, mobile bar, footer count. `SuggestionPopover` with Cmd/Ctrl+. fix-or-next, Shift+Cmd/Ctrl+. previous, Up/Down/Enter/Tab/Esc, digits 1 to 5, A and I mnemonics, pass-through typing, focus retention; select, scroll and auto-open on navigation; core `OPEN_CONTEXT_MENU.point` plus its `api-editor` row; mobile `SuggestionBar` in the keyboard-toolbar slot on caret-enter-by-move with haptics; polite live-region announcements; clickable "Spelling: n" in `WordCountOverlay`; Action Center "Spelling" command; `PersonalDictionaryDialog` (search, add, remove, import `.txt` and `.dic`, export `.txt`); Lenient Arabic, ALL-CAPS and high-contrast settings wired; the Safari ⌘; sidebar check by hand; own_prefs `getAll` measured at 5k words. | 5 d | P1 | in progress (2026-09-01) |
| P3 | Accessibility projection. Core: `RangeDecoration.a11y` honoured by `DomMirror` (`getDecorations` option, `applyDecorations` coalesced into the rAF flush, TreeWalker range wrapping with the alignment guard), DOM-free unit tests for the offset-to-text-node planner, the docs row. Host: sets `a11y: { invalid: "spelling" }`, listbox semantics finalised, VoiceOver plus NVDA manual pass on canvas reading, the popover and the bar. | 2.5 d | P0b (P2 for popover semantics) | in progress (2026-09-01) |
| P4 | Dictionary management and Arabic hardening. Import Hunspell `.dic` plus `.aff` pairs and `.txt` word lists as additional dictionaries via `FsDriver` (validation, language inference, list and remove in Settings, `bytes` source to the worker); "Remove from this device"; import cap routing (over 5k goes to an additional dictionary); the `ar/supplement.dic.txt` curation pass with an Arabic-speaking subagent; download and failure states with Retry; touch-device idle disposal of the Arabic engine; long-token suggest-skip tuning; per-page ignored-words UI with Clear in PageSettings. | 4.5 d | P1 | later |
| P5 | Spelling sheet and pane, hover hint, table gap. `SpellingSheet` (bottom sheet on touch via `components/ui/bottom-sheet`, side sheet on desktop) with Change / Change all / Ignore / Ignore all / Add and "n of m", opened from the footer count, the mobile toolbar "Spelling" button, Action Center and F7 (after the Firefox caret-browsing check); optional core `view.posAtCoords` plus a 600 ms resting-pointer hint; optional `contentSelectionRects` in `packages/table` plus structured-cell text extraction so table cells get squiggles (about 1.5 d of the total). | 4 d | P2 | later |
| P6 | Low-end hardening, measurement-gated. Only if P0a or P1 numbers miss the phone budget: `TrieEngine` (cspell-trie-lib) for bundled English behind `SpellEngine`; a frequency-trimmed Ayaspell build script; memoised anchor resolution; flag-cap and idle-dispose tuning; repaint-storm guard verification; re-run the measurement plan and update the dev-docs. Also the owned emcc Hunspell build if the npm wrapper has stagnated. | 3 d | P1 | later |
| P7 | Optional extras, each independently shippable: (a) the iOS `UITextChecker.guesses` Capacitor plugin as a suggestion enricher (2 d, after P2); (b) desktop autocorrect, default off, single-candidate rule, grey dashed cue, Backspace revert plus `spell.nocorrect.*` (3 d, after P2); (c) "Complete long words" opt-in ghost completion, desktop and hardware keyboard only (4 d, after P2); (d) a site docs page for `@tasfer/spell` once the protocol has settled (0.5 d, after P4). | 9.5 d | P2 (a, b, c); P4 (d) | later |

The committed path P0a to P4 is about 29 maintainer-days in independently shippable phases. P1 at 12 days is the honest number, not 7 to 9. Each phase ships alone and P1 already delivers most of the value.

---

## 10. Risks

- **Licensing.** `apps/web` is AGPL-3.0-or-later, so Hunspell, `hunspell-wasm` and Ayaspell must be recorded under their LGPL (or GPL) option, not the MPL 1.1 option all three proposals picked; `packages/spell` stays MIT by depending on the library rather than vendoring it. Licence texts and the third-party page must land with P1. Frequency lists for any later completion should be CC BY (Leipzig), not CC-BY-SA.
- **Electron worker construction.** The renderer is a `file://` page (`win.loadFile`, `apps/desktop/src/main/index.ts:352-353`) with no dedicated-Worker precedent in `apps/web` (only the platform SharedWorker); module-worker construction and in-worker fetch from `file://` are unverified. This is a hypothesis, not a confirmed bug. Locales already load via `publicAssetUrl` plus fetch in Electron, so main-thread asset fetch is proven; P0a decides between a normal module worker, Vite `?worker&inline`, and main-thread fetch plus transferred `bytes`. If none works, a custom `app://` protocol via `protocol.handle` is the last resort (about a day).
- **Wrapper stagnation.** `hunspell-wasm` is a one-author package with an unstated Hunspell version; mitigated by pinning, the `SpellEngineFactory` seam and a documented owned emcc build (P6). The adapter is the only file that changes.
- **Arabic memory and load time.** The Arabic dictionary costs +46 to 48 MB and about 300 ms on M-series, so likely 1 to 1.5 s and possible memory pressure on 2 GB Android WebViews; all engine numbers so far are Node on Apple Silicon. Mitigated by lazy load on the first Arabic token, deferred (never false) flags while loading, idle disposal on touch devices, and the P0a spike on a real phone gating the P6 diet. `navigator.deviceMemory` is Chromium-only, so WebKit never sees a memory guard; the trigger is touch plus idle.
- **Ayaspell false positives.** A 2012 lexicon rejects common loanwords and brands and some clitic stacks, and silently accepts ta-marbuta to ha; false positives erode trust fastest. Mitigated by the bundled supplement accept-list (needs ongoing curation, P4), the lenient toggle, one-click synced Add, and measuring the flag rate on real Arabic notes before Arabic is default-on.
- **Mark loss on replacement.** `replaceInlineRangeAction` deletes then inserts and applies at most one explicit mark (section 3.9), so a fix touching the first or last char of a bold or linked word can drop the format. Minimal-diff replacement plus full-cover mark re-application in `REPLACE_WORD` handles it; the bold-word, link-word and RTL tests in P1 are mandatory, and a `ChangeApi.replaceText(range, text, { inheritMarks })` core addition is the fallback if re-application proves fragile.
- **Full-viewport repaint on every `setDecorations`.** Even with the per-block index, publishing during the initial pass must be throttled (about 4 frames per second) and per-frame coalesced; measure with 2000 flags in P0b and P1. Without the index the feature is a per-keystroke performance regression on slow devices: do not ship P1 without P0b.
- **Native menus cannot update after presentation.** Arabic suggest can exceed the 150 ms wait on a slow phone even with prefetch, yielding a long-press menu without suggestions (Add and Ignore still present). Acceptable degradation; the mobile bar and web popover fill asynchronously.
- **own_prefs growth.** Per-word keys are fine at thousands of rows (one DB write plus one replication push per `set`), but tombstones never leave, every handshake ships every row, and a bulk import must be capped (about 5k) and routed to per-device dictionaries above that; measure `getAll` at 5k in P2.
- **Table cells receive no squiggles** until `packages/table` implements `contentSelectionRects` and the checker walks structured cell text (P5, optional); users of table-heavy notes may read this as "spellcheck is broken in tables".
- **Two correction sources on phones.** OS autocorrect rewrites words through the hidden surface while Tasfer flags others; no functional conflict in v1 (Tasfer never autocorrects) but users may attribute OS swaps to Tasfer. Explain it in the Settings description.
- **Cosmetic IME shift.** While an IME composition is open, decorations after the caret in the same block paint shifted by the composition length (pre-existing for find highlights and remote selections); the caret filter hides the common case; the optional internal core fix is section 3.7.
- **Arabic UI is disabled** (`supportedLngs: ["en"]`, `apps/web/src/i18n.ts:29`), so the ar strings ship untested in the live UI; they are still required by AGENTS.md and must go through the Arabic-speaking subagent with the glossary.
- **Canvas is opaque to DOM automation.** Squiggle geometry (RTL, wrapped, mixed lines) can only be verified visually or via a canvas pixel-sampling harness; plan manual passes per platform and agree the recipe with Hamza before P1 is called done.
- **Schedule.** About 29 days committed (P0a to P4) plus 4 for P5 for one maintainer across a new package, a worker, four platforms of menus and a settings surface.
- **Shortcut habit.** Cmd/Ctrl+. was the sidebar toggle in production; people who learned it need to find Cmd/Ctrl+; (the tooltips now say so). The move is done, so the risk is only the habit.

---

## 11. Measurement plan (P0a)

Run `apps/web/src/dev/SpellBench.tsx` on a real 2 to 3 GB Android via `chrome://inspect`, an old laptop, an iPhone via Web Inspector, an M-series baseline, and the Electron build. Record everything in `dev-docs/spellcheck-measurements.md`.

1. Fetch, compile and parse ms per dictionary (en, ar) and for `hunspell.wasm`.
2. Heap via `performance.measureUserAgentSpecificMemory()` where available, else DevTools before and after load and after `dispose()`.
3. Words per second over a 10k-word bilingual fixture and the slice histogram.
4. Suggest p50, p95 and max for 30 short and 30 long misspellings per language.
5. Long tasks (`PerformanceObserver` `longtask`) during 60 s of scripted typing with 0, 500 and 2000 flags.
6. `setDecorations` to next-frame time at 0, 100, 500 and 2000 flags with and without the per-block index.
7. Keystroke to squiggle via `performance.mark`.
8. `Intl.Segmenter` availability and cost inside the Android WebView worker.
9. Electron: does `new Worker(new URL(...), { type: "module" })` construct from the `file://` renderer, and does `fetch(publicAssetUrl(...))` work inside that worker. Fallbacks: Vite `?worker&inline` (Blob URL) and fetching bytes on the main thread via the path locales use, transferring them as a `bytes` source.
10. Confirm the `.txt` assets are served compressed by Vercel (`curl -sI -H 'Accept-Encoding: br,gzip' <url>` shows `content-encoding`). This should be a formality given `text/plain`; it replaces the synthesis's "verify and rename if needed" step, since the rename was done up front.

Pass or fail is the budget table in section 5.9. The results decide: Hunspell-only versus the trie fallback for English; Arabic eager versus lazy; the Electron worker form.

---

## 12. Open questions for Hamza

The shortcut, the asset suffix, the engine adapter shape, the package layout and the phase scope are decided and are not repeated here.

1. **Licence bookkeeping.** Confirm recording the LGPL option for Hunspell, `hunspell-wasm` and Ayaspell (not MPL 1.1), keeping `packages/spell` MIT, and adding all three to the third-party licences page in P1.
2. **Default state.** Spellcheck on for everyone from P1 with English and Arabic both enabled (Arabic downloads about 1.5 MB on the web only when the first Arabic word appears), or only the UI or OS language with a one-time prompt when the other script shows up?
3. **Arabic strictness default.** Flag hamza, ta-marbuta and ya variants (Ayaspell strict, correct top-1 fixes; the recommendation) with "Lenient Arabic spelling" off by default, or lenient by default for casual notes?
4. **Personal dictionary.** One global list applied per script (recommended) or per language? Is a few thousand own_prefs rows acceptable, or do you want the 5k benchmark before P1 ships?
5. **"Ignore all on this page".** Per device in localStorage for v1 (recommended, promotable later) or synced per person via own_prefs per-word keys from the start?
6. **Desktop hidden surface.** OK to mount with `nativeAutocomplete: false` on non-touch devices so Chromium and WebKit's invisible spellcheck and autocorrect stop running on the hidden surface (takes effect on the next page open)?
7. **Native menus.** Accept waiting up to 150 ms for suggestions before presenting the long-press or right-click menu (prefetch makes it rare), or prefer a "Spelling…" submenu that opens the popover or bar instead?
8. **Table cells.** Worth adding `contentSelectionRects` to `packages/table` (P5, about 1.5 d) so cells get squiggles, or accept the documented gap?
9. **Devices for P0a.** Which low-end Android device and old laptop can the bench run on, and is there a Windows Electron machine for the Ctrl bindings and the native-menu wait? What is your preferred way to verify canvas squiggles given automation cannot see the canvas?
10. **Electron fallback preference.** If the `file://` renderer cannot construct a module Worker or fetch from inside it, do you prefer the inline-worker plus main-thread-fetch fallback, or introducing an `app://` custom protocol for the whole renderer?
11. **Optional extras.** Do you want the P7 extras on the roadmap at all (iOS suggestion enricher, desktop autocorrect default off, word completion), or should they stay out until users ask?
12. **Arabic terminology** to lock in with the translation subagent: "spelling" / "spellcheck" (for example التدقيق الإملائي), "personal dictionary" (قاموسك الشخصي), "Add to dictionary", "Ignore". Any preferences beyond `dev-docs/i18n-arabic-glossary.md`?

---

## 13. Docs and i18n obligations

### 13.1 Public docs (same PR as each core change; English-only SDK pages)

- **P0b:** `apps/site/src/views/DocsPage/pages/editor/api-editor.mdx`: a new Decorations table (kinds, the three point forms, `RangeDecorationStyle`, `paintDecorationRects`, layer semantics); the `query.marks(at?: DocPoint | DocRange)` row; add the missing `query.content` row; fix the `focus(at?)` to `focus()` drift around line 112. `custom-nodes.mdx:77`: paint range decorations through `paintDecorationRects` so every style renders, and state what atomic and grid painters are expected to do with an underline. `collaboration.mdx:53-65`: the presence section links to the Decorations table.
- **P2:** `api-editor.mdx` `OPEN_CONTEXT_MENU` payload row (`point?`).
- **P3:** `api-editor.mdx` Decorations table, `a11y` column.
- **P5 (if built):** `api-editor.mdx` `view.posAtCoords` facet row.
- No change to `api-schema.mdx`, `theming.mdx` or `compatibility.mdx` (no facet, no theme leaf, no op, wire or schema change).
- **Package:** `packages/spell/README.md` in P1 (install, `SpellChecker` usage, worker wiring, dictionary formats, licence notes). A site docs page for `@tasfer/spell` only in P7(d) once the protocol has settled; `install.mdx` and `api-schema.mdx` mention it then.
- **Internal:** `dev-docs/spellcheck-measurements.md` (P0a numbers); `dev-docs/i18n-arabic-glossary.md` gains the spelling terms.

### 13.2 i18n

Every string lands in `apps/web/public/app/locales/en/translation.json` and `ar/translation.json` (an app-only feature; the site's duplicate locale files are untouched unless a marketing page mentions spelling). Arabic wording is meaning-based via the `localize-web-ui` skill or an Arabic-speaking subagent against the glossary; plural forms use i18next `_one` / `_other`; shortcut labels are composed at runtime from `isApplePlatform()` (⌘. / Ctrl+.); there are no OS-drawn Electron menu items, so `gen-desktop-strings.mjs` is untouched.

Key set (English values):

| Key | English |
| --- | --- |
| `contextMenu.spellAddToDictionary` | Add to dictionary |
| `contextMenu.spellIgnore` | Ignore |
| `contextMenu.spellIgnorePage` | Ignore all on this page |
| `contextMenu.spellLookingUp` | Looking up… |
| `contextMenu.spellNoSuggestions` | No suggestions |
| `spell.popover.title` | Suggestions |
| `spell.popover.addHint` | A |
| `spell.popover.ignoreHint` | I |
| `spell.popover.ignoredCount_one` / `_other` | {{count}} word ignored on this page / {{count}} words ignored on this page |
| `spell.popover.clearIgnored` | Clear |
| `spell.bar.add` | Add |
| `spell.bar.ignore` | Ignore |
| `spell.bar.dismiss` | Dismiss |
| `spell.footer.count_one` / `_other` | {{count}} spelling issue / {{count}} spelling issues |
| `spell.footer.none` | No spelling issues |
| `spell.announce.flag_one` / `_other` | {{word}}: misspelled, {{count}} suggestion / {{word}}: misspelled, {{count}} suggestions |
| `spell.announce.flagNone` | {{word}}: misspelled, no suggestions |
| `spell.announce.noMore` | No more misspelled words |
| `spell.announce.changed` | Changed to {{word}} |
| `spell.announce.added` | Added {{word}} to your dictionary |
| `spell.announce.ignored` | {{word}} ignored on this page |
| `spell.shortcut.fixOrNext` | Fix spelling or go to the next misspelled word |
| `spell.shortcut.prev` | Previous misspelled word |
| `spell.tooltip` | Misspelled: press {{shortcut}} for suggestions |
| `spell.sheet.title` | Spelling |
| `spell.sheet.progress` | {{current}} of {{total}} |
| `spell.sheet.change` | Change |
| `spell.sheet.changeAll` | Change all |
| `spell.sheet.ignoreAll` | Ignore all |
| `spell.sheet.ignoredOnPage` | Ignored on this page ({{count}}) |
| `spell.sheet.empty` | Nothing to fix here. |
| `spell.download.toast` | Downloading the {{language}} dictionary ({{size}})… |
| `spell.download.failed` | Couldn't download the {{language}} dictionary |
| `spell.download.retry` | Retry |
| `settings.spelling.title` | Spelling |
| `settings.spelling.description` | Typos get a red underline as you write. Fix them from the menu, the keyboard, or the Spelling sheet. Dictionaries download once per language. |
| `settings.spelling.keywords` | spelling spellcheck dictionary typo |
| `settings.spelling.checkWhileTyping` | Check spelling as you type |
| `settings.spelling.languages` | Languages |
| `settings.spelling.language.en` | English |
| `settings.spelling.language.ar` | Arabic |
| `settings.spelling.languageSize` | {{size}} download |
| `settings.spelling.state.notDownloaded` | Downloads when first needed |
| `settings.spelling.state.downloading` | Downloading… |
| `settings.spelling.state.downloaded` | Downloaded |
| `settings.spelling.state.error` | Couldn't download |
| `settings.spelling.removeFromDevice` | Remove from this device |
| `settings.spelling.lenientArabic` | Lenient Arabic spelling |
| `settings.spelling.lenientArabicHint` | Accept common hamza, ة/ه and ى/ي variants |
| `settings.spelling.flagAllCaps` | Flag words in ALL CAPS |
| `settings.spelling.highContrast` | High-contrast underline |
| `settings.spelling.personalDictionary` | Personal dictionary |
| `settings.spelling.personalDictionaryHint` | Words you add are never flagged. Synced to your devices. |
| `settings.spelling.wordCount_one` / `_other` | {{count}} word / {{count}} words |
| `settings.spelling.manage` | Manage |
| `settings.spelling.searchWords` | Search words |
| `settings.spelling.addWord` | Add a word |
| `settings.spelling.removeWord` | Remove |
| `settings.spelling.import` | Import |
| `settings.spelling.export` | Export |
| `settings.spelling.imported_one` / `_other` | Imported {{count}} word / Imported {{count}} words |
| `settings.spelling.importTooLarge` | That list is too large for your personal dictionary. Add it as an additional dictionary instead. |
| `settings.spelling.importInvalid` | Choose a .txt or .dic word list |
| `settings.spelling.additionalDictionaries` | Additional dictionaries (this device) |
| `settings.spelling.addDictionary` | Add a dictionary… |
| `settings.spelling.addDictionaryHint` | A Hunspell .dic and .aff pair, or a plain word list (.txt) |
| `settings.spelling.addDictionaryNeedPair` | Choose both the .dic and the .aff file |
| `settings.spelling.dictionaryLanguage` | Language |
| `settings.spelling.removeDictionary` | Remove |
| `settings.spelling.osAutocorrectHint` | Applies when you next open a page |
| `pageSettings.ignoredWords` | Ignored words |
| `pageSettings.ignoredWordsClear` | Clear |
| `pageSettings.ignoredWordsEmpty` | No ignored words on this page |
| `toolbar.spelling` | Spelling |
| `actionCenter.spelling` | Spelling |

Keys that exist only if the matching P7 extra is built: `settings.spelling.autocorrect` "Correct spelling automatically"; `settings.spelling.autocorrectHint` "Only when there is a single clear correction. Press Backspace right after to undo."; `settings.spelling.neverCorrected` "Words never corrected"; `contextMenu.spellChangeBack` "Change back to “{{word}}”"; `contextMenu.spellStopCorrecting` "Stop correcting “{{word}}”"; `settings.spelling.completion` "Complete long words as I type".

The P4 keys (`settings.spelling.state.*`, `removeFromDevice`, `additionalDictionaries`, `addDictionary*`, `dictionaryLanguage`, `removeDictionary`, `importTooLarge`, `spell.download.*`) can be added when P4 lands; the rest ship with P1 to P3.
