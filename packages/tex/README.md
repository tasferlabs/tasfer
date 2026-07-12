# @cypherkit/tex

A **canvas-native, live-editable LaTeX math engine**. Parses LaTeX, lays it out
with TeX box-and-glue rules, and paints it **directly onto an HTML5 `<canvas>`**
with `ctx.fillText` / `ctx.fillRect` — no DOM, no SVG, no `<foreignObject>`, no
rasterization step.

Every existing math renderer (KaTeX, MathJax) delivers its result as DOM or SVG,
which makes it awkward and heavy to put on a canvas. `@cypherkit/tex` keeps the
_layout_ (the genuinely hard, correctness-critical part) and replaces only the
_backend_ with one that draws vector glyphs straight onto the canvas. The result
is small, theme-color-free (color is just `fillStyle`), DPI-correct for free, and
— crucially — built from day one to support a **caret living inside the formula**
for live editing.

## Why this is feasible (Phase 0 result)

A canvas can already render everything math needs: **glyphs** (`fillText` with a
loaded font) and **rules** (`fillRect`). The only thing missing is a layout
engine with a canvas backend.

We reuse KaTeX's MIT-licensed **data** (glyph metrics, math constants, symbol
map, and the WOFF2 fonts — ~296 KB for all 20 faces, vs. MathJax's ~3.5 MB
bundle) and write our own **logic** (parser, layout, paint, edit).

The foundational assumption — that KaTeX's metric table describes the glyphs we
draw — is verified by `src/data/__spike__/metric-match.test.ts`:

```
TOTAL advance-laid glyphs: 2010/2010 = 100.000% exact match
```

`metric.width === font.advanceWidth` for **every** advance-laid glyph across all
18 fonts. The only divergences are 7 enumerated codepoints (combining accents
`̂ ̃ ⃗`, multi-integrals `∬ ∭`, the degree sign, one private-use assembly
piece) — all laid out by special rules, not by horizontal advance, so they were
never going to use plain advance anyway. The test pins that set, so a future
font/metric bump that introduces a _new_ divergence fails loudly.

(Vertical metrics `height`/`depth` are taken from the table verbatim, exactly as
KaTeX does; they intentionally differ from the glyph's ink bounding box by font
overshoot, so they are not compared to it.)

## Architecture

```
latex string → parse/ error-tolerant Lexer → Parser → AST (source spans)
                                               ├→ layout/ → positioned boxes → paint/ canvas
                                               │              └→ edit/ caret geometry
                                               └→ document/ → MathDocument
MathDocument → deterministic printer → canonical LaTeX → the same render pipeline
data/ → font metrics, math constants, symbol map, and WOFF2 fonts
```

Public surface:

- `layoutMath(latex, { displayMode, fontSize }) → MathLayout` — synchronous;
  returns the box tree plus exact `{ width, height, depthBelowBaseline }`.
- `parseMathDocument(latex) → MathDocument` — imports into an identity-bearing
  semantic tree with persistent rows, slots, matrix cells, and lossless raw
  fallback nodes for unsupported constructs.
- `printMathDocument(document) → latex` — deterministic canonical serialization.
- `layoutMathDocument(document) → MathDocumentLayout` — the same paintable
  layout plus geometry and caret stops keyed by stable root/row/node ids.
- `paintMath(ctx, layout, x, y, { color }) → void`.
- `edit`: `hitTest`, `caretRect`, `selectionRects` — the caret/selection model
  that powers in-place editing.

Design rules: **no module-global mutable state** (per-instance, multi-editor
safe); the only shared state is the immutable metric/symbol data and font faces.
**Error-tolerant always** — partial/invalid input (the normal case mid-keystroke)
renders the valid prefix plus a placeholder and never throws.

### Structured documents

`MathDocument` is the stable public editing model; the rendering parser AST is
an internal implementation detail. The tree gives every root, row, construct,
matrix row, and matrix cell an identity, and represents semantic slots directly
instead of making an editor infer them from character offsets. Empty rows remain
valid caret targets. Unsupported constructs become exact `raw-latex` leaves, so
importing a formula is forward-compatible and lossless even before every TeX
command has a structured node.

