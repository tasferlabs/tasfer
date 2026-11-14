/**
 * Schema — the public, editor-facing document schema.
 *
 * This is the canvas-aware half: it bundles the canvas-free `DataSchema` (CRDT
 * + serialization facets) with the rendering facet (the list of `Node`s the
 * editor draws). `createEditor({ schema })` consumes both halves; `createDoc`
 * needs only `schema.data`.
 *
 *   const schema = baseSchema.extend({ nodes: [callout] });
 *   const editor = createEditor({ element, schema });
 *
 * `defineNode` / `defineMark` build the spec objects; `baseSchema` is the
 * math-free core set. Schemas are immutable — `extend()` and `use()` return a new one
 * — so two editors can hold different schemas on the same page (the project's
 * no-shared-mutable-state rule).
 *
 * v1 scope: custom block types are LEAF, void nodes (no text content, no
 * nested blocks). They serialize through the generic `<x-type …>` HTML-tag
 * round-trip, so no tokenizer changes are needed. Text-bearing and
 * block-containing custom nodes are future steps.
 */

import { getBaseDataSchema } from "./baseDataSchema";
import type {
  FeatureFacets,
  StructuredMarkFacet,
  SyntaxRule,
} from "./feature-facets";
import { defaultMarks, Mark } from "./rendering/marks";
import { defaultNodes } from "./rendering/nodes";
import { BoxNode, type BoxRenderStyle } from "./rendering/nodes/BoxNode";
import { Node } from "./rendering/nodes/Node";
import type {
  BaseSchemaDefinition,
  BlockName,
  InferAttrs,
  MarkNameOf,
  MergeSchema,
  SchemaDefinition,
} from "./schema-types";
import {
  type BlockCodec,
  type InputCtx,
  type ParsedTag,
} from "./serlization/codecs";
import { codecFromNode } from "./serlization/codecs/from-node";
import { escapeAttr } from "./serlization/codecs/inline";
import type { MarkCodec } from "./serlization/codecs/mark-codec";
import { asBlock, type Block, type CustomBlock } from "./serlization/loadPage";
import type {
  BlockCapabilities,
  BlockTypeDescriptor,
  FieldDescriptor,
} from "./sync/block-registry";
import {
  type BlockSpecCore,
  type DataSchema,
  type MarkSpec,
  type StructuredKindSpec,
} from "./sync/schema";
import { invariant } from "@shared/invariant";

/**
 * A custom block type, as returned by {@link defineNode}. Pass it in `nodes` to
 * `Schema.extend()`. It holds the type's data rules and save format, plus
 * `node`, the {@link Node} that draws it.
 */
export interface BlockSpec<
  T extends string = string,
  A extends Record<string, unknown> = Record<string, unknown>,
> extends BlockSpecCore<T, A> {
  readonly node: Node;
}

/**
 * A custom mark type, as returned by {@link defineMark}. Pass it in `marks` to
 * `Schema.extend()`. It is a {@link MarkSpec} plus `render`, the {@link Mark}
 * that draws it. Without `render`, the mark is still kept and synced, but looks
 * like plain text.
 */
export interface MarkDef<
  T extends string = string,
  A extends Record<string, unknown> = Record<string, unknown>,
> extends MarkSpec<T, A> {
  readonly render?: Mark;
}

/**
 * What you pass to `Schema.extend()`, for example
 * `baseSchema.extend({ nodes, marks })`: the custom block types and marks to
 * add to a schema.
 */
