# @tasfer/tex

A **canvas-native, live-editable LaTeX math engine**. It parses LaTeX, lays it
out with TeX's box-and-glue rules, and paints it **directly onto an HTML5
`<canvas>`** with `fillText` and `fillRect` — no DOM, no SVG, no
`<foreignObject>`, no rasterization step.

Every other math renderer (KaTeX, MathJax) delivers its result as DOM or SVG,
which is awkward and heavy to put on a canvas. `@tasfer/tex` keeps the _layout_
— the genuinely hard, correctness-critical part — and replaces only the
_backend_ with one that draws glyphs straight onto the context. The result is
small, theme-color-free (color is just `fillStyle`), DPI-correct for free, and
built from day one to support a **caret living inside the formula**.

## Install

```bash
npm install @tasfer/tex
```

## Usage

Lay out a formula and paint it. `layoutMath` is synchronous and returns exact
pixel dimensions — metrics come from a data table, not an async measurement:

```ts
import { layoutMath, paintMath } from "@tasfer/tex";

const layout = layoutMath(String.raw`\frac{-b \pm \sqrt{b^2-4ac}}{2a}`, {
  displayMode: true,
  fontSize: 20,
});

layout.width; // exact advance width in px
layout.height; // extent above the baseline
layout.depth; // extent below it

// `x` is the left edge, `y` is the baseline. DPI scaling is whatever
// transform you already set on the context.
paintMath(ctx, layout, 40, 120, { color: "#111" });
```

Layout never throws. Partial or invalid input — the normal case mid-keystroke —
renders the valid prefix plus a placeholder, and unknown commands paint as a
red placeholder. Use `isValidLatex(latex)` when you want an explicit "does this
parse" signal for an editor.

Long formulas can wrap: pass `maxWidth` (plus optional `firstMaxWidth`,
`wrapIndent`, `wrapLineGap`) and the top-level expression breaks at binary
operators and relations into one taller layout.

## Fonts

The engine paints with the KaTeX WOFF2 faces, each registered under its own CSS
family (`TasferTeX_<Variant>`) so it never depends on synthetic bold/italic.
Serve the `KaTeX_<Variant>.woff2` files from somewhere you control and point
`loadFonts` at them before the first paint:

```ts
import { loadFonts } from "@tasfer/tex";

await loadFonts({ baseUrl: "/fonts/tex" });
// …or let a bundler hash them and resolve each face yourself:
await loadFonts({ urlFor: (variant) => fontUrls[variant] });
```

It resolves once every requested face is ready. Before that, `paintMath` simply
draws nothing for a face that hasn't loaded — so drive a redraw on completion.
`ALL_VARIANTS` lists the faces; pass `variants` to load a subset.

## What it renders

- Ordinary letters (math italic), digits, and ~2200 named symbols, greek
  letters, and operators.
- Inter-atom spacing for binary/relation/operator classes, plus the explicit
  spaces (`\quad`, `\,`, `\;`, …).
- Super- and subscripts, including the dual-script clamp and nesting.
- Fractions and the full display/text/script/scriptscript style cascade.
- Stretchy and sized delimiters — `\left(…\right)`, `\big` through `\Bigg` —
  sized to their content via extensible glyph assembly.
- Radicals (`\sqrt`, `\sqrt[n]{…}`) drawn as a vector path that stretches to any
  radicand.
- Big operators with limits: `\sum`, `\prod`, `\int`, `\oint`, … stacking limits
  in display style and keeping right-side scripts where TeX does.
- Accents (`\hat`, `\vec`, `\tilde`, …) plus stretchy `\widehat` / `\widetilde`.
- Over/under: `\overline`, `\underline`, `\overbrace`, `\underbrace`.
- Environments: the `matrix` family (`pmatrix`, `bmatrix`, `vmatrix`, …),
  `cases` / `dcases`, `aligned`, `gathered`, `array` with column specs, and
  `smallmatrix`.
