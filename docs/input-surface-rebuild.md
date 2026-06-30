# Input-surface rebuild: browser-authoritative contenteditable

## Why

The current input layer is a **minimal, puppeteered** hidden contenteditable: it
holds only a sentinel plus the current word/sentence (`Editor.SENTINEL`,
`mirrorSentenceContext`, `syncMirrorToSelection` in `entries/editor.ts`), and the
engine re-seeds it every keystroke. Every *stateful* OS keyboard feature —
autocapitalize, autocorrect sessions, predictive text, double-space-period, IME —
assumes a *real, stable* field it can read context from and that advances as the
user types. We keep nuking that field, so we keep fighting each feature with a
per-platform patch.

Concrete proof of the dead end: on iOS, autocapitalize works mid-sentence and
after `". "` (WebKit's state machine advanced on the real `.`/space keystrokes)
but **not on a new line**, because we `preventDefault()` Enter and synthesize the
block split — WebKit never sees the paragraph break, so its shift-state never
advances. No sentinel trick fixes this; the architecture is the problem.

## Target architecture

Flip authority: **the hidden contenteditable becomes the real input field; the
canvas is a parallel renderer.** This is the ProseMirror / CodeMirror 6 model.

- **Faithful per-block mirror.** The contenteditable holds the focused block's
  visible text as a *single text node*, with the real DOM caret. It is persistent
  — never wiped to a sentinel. One text node keeps the DOM↔document mapping
  trivial: a DOM offset within the node equals the visible-character offset that
  `resolvePoint` / `getCharIdAtVisiblePosition` already use.
- **Browser edits it; we observe.** Stop `preventDefault`-ing typing and
  structural keys. Let `beforeinput`/`input`/`selectionchange` mutate the DOM,
  then reconcile DOM → CRDT ops. Because the field looks real, the OS keyboard's
  autocapitalize (incl. new lines), autocorrect, predictions, double-space-period
  and IME work natively, with **zero** per-platform sentinel/mirror code.
- **Canvas stays the visual layer**, rendered from the model as today. The
  contenteditable stays invisible (`opacity:0`) but is the input *authority*.

The DOM→ops reconciler is the one genuinely new piece. We already have the op
primitives (`crdt-utils.ts`: `text_insert`/`text_delete`/block ops), the diff
(`computeSurfaceDelta` in `input-diff.ts`), the change funnel (`change()` /
`commitChange`), and offset→charId mapping. We do **not** need DOM trees or marks
in the contenteditable — the canvas paints visuals; the field only needs plain
text for keyboard context.

## Staged plan (incremental, behind a strategy flag)

### Stage 0 — Safety net
- Add a per-instance input-strategy selector (constructor option, default =
  current "managed-surface") so both paths coexist during migration.
- Build an input-layer regression harness (happy-dom): replay recorded
  `beforeinput`/`input`/composition sequences and assert resulting ops + caret.
  Seed with: type word, autocorrect swap, predictive completion, Enter→new block,
  Backspace-merge, sentence-start caps, IME compose, emoji. This is the spec the
  rebuild must satisfy.

### Stage 1 — Faithful per-block mirror (content + caret)
- New `syncMirrorToSelection` caret branch for the strategy: write the **full**
  focused-block text as one text node, set the DOM caret to the real offset
  (still wrapped in `isMirrorUpdating`). Drop the sentinel for this path.
- Generalize the reconciler: `hiddenInputHandler` diffs the **whole block** text
  (`docRegion` = block text, `newRegion` = surface) via `computeSurfaceDelta` →
  one `text_insert`/`text_delete`. This subsumes the word-diff path.
- Add a `selectionchange` listener: map DOM selection within the text node →
  document `Position`/`SelectionState`, so caret moves and autocorrect-moved
  carets update the model.
- Result: typing, autocorrect, predictions, mid-sentence + after-`". "` caps all
  work through a real field.

### Stage 2 — Stop swallowing structural keys (fixes new-line caps)
- For the new strategy, remove `preventDefault`+synthetic replay of
  Enter/Backspace/Delete in `hiddenInputKeyDownHandler`. Handle via `beforeinput`/
  `input`:
  - `insertParagraph`/`insertLineBreak` → `SPLIT_BLOCK` at the DOM caret; then
    re-render the mirror to the new (empty) focused block, caret at 0. WebKit
    already processed Enter → autocap advances → **next letter capitalizes.**
  - `deleteContentBackward` at offset 0 → existing block-merge/outdent
    (`DELETE_BACKWARD`); re-render mirror.
  - forward/word deletes → map through the block diff.
- IME composition unchanged in shape (runs against the faithful mirror; already
  bypassed while `isComposing`).

### Stage 3 — Selection / multi-block / clipboard parity
- Single-block ranged selection → DOM-authoritative (`SelectionState` from DOM
  range). Multi-block selection stays model-authoritative (canvas-painted; mirror
  selection plain text only for native copy/cut, as today).
- Verify copy/cut/paste (already model/clipboard-event driven; minimal change).

### Stage 4 — Delete old machinery, flip default, platform cleanup
- Remove `SENTINEL`, `mirrorSentenceContext`, `mirrorStartOffset`,
  `clampedMirrorStart`, `sentenceStartOffset`/`currentWordStart`, `resetSentinel`,
  and synthetic-key replay for text. Keep `computeSurfaceDelta` (now block-level).
- The `isAndroid`/`isIOS` input branches collapse to ~zero.
- Update comments and public docs (`apps/site/.../editor/*`) where input behavior
  is described.

### Stage 5 — Verification
- Device matrix: iOS (new-line caps, after-`". "`, mid-sentence, autocorrect,
  predictions, IME, double-space-period), Android (no list over-capitalization,
  GBoard predictions, backspace), desktop (typing, CJK IME, shortcuts).
- `packages/editor` tests + lint; `apps/web` build.

## Risks

- **Inline verbatim source (math chips, code).** Today `clampedMirrorStart` keeps
  the mirror out of LaTeX source. In a faithful block mirror, a block containing a
  chip must represent it as a placeholder (e.g. U+FFFC) so the keyboard can't
  autocorrect into source; the DOM↔doc mapping must account for placeholder width.
  **This is the main new complexity** — design the mapping before Stage 1 lands
  for chip-bearing blocks (or keep those blocks on the managed-surface path until
  handled).
- **Programmatic vs user edits.** Keep `isMirrorUpdating`; add a generation
  counter to drop stale `input` events arriving after a model-driven re-render
  (remote peer edits, autoformat, undo).
- **CRDT determinism** is unaffected — same op families, only the trigger path
  changes. Existing convergence/fuzz tests still gate it.

## Recommendation

Land Stage 0 + Stage 1 behind the flag first (faithful mirror, no structural
change) — that alone makes autocorrect/predictions more correct and is fully
reversible. Stage 2 is the one that fixes new-line caps. Defer chip-bearing
blocks to a follow-up or keep them on the old path until the placeholder mapping
is designed.