export interface SchemaExtension {
  /**
   * Custom block types to add. Each entry is a {@link BlockSpec} from
   * `defineNode`, or an instance of your own {@link Node} subclass. A subclass
   * can set `static nodeConfig` with the same fields as `defineNode`'s config.
   * Both styles give the same result.
   */
  readonly nodes?: readonly (BlockSpec | Node)[];
  /**
   * Custom marks to add, made with `defineMark`. Each {@link MarkDef} may carry
   * a {@link Mark} in `render`. `extend()` adds it to the schema, so
   * `createEditor({ schema })` draws the mark with no extra option.
   */
  readonly marks?: readonly MarkDef[];
  /**
   * Helpers for each kind of nested content this extension brings, such as math
   * or tables. They tell the editor how to select, copy, paste and duplicate
   * content inside it, and how to read its text. One kind can serve several
   * types: display math and inline math share one, so these live here and not
   * on a single node or mark.
   */
  readonly structuredKinds?: readonly StructuredKindSpec[];
}

/**
 * A reusable feature you install with {@link Schema.use}. It can hold
 * everything `extend()` takes (nodes, marks, `structuredKinds`). It can also
 * add typing rules (`inputRules`), paste handling (`pasteRules`), `actions` and
 * `theme` defaults.
 *
 * `name` is optional and only for tooling. It is not a unique key: two features
 * with the same name are both installed.
 *
 * Use `satisfies`, not a type annotation, so the exact node and mark names stay
 * typed:
 *
 * ```ts
 * export const callouts = {
 *   name: "callouts",
 *   nodes: [defineNode("callout")],
 * } as const satisfies FeatureExtension;
 *
 * const schema = baseSchema.use(callouts);
 * ```
 */
// This distinct shape is the stable composition boundary for extension
// packages; new feature capabilities can be added here without changing how
// consumers install them.
export interface FeatureExtension extends SchemaExtension, FeatureFacets {
  readonly name?: string;
}

/**
 * What you pass to {@link Schema.restrict}: the block and mark types the user
 * may create. Names autocomplete from the schema. Leave out `blocks` or `marks`
 * to allow every type. `marks: []` allows no formatting at all. `paragraph` is
 * always allowed, so you need not list it. When you set `content`, it is not
 * added for you. A blocked type that arrives from another person or an older
 * document still shows.
 *
 * ```ts
 * const titleSchema = baseSchema.restrict({ blocks: ["heading1"], marks: [] });
 * ```
 */
export interface SchemaRestriction<
  D extends SchemaDefinition = BaseSchemaDefinition,
> {
  readonly blocks?: readonly BlockName<D>[];
  readonly marks?: readonly MarkNameOf<D>[];
  /**
   * The order and number of blocks the document must follow. `blocks` says
   * which types are allowed. `content` says in what order and how many.
   *
   * ```text
   * "heading1 paragraph+"              a heading, then one or more paragraphs
   * "heading1 (paragraph|image){1,3}"  a heading, then one to three of either
   * "heading1 block*"                  a heading, then anything
   * ```
   *
   * A name is a block type or a group: `block`, `text`, `heading`, `list`,
   * `void`, or a name from a node's `groups`. Use `|` for "or", `( )` to group,
   * and `+`, `*`, `?`, `{n}`, `{n,}`, `{n,m}` to repeat. Spaces separate names.
   *
   * The groups come from the registered types, so there is no list to keep up:
   *
   * - `block`: every type.
   * - `text`: every type that holds text (paragraph, headings, quote, lists,
   *   code).
   * - `void`: every type with no text (image, divider, custom nodes).
   * - `heading`: `heading1`, `heading2` and `heading3`.
   * - `list`: bullet, numbered and todo lists.
   *
   * An edit that would break this shape is refused. Paste and import are fixed
   * up to fit it. Edits from other people are not checked, so everyone still
   * ends up with the same document.
   *
   * Where an edit can adapt, it does. Enter makes the new block a type the
   * shape allows there, and does nothing when none is allowed. A paste is fixed
   * to fit where it lands. Other edits that would break the shape do nothing:
   * turning a block into another type, a Backspace that joins two blocks,
   * deleting a selected block, or `deleteBlock()`. {@link Editor.change}
   * returns `false` when it refuses a batch, and {@link Editor.canChange}
   * tells you ahead of time.
   *
   * A loaded document is fixed as a whole. A block that does not fit becomes a
   * type that does, keeping its text, or is dropped. Blocks missing at the end
   * are added.
   *
   * A document that already breaks the shape is never locked. It may come from
   * someone on a looser schema, or be saved before you added the rule. It
   * still edits normally. Only an edit that breaks a document that fit is
   * refused.
   *
   * The shape is a guard on what this user types, not a promise about the
   * document. Two people's edits can each be fine and still break the shape
   * once they merge. If your code depends on the shape, for export or
   * rendering, check it with `schema.data.contentAccepts()` at that point, and
   * fix a document that fails.
   *
   * Every name must already be registered, so call `restrict()` after
   * `extend()` and `use()`. A bad expression, an unknown name, or a shape no
   * document can meet throws when you call `restrict()`, not later.
   */
  readonly content?: string;
}

