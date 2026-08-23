# @tasfer/math

The **opt-in math feature** for [`@tasfer/editor`](https://www.npmjs.com/package/@tasfer/editor):
a display math block and an inline math mark, both rendered directly onto the
canvas by the [`@tasfer/tex`](https://www.npmjs.com/package/@tasfer/tex) layout
engine — no SVG, no bitmaps, no rasterization step.

The engine has no math in its base schema and nothing in it imports this
package, so a host that never installs math never pulls the math stack — or the
layout engine it owns — into its bundle. That dependency is exactly why math is
a package and not part of the engine.

## Install

```bash
npm install @tasfer/editor @tasfer/math @tasfer/tex
```

## Usage

Compose the extension into your schema:

```ts
import { baseSchema, createEditor } from "@tasfer/editor";
import { mathExtension } from "@tasfer/math";

const schema = baseSchema.use(mathExtension());

const editor = createEditor({
  element,
  schema,
  markdown: String.raw`Euler: $e^{i\pi}+1=0$`,
});
```

That registers the `math` block and mark, their markdown codecs, the `$…$` and
`$$…$$` input rules, the paste rule, and the selection adapters that keep a
formula construct-atomic while you move through it.

Without the extension, dollar-delimited input stays literal text — the parser
preserves both `$…$` and `$$…$$` source instead of interpreting or discarding
it, so a math-free client retains content from a peer that has the feature.

## The data-only entry

Workers, persistence, and other render-free contexts import
`@tasfer/math/data` instead. It registers the codecs, markdown syntax,
structured-mark behavior, and the clone adapter for the shared `"math"` kind —
without constructing `MathNode`, `MathMark`, or the live input and canvas stack:

```ts
import { baseDataSchema } from "@tasfer/editor";
import { mathDataExtension } from "@tasfer/math/data";

export const workerDataSchema = baseDataSchema.extend(mathDataExtension());
```

Keep the two definitions paired but their modules separate, so a worker
importing the data schema never evaluates the interactive graph.

## Also exported

- `MathNode`, `MathMark` — the node and mark classes, subclassable.
- `MATH_COMMANDS`, `filterMathCommands`, `mathCommandInsertion` — a ready-made
  command set for a slash menu or command palette.
- `mathMatrixContext`, `mathMatrixResize` — matrix row/column editing.
- `isValidLatex`, `renderToSVG` — validation and an SVG export path for
  contexts with no canvas (previews, exports).
- `mathDocumentToStructured`, `structuredToMathDocument`,
  `parseMathDocumentInit` — adapters between `MathDocument` and the editor's
  generic structured-content CRDT.

Formulas are stored as a structured `MathDocument` tree, not as an editable
LaTeX string: an inline equation anchors on a single object-replacement
character (U+FFFC) and its content lives wholly in the referenced document.
Display and inline forms convert into each other losslessly.

## Documentation

[tasfer.app/docs/editor/api-schema#math](https://www.tasfer.app/docs/editor/api-schema#math)

## License

MIT
