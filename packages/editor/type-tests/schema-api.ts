import {
  baseSchema,
  createDoc,
  createEditor,
  defineMark,
  defineNode,
} from "../dist/index.mjs";

declare const element: HTMLElement;

const callout = defineNode("callout", {
  attrs: {
    tone: {
      default: "note",
      validate: (value: unknown): value is "note" | "warning" =>
        value === "note" || value === "warning",
    },
    count: { default: 0 },
  },
});

const highlight = defineMark("highlight", {
  attrs: {
    color: { default: "yellow" },
  },
});

const schema = baseSchema.extend({
  nodes: [callout],
  marks: [highlight],
});

const doc = createDoc({ schema: schema.data });
const editor = createEditor({ element, doc });
const directEditor = createEditor({ element, schema });

directEditor.change((change) => {
  change.setBlock({ type: "callout", tone: "warning" });
  // @ts-expect-error Direct schema inference rejects unknown custom attrs.
  change.setBlock({ type: "callout", missing: true });
});

editor.change((change) => {
  change.insertBlock({ type: "callout", tone: "warning", count: 2 });
  change.setBlock({ type: "callout", tone: "note" });
  change.setMark("highlight", { attrs: { color: "orange" } });

  // @ts-expect-error Unknown block type.
  change.insertBlock({ type: "calluot" });
  // @ts-expect-error The validator narrows tone to the declared union.
  change.setBlock({ type: "callout", tone: "danger" });
  // @ts-expect-error count is inferred from its numeric default.
  change.setBlock({ type: "callout", count: "two" });
  // @ts-expect-error Unknown mark type.
  change.setMark("higlight");
  // @ts-expect-error Mark attributes are inferred from defineMark.
  change.setMark("highlight", { attrs: { color: 123 } });
});

const block = editor.query.block();
if (block?.type === "callout") {
  const tone: "note" | "warning" = block.attrs.tone;
  const count: number = block.attrs.count;
  void tone;
  void count;

  // @ts-expect-error Narrowing by block.type exposes typed custom attributes.
  const invalid: string = block.attrs.count;
  void invalid;
}

const mark = editor.query.marks().find((item) => item.name === "highlight");
if (mark?.name === "highlight") {
  const color: string = mark.attrs.color;
  void color;
}