type UnionToIntersection<U> = (
  U extends unknown ? (value: U) => void : never
) extends (value: infer I) => void
  ? I
  : never;

type NodeEntryDefinition<N> =
  N extends BlockSpec<infer T, infer A> ? { readonly [K in T]: A } : {};

type MarkEntryDefinition<M> =
  M extends MarkDef<infer T, infer A> ? { readonly [K in T]: A } : {};

type ExtensionDefinition<E extends SchemaExtension> = {
  readonly blocks: E["nodes"] extends readonly (infer N)[]
    ? UnionToIntersection<NodeEntryDefinition<N>>
    : {};
  readonly marks: E["marks"] extends readonly (infer M)[]
    ? UnionToIntersection<MarkEntryDefinition<M>>
    : {};
};

/**
 * The block and mark types an editor knows, and the nodes and marks that draw
 * them. A schema never changes: `extend()`, `use()` and `restrict()` each
 * return a new one. Start from `baseSchema`. Two editors on one page can use
 * different schemas.
 *
 * TypeScript carries the schema's block and mark names into the editor, its
 * `change()` and `query` APIs, and the React bindings, with no type argument
 * to write. So `setBlock({ type: "calluot" })` is a type error.
 *
 * ```ts
 * const callout = defineNode("callout");
 * const schema = baseSchema.extend({ nodes: [callout] });
 * const editor = createEditor({ element, schema });
 * ```
 */
export class Schema<D extends SchemaDefinition = BaseSchemaDefinition> {
  readonly data: DataSchema<D>;
  readonly nodes: readonly Node[];
  readonly marks: readonly Mark[];

  constructor(
    data: DataSchema<D>,
    nodes: readonly Node[],
    marks: readonly Mark[],
  ) {
    this.data = data;
    this.nodes = nodes;
    this.marks = marks;
  }

  /**
   * Derive a new schema with extra custom node and mark types. `nodes` and
   * `marks` are arrays. A type whose name is already in the schema replaces the
   * old one. Use {@link Schema.use} for a reusable feature bundle.
   *
   * ```ts
   * const schema = baseSchema.extend({ nodes: [defineNode("one_off")] });
   * ```
   */
  extend<const E extends SchemaExtension>(
    ext: E,
  ): Schema<MergeSchema<D, ExtensionDefinition<E>>> {
    // Normalize both authoring styles (a prebuilt BlockSpec, or a bare Node
    // subclass instance registered directly) to a single BlockSpec list.
    const specs = ext.nodes?.map(toBlockSpec) ?? [];
    const markDefs = ext.marks ?? [];
    const data = this.data.extend({
      // Strip ONLY the render facet (the Node) and forward the rest of the
      // spec structurally, so a data-side field added to BlockSpecCore can
      // never be silently dropped on the canvas path.
      blocks: specs.map(({ node: _node, ...core }): BlockSpecCore => core),
      // Same structural strip for marks — `render` is the one canvas facet.
      // The codec is resolved from the render Mark when present (the Mark is
      // the single source of truth for its facets); `defineMark`'s `codec` is
      // the fallback only for a data-only mark with no render instance to
      // carry it.
      marks: markDefs.map((mark): MarkSpec => {
        const { render: _render, ...core } = mark;
        return { ...core, codec: resolveMarkCodec(mark) };
      }),
      structuredKinds: ext.structuredKinds,
    }) as DataSchema<MergeSchema<D, ExtensionDefinition<E>>>;
    const nodes = [...this.nodes, ...specs.map((spec) => spec.node)];
    // Fold each custom mark's render facet into the rendering list (built-ins +
    // custom), so `createEditor({ schema })` paints them with no separate
    // `marks` option. A data-only mark (no `render`) contributes nothing here —
    // it replicates and serializes but renders as plain text.
    const marks = [
      ...this.marks,
      ...markDefs
        .map((mark) => mark.render)
        .filter((render): render is Mark => Boolean(render)),
    ];
    return new Schema(data, nodes, marks);
  }

