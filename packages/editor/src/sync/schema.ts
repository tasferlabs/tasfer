/**
 * DataSchema — the canvas-free half of a document schema, and the single
 * dispatch surface for extension facets.
 *
 * A schema is the per-instance bundle of "what block and mark types this
 * document is made of." It has two halves so the sync/fuzz import graph never
 * pulls in canvas code (the same split that keeps the block-registry and the
 * codecs out of the rendering layer):
 *
 *   - DataSchema (this file) — the CRDT + serialization facets: per-type
 *     descriptors (defaults, validators, capabilities, morph targets), codecs
 *     (markdown/html/text round-trip), and every extension facet a spec
 *     carries (markdown syntax rules, structured-mark behavior, structured
 *     document-kind adapters). Consumed by the Doc, the reducer, the parser,
 *     and the serializers.
 *   - Schema (../schema, canvas) — DataSchema plus a NodeRegistry (the
 *     rendering facet). Consumed by the editor/renderer only.
 *
 * Facet dispatch is DERIVED from the registered specs on every construction —
 * from the already-deduped type maps, so overriding a spec replaces its facets
 * wholesale, and every derivation path (`extend`, `restrict`, `withFeatures`,
 * direct construction) yields the same dispatch for the same specs. Only the
 * genuinely cross-type facets (live-input rules, action hooks, theme
 * defaults) are installed separately with `withFeatures()` and threaded
 * through derivations unchanged.
 *
 * `baseDataSchema` is an immutable module-level value built from the built-in
 * block types — configuration, not shared mutable state, so two editors on
 * the same page can hold different schemas without clobbering each other
 * (the same guarantee BLOCK_REGISTRY and the codec tables already provide).
 * Custom types are added with `extend()`, which returns a NEW immutable
 * schema; nothing is ever mutated in place.
 */

import type { ActionBus, StateResult } from "../action-bus";
import {
  type ContentSelectionResolver,
  type ContentSelectionSerializer,
  type ContentSelectionSlice,
  type FeatureActionHook,
  type FeatureFacetSource,
  type FeatureInputPhase,
  type FeatureInputRule,
  type FeatureInputRuleCtx,
  type FeatureThemeDefaults,
  orderedFacets,
  type ResolvedFeatureThemeDefaults,
  resolveFeatureThemeDefaults,
  type StructuredContentClone,
  type StructuredContentCloneCtx,
  type StructuredContentCloneResult,
  type StructuredMarkCloneCtx,
  type StructuredMarkCreateCtx,
  type StructuredMarkCreateResult,
  type StructuredMarkFacet,
  type StructuredMarkResolveCtx,
  type SyntaxCtx,
  type SyntaxMatch,
  type SyntaxRule,
  upsertFacetsById,
} from "../feature-facets";
import type {
  AnySchemaDefinition,
  MergeSchema,
  SchemaDefinition,
} from "../schema-types";
import type { BlockCodec } from "../serlization/codecs";
import type { MarkCodec } from "../serlization/codecs/mark-codec";
import type { Block, Mark } from "../serlization/loadPage";
import type { TokenType } from "../serlization/tokenizer";
import type { EditorState } from "../state-types";
import type { ContentSelection } from "../structured-selection";
import {
  type BlockTypeDescriptor,
  isStyleField,
  isValidStyleValue,
} from "./block-registry";
import type { StructuredDocument } from "./structured-content";
import { invariant } from "@shared/invariant";

/**
 * The CRDT + serialization facets of one block type, bundled. The rendering
 * facet (the canvas Node) is added separately by the full Schema so this stays
 * canvas-free.
 */
export interface BlockSpecCore<
  T extends string = string,
  A extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly type: T;
  readonly descriptor: BlockTypeDescriptor;
  readonly codec: BlockCodec;
  /**
   * Markdown recognizers owned by this block type. Emitted tokens are only
   * consumed when a codec claims them (normally this spec's own `codec`), so a
   * rule and its claiming codec ride the same spec.
   */
  readonly markdownSyntax?: readonly SyntaxRule[];
  /** @internal Phantom carrier for the block's public attribute type. */
  readonly _attrs?: A;
}

