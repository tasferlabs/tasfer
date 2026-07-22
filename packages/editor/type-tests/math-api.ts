import type {
  FeatureExtension,
  FeatureInputRule,
  SyntaxRule,
} from "../dist/index.mjs";
import {
  EXIT_INLINE_MATH as legacyExitInlineMath,
  filterMathCommands as legacyFilterMathCommands,
  MathMark as LegacyMathMark,
  MathNode as LegacyMathNode,
  renderToSVG as legacyRenderToSVG,
} from "../dist/index.mjs";
import {
  createDeterministicIdentityAllocator,
  createStructuredMathMarkAttachment,
  type IdentityAllocator,
  type MathDocumentNode as DataMathDocumentNode,
  type MathDataExtension,
  type MathMarkAttrs,
  type MathNode as LegacyDataMathNode,
} from "../dist/math/data.mjs";
import {
  type MathDocumentNode,
  mathExtension,
  type MathFeatureExtension,
  MathNode,
} from "../dist/math/index.mjs";

// The full feature keeps the renderer's established MathNode value/type while
// exposing the editable TeX tree node through an unambiguous public alias.
const mathRenderer = new MathNode();
const rendererType: "math" = mathRenderer.type;
declare const documentNode: MathDocumentNode;
const dataDocumentNode: DataMathDocumentNode = documentNode;
const legacyDataDocumentNode: LegacyDataMathNode = documentNode;
void rendererType;
void dataDocumentNode;
void legacyDataDocumentNode;

// Existing root imports remain source-compatible while new consumers migrate
// to the explicit math entry point.
const legacyMathRenderer: MathNode = new LegacyMathNode();
const legacyMathMark = new LegacyMathMark();
const legacyCommands = legacyFilterMathCommands("fra");
const legacySvg: string = legacyRenderToSVG("x", false);
void legacyMathRenderer;
void legacyMathMark;
void legacyCommands;
void legacySvg;
void legacyExitInlineMath;

const ids: IdentityAllocator =
  createDeterministicIdentityAllocator("math-type-test");
ids.nextId();
const mathMarkAttrs: MathMarkAttrs = {};
const structuredMark = createStructuredMathMarkAttachment("x", ids);
const structuredContentId: string = structuredMark.contentId;
void mathMarkAttrs;
void structuredContentId;

// Facets ride the owning spec. The spec-carried rule lists stay
// count-agnostic: adding a syntax or input rule must not become a breaking
// change in the emitted public type.
declare const syntaxRules: readonly SyntaxRule[];
declare const inputRules: readonly FeatureInputRule[];
declare const dataExtension: MathDataExtension;
const dataBlockSyntax: readonly SyntaxRule[] | undefined =
  dataExtension.blocks[0].markdownSyntax;
const dataMarkSyntax: readonly SyntaxRule[] | undefined =
  dataExtension.marks[0].markdownSyntax;
// @ts-expect-error Data schemas intentionally do not carry live authoring rules.
dataExtension.inputRules;
// @ts-expect-error Markdown syntax rides the specs, not the bundle.
dataExtension.markdownSyntax;
const featureInputs: MathFeatureExtension["inputRules"] = inputRules;
const featureKinds: MathFeatureExtension["structuredKinds"] =
  mathExtension().structuredKinds;
void dataBlockSyntax;
void dataMarkSyntax;
void featureInputs;
void featureKinds;

// A bundle authored against the removed facet-list registration fails to
// compile: the relocated keys are tombstoned on the feature surface.
const staleBundle = {
  name: "stale",
  // @ts-expect-error Markdown syntax now rides the owning spec.
  markdownSyntax: syntaxRules,
} satisfies FeatureExtension;
void staleBundle;

const structuredMath: MathFeatureExtension = mathExtension();
void structuredMath;