  /**
   * Installs one reusable feature, such as math or tables, and returns a new
   * schema. A {@link FeatureExtension} adds nodes and marks the same way
   * `extend()` does, with the same exact types. It can also add typing rules,
   * paste handling, actions and theme defaults.
   *
   * ```ts
   * const callouts = {
   *   name: "callouts",
   *   nodes: [defineNode("callout")],
   * } as const satisfies FeatureExtension;
   *
   * const schema = baseSchema.use(callouts);
   * ```
   */
  // use() is the public composition boundary for extension packages. Keeping
  // use() and extend() separate prevents the low-level node/mark registration
  // API from becoming a framework-wide hook bag.
  use<const F extends FeatureExtension>(
    feature: F,
  ): Schema<MergeSchema<D, ExtensionDefinition<F>>> {
    const extended = this.extend(feature);
    return new Schema(
      extended.data.withFeatures(feature),
      extended.nodes,
      extended.marks,
    );
  }

  /**
   * Returns a new schema that limits which block and mark types the user can
   * create. It only blocks creating them. A blocked type that arrives from
   * another person or an older document still shows. Call it after `extend()`,
   * so your custom types exist first. It throws if a name is not in the schema,
   * or if `content` can never be met.
   *
   * Every way of making a blocked type is stopped: menu conversions, Enter,
   * Markdown shortcuts like `# `, and `change()` calls. Each one does nothing
   * or makes a plain paragraph instead. A blocked mark does nothing. Paste and
   * import are cut down to fit: a blocked heading pastes as plain text, and a
   * blocked image is dropped. Content already in the document is not changed.
   *
   * Edits from other people are never checked against it, so editors with
   * different limits (a locked title and a full body) still share one
   * document. To hide your own controls for blocked types, ask
   * `schema.data.isBlockAllowed(type)` and `schema.data.isMarkAllowed(type)`.
   *
   * ```ts
   * const titleSchema = baseSchema.restrict({ blocks: ["heading1"], marks: [] });
   * const editor = createEditor({ element, schema: titleSchema });
   * ```
   */
  restrict(restriction: SchemaRestriction<D>): Schema<D> {
    return new Schema(
      this.data.restrict(restriction) as DataSchema<D>,
      this.nodes,
      this.marks,
    );
  }
}

/** Extract the compile-time document definition carried by a {@link Schema}. */
export type SchemaDefinitionOf<S> = S extends Schema<infer D> ? D : never;

/**
 * Resolve a custom mark's serialization codec, keeping the {@link Mark} instance
 * the single source of truth for its facets (mirrors how `baseDataSchema` reads
 * `mark.codec` off the built-in mark instances). The render Mark's `codec` wins;
 * `defineMark`'s `codec` is the fallback for a *data-only* mark with no render
 * instance to carry one. Throws on an ambiguous setup — two disagreeing codecs,
 * or a render Mark whose `type` doesn't match the declared type — so a second
 * source of truth can't silently creep back in.
 */