/** A declared inline mark (bold, a custom highlight, …). */
export interface MarkSpec<
  T extends string = string,
  A extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly type: T;
  /** Markdown serialization facet — wrap on output, paired tokens on input. */
  readonly codec?: MarkCodec;
  /** Markdown recognizers owned by this mark type (inline scope, normally). */
  readonly markdownSyntax?: readonly SyntaxRule[];
  /**
   * Structured-content behavior of this mark type, dispatched by the spec's
   * own `type` — there is no separate key to keep in sync.
   */
  readonly structured?: StructuredMarkFacet;
  /** @internal Phantom carrier for the mark's public attribute type. */
  readonly _attrs?: A;
}

/**
 * Adapters for one structured document KIND. A kind is its own registration
 * axis, not a property of a block or mark type: display math (block authority)
 * and inline math (supplemental attachments on ordinary text blocks) share the
 * `"math"` kind, and dispatch is purely by `document.kind`.
 *
 * Entries for the same kind merge as long as their adapter fields are
 * disjoint (the worker-safe data bundle contributes `clone`; the interactive
 * bundle contributes `contentSelection`). Two entries supplying the SAME
 * adapter for one kind fail loudly.
 */
export interface StructuredKindSpec {
  readonly kind: string;
  /** Clipboard projection of a selected range inside this kind's documents. */
  readonly contentSelection?: ContentSelectionSerializer;
  /** Snaps a nested range to this kind's structural discipline. */
  readonly resolveSelection?: ContentSelectionResolver;
  /** Re-addressing adapter for snapshot/import clones of this kind. */
  readonly clone?: StructuredContentClone;
  /** Canonical source text of one of this kind's documents (math's LaTeX). */
  readonly source?: (document: StructuredDocument) => string | undefined;
}

/** The merged per-kind adapters derived by the schema constructor. */
export interface StructuredKindAdapters {
  contentSelection?: ContentSelectionSerializer;
  resolveSelection?: ContentSelectionResolver;
  clone?: StructuredContentClone;
  source?: (document: StructuredDocument) => string | undefined;
}

/**
 * Cross-type feature facets installed with {@link DataSchema.withFeatures} and
 * threaded through schema derivations. @internal — hosts install facets via
 * `withFeatures()`/`Schema.use()`, never by constructing this shape.
 */
export interface InstalledFeatureFacets {
  readonly inputRules: readonly FeatureInputRule[];
  readonly actions: readonly FeatureActionHook[];
  readonly themes: readonly FeatureThemeDefaults[];
}

const NO_FEATURES: InstalledFeatureFacets = {
  inputRules: [],
  actions: [],
  themes: [],
};

export interface DataSchemaExtension {
  readonly blocks?: readonly BlockSpecCore[];
  readonly marks?: readonly MarkSpec[];
  readonly structuredKinds?: readonly StructuredKindSpec[];
  /** Cross-type input rules install with `withFeatures()`, not `extend()`. */
  readonly inputRules?: never;
  /** Action hooks install with `withFeatures()`, not `extend()`. */
  readonly actions?: never;
  /** Theme defaults install with `withFeatures()`, not `extend()`. */
  readonly theme?: never;
  /** Removed — Markdown recognizers ride the owning spec's `markdownSyntax`. */
  readonly markdownSyntax?: never;
  /** Removed — selection serializers ride `structuredKinds[].contentSelection`. */
  readonly contentSelections?: never;
  /** Removed — structured-mark behavior rides the mark spec's `structured`. */
  readonly structuredMarks?: never;
  /** Removed — clone adapters ride `structuredKinds[].clone`. */
  readonly structuredContentClones?: never;
}

type UnionToIntersection<U> = (
  U extends unknown ? (value: U) => void : never
) extends (value: infer I) => void
  ? I
  : never;

type BlockEntryDefinition<B> =
  B extends BlockSpecCore<infer T, infer A> ? { readonly [K in T]: A } : {};

type MarkEntryDefinition<M> =
  M extends MarkSpec<infer T, infer A> ? { readonly [K in T]: A } : {};

export type DataSchemaExtensionDefinition<E extends DataSchemaExtension> = {
  readonly blocks: E["blocks"] extends readonly (infer B)[]
    ? UnionToIntersection<BlockEntryDefinition<B>>
    : {};
  readonly marks: E["marks"] extends readonly (infer M)[]
    ? UnionToIntersection<MarkEntryDefinition<M>>
    : {};
};