- `\text{…}` runs, with an optional `textFallback` so a host font can supply
  characters the math faces don't cover (CJK, emoji).

## Structured documents

`MathDocument` is the stable editing model: an identity-bearing tree where every
root, row, construct, matrix row, and cell has a persistent id, and semantic
slots are represented directly instead of being inferred from character offsets.
Empty rows stay valid caret targets, and unsupported constructs import as exact
`raw-latex` leaves — so importing a formula is lossless and forward-compatible
even before every TeX command has a structured node.

```ts
import {
  layoutMathDocument,
  parseMathDocument,
  printMathDocument,
} from "@tasfer/tex";

const formula = parseMathDocument(String.raw`\frac{x_1}{\sqrt{y}}`);

formula.root.body.children[0]?.type; // "fraction"

const layout = layoutMathDocument(formula); // paintable, plus caret stops
const canonical = printMathDocument(formula); // deterministic LaTeX
```

The printer is deterministic but may choose a canonical spelling, so compare
trees with `mathDocumentsSemanticallyEqual` (it ignores ids and harmless
raw-text chunk boundaries) rather than comparing printed strings.

Identity allocation is pluggable: the default is deterministic for a standalone
local value, `createDeterministicIdentityAllocator(scope)` gives tests and
imports an explicit stable scope, and collaborative editing passes the allocator
owned by its document CRDT.

## Editing geometry

The caret and selection model that makes in-place editing possible:

```ts
import { caretRect, hitTest, selectionRects } from "@tasfer/tex";

// All three speak source offsets into the LaTeX string.
const offset = hitTest(layout, pointerX, pointerY);
const rect = caretRect(layout, offset);
const rects = selectionRects(layout, startOffset, endOffset);
```

`layoutMathDocument` exposes the same geometry keyed by stable ids —
`layout.items.get(id)` returns an item's bounds, baseline, and caret stops —
with `mathDocumentCaretStop`, `mathDocumentCaretFromSourceOffset`, and
`hitTestMathDocument` bridging between stable addresses and source offsets.

Alongside these, the package exports the editing helpers an input layer needs:
brace balancing, matrix row/column resizing, LaTeX normalization, unit
navigation (`unitAt`, `unitBefore`, `unitAfter`), and the command vocabulary
(`symbolCommands`, `operatorCommands`, `accentCommands`, …).

## Rendering to SVG

For contexts with no canvas — print, PDF export, a static preview — `toSVG`
returns a self-described `<svg>` string that references the same
`TasferTeX_<Variant>` families:

```ts
import { toSVG } from "@tasfer/tex";

const svg = toSVG(layout, { color: "#111" });
```

Those `@font-face`s must be available wherever the SVG is rendered.

## Entry points

| Import                 | Contents                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@tasfer/tex`          | The public contract: layout, paint, fonts, documents, caret geometry                                                        |
| `@tasfer/tex/data`     | Document model, parser, canonical printer, semantic equality, brace-safe normalization — no layout, fonts, or paint backend |
| `@tasfer/tex/document` | The structured document model on its own                                                                                    |
| `@tasfer/tex/internal` | The box tree and parse AST. Brittle engine internals, explicitly **not** a stable contract                                  |

`/data` is the one to reach for in workers and persistence code: it evaluates
neither the layout pipeline nor either paint backend.

## Design rules

- **No module-global mutable state.** Everything is per-call or per-instance, so
  several editors can render math on one page. The only shared state is the
  immutable metric and symbol data plus the font faces.
- **Error-tolerant always.** The parser never throws on partial or invalid
  input; it renders what it can and marks the rest.

## Attribution

Vendors data and fonts from [KaTeX](https://github.com/KaTeX/KaTeX) (MIT): glyph
metrics, math constants, the symbol map, and the WOFF2 faces (~296 KB for all
20, against MathJax's ~3.5 MB bundle). KaTeX is also used as the correctness
oracle in tests — a `devDependency`, never at runtime.

See [`NOTICE`](./NOTICE) for the full third-party notice.

## License

MIT