function resolveMarkCodec(mark: MarkDef): MarkCodec | undefined {
  invariant(
    !mark.render || mark.render.type === mark.type,
    'defineMark("%s") was given a render Mark of type "%s" — the declared type and the Mark\'s type must match.',
    mark.type,
    mark.render?.type ?? "",
  );
  const renderCodec = mark.render?.codec;
  invariant(
    !(renderCodec && mark.codec && renderCodec !== mark.codec),
    'Mark "%s" declares a codec on both its render Mark and its defineMark config, and they differ. Keep the codec on the Mark (the single source of truth) and drop the defineMark codec.',
    mark.type,
  );
  return renderCodec ?? mark.codec;
}

/**
 * Normalize a `SchemaExtension.nodes` entry to a {@link BlockSpec}. A prebuilt
 * spec (from `defineNode`) passes through; a bare {@link Node} subclass instance
 * is turned into a leaf spec using its `type` and optional `static nodeConfig`,
 * via the same generator `defineNode` uses — so registering a class directly
 * and registering `defineNode(...)` produce identical data facets.
 */
function toBlockSpec(entry: BlockSpec | Node): BlockSpec {
  if (entry instanceof Node) {
    const config =
      (entry.constructor as { nodeConfig?: DefineNodeConfig }).nodeConfig ?? {};
    return buildLeafSpec(entry.type, config, entry);
  }
  return entry;
}

/**
 * The default schema: every built-in block and mark type, ready to draw.
 * Optional features such as math are not included. It has no `restrict()`
 * limits, so the user can create every type. `baseSchema` never changes.
 * Add types with `baseSchema.extend()` or `baseSchema.use()`, which return a
 * new schema.
 *
 * The blocks are `paragraph`, `heading1` to `heading3`, `bullet_list`,
 * `numbered_list`, `todo_list`, `quote`, `code`, `image` and `line`. The marks
 * are `strong`, `emphasis`, `strike`, `code` and `link`. Note the mark names:
 * `strong`, not bold; `emphasis`, not italic; `strike`, not strikethrough.
 *
 * The `code` block is the one type that is not drawn here. It still loads,
 * saves, syncs and exports, but it shows as a placeholder until you add
 * `codeExtension()` from `@tasfer/code`.
 */
// The node/mark instances come straight from defaultNodes() / defaultMarks()
// (the single source of truth for the core set), so this never drifts from
// them.
export const baseSchema: Schema<BaseSchemaDefinition> = new Schema(
  getBaseDataSchema(),
  defaultNodes(),
  defaultMarks(),
);

// ─── defineMark ──────────────────────────────────────────────────────────────

/**
 * Options for {@link defineMark}: how the custom mark looks on the canvas, how
 * it is written to and read from Markdown and HTML, and the data it carries.
 * Every field is optional.
 */
export interface DefineMarkConfig<
  A extends Record<string, unknown> = Record<string, never>,
> {
  /**
   * How the mark looks on the canvas: an instance of a {@link Mark} subclass.
   * Its `type` must match the name given to `defineMark`, or `extend()` throws.
   * Without `render`, the mark is still kept and synced but looks like plain
   * text. `extend()` adds it to the schema, so `createEditor` needs no `marks`
   * option.
   */
  readonly render?: Mark;
  /**
   * How the mark is written as Markdown and HTML, for example `==text==` and an
   * HTML tag. It is used only when the `render` Mark has no `codec` of its own.
   * If both have a codec and they differ, `extend()` throws. With no codec at
   * all, the mark stays in the document but is lost on Markdown export.
   */
  readonly codec?: MarkCodec;
  /**
   * Rules that find this mark's own delimiters when Markdown is read. These
   * are usually `scope: "inline"` rules. They only take effect when the mark's
   * codec lists matching `tokens`, so a custom rule needs a codec you write.
   */
  readonly markdownSyntax?: readonly SyntaxRule[];
  /**
   * For a mark whose content lives in its own nested document, such as inline
   * math. It tells the editor how to create that content, read its source, copy
   * it and clean it up. Most marks do not need it.
   *
   * Such a mark covers one placeholder character in the text. The nested
   * document is the only real copy of what it holds.
   */
  readonly structured?: StructuredMarkFacet;
  /**
   * The data this mark carries in `mark.attrs`, declared like node attributes,
   * for example `{ color: { default: "yellow" } }`. It is for TypeScript only:
   * it types `setMark` and `query.marks`. It does not set defaults or check
   * values at runtime.
   */
  readonly attrs?: A;
}

