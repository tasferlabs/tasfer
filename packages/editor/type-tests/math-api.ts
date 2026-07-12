import type { FeatureInputRule, FeatureSyntaxRule } from "../dist/index.mjs";
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
  type MathExtensionOptions,
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

// Extension metadata is intentionally count-agnostic. Adding a syntax or
// input rule must not become a breaking change in the emitted public type.
declare const syntaxRules: readonly FeatureSyntaxRule[];
declare const inputRules: readonly FeatureInputRule[];
declare const dataExtension: MathDataExtension;
const dataSyntax: MathDataExtension["markdownSyntax"] = syntaxRules;
// @ts-expect-error Data schemas intentionally do not carry live authoring rules.
dataExtension.inputRules;
const featureSyntax: MathFeatureExtension["markdownSyntax"] = syntaxRules;
const featureInputs: MathFeatureExtension["inputRules"] = inputRules;
void dataSyntax;
void featureSyntax;
void featureInputs;

const treeOptions: MathExtensionOptions = {
  displayEditing: "tree",
  inlineEditing: "tree",
};
const treeMath: MathFeatureExtension = mathExtension(treeOptions);
void treeMath;