/**
 * Loud runtime guard for JavaScript callers (the TypeScript surface already
 * rejects these keys via `never` tombstones): a bundle built against the old
 * facet-list registration must fail instead of silently registering nothing.
 */
function assertNoRelocatedFacets(source: object, api: string): void {
  const relocated: Record<string, string> = {
    markdownSyntax: "the owning block/mark spec's `markdownSyntax`",
    contentSelections: "a `structuredKinds` entry's `contentSelection`",
    contentSelectionResolvers: "a `structuredKinds` entry's `resolveSelection`",
    structuredMarks: "the mark spec's `structured`",
    structuredContentClones: "a `structuredKinds` entry's `clone`",
  };
  for (const [key, home] of Object.entries(relocated)) {
    invariant(
      (source as Record<string, unknown>)[key] === undefined,
      '%s(): "%s" is no longer a feature facet — register it on %s.',
      api,
      key,
      home,
    );
  }
}

/**
 * Same loud-failure contract for the cross-type facets: `extend()` used to
 * install them, but they now go through `withFeatures()` exclusively — a
 * JavaScript bundle still passing them to `extend()` must fail, not silently
 * lose its typing rules and theme defaults.
 */
function assertNoBundleFacets(source: object): void {
  for (const key of ["inputRules", "actions", "theme"] as const) {
    invariant(
      (source as Record<string, unknown>)[key] === undefined,
      'extend(): "%s" is a cross-type feature facet — install it with withFeatures() (or Schema.use()).',
      key,
    );
  }
}

/**
 * Immutable per-instance schema (canvas-free). Build the default with
 * `baseDataSchema`; derive variants with `extend()`.
 */
export class DataSchema<D extends SchemaDefinition = AnySchemaDefinition> {
  private readonly blocks: ReadonlyMap<string, BlockSpecCore>;
  private readonly marks: ReadonlyMap<string, MarkSpec>;
  /**
   * Authoring allow-list — the subset of REGISTERED block types the local user
   * may create. `undefined` = unrestricted (every registered type is creatable).
   * This gates authoring ONLY; the reducer/oplog stays agnostic, so a peer or a
   * stored snapshot may still carry — and this schema will still render — a type
   * that is registered but absent from this set. Narrow it with `restrict()`.
   */
  readonly allowedBlocks?: ReadonlySet<string>;
  /** Authoring allow-list for inline marks; `undefined` = unrestricted. */
  readonly allowedMarks?: ReadonlySet<string>;
  /** Block-start token → codec, derived from each block's markdown.tokens. */
  readonly tokenDispatch: ReadonlyMap<TokenType, BlockCodec>;
  /** HTML tag (lowercase) → codec, derived from each block's markdown.htmlTags. */
  readonly htmlTagDispatch: ReadonlyMap<string, BlockCodec>;
  /** Inline-mark open-token → mark type, derived from each mark codec's tokens. */
  private readonly markStartTokens: ReadonlyMap<TokenType, string>;
  /** Inline-mark close-token → mark type. */
  private readonly markEndTokens: ReadonlyMap<TokenType, string>;
  /** Raw structured-kind entries, re-threaded through derivations. */
  private readonly structuredKindSpecs: readonly StructuredKindSpec[];
  /** Merged per-kind adapters (one contentSelection/clone per kind). */
  private readonly kinds: ReadonlyMap<string, StructuredKindAdapters>;
  /** Spec-carried syntax rules in dispatch order (priority, then spec order). */
  private readonly syntaxAllRules: readonly SyntaxRule[];
  private readonly syntaxBlockRules: readonly SyntaxRule[];
  private readonly syntaxInlineRules: readonly SyntaxRule[];
  /** Cross-type feature facets installed via `withFeatures()`. */
  private readonly features: InstalledFeatureFacets;
  /** Input rules per phase, in dispatch order. */
  private readonly inputRulesBefore: readonly FeatureInputRule[];
  private readonly inputRulesAfter: readonly FeatureInputRule[];