```ts
import {
  createDeterministicIdentityAllocator,
  layoutMathDocument,
  mathDocumentCaretStop,
  parseMathDocument,
  printMathDocument,
} from "@cypherkit/tex";

const formula = parseMathDocument(String.raw`\frac{x_1}{\sqrt{y}}`, {
  identityAllocator: createDeterministicIdentityAllocator("formula-42"),
});

formula.root.body.children[0]?.type; // "fraction"
const layout = layoutMathDocument(formula);
const rootStart = mathDocumentCaretStop(layout, {
  kind: "row",
  rowId: formula.root.body.id,
  offset: 0,
});
const canonicalLatex = printMathDocument(formula);
```

Persistence code that needs only the document model, parser, canonical printer,
semantic equality, and brace-safe source normalization can import those APIs
from `@cypherkit/tex/data`. That entry does not evaluate layout, fonts, or either
paint backend.

`layout.items.get(id)` returns an item's bounds, baseline, and contained caret
stops. Each stop carries stable row/field positions and a transitional
`sourceOffset`; `mathDocumentCaretStop`,
`mathDocumentCaretFromSourceOffset`, and `hitTestMathDocument` provide the
bidirectional bridge needed while existing selection code is still
source-oriented. The canonical source is generated only inside layout and is
never the authoritative editable value.

The printer is deterministic and preserves formula semantics, but it may choose
a canonical spelling for supported constructs. `mathDocumentsSemanticallyEqual`
compares two trees while ignoring ids and harmless raw-text chunk boundaries.
The default allocator is deterministic for a standalone local value. Tests and
imports can inject `createDeterministicIdentityAllocator(scope)` when they need
an explicit stable scope. Live collaborative editing must instead pass the
single allocator owned by its document CRDT. Identity allocation is generic:
there is deliberately no separate generator API for each structured feature.

Layout currently projects the document through the existing parser/box engine,
so the opaque draw boxes themselves are not yet a document-native tree. The
public geometry is mapped back to stable ids before it leaves the package, and
structural edits mutate `MathDocument`, never the transient source. Editor core
provides generic structured-content operations, deterministic reduction, undo,
and snapshot replay; the optional math feature provides `MathDocument` ↔
structured-store adapters plus an atomic legacy-LaTeX initializer.

Interactive math editing uses the structured `MathDocument` model:

```ts
import { baseDataSchema, baseSchema } from "@cypherkit/editor";
import { mathExtension } from "@cypherkit/editor/math";
import { mathDataExtension } from "@cypherkit/editor/math/data";

baseSchema.use(mathExtension());
baseDataSchema.extend(mathDataExtension());
```

An imported legacy display formula is initialized into the structured CRDT
when it is first edited; from then on the tree
is the single authority and canonical LaTeX is derived only for rendering and
interchange. Nested selection points and layout caret stops refer to stable
row, slot, node, and character identities, including empty fraction slots.

Data-only reducers and workers have no editing mode: `mathDataExtension()`
supplies codecs, syntax, and structured adapters so they can replay imported
legacy data and structured operations without importing live input or canvas
code.

The `document_init` operation is monotonic and add-only. Undo does not remove
the structured attachment, because another peer may already have added edits
that the undoing peer has not observed. Undo may restore the legacy
character-run shadow, but the tree remains authoritative and the next tree edit
cleans that shadow again.

Inline `MathMark` editing uses a supplemental structured document referenced by
the covering mark. Compatibility characters remain an import/interchange
projection, not a second editable LaTeX representation.

## What works today

Parsed and rendered on canvas:

- Ordinary letters (math italic), digits, ~2200 named symbols/greek/operators.
- Binary/relation/operator **inter-atom spacing** + explicit spaces (`\quad`,
  `\,`, `\;`, …).
- **Super/subscripts** (TeXbook Rule 18, incl. the dual-script clamp & nesting).
- **Fractions** (`\frac`, Rule 15, nested) and the **style cascade**
  (display/text/script/scriptscript).
- **Stretchy & sized delimiters** — `\left(…\right)`, `\big`/`\Big`/`\bigg`/`\Bigg`
  for parens, brackets, braces (with the curly middle piece), floors, ceilings,
  bars — sized to content via the TeX size sequence + extensible glyph assembly.
- **Radicals** — `\sqrt`, `\sqrt[n]{…}`, drawn as a stretching canvas vector
  path that scales to any radicand.