/**
 * Declares a custom inline mark. It returns a {@link MarkDef} to pass to
 * `baseSchema.extend({ marks })`, or to list in a {@link FeatureExtension}
 * you install with `use()`. Set `render` to choose how it looks, and `codec`
 * to save it as Markdown and HTML.
 *
 * With only a name, you get a format the user can turn on and off. It is kept
 * and synced, but draws as plain text and is lost on Markdown export.
 *
 * ```ts
 * const schema = baseSchema.extend({
 *   marks: [defineMark("highlight", { render: new HighlightMark() })], // your Mark subclass
 * });
 * const editor = createEditor({ element, schema }); // draws it, no `marks` option needed
 * ```
 */
export function defineMark<
  const T extends string,
  const A extends Record<string, unknown> = Record<string, never>,
>(type: T, config: DefineMarkConfig<A> = {}): MarkDef<T, InferAttrs<A>> {
  return {
    type,
    codec: config.codec,
    render: config.render,
    markdownSyntax: config.markdownSyntax,
    structured: config.structured,
  };
}

// ─── defineNode ──────────────────────────────────────────────────────────────

/** One declared attribute of a custom node. */
export interface AttrSpec<T = unknown> {
  /** Default value, applied when the block is created. */
  default?: T;
  /**
   * Checks a new value for this attribute. A value that fails is not applied.
   * By default any string, number or boolean passes.
   */
  validate?: (value: unknown) => boolean;
}

/**
 * Options for {@link defineNode}: the custom block's attributes, how it is
 * drawn (a styled box or your own node), and how it is written as Markdown,
 * HTML and plain text. A node class can supply the same fields as its
 * `static nodeConfig`.
 */
export interface DefineNodeConfig<
  A extends Record<string, AttrSpec> = Record<string, AttrSpec>,
> {
  /**
   * What the block holds. Only `"none"` is supported: the block has no text and
   * no child blocks.
   */
  content?: "none";
  /**
   * The block's attributes, by name. Each one is an {@link AttrSpec}. They sync
   * to other people like the rest of the document.
   *
   * TypeScript reads each attribute's type from its `default`. A `validate`
   * written as a type guard gives a narrower type, such as
   * `(v): v is "note" | "warn" => v === "note" || v === "warn"`.
   */
  attrs?: A;
  /**
   * Extra group names for this block type, used in a `restrict({ content })`
   * expression. Custom blocks are already in the `block` and `void` groups.
   * Give several types one group to name them all at once, as in `"heading1
   * card+"`.
   */
  groups?: readonly string[];
  /**
   * Style for the generated {@link BoxNode}: background, border, left accent
   * bar and label. Ignored when `node` is supplied.
   */
  render?: BoxRenderStyle;
  /**
   * A custom Node to render with, instead of the generated BoxNode. It does its
   * own drawing, hit testing and overlays.
   */
  node?: Node;
  /**
   * Rules that find this block's own syntax when Markdown is read. These are
   * usually `scope: "block"` rules. They only take effect when `node` has its
   * own `codec` whose `markdown.tokens` match.
   * The default `<x-type />` tag format does not use them.
   */
  markdownSyntax?: readonly SyntaxRule[];
  /**
   * Writes the block as Markdown. By default it writes a tag such as
   * `<x-callout tone="note" />`, which loads back as the same block. If you
   * override it, make sure the result still loads back. If `node` (or a node
   * class you register) has its own `codec` and you also set `toMarkdown`,
   * `toHtml` or `toText`, it throws.
   */
  toMarkdown?: (block: CustomBlock) => string;
  /** HTML output. Defaults to the same generic tag. */
  toHtml?: (block: CustomBlock) => string;
  /** Plain-text output. Defaults to empty (void block). */
  toText?: (block: CustomBlock) => string;
}

