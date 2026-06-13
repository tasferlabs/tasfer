/**
 * DataSchema — the canvas-free half of a document schema.
 *
 * A schema is the per-instance bundle of "what block and mark types this
 * document is made of." It has two halves so the sync/fuzz import graph never
 * pulls in canvas code (the same split that keeps the block-registry and the
 * codecs out of the rendering layer):
 *
 *   - DataSchema (this file) — the CRDT + serialization facets: per-type
 *     descriptors (defaults, validators, capabilities, morph targets) and
 *     codecs (markdown/html/text round-trip). Consumed by the Doc, the
 *     reducer, the parser, and the serializers.
 *   - Schema (../schema, canvas) — DataSchema plus a NodeRegistry (the
 *     rendering facet). Consumed by the editor/renderer only.
 *
 * `baseDataSchema` is an immutable module-level value built from the built-in
 * block types — configuration, not shared mutable state, so two editors on
 * the same page can hold different schemas without clobbering each other
 * (the same guarantee BLOCK_REGISTRY and the codec tables already provide).
 * Custom types are added with `extend()`, which returns a NEW immutable
 * schema; nothing is ever mutated in place.
 */

import { ALL_CODECS, type BlockCodec } from "../serlization/codecs";
import {
  BUILTIN_MARK_CODECS,
  type MarkCodec,
} from "../serlization/codecs/mark-codec";
import type { Block } from "../serlization/loadPage";
import type { TokenType } from "../serlization/tokenizer";
import { BLOCK_REGISTRY, type BlockTypeDescriptor } from "./block-registry";

/** The built-in inline mark types (Mark.type values). */
export const BUILTIN_MARK_TYPES: readonly string[] = [
  "strong",
  "emphasis",
  "strike",
  "code",
  "link",
  "math",
];

/**
 * The CRDT + serialization facets of one block type, bundled. The rendering
 * facet (the canvas Node) is added separately by the full Schema so this stays
 * canvas-free.
 */
export interface BlockSpecCore {
  readonly type: string;
  readonly descriptor: BlockTypeDescriptor;
  readonly codec: BlockCodec;
}

/** A declared inline mark (bold, a custom highlight, …). */
export interface MarkSpec {
  readonly type: string;
  /** Markdown serialization facet — wrap on output, paired tokens on input. */
  readonly codec?: MarkCodec;
}

export interface DataSchemaExtension {
  readonly blocks?: readonly BlockSpecCore[];
  readonly marks?: readonly MarkSpec[];
}

/**
 * Immutable per-instance schema (canvas-free). Build the default with
 * `baseDataSchema`; derive variants with `extend()`.
 */
export class DataSchema {
  private readonly blocks: ReadonlyMap<string, BlockSpecCore>;
  private readonly marks: ReadonlyMap<string, MarkSpec>;
  /** Block-start token → codec, derived from each block's markdown.tokens. */
  readonly tokenDispatch: ReadonlyMap<TokenType, BlockCodec>;
  /** HTML tag (lowercase) → codec, derived from each block's markdown.htmlTags. */
  readonly htmlTagDispatch: ReadonlyMap<string, BlockCodec>;
  /** Inline-mark open-token → mark type, derived from each mark codec's tokens. */
  private readonly markStartTokens: ReadonlyMap<TokenType, string>;
  /** Inline-mark close-token → mark type. */
  private readonly markEndTokens: ReadonlyMap<TokenType, string>;

  constructor(
    blockSpecs: readonly BlockSpecCore[],
    markSpecs: readonly MarkSpec[],
  ) {
    const blocks = new Map<string, BlockSpecCore>();
    const tokenDispatch = new Map<TokenType, BlockCodec>();
    const htmlTagDispatch = new Map<string, BlockCodec>();
    for (const spec of blockSpecs) {
      // One spec → one block type with one descriptor. A codec may BACK a
      // family of types (text, list), but each member type carries its own
      // descriptor/spec — so register only `spec.type` here, never the codec's
      // whole `types` set (that would clobber sibling descriptors).
      blocks.set(spec.type, spec);
      for (const token of spec.codec.markdown.tokens ?? []) {
        tokenDispatch.set(token, spec.codec);
      }
      for (const tag of spec.codec.markdown.htmlTags ?? []) {
        htmlTagDispatch.set(tag.toLowerCase(), spec.codec);
      }
    }
    const marks = new Map<string, MarkSpec>();
    const markStartTokens = new Map<TokenType, string>();
    const markEndTokens = new Map<TokenType, string>();
    for (const mark of markSpecs) {
      marks.set(mark.type, mark);
      const tokens = mark.codec?.tokens;
      if (tokens) {
        markStartTokens.set(tokens.start, mark.type);
        markEndTokens.set(tokens.end, mark.type);
      }
    }

    this.blocks = blocks;
    this.marks = marks;
    this.tokenDispatch = tokenDispatch;
    this.htmlTagDispatch = htmlTagDispatch;
    this.markStartTokens = markStartTokens;
    this.markEndTokens = markEndTokens;
  }