  constructor(
    blockSpecs: readonly BlockSpecCore[],
    markSpecs: readonly MarkSpec[],
    allowed?: {
      readonly blocks?: ReadonlySet<string>;
      readonly marks?: ReadonlySet<string>;
    },
    features: InstalledFeatureFacets = NO_FEATURES,
    structuredKinds: readonly StructuredKindSpec[] = [],
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

    // ── Facet derivation ──────────────────────────────────────────────────
    // Derived from the DEDUPED maps, never the raw spec lists: an overriding
    // spec replaces the overridden type's facets wholesale, and re-deriving on
    // every construction keeps extend()/restrict()/withFeatures() and direct
    // construction observationally identical for the same specs.
    const syntax: SyntaxRule[] = [];
    const syntaxIds = new Set<string>();
    const collectSyntax = (rules: readonly SyntaxRule[] | undefined): void => {
      for (const rule of rules ?? []) {
        invariant(
          !syntaxIds.has(rule.id),
          'Markdown syntax rule "%s" is registered by more than one spec. Rule ids must be unique across the schema; attach a shared rule to exactly one spec.',
          rule.id,
        );
        syntaxIds.add(rule.id);
        syntax.push(rule);
      }
    };
    for (const spec of blocks.values()) collectSyntax(spec.markdownSyntax);
    for (const mark of marks.values()) collectSyntax(mark.markdownSyntax);
    const orderedSyntax = orderedFacets(syntax);

    const kinds = new Map<string, StructuredKindAdapters>();
    for (const entry of structuredKinds) {
      invariant(
        entry.kind.length > 0,
        "structuredKinds: an entry declared an empty kind.",
      );
      const merged: StructuredKindAdapters = { ...kinds.get(entry.kind) };
      if (entry.contentSelection) {
        invariant(
          !merged.contentSelection,
          'Structured kind "%s" registers two contentSelection serializers. Each kind has exactly one; entries for a kind may only contribute disjoint adapters.',
          entry.kind,
        );
        merged.contentSelection = entry.contentSelection;
      }
      if (entry.resolveSelection) {
        invariant(
          !merged.resolveSelection,
          'Structured kind "%s" registers two selection resolvers. Each kind has exactly one; entries for a kind may only contribute disjoint adapters.',
          entry.kind,
        );
        merged.resolveSelection = entry.resolveSelection;
      }
      if (entry.clone) {
        invariant(
          !merged.clone,
          'Structured kind "%s" registers two clone adapters. Each kind has exactly one; entries for a kind may only contribute disjoint adapters.',
          entry.kind,
        );
        merged.clone = entry.clone;
      }
      if (entry.source) {
        invariant(
          !merged.source,
          'Structured kind "%s" registers two source adapters. Each kind has exactly one; entries for a kind may only contribute disjoint adapters.',
          entry.kind,
        );
        merged.source = entry.source;
      }
      // Frozen: `structuredKind()` hands this record out, and a later entry
      // for the same kind merges via copy — nothing may mutate a shared one.
      kinds.set(entry.kind, Object.freeze(merged));
    }

    this.blocks = blocks;
    this.marks = marks;
    this.allowedBlocks = allowed?.blocks;
    this.allowedMarks = allowed?.marks;
    this.tokenDispatch = tokenDispatch;
    this.htmlTagDispatch = htmlTagDispatch;
    this.markStartTokens = markStartTokens;
    this.markEndTokens = markEndTokens;
    this.structuredKindSpecs = [...structuredKinds];
    this.kinds = kinds;
    this.syntaxAllRules = orderedSyntax;
    this.syntaxBlockRules = orderedSyntax.filter((r) => r.scope === "block");
    this.syntaxInlineRules = orderedSyntax.filter((r) => r.scope === "inline");
    this.features = features;
    this.inputRulesBefore = orderedFacets(
      features.inputRules.filter((rule) => rule.phase === "before-insert"),
    );
    this.inputRulesAfter = orderedFacets(
      features.inputRules.filter((rule) => rule.phase === "after-insert"),
    );
  }

  /** Whether a block type is known to this schema. */
  hasBlock(type: string): boolean {
    return this.blocks.has(type);
  }

  getDescriptor(type: string): BlockTypeDescriptor | undefined {
    return this.blocks.get(type)?.descriptor;
  }