- **Big operators with limits** — `\sum`/`\prod`/`\bigcup`/… stack limits above
  and below in display style; `\int`/`\oint` keep right-side scripts. All render
  at the larger Size1/Size2 glyph, centered on the axis.
- **Accents** — `\hat`, `\bar`, `\vec`, `\tilde`, `\dot`, `\acute`, … over a
  base, plus stretchy `\widehat` / `\widetilde` drawn as width-fitting paths.
- **Over/under** — `\overline` / `\underline` (a full-width vinculum) and
  `\overbrace` / `\underbrace` (stretchy canvas braces).
- **Environments** — `matrix` and the delimited family (`pmatrix`, `bmatrix`,
  `Bmatrix`, `vmatrix`, `Vmatrix`), `cases` / `dcases`, `aligned`, `gathered`,
  `array` (with `{lcr}` column specs), and `smallmatrix` — cells separated by
  `&` and rows by `\\`, sized by the TeX array strut model
  (`arstrut` 0.7/0.3 × `\arraystretch` × 12 pt baselineskip) and centered on the
  math axis.

Unknown commands render as a red placeholder; the parser never throws on
partial/invalid input.

Correctness is pinned three ways: `layout/oracle.test.ts` asserts our
height/depth match KaTeX's own computed tree across a corpus (text + display
expressions incl. the Phase 3 environments and over/under rules, exact to 3
decimals); `paint/render.test.ts` renders the corpus through the real
`paintMath` onto an off-screen canvas (with the actual WOFF2 faces) and checks
the inked pixels land within the computed box — a stable layout↔paint contract,
not a flaky golden-image diff; and `data/__spike__/metric-match.test.ts` guards
the metric/glyph correspondence. Known approximations: stretchy accents
(`\widehat`/`\widetilde`, tiered by KaTeX across glyph sizes) and integral
script-nestling differ from KaTeX by a few hundredths of an em.

## Roadmap

- **Phase 0 — de-risk** ✅ metric/glyph correspondence proven (above).
- **Phase 1 — core engine** ✅ lexer → parser (spans, error-tolerant) → layout
  → canvas paint; KaTeX numeric oracle. Atoms, spacing, `^`/`_`, `\frac`, style
  cascade, greek/symbols.
- **Phase 2 — delimiters, radicals, big ops, accents** ✅ stretchy/sized
  delimiters, stretching radicals, big operators with limits, single-glyph
  accents, spacing commands.
- **Phase 3 — environments, over/under, stretchy accents** ✅ the matrix family
  - delimiters, `cases`/`dcases`, `aligned`/`gathered`, `array`, `smallmatrix`;
    `\overline`/`\underline`; `\overbrace`/`\underbrace`; stretchy
    `\widehat`/`\widetilde`. Heights pinned to the KaTeX oracle (stretchy accents
    approximated). A headless `paint/render.test.ts` validates the paint output.
- **Phase 4 — canvas editor integration** ✅ the `edit/` geometry
  (`hitTest` / `caretRect` / `selectionRects`) is built and tested; the opt-in
  `MathNode` and `MathMark` from `@cypherkit/editor/math` paint **directly** via
  `layoutMath` + `paintMath` (no SVG or bitmaps). The 3.5 MB MathJax bundle, its
  rasterization path, and the service-worker size workaround are deleted.
- **Phase 5 — structured editing** 🟡 `MathDocument`, canonical printing,
  identity-keyed layout/caret geometry, semantic equality, stable slots, raw
  fallbacks, generic structured-content CRDT operations/reduction/undo, and the
  math adapter are in place. Display `MathNode` editing now has an opt-in,
  app-enabled tree path with lazy legacy initialization, nested stable
  selection, structural fraction commands, and no dual-writing. Remaining:
  nested-range editing and clipboard behavior, document-native IME, direct
  editor hit testing into tree positions, arbitrary structural splitting inside
  raw-text leaves, broader command coverage, and migration / convergence
  rollout testing before making tree editing the default. Inline `MathMark`
  editing remains on the legacy text path during this phase.
- **Phase 6** — font subsetting, perf, a pixel visual-diff harness, docs, publish.

## Attribution

Vendors data and fonts from [KaTeX](https://github.com/KaTeX/KaTeX) (MIT). See
`src/data/KATEX_LICENSE`. KaTeX is also used as the correctness oracle in tests
(a `devDependency`), never at runtime.