const VOID_CAPS: BlockCapabilities = {
  hasText: false,
  hasFormats: false,
  indentable: false,
  togglable: false,
};

function defaultAttrValidate(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Coerce an HTML attribute string back to the type implied by its default. */
function coerceAttr(raw: string, def: unknown): unknown {
  if (typeof def === "number") return Number(raw);
  if (typeof def === "boolean") return raw === "true";
  return raw;
}

/**
 * Defines a custom block type with no text, such as a callout box or an embed.
 * You choose its attributes, how it draws, and how it is saved as Markdown,
 * HTML and plain text. Pass the result to `baseSchema.extend({ nodes })`, or
 * list it in a {@link FeatureExtension} you install with `use()`. With no
 * serialization of your own, it is saved as a `<x-type …attrs />` tag that
 * loads back as the same block.
 *
 * There are two ways to write one, and both give the same result:
 *
 * ```ts
 * // 1. Config: a styled box, no drawing code.
 * const callout = defineNode("callout", {
 *   attrs: { tone: { default: "note" } },
 *   render: { background: "rgba(0,0,0,0.04)", borderLeft: { width: 3, color: "#1db984" } },
 * });
 * const schema = baseSchema.extend({ nodes: [callout] });
 *
 * // 2. Class: your own node draws it. `static nodeConfig` takes the same
 * //    fields as the config above.
 * class Callout extends AtomicNode {
 *   readonly type = "callout";
 *   static nodeConfig = { attrs: { tone: { default: "note" } } };
 *   protected intrinsicHeight() { return 48; }
 *   protected draw(box, c) { … }
 * }
 * const schema = baseSchema.extend({ nodes: [new Callout()] });
 * ```
 */
export function defineNode<
  const T extends string,
  const A extends Record<string, AttrSpec> = Record<string, never>,
>(type: T, config: DefineNodeConfig<A> = {}): BlockSpec<T, InferAttrs<A>> {
  return buildLeafSpec(
    type,
    config,
    config.node ?? new BoxNode(type, config.render ?? {}),
  );
}

/** Whether a node carries its own markdown/HTML/text round-trip codec. */
function nodeHasSerialization(node: Node): boolean {
  return Boolean(node.codec);
}

/**
 * Build the leaf {@link BlockSpec} (descriptor + serialization codec) for
 * `type`, rendered by the supplied `node`. Shared by `defineNode` (which picks
 * a BoxNode or `config.node`) and class-first registration (which passes the
 * Node subclass instance). The `render`/`node` fields of `config` are ignored
 * here — node selection is the caller's job.
 *
 * The codec follows the node: a node that declares its own `codec` IS the
 * source of truth, adapted via {@link codecFromNode} exactly as the built-in
 * nodes are in `baseDataSchema`.
 * Only when the node provides none do we synthesize the generic `<x-type … />`
 * round-trip (the BoxNode / config style). Supplying both a serializing node and
 * a `defineNode` `toMarkdown`/`toHtml`/`toText` override is rejected, so the node
 * can't be quietly overruled by a second source.
 */
function buildLeafSpec<T extends string, A extends Record<string, AttrSpec>>(
  type: T,
  config: DefineNodeConfig<A>,
  node: Node,
): BlockSpec<T, InferAttrs<A>> {
  const attrs: Record<string, AttrSpec> = config.attrs ?? {};
  const attrNames = Object.keys(attrs);

  // ── CRDT descriptor ───────────────────────────────────────────────────────
  const fields: Record<string, FieldDescriptor> = {
    type: {
      validate: (value) => value === type,
      extractForInverse: (block) => block.type,
    },
  };
  for (const name of attrNames) {
    const spec = attrs[name];
    fields[name] = {
      validate: spec.validate ?? defaultAttrValidate,
      extractForInverse: (block) =>
        (block as unknown as Record<string, unknown>)[name],
    };
  }

  const descriptor: BlockTypeDescriptor = {
    type: type as BlockTypeDescriptor["type"],
    capabilities: VOID_CAPS,
    defaults: (id, orderKey) => {
      const block: CustomBlock = { id, orderKey, deleted: false, type };
      for (const name of attrNames) {
        if (attrs[name].default !== undefined) {
          block[name] = attrs[name].default;
        }
      }
      return asBlock(block);
    },
    fields,
    // No `morphGroup` on VOID_CAPS → a custom leaf only morphs to itself, the
    // same self-only behavior the old `textPreservingMorphs: [type]` gave.
  };

  // ── Serialization codec ───────────────────────────────────────────────────
  // A node that owns its round-trip is the source of truth (adapted the same
  // way `baseDataSchema` adapts the built-ins). Otherwise synthesize the generic
  // HTML-tag round-trip from the declared attrs.
  let codec: BlockCodec;
  if (nodeHasSerialization(node)) {
    invariant(
      !(config.toMarkdown || config.toHtml || config.toText),
      'Block type "%s" supplies its own serialization methods AND a defineNode toMarkdown/toHtml/toText override. Remove one so the node stays the single source of truth for its serialization.',
      type,
    );
    // The node's `codec` is a complete NodeCodec (its markdown/html/text output
    // channels are non-optional); `codecFromNode` only injects the node's types.
    codec = codecFromNode(node);
  } else {
    codec = buildGenericTagCodec(type, config, attrs, attrNames);
  }

  return {
    type,
    descriptor,
    codec,
    markdownSyntax: config.markdownSyntax,
    groups: config.groups,
    node,
  };
}

/**
 * The generic `<x-type … />` markdown/HTML round-trip for a leaf node that
 * brings no serialization of its own (the BoxNode / config style). A
 * self-closing tag (like the built-in `<img/>`) round-trips as a single token,
 * vs an open+close pair that would leave the closing tag as a stray paragraph.
 */
function buildGenericTagCodec(
  type: string,
  config: DefineNodeConfig,
  attrs: Record<string, AttrSpec>,
  attrNames: readonly string[],
): BlockCodec {
  const tagName = `x-${type.toLowerCase()}`;
  const renderTag = (block: Block): string => {
    const b = block as unknown as Record<string, unknown>;
    let out = `<${tagName}`;
    for (const name of attrNames) {
      const v = b[name];
      if (v === undefined || v === null) continue;
      out += ` ${name}="${escapeAttr(String(v))}"`;
    }
    return `${out} />`;
  };

  return {
    types: [type],
    markdown: {
      output: config.toMarkdown
        ? (block) => config.toMarkdown!(block as unknown as CustomBlock)
        : (block) => renderTag(block),
      htmlTags: [tagName],
      inputTag: (tag: ParsedTag, ctx: InputCtx): Block => {
        const block: CustomBlock = {
          id: ctx.nextBlockId(),
          // Placeholder — the caller (parser / clipboard) assigns the real
          // fractional-index key once the full block sequence is known.
          orderKey: "",
          deleted: false,
          type,
        };
        for (const name of attrNames) {
          const raw = tag.attrs[name.toLowerCase()];
          if (raw !== undefined) {
            block[name] = coerceAttr(raw, attrs[name].default);
          } else if (attrs[name].default !== undefined) {
            block[name] = attrs[name].default;
          }
        }
        return asBlock(block);
      },
    },
    html: {
      output: config.toHtml
        ? (block) => config.toHtml!(block as unknown as CustomBlock)
        : (block) => renderTag(block),
    },
    text: {
      output: config.toText
        ? (block) => config.toText!(block as unknown as CustomBlock)
        : () => "",
    },
  };
}