  /** Every CRDT-backed field declared by a registered block type. */
  getFieldNames(type: string): readonly string[] {
    const descriptor = this.getDescriptor(type);
    return descriptor ? Object.keys(descriptor.fields) : [];
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

  // ── Facet dispatch (derived from the registered specs) ─────────────────────

  /** Spec-carried syntax recognizers in deterministic dispatch order. */
  syntaxRules(scope?: SyntaxRule["scope"]): readonly SyntaxRule[] {
    if (scope === "block") return this.syntaxBlockRules;
    if (scope === "inline") return this.syntaxInlineRules;
    return this.syntaxAllRules;
  }

  /**
   * Ask the registered syntax rules for the first valid match at a source
   * position. Invalid zero-length/overrun matches fail loudly instead of
   * hanging the tokenizer or consuming source nondeterministically.
   */
  matchSyntax(
    scope: SyntaxRule["scope"],
    ctx: SyntaxCtx,
  ): { readonly rule: SyntaxRule; readonly match: SyntaxMatch } | null {
    for (const rule of this.syntaxRules(scope)) {
      if (scope === "block" && !ctx.startOfLine) continue;
      const match = rule.match(ctx);
      if (!match) continue;
      if (
        !Number.isInteger(match.length) ||
        match.length <= 0 ||
        ctx.offset < 0 ||
        ctx.offset + match.length > ctx.source.length ||
        match.tokens.length === 0
      ) {
        throw new Error(
          `Syntax rule "${rule.id}" returned an invalid match at offset ${ctx.offset}`,
        );
      }
      return { rule, match };
    }
    return null;
  }

  /** Installed input rules for one phase in deterministic dispatch order. */
  inputRules(phase: FeatureInputPhase): readonly FeatureInputRule[] {
    return phase === "before-insert"
      ? this.inputRulesBefore
      : this.inputRulesAfter;
  }

  /** Whether an installed rule owns this input before flat-text fallback. */
  ownsInput(
    phase: FeatureInputPhase,
    state: EditorState,
    input: string,
  ): boolean {
    const ctx = { state, input } satisfies FeatureInputRuleCtx;
    return this.inputRules(phase).some((rule) => rule.owns?.(ctx) === true);
  }

  /** Run one live-input phase, threading state and accumulating CRDT ops. */
  runInputRules(
    phase: FeatureInputPhase,
    state: EditorState,
    input: string,
  ): StateResult & { readonly handled: boolean } {
    let current = state;
    const ops: StateResult["ops"] = [];
    for (const rule of this.inputRules(phase)) {
      const result = rule.apply({ state: current, input });
      if (!result) continue;
      current = result.state;
      ops.push(...result.ops);
      if (result.handled) return { state: current, ops, handled: true };
    }
    return { state: current, ops, handled: false };
  }

  /** Installed action hooks in deterministic registration order. */
  actions(): readonly FeatureActionHook[] {
    return orderedFacets(this.features.actions);
  }

  /** Install every feature-level action hook into one editor's action bus. */
  registerActions(bus: ActionBus): void {
    for (const hook of this.actions()) hook.register(bus);
  }

  /** Resolve all feature theme defaults, with later installations winning. */
  resolveThemeDefaults(): ResolvedFeatureThemeDefaults {
    return resolveFeatureThemeDefaults(this.features.themes);
  }

  /** Structured-content behavior registered by one mark type's spec. */
  structuredMark(markType: string): StructuredMarkFacet | undefined {
    return this.marks.get(markType)?.structured;
  }

  /** The merged adapters registered for one structured document kind. */
  structuredKind(kind: string): Readonly<StructuredKindAdapters> | undefined {
    return this.kinds.get(kind);
  }

  /** Structured initializer for one newly-created mark of `markType`. */
  createStructuredMark(
    markType: string,
    ctx: StructuredMarkCreateCtx,
  ): StructuredMarkCreateResult | undefined {
    return this.structuredMark(markType)?.create?.(ctx);
  }

  /** Resolve a structured mark's canonical source without a feature import. */
  resolveStructuredMark(
    markType: string,
    ctx: StructuredMarkResolveCtx,
  ): string | undefined {
    return this.structuredMark(markType)?.resolve?.(ctx);
  }

  /** Rewrite a structured mark to the attachment ids cloned for its block. */
  cloneStructuredMark(
    markType: string,
    ctx: StructuredMarkCloneCtx,
  ): Mark | undefined {
    return this.structuredMark(markType)?.clone?.(ctx);
  }

  /** Attachment content ids referenced by one mark of `markType`. */
  structuredMarkReferences(
    markType: string,
    ctx: StructuredMarkResolveCtx,
  ): readonly string[] {
    return this.structuredMark(markType)?.references?.(ctx) ?? [];
  }

  /** Ask the kind's adapter for a lossless encoding of one nested range. */
  serializeContentSelection(
    document: StructuredDocument,
    selection: ContentSelection,
  ): ContentSelectionSlice | undefined {
    return this.kinds.get(document.kind)?.contentSelection?.({
      document,
      selection,
    });
  }

  /** Let the kind's adapter adjust one nested range before it becomes active. */
  resolveContentSelection(
    document: StructuredDocument,
    selection: ContentSelection,
  ): ContentSelection | undefined {
    return this.kinds.get(document.kind)?.resolveSelection?.({
      document,
      selection,
    });
  }

  /** Ask the kind's adapter to re-address one cloned attachment. */
  cloneStructuredContent(
    ctx: StructuredContentCloneCtx,
  ): StructuredContentCloneResult | undefined {
    return this.kinds.get(ctx.document.kind)?.clone?.(ctx);
  }

  /** Canonical source text of one structured document, via its kind adapter. */
  structuredContentSource(document: StructuredDocument): string | undefined {
    return this.kinds.get(document.kind)?.source?.(document);
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
    orderKey: string,
  ): Block | undefined {
    return this.getDescriptor(type)?.defaults(id, orderKey);
  }

  validateField(type: string, field: string, value: unknown): boolean {
    // Per-block style is an open vocabulary under the `style.` namespace —
    // validated by value (JSON-serializable), not against a per-type descriptor,
    // so every block type can carry style without enumerating keys.
    if (isStyleField(field)) return isValidStyleValue(value);
    // A type morph is validated against the TARGET registration, not the
    // source descriptor. Custom descriptors deliberately validate their own
    // literal type, which would otherwise make paragraph → extension morphs
    // impossible to replay even though both types belong to this schema.
    if (field === "type") {
      return typeof value === "string" && this.hasBlock(value);
    }
    const descriptor = this.getDescriptor(type);
    if (!descriptor) return false;
    const fieldDescriptor = descriptor.fields[field];
    return fieldDescriptor ? fieldDescriptor.validate(value) : false;
  }

  canMorphTo(from: string, to: string): boolean {
    if (from === to) return this.hasBlock(from);
    const fromGroup = this.getDescriptor(from)?.capabilities.morphGroup;
    const toGroup = this.getDescriptor(to)?.capabilities.morphGroup;
    return fromGroup !== undefined && fromGroup === toGroup;
  }

  // ── Authoring allow-list ───────────────────────────────────────────────────
  //
  // A whitelist of the block/mark types the local user may CREATE. It is a
  // subset of the registered set and gates authoring only (actions, paste,
  // input rules, mark toggles) — never the reducer, so peers that share the
  // base registry converge regardless of their allow-lists. `restrict()`
  // narrows it; the query helpers are consulted at every authoring boundary and
  // by host chrome to hide disallowed controls. All are no-ops when unrestricted.

  /**
   * The universal fallback block type — a plain text block a disallowed type is
   * coerced to, and the type a document is guaranteed to be able to hold. By
   * convention `paragraph` (the same type `getFallbackCodec` claims); `restrict`
   * always keeps it creatable so a document can never become unrepresentable.
   */
  fallbackBlockType(): string {
    return "paragraph";
  }

  /** Whether the local user may create a block of `type` (registered + allowed). */
  isBlockAllowed(type: string): boolean {
    return this.allowedBlocks
      ? this.allowedBlocks.has(type)
      : this.hasBlock(type);
  }

  /** Whether the local user may apply a mark of `type` (registered + allowed). */
  isMarkAllowed(type: string): boolean {
    return this.allowedMarks ? this.allowedMarks.has(type) : this.hasMark(type);
  }

  /**
   * `type` if it is creatable here, else the fallback type. The single clamp an
   * authoring site applies before minting/morphing a block, so a disallowed
   * target degrades to a plain block rather than being admitted.
   */
  coerceCreatable(type: string): string {
    return this.isBlockAllowed(type) ? type : this.fallbackBlockType();
  }

  /**
   * Derive a new schema that restricts which registered types may be authored.
   * Omit a key to leave that dimension unrestricted; `marks: []` yields a
   * format-free field. The full registry is preserved (rendering is unchanged),
   * so this is purely an authoring constraint. The receiver is never mutated.
   *
   * The fallback block type (`paragraph`) is always creatable and cannot be
   * excluded — a document must always be able to hold a plain block. Every named
   * type must already be registered in this schema (apply `extend()` first, then
   * `restrict()` last).
   */
  restrict(restriction: {
    readonly blocks?: readonly string[];
    readonly marks?: readonly string[];
  }): DataSchema<D> {
    const allowedBlocks =
      restriction.blocks === undefined
        ? this.allowedBlocks
        : this.buildAllowedBlockSet(restriction.blocks);
    const allowedMarks =
      restriction.marks === undefined
        ? this.allowedMarks
        : this.buildAllowedMarkSet(restriction.marks);
    return new DataSchema(
      this.blockSpecs(),
      this.markSpecs(),
      {
        blocks: allowedBlocks,
        marks: allowedMarks,
      },
      this.features,
      this.structuredKindSpecs,
    );
  }

  private buildAllowedBlockSet(names: readonly string[]): ReadonlySet<string> {
    const set = new Set<string>();
    for (const name of names) {
      invariant(
        this.hasBlock(name),
        'restrict(): block type "%s" is not registered in this schema — register it with extend() before restricting.',
        name,
      );
      set.add(name);
    }
    // The fallback is never excludable, so a document can always hold a plain
    // block (and coerceCreatable always has a legal target).
    const fallback = this.fallbackBlockType();
    invariant(
      this.hasBlock(fallback),
      'restrict(): the fallback block type "%s" must be registered to restrict this schema.',
      fallback,
    );
    set.add(fallback);
    return set;
  }

  private buildAllowedMarkSet(names: readonly string[]): ReadonlySet<string> {
    const set = new Set<string>();
    for (const name of names) {
      invariant(
        this.hasMark(name),
        'restrict(): mark type "%s" is not registered in this schema.',
        name,
      );
      set.add(name);
    }
    // No mandatory mark — `marks: []` is a legitimately format-free field.
    return set;
  }

  /**
   * Derive a new schema with extra block/mark types and structured kinds.
   * Later definitions win on key collision, so a host can override a built-in
   * (the overriding spec replaces the overridden type's facets wholesale). The
   * receiver is never mutated. Any existing authoring allow-list is carried
   * through unchanged: `extend()` only widens the REGISTERED set, never the
   * allowed set (apply `restrict()` last).
   */
  extend<const E extends DataSchemaExtension>(
    ext: E,
  ): DataSchema<MergeSchema<D, DataSchemaExtensionDefinition<E>>> {
    assertNoRelocatedFacets(ext, "extend");
    assertNoBundleFacets(ext);
    const blocks = [...this.blockSpecs(), ...(ext.blocks ?? [])];
    const marks = [...this.markSpecs(), ...(ext.marks ?? [])];
    const structuredKinds = [
      ...this.structuredKindSpecs,
      ...(ext.structuredKinds ?? []),
    ];
    return new DataSchema(
      blocks,
      marks,
      {
        blocks: this.allowedBlocks,
        marks: this.allowedMarks,
      },
      this.features,
      structuredKinds,
    );
  }

  /**
   * Install cross-type feature facets (input rules, action hooks, theme
   * defaults) without changing the registered type set. Rules are ordered by
   * priority, then installation order; reusing a facet id replaces the earlier
   * definition at the later installation position.
   */
  withFeatures(feature: FeatureFacetSource): DataSchema<D> {
    assertNoRelocatedFacets(feature, "withFeatures");
    return new DataSchema(
      this.blockSpecs(),
      this.markSpecs(),
      {
        blocks: this.allowedBlocks,
        marks: this.allowedMarks,
      },
      {
        inputRules: upsertFacetsById(
          this.features.inputRules,
          feature.inputRules ?? [],
        ),
        actions: upsertFacetsById(this.features.actions, feature.actions ?? []),
        themes: feature.theme
          ? upsertFacetsById(this.features.themes, [feature.theme])
          : [...this.features.themes],
      },
      this.structuredKindSpecs,
    );
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

// `baseDataSchema` (the default schema instance, assembled from the built-in
// node instances) lives in ../baseDataSchema — this module stays canvas-free so
// the sync/fuzz import graph never pulls in the nodes at module-init.
