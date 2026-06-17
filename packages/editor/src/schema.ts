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
 * built-in set. Schemas are immutable — `extend()` returns a new one — so two
 * editors can hold different schemas on the same page (the project's
 * no-shared-mutable-state rule).
 *
 * v1 scope: custom block types are LEAF, void nodes (no text content, no
 * nested blocks). They serialize through the generic `<x-type …>` HTML-tag
 * round-trip, so no tokenizer changes are needed. Text-bearing and
 * block-containing custom nodes are future steps — see docs/editor/custom-nodes.
 */

import { baseDataSchema } from "./baseDataSchema";
import { defaultMarks, Mark } from "./rendering/marks";
import { defaultNodes } from "./rendering/nodes";
import { BoxNode, type BoxRenderStyle } from "./rendering/nodes/BoxNode";
import { Node } from "./rendering/nodes/Node";
import {
  type BlockCodec,
  type InputCtx,
  type ParsedTag,
} from "./serlization/codecs";
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

/** A full block spec: the canvas-free facets plus the rendering Node. */
export interface BlockSpec extends BlockSpecCore {
  readonly node: Node;
}

/**
 * A full mark spec: the canvas-free data facet ({@link MarkSpec}) plus the
 * rendering {@link Mark}. The inline analogue of {@link BlockSpec} — `render` is
 * the mark's on-canvas paint, stripped before the spec reaches the canvas-free
 * `DataSchema`. Omit `render` for a data-only mark (it replicates and serializes
 * but paints as plain text).
 */
export interface MarkDef extends MarkSpec {
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
 * An immutable editor schema: the data facets (`data`) plus the nodes the
 * editor renders (`nodes`). Build the default with `baseSchema`, derive
 * variants with `extend()`.
 */
export class Schema {
  readonly data: DataSchema;
  readonly nodes: readonly Node[];
  readonly marks: readonly Mark[];

  constructor(
    data: DataSchema,
    nodes: readonly Node[],
    marks: readonly Mark[],
  ) {
    this.data = data;
    this.nodes = nodes;
    this.marks = marks;
  }

  /** Derive a new schema with extra custom node and mark types. */
  extend(ext: SchemaExtension): Schema {
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
      // block path drops `node` before reaching `this.data.extend`).
      marks: markDefs.map(({ type, codec }): MarkSpec => ({ type, codec })),
    });
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
 * The default schema — every built-in block and mark type, and the built-in
 * nodes. The node/mark instances come straight from `defaultNodes()` /
 * `defaultMarks()` (the single source of truth for the built-in set), so this
 * never drifts from them. Immutable; derive variants with `baseSchema.extend(...)`.
 */
export const baseSchema: Schema = new Schema(
  baseDataSchema,
  defaultNodes(),
  defaultMarks(),
);

// ─── defineMark ──────────────────────────────────────────────────────────────

export interface DefineMarkConfig {
  /**
   * On-canvas appearance — a {@link Mark} subclass instance. Omit and the mark
   * still replicates and serializes, but paints as plain text. Folded into the
   * schema's render list by `extend()`, so no separate `createEditor({ marks })`
   * is needed.
   */
  readonly render?: Mark;
  /**
   * Markdown/HTML round-trip. Omit and the mark survives only via the CRDT (the
   * source of truth) — it's dropped on markdown export. Provide a codec to give
   * it delimiters (`==text==`) and an HTML tag.
   */
  readonly codec?: MarkCodec;
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
export function defineMark(
  type: string,
  config: DefineMarkConfig = {},
): MarkDef {
  return { type, codec: config.codec, render: config.render };
}

// ─── defineNode ──────────────────────────────────────────────────────────────

/** One declared attribute of a custom node. */
export interface AttrSpec {
  /** Default value, applied when the block is created. */
  default?: unknown;
  /** Validate a value before a `block_set` is accepted. Default: string/number/boolean. */
  validate?: (value: unknown) => boolean;
}

export interface DefineNodeConfig {
  /**
   * What the node contains. v1 supports only `"none"` (a leaf void block).
   * Declared explicitly so the value reads as a deliberate choice.
   */
  content?: "none";
  /** Declared attributes (replicated as top-level fields via `block_set`). */
  attrs?: Record<string, AttrSpec>;
  /** Style for the generated {@link BoxNode}. Ignored when `node` is supplied. */
  render?: BoxRenderStyle;
  /** A custom Node to render with, instead of the generated BoxNode. */
  node?: Node;
  /**
   * Markdown output. Defaults to the generic `<x-type …attrs>` round-trip that
   * `parseMarkdown` (also generated) reads back. Override only if you also
   * ensure the result re-parses.
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
export function defineNode(
  type: string,
  config: DefineNodeConfig = {},
): BlockSpec {
  return buildLeafSpec(
    type,
    config,
    config.node ?? new BoxNode(type, config.render ?? {}),
  );
}

/**
 * Build the leaf {@link BlockSpec} (descriptor + generic round-trip codec) for
 * `type`, rendered by the supplied `node`. Shared by `defineNode` (which picks
 * a BoxNode or `config.node`) and class-first registration (which passes the
 * Node subclass instance). The `render`/`node` fields of `config` are ignored
 * here — node selection is the caller's job.
 */
function buildLeafSpec(
  type: string,
  config: DefineNodeConfig,
  node: Node,
): BlockSpec {
  const attrs = config.attrs ?? {};
  const attrNames = Object.keys(attrs);
  const tagName = `x-${type.toLowerCase()}`;

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
    defaults: (id, afterId) => {
      const block: CustomBlock = { id, afterId, deleted: false, type };
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

  // ── Serialization codec (generic HTML-tag round-trip) ─────────────────────
  // Self-closing tag (like the built-in <img/>): a single token the
  // tokenizer/parser round-trips, vs an open+close pair that would leave the
  // closing tag as a stray paragraph.
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

  const codec: BlockCodec = {
    types: [type],
    markdown: {
      output: config.toMarkdown
        ? (block) => config.toMarkdown!(block as unknown as CustomBlock)
        : (block) => renderTag(block),
      htmlTags: [tagName],
      inputTag: (tag: ParsedTag, ctx: InputCtx): Block => {
        const block: CustomBlock = {
          id: ctx.nextBlockId(),
          afterId: null,
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

  return { type, descriptor, codec, node };
}
