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
 * block-containing custom nodes are future steps — see docs/editor/custom-nodes.
 */

import { getBaseDataSchema } from "./baseDataSchema";
import type { FeatureFacets } from "./feature-facets";
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
} from "./sync/schema";
import { invariant } from "@shared/invariant";

/** A full block spec: the canvas-free facets plus the rendering Node. */
export interface BlockSpec<
  T extends string = string,
  A extends Record<string, unknown> = Record<string, unknown>,
> extends BlockSpecCore<T, A> {
  readonly node: Node;
}

/**
 * A full mark spec: the canvas-free data facet ({@link MarkSpec}) plus the
 * rendering {@link Mark}. The inline analogue of {@link BlockSpec} — `render` is
 * the mark's on-canvas paint, stripped before the spec reaches the canvas-free
 * `DataSchema`. Omit `render` for a data-only mark (it replicates and serializes
 * but paints as plain text).
 */
export interface MarkDef<
  T extends string = string,
  A extends Record<string, unknown> = Record<string, unknown>,
> extends MarkSpec<T, A> {
  readonly render?: Mark;
}

export interface SchemaExtension {
  /**
   * Custom block types to add. Each entry is either a {@link BlockSpec} (built
   * by `defineNode`) or — the class-first style — a {@link Node} subclass
   * instance that carries its own facets: its `type`, optional `static
   * nodeConfig` (attrs + serialization), plus its draw/overlays/strings. A bare
   * Node is normalized to a leaf BlockSpec with the same generic round-trip
   * `defineNode` produces, so both styles are interchangeable.
   */
  readonly nodes?: readonly (BlockSpec | Node)[];
  /**
   * Custom inline marks to add, built by `defineMark`. Each {@link MarkDef}
   * carries the data facet (CRDT type + optional serialization codec) and,
   * optionally, the rendering {@link Mark} — `extend()` folds the render facet
   * into the schema's mark list so `createEditor({ schema })` paints it without
   * a separate `marks` option.
   */
  readonly marks?: readonly MarkDef[];
}

/**
 * A reusable editor feature installed with {@link Schema.use}.
 *
 * A feature contributes the block-node and inline-mark facets accepted by the
 * lower-level {@link Schema.extend} API plus schema-scoped input, Markdown,
 * action, and theme facets. This distinct public shape is the stable composition
 * boundary for extension packages; new feature capabilities can be added here
 * without changing how consumers install them.
 *
 * `name` is optional metadata for tooling and diagnostics. Composition is
 * structural and immutable; a name is not a global registration key and does
 * not cause features to be deduplicated.
 *
 * Preserve literal node and mark types when exporting a feature by using
 * `satisfies` rather than widening the value with a type annotation:
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
export interface FeatureExtension extends SchemaExtension, FeatureFacets {
  readonly name?: string;
}

/**
 * The authoring allow-list passed to {@link Schema.restrict}. Names are the
 * schema's own registered block/mark types (so they autocomplete). Omit a key to
 * leave that dimension unrestricted; `marks: []` yields a format-free field. The
 * fallback block type (`paragraph`) is always kept creatable and need not be
 * listed. The full registry is preserved — a restricted editor still RENDERS a
 * disallowed type that arrives via sync or an older document; it only stops the
 * local user from creating one.
 *
 *   const titleSchema = baseSchema.restrict({ blocks: ["heading1"], marks: [] });
 */
export interface SchemaRestriction<
  D extends SchemaDefinition = BaseSchemaDefinition,
