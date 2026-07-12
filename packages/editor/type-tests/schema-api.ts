import {
  baseSchema,
  type Block,
  createDeterministicIdentityAllocator,
  createDoc,
  createEditor,
  defineMark,
  defineNode,
  type ContentSelection,
  type FeatureExtension,
  type IdentityAllocator,
  type Node,
  type StructuredDocument,
  structuredContentId,
} from "../dist/index.mjs";
import {
  type MathBlock,
  mathDocumentToStructured,
  mathExtension,
  MathNode,
  parseMathDocument,
  structuredToMathDocument,
} from "../dist/math/index.mjs";

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

const featureCallout = defineNode("feature_callout", {
  attrs: {
    severity: {
      default: "info",
      validate: (value: unknown): value is "info" | "danger" =>
        value === "info" || value === "danger",
    },
  },
});

const featureHighlight = defineMark("feature_highlight", {
  attrs: { color: { default: "yellow" } },
});

const reusableFeature = {
  name: "feature-callouts",
  nodes: [featureCallout],
  marks: [featureHighlight],
} as const satisfies FeatureExtension;

const schema = baseSchema.extend({
  nodes: [callout],
  marks: [highlight],
});

const featureSchema = baseSchema.use(reusableFeature);
const featureEditor = createEditor({ element, schema: featureSchema });

featureEditor.change((change) => {
  change.setBlock({ type: "feature_callout", severity: "danger" });
  change.setMark("feature_highlight", { attrs: { color: "orange" } });

  // @ts-expect-error Feature node attributes remain exact through Schema.use.
  change.setBlock({ type: "feature_callout", severity: "warning" });
  // @ts-expect-error Feature mark attributes remain exact through Schema.use.
  change.setMark("feature_highlight", { attrs: { color: 42 } });
});

const mathSchema = baseSchema.use(mathExtension());
const mathEditor = createEditor({ element, schema: mathSchema });
mathEditor.change((change) => {
  change.setBlock({ type: "math", displayMode: true });
  // @ts-expect-error The optional math block keeps its exact attribute type.
  change.setBlock({ type: "math", displayMode: "yes" });
});

// Optional feature blocks specialize the generic node base without joining the
// root package's closed core Block union (which would pull feature declarations
// into a consumer that never imports `@cypherkit/editor/math`).
type RootMathBlock = Extract<Block, { readonly type: "math" }>;
const rootBlockIsMathFree: [RootMathBlock] extends [never] ? true : false =
  true;
const mathNodeIsPublicNode: Node = new MathNode();
declare const featureMathBlock: MathBlock;
const mathBlockType: "math" = featureMathBlock.type;
void rootBlockIsMathFree;
void mathNodeIsPublicNode;
void mathBlockType;

const mathDocument = parseMathDocument(String.raw`\frac{x}{y}`);
const structuredMath = mathDocumentToStructured(mathDocument);
structuredToMathDocument(structuredMath);
const deterministicImportIds: IdentityAllocator =
  createDeterministicIdentityAllocator("type-test-import");
const genericAttachmentId: string = structuredContentId("block", "diagram");
void genericAttachmentId;
const allocatedMathDocument = parseMathDocument("x", {
  identityAllocator: deterministicImportIds,
});
mathDocumentToStructured(allocatedMathDocument, {
  identityAllocator: deterministicImportIds,
});

const doc = createDoc({ schema: schema.data });
const editor = createEditor({ element, doc });
const directEditor = createEditor({ element, schema });

declare const genericContent: StructuredDocument;
const genericSelection: ContentSelection = {
  anchor: {
    kind: "gap",
    blockId: "block",
    contentId: "content",
    parentId: "content",
    slot: "children",
    afterNodeId: null,
    affinity: "forward",
  },
  focus: {
    kind: "gap",
    blockId: "block",
    contentId: "content",
    parentId: "content",
    slot: "children",
    afterNodeId: null,
    affinity: "forward",
  },
};

editor.change((change) => {
  const featureNodeId: string = change.identities.nextId();
  void featureNodeId;
  change
    .editContent("block", "content", {
      kind: "document_init",
      document: genericContent,
    })
    .selectContent(genericSelection);
});
const queriedContent: StructuredDocument | null = editor.query.content(
  "block",
  "content",
);
const publishedContentSelection: ContentSelection | null =
  editor.state.contentSelection;
void queriedContent;
void publishedContentSelection;

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