  /** Whether a block type is known to this schema. */
  hasBlock(type: string): boolean {
    return this.blocks.has(type);
  }

  getDescriptor(type: string): BlockTypeDescriptor | undefined {
    return this.blocks.get(type)?.descriptor;
  }

  getCodec(type: string): BlockCodec | undefined {
    return this.blocks.get(type)?.codec;
  }

  /**
   * Parser fallback codec — claims any block start no other codec handles
   * (plain paragraph text). The `paragraph` codec, by convention.
   */
  getFallbackCodec(): BlockCodec | undefined {
    return this.getCodec("paragraph");
  }

  /** The list family of a block type, or undefined for non-list blocks. */
  listKind(type: string): "bullet" | "numbered" | "todo" | undefined {
    return this.getDescriptor(type)?.capabilities.listKind;
  }

  /** Every mark type this schema declares. */
  hasMark(type: string): boolean {
    return this.marks.has(type);
  }

  /** The markdown serialization codec for a mark type, if any. */
  getMarkCodec(type: string): MarkCodec | undefined {
    return this.marks.get(type)?.codec;
  }

  /** The mark type a paired-delimiter open token introduces, if any. */
  markTypeForStartToken(token: TokenType): string | undefined {
    return this.markStartTokens.get(token);
  }

  /** The mark type a paired-delimiter close token ends, if any. */
  markTypeForEndToken(token: TokenType): string | undefined {
    return this.markEndTokens.get(token);
  }

  // ── Capability queries (sourced from the per-type descriptor) ──────────────

  isTextual(type: string): boolean {
    return this.getDescriptor(type)?.capabilities.hasText ?? false;
  }

  hasFormats(type: string): boolean {
    return this.getDescriptor(type)?.capabilities.hasFormats ?? false;
  }

  isIndentable(type: string): boolean {
    return this.getDescriptor(type)?.capabilities.indentable ?? false;
  }

  isTogglable(type: string): boolean {
    return this.getDescriptor(type)?.capabilities.togglable ?? false;
  }

  // ── CRDT operations the reducer routes through ─────────────────────────────

  /**
   * Construct a default block of `type`, or `undefined` when the type is not
   * in this schema (the reducer treats that as "drop the op, keep the data" —
   * a peer may legitimately send a type we don't have registered yet).
   */
  createDefaultBlock(
    type: string,
    id: string,
    afterId: string | null,
  ): Block | undefined {
    return this.getDescriptor(type)?.defaults(id, afterId);
  }

  validateField(type: string, field: string, value: unknown): boolean {
    const descriptor = this.getDescriptor(type);
    if (!descriptor) return false;
    const fieldDescriptor = descriptor.fields[field];
    return fieldDescriptor ? fieldDescriptor.validate(value) : false;
  }

  canMorphTo(from: string, to: string): boolean {
    const descriptor = this.getDescriptor(from);
    return descriptor
      ? (descriptor.textPreservingMorphs as readonly string[]).includes(to)
      : false;
  }

  /**
   * Derive a new schema with extra block/mark types. Later definitions win on
   * key collision, so a host can override a built-in. The receiver is never
   * mutated.
   */
  extend(ext: DataSchemaExtension): DataSchema {
    const blocks = [...this.blockSpecs(), ...(ext.blocks ?? [])];
    const marks = [...this.markSpecs(), ...(ext.marks ?? [])];
    return new DataSchema(blocks, marks);
  }

  /** The block specs this schema was built from (deduped by primary type). */
  blockSpecs(): BlockSpecCore[] {
    const seen = new Set<string>();
    const out: BlockSpecCore[] = [];
    for (const spec of this.blocks.values()) {
      if (seen.has(spec.type)) continue;
      seen.add(spec.type);
      out.push(spec);
    }
    return out;
  }

  markSpecs(): MarkSpec[] {
    return [...this.marks.values()];
  }
}

/** Pair each built-in descriptor with the codec that claims its type. */
function buildBaseBlockSpecs(): BlockSpecCore[] {
  const codecByType = new Map<string, BlockCodec>();
  for (const codec of ALL_CODECS) {
    for (const type of codec.types) codecByType.set(type, codec);
  }
  const specs: BlockSpecCore[] = [];
  for (const descriptor of Object.values(BLOCK_REGISTRY)) {
    const codec = codecByType.get(descriptor.type);
    if (!codec) continue;
    specs.push({ type: descriptor.type, descriptor, codec });
  }
  return specs;
}

/**
 * The default schema: every built-in block and mark type. Immutable — derive
 * variants with `baseDataSchema.extend(...)`, never mutate this.
 */
export const baseDataSchema: DataSchema = new DataSchema(
  buildBaseBlockSpecs(),
  BUILTIN_MARK_TYPES.map((type) => ({
    type,
    codec: BUILTIN_MARK_CODECS[type],
  })),
);