> {
  readonly blocks?: readonly BlockName<D>[];
  readonly marks?: readonly MarkNameOf<D>[];
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
 * An immutable editor schema: the data facets (`data`) plus the nodes the
 * editor renders (`nodes`). Build the default with `baseSchema`, derive
 * variants with `extend()` or compose reusable features with `use()`.
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

  /** Derive a new schema with extra custom node and mark types. */
  extend<const E extends SchemaExtension>(
    ext: E,
  ): Schema<MergeSchema<D, ExtensionDefinition<E>>> {
    // Normalize both authoring styles (a prebuilt BlockSpec, or a bare Node
    // subclass instance registered directly) to a single BlockSpec list.
    const specs = ext.nodes?.map(toBlockSpec) ?? [];
    const markDefs = ext.marks ?? [];
    const data = this.data.extend({
      blocks: specs.map(
        ({ type, descriptor, codec }): BlockSpecCore => ({
          type,
          descriptor,
          codec,
        }),
      ),
      // Strip the render facet — DataSchema stays canvas-free (mirrors how the
      // block path drops `node` before reaching `this.data.extend`). The codec
      // is resolved from the render Mark when present (the Mark is the single
      // source of truth for its facets); `defineMark`'s `codec` is the fallback
      // only for a data-only mark with no render instance to carry it.
      marks: markDefs.map(
        (mark): MarkSpec => ({
          type: mark.type,
          codec: resolveMarkCodec(mark),
        }),
      ),
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
   * Install one reusable feature and return a new schema.
   *
   * `use()` is the public composition boundary for extension packages. Today a
   * {@link FeatureExtension} registers nodes and marks through the same
   * normalization as {@link extend}, including exact schema type inference, then
   * installs its cross-type facets on the derived data schema. Keeping the
   * methods separate prevents the low-level node/mark registration API from
   * becoming a framework-wide hook bag.
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
   * Derive a schema that restricts which registered types the local user may
   * author — the ProseMirror-style whitelist. Rendering is untouched (the same
   * nodes/marks), so this only gates creation: a restricted editor still paints
   * a disallowed block that arrives via sync or an older document. Immutable —
   * returns a new schema. Apply after `extend()` (register types first, then
   * restrict).
   *
   *   const titleSchema = baseSchema.restrict({ blocks: ["heading1"], marks: [] });
   *   const editor = createEditor({ element, schema: titleSchema });
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
 * The default schema — every core block and mark type, and the core nodes.
 * Optional features such as math are absent. The node/mark instances come
 * straight from `defaultNodes()` / `defaultMarks()` (the single source of truth
 * for the core set), so this
 * never drifts from them. Immutable; derive variants with `baseSchema.extend(...)`.
 */
export const baseSchema: Schema<BaseSchemaDefinition> = new Schema(
  getBaseDataSchema(),
  defaultNodes(),
  defaultMarks(),
);

// ─── defineMark ──────────────────────────────────────────────────────────────

export interface DefineMarkConfig<
  A extends Record<string, unknown> = Record<string, never>,
> {
  /**
   * On-canvas appearance — a {@link Mark} subclass instance. Omit and the mark
   * still replicates and serializes, but paints as plain text. Folded into the
   * schema's render list by `extend()`, so no separate `createEditor({ marks })`
   * is needed.
   */
  readonly render?: Mark;
  /**
   * Markdown/HTML round-trip for a *data-only* mark (one with no `render` Mark).
   * When `render` is supplied, its `codec` is authoritative and this is ignored
   * (set both to disagreeing codecs and `extend()` throws) — the Mark instance is
   * the single source of truth for its facets. Omit on a data-only mark and it
   * survives only via the CRDT, dropped on markdown export; provide one to give
   * it delimiters (`==text==`) and an HTML tag.
   */
  readonly codec?: MarkCodec;
  /**
   * Compile-time declaration of data carried in `mark.attrs`. Runtime mark
   * validation remains owned by the mark/action using it; this declaration
   * makes `ChangeApi.setMark` and `query.marks` schema-aware.
   */
  readonly attrs?: A;
}

/**
 * Declare an inline mark. Returns a {@link MarkDef} for `baseSchema.extend({
 * marks })` — carrying the data facet (the mark type), and optionally how it
 * paints (`render`) and serializes (`codec`):
 *
 *   const schema = baseSchema.extend({
 *     marks: [defineMark("highlight", { render: new HighlightMark() })],
 *   });
 *   const editor = createEditor({ element, schema }); // paints, no `marks` option
 */
export function defineMark<
  const T extends string,
  const A extends Record<string, unknown> = Record<string, never>,
>(type: T, config: DefineMarkConfig<A> = {}): MarkDef<T, InferAttrs<A>> {
  return { type, codec: config.codec, render: config.render };
}

// ─── defineNode ──────────────────────────────────────────────────────────────

/** One declared attribute of a custom node. */
export interface AttrSpec<T = unknown> {
  /** Default value, applied when the block is created. */
  default?: T;
  /** Validate a value before a `block_set` is accepted. Default: string/number/boolean. */
  validate?: (value: unknown) => boolean;
}

export interface DefineNodeConfig<
  A extends Record<string, AttrSpec> = Record<string, AttrSpec>,
> {
  /**
   * What the node contains. v1 supports only `"none"` (a leaf void block).
   * Declared explicitly so the value reads as a deliberate choice.
   */
  content?: "none";
  /** Declared attributes (replicated as top-level fields via `block_set`). */
  attrs?: A;
  /** Style for the generated {@link BoxNode}. Ignored when `node` is supplied. */
  render?: BoxRenderStyle;
  /** A custom Node to render with, instead of the generated BoxNode. */
  node?: Node;
  /**
   * Markdown output for the generic box/config style. Defaults to the generic
   * `<x-type …attrs>` round-trip that `parseMarkdown` (also generated) reads
   * back. Override only if you also ensure the result re-parses. Rejected when
   * the supplied `node` implements its own serialization methods — that node is
   * the source of truth, so the two can't both be set.
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
 * Define a custom leaf block type — its CRDT shape, its markdown/HTML/text
 * round-trip, and how it draws. Two interchangeable authoring styles:
 *  ```ts
 *   // 1. Config style — a styled box with no canvas code:
 *   const callout = defineNode("callout", {
 *     attrs: { tone: { default: "note" } },
 *     render: { background: "rgba(0,0,0,0.04)", borderLeft: { width: 3, color: "#1db984" } },
 *   });
 *   const schema = baseSchema.extend({ nodes: [callout] });
 *
 *   // 2. Class-first style — subclass a Node and register it directly. The
 *   //    class owns its draw/overlays/strings; `static nodeConfig` supplies
 *   //    attrs + serialization (same fields as this config):
 *   class Callout extends AtomicNode {
 *     readonly type = "callout";
 *     static nodeConfig = { attrs: { tone: { default: "note" } } };
 *     protected intrinsicHeight() { return 48; }
 *     protected draw(box, c) {  ... }
 *   }
 *   const schema = baseSchema.extend({ nodes: [new Callout()] });
 *   ```
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

  return { type, descriptor, codec, node };
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
