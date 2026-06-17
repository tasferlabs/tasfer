# @cypherkit/tex

A **canvas-native, live-editable LaTeX math engine**. Parses LaTeX, lays it out
with TeX box-and-glue rules, and paints it **directly onto an HTML5 `<canvas>`**
with `ctx.fillText` / `ctx.fillRect` — no DOM, no SVG, no `<foreignObject>`, no
rasterization step.

Every existing math renderer (KaTeX, MathJax) delivers its result as DOM or SVG,
which makes it awkward and heavy to put on a canvas. `@cypherkit/tex` keeps the
*layout* (the genuinely hard, correctness-critical part) and replaces only the
*backend* with one that draws vector glyphs straight onto the canvas. The result
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
font/metric bump that introduces a *new* divergence fails loudly.

(Vertical metrics `height`/`depth` are taken from the table verbatim, exactly as
KaTeX does; they intentionally differ from the glyph's ink bounding box by font
overshoot, so they are not compared to it.)

## Architecture

```
latex string
  → parse/   error-tolerant Lexer → Parser → AST   (every node carries a source span)
  → layout/  AST → positioned box tree (em units, metric data; boxes keep spans)
  → paint/   walk boxes → ctx.fillText(glyph) / ctx.fillRect(rule)   ← canvas backend
  + edit/    hitTest(layout,x,y)→offset ; caretRect(layout,offset) ; selectionRects(range)
  + data/    fontMetricsData, math constants, symbol map (vendored from KaTeX) + WOFF2
```

Public surface (planned):

- `layoutMath(latex, { displayMode, fontSize }) → MathLayout` — synchronous;
  returns the box tree plus exact `{ width, height, depthBelowBaseline }`.
- `paintMath(ctx, layout, x, y, { color }) → void`.
- `edit`: `hitTest`, `caretRect`, `selectionRects` — the caret/selection model
  that powers in-place editing.

Design rules: **no module-global mutable state** (per-instance, multi-editor
safe); the only shared state is the immutable metric/symbol data and font faces.
**Error-tolerant always** — partial/invalid input (the normal case mid-keystroke)
renders the valid prefix plus a placeholder and never throws.

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
  + delimiters, `cases`/`dcases`, `aligned`/`gathered`, `array`, `smallmatrix`;
  `\overline`/`\underline`; `\overbrace`/`\underbrace`; stretchy
  `\widehat`/`\widetilde`. Heights pinned to the KaTeX oracle (stretchy accents
  approximated). A headless `paint/render.test.ts` validates the paint output.
- **Phase 4 — live edit + editor integration** ✅ the `edit/` caret model
  (`hitTest` / `caretRect` / `selectionRects`) is built and tested; `MathNode`
  and `MathMark` in `@cypherkit/editor` now paint **directly** via `layoutMath` +
  `paintMath` (no SVG, no bitmaps); the 3.5 MB MathJax bundle, its rasterization
  path, and the service-worker size workaround are deleted. Remaining: wiring the
  `edit/` primitives into the editor's caret system for an in-formula caret
  (Level 2).
- **Phase 5** — font subsetting, perf, a pixel visual-diff harness, docs, publish.

## Attribution

Vendors data and fonts from [KaTeX](https://github.com/KaTeX/KaTeX) (MIT). See
`src/data/KATEX_LICENSE`. KaTeX is also used as the correctness oracle in tests
(a `devDependency`), never at runtime.
