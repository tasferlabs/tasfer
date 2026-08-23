# @tasfer/code

The **opt-in syntax-highlighted code block** for
[`@tasfer/editor`](https://www.npmjs.com/package/@tasfer/editor) — on-canvas
layout, editing behavior, and highlighting.

Code splits differently from math: the **type** is core, the **painter** is not.
`@tasfer/editor` tokenizes fenced code blocks, describes the CRDT shape, and owns the
Markdown/HTML/text round-trip, so a document containing code parses, syncs,
serializes, and exports with `baseSchema` alone. What lives out here is the
painter — because the highlighting carries a grammar set far larger than the
engine itself.

## Install

```bash
npm install @tasfer/editor @tasfer/code
```

## Usage

````ts
import { baseSchema, createEditor } from "@tasfer/editor";
import { codeExtension } from "@tasfer/code";

const schema = baseSchema.use(codeExtension());

const editor = createEditor({
  element,
  schema,
  markdown: "```ts\nconst x = 1\n```",
});
````

Skip the package and nothing is lost from the document: the block still
round-trips and still replicates, it simply has no painter and renders as the
placeholder any unregistered block type gets.

## Also exported

- `CODE_LANGUAGES`, `codeLanguageLabel` — for a language picker.
- `INDENT_CODE`, `OUTDENT_CODE` — actions to wire into a toolbar or shortcut.
- `highlightLine` — the tokenizer on its own, if you want it elsewhere.
- `CodeNode` — the node class, subclassable.

Highlighting is powered by [lowlight](https://github.com/wooorm/lowlight)
(highlight.js).

## Documentation

[tasfer.app/docs/editor/api-schema#code](https://www.tasfer.app/docs/editor/api-schema#code)

## License

MIT
