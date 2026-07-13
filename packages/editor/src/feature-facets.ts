/**
 * Feature-wide extension facets.
 *
 * Nodes and marks already own behavior that is local to one document type
 * (rendering, caret semantics, codecs, action handlers, and node strings).
 * These contracts cover the remaining cross-type pieces an optional feature
 * may need: live-input rules, markdown syntax recognizers, feature-level action
 * hooks, and theme defaults.
 *
 * The registry is immutable and per-schema. It deliberately has no module-level
 * registration API: `Schema.use(feature)` folds a feature's facets into a new
 * registry, and each editor receives that registry with its schema. Rules are
 * ordered by explicit priority (high first), then installation order. Reusing a
 * facet id replaces its earlier definition at the later installation position,
 * which makes overrides deterministic without deduplicating by feature name.
 */

import type { ActionBus, StateResult } from "./action-bus";
import type { Mark } from "./serlization/loadPage";
import type { EditorState } from "./state-types";
import type { ContentSelection } from "./structured-selection";
import type {
  StructuredContentMap,
  StructuredDocument,
  StructuredMutation,
} from "./sync/structured-content";
import type { IdentityAllocator } from "@shared/identity";

/** Shared identity/order fields for dispatchable feature facets. */
export interface OrderedFeatureFacet {
  /** Stable id used for diagnostics and intentional replacement. */
  readonly id: string;
  /** Higher runs first. Equal priorities preserve installation order. */
  readonly priority?: number;
}

/** The point in the text-input transaction at which a rule runs. */
export type FeatureInputPhase = "before-insert" | "after-insert";

/** Context passed to a feature-owned live-input rule. */
export interface FeatureInputRuleCtx {
  /** The current threaded state (including earlier rules' changes). */
  readonly state: EditorState;
  /** The exact text supplied by the input event. */
  readonly input: string;
}

/** A rule contribution to the pure editor-state input pipeline. */
export interface FeatureInputRule extends OrderedFeatureFacet {
  readonly phase: FeatureInputPhase;
  /**
   * Read-only ownership query for mutation surfaces that otherwise bypass the
   * live typing pipeline (explicit public ranges, rich paste, async cut).
   *
   * Return true when this rule must receive the input before core may touch
   * flat block storage. The predicate must not allocate identities or mutate
   * state; {@link apply} performs the actual transaction after ownership wins.
   */
  readonly owns?: (ctx: FeatureInputRuleCtx) => boolean;
  /**
   * Return `undefined` when the rule does not match. Returned ops are appended
   * to the current transaction. `handled` stops lower-priority rules in this
   * phase; it does not implicitly discard edits already made by earlier rules.
   *
   * The callback must be deterministic from its arguments. Persistent changes
   * must be represented by CRDT ops in the returned result.
   */
  apply(
    ctx: FeatureInputRuleCtx,
  ): (StateResult & { readonly handled?: boolean }) | undefined;
}

/** Token emitted by a feature markdown recognizer. */
export interface FeatureSyntaxToken {
  /** Open token vocabulary; codecs claim the strings they understand. */
  readonly type: string;
  /** Decoded token payload, when the token carries content. */
  readonly content?: string;
  /** Exact consumed source, used when the active schema does not claim it. */
  readonly raw?: string;
}

/** Read-only cursor passed to a feature markdown recognizer. */
export interface FeatureSyntaxCtx {
  readonly source: string;
  readonly offset: number;
  readonly startOfLine: boolean;
}

/** A successful syntax recognition at the current source offset. */
export interface FeatureSyntaxMatch {
  /** Number of UTF-16 code units consumed; must be a positive integer. */
  readonly length: number;
  readonly tokens: readonly FeatureSyntaxToken[];
}

/**
 * A tokenizer extension. Block rules are considered only at start-of-line;
 * inline rules are considered everywhere the core tokenizer asks extensions.
 */
export interface FeatureSyntaxRule extends OrderedFeatureFacet {
  readonly scope: "block" | "inline";
  match(ctx: FeatureSyntaxCtx): FeatureSyntaxMatch | undefined;
}

/** A feature-level action-bus installer not naturally owned by one node/mark. */
export interface FeatureActionHook extends OrderedFeatureFacet {
  register(bus: ActionBus): void;
}

/** Clipboard-safe representations of a selected slice of structured content. */
export interface FeatureContentSelectionSlice {
  readonly plainText: string;
  /** Falls back to `plainText` when omitted. */
  readonly markdown?: string;
  /** Falls back to escaped `plainText` when omitted. */
  readonly html?: string;
}

/** Data-only context for serializing an extension-owned nested selection. */
export interface FeatureContentSelectionCtx {
  readonly document: StructuredDocument;
  readonly selection: ContentSelection;
}

/**
 * Serialize a range inside one structured-document kind.
 *
 * This is a schema facet rather than a core switch on node names: an editor
 * without that feature installs no serializer, while any future structured
 * block can add clipboard support without changing the editor engine.
 */
export interface FeatureContentSelectionSerializer extends OrderedFeatureFacet {
  /** StructuredDocument.kind claimed by this serializer. */
  readonly kind: string;
  /** Return undefined when this serializer cannot losslessly encode the range. */
  serialize(
    ctx: FeatureContentSelectionCtx,
  ): FeatureContentSelectionSlice | undefined;
}

/** Context for adjusting one nested range inside a structured-document kind. */
export interface FeatureContentSelectionResolveCtx {
  readonly document: StructuredDocument;
  readonly selection: ContentSelection;
}

/**
 * Adjust a nested range before it becomes the active selection.
 *
 * Core commits every non-collapsed nested selection through this facet, so a
 * feature keeps its ranges structurally valid no matter which gesture produced
 * them — a drag, shift+click, keyboard extension, or the public API. Display
 * math uses it to snap a range so it never partially covers a construct. Like
 * the serializer above, this is a schema facet rather than a core switch on
 * document kinds.
 */
export interface FeatureContentSelectionResolver extends OrderedFeatureFacet {
  /** StructuredDocument.kind claimed by this resolver. */
  readonly kind: string;
  /** Return undefined to keep the range exactly as produced. */
  resolve(ctx: FeatureContentSelectionResolveCtx): ContentSelection | undefined;
}

/** One supplemental attachment initialized alongside a newly-created mark. */
export interface FeatureStructuredMarkAttachment {
  readonly contentId: string;
  readonly edit: StructuredMutation;
}

/** Data-only context for feature initialization of a new inline mark. */
export interface FeatureStructuredMarkCreateCtx {
  /** Mark requested by the generic authoring action. */
  readonly mark: Mark;
  /** Visible text that the new mark will cover. */
  readonly text: string;
  /** The document's single live persisted identity allocator. */
  readonly identities: IdentityAllocator;
}

export interface FeatureStructuredMarkCreateResult {
  /** Mark persisted by `mark_set`, normally enriched with a contentId attr. */
  readonly mark: Mark;
  /** Initializers emitted in the same transaction before the mark operation. */
  readonly attachments: readonly FeatureStructuredMarkAttachment[];
}

/** Data-only context for resolving a structured mark's canonical source. */
export interface FeatureStructuredMarkResolveCtx {
  readonly mark: Mark;
  readonly compatibilityText: string;
  readonly attachments: StructuredContentMap | undefined;
}

/** Context for rewriting a mark after its block attachments were cloned once. */
export interface FeatureStructuredMarkCloneCtx {
  readonly mark: Mark;
  readonly sourceBlockId: string;
  readonly targetBlockId: string;
  readonly attachments: StructuredContentMap | undefined;
  /** Stable source-content-id to cloned-content-id map for this block clone. */
  readonly clonedContentIds: Readonly<Record<string, string>>;
}

/**
 * Optional structured-content behavior owned by one mark type.
 *
 * Core authoring and serializers dispatch this facet by `markType`; they never
 * import the feature. `create` runs only for an explicitly new mark, avoiding
 * accidental replacement of an existing attachment when a range is extended.
 */
export interface FeatureStructuredMarkFacet extends OrderedFeatureFacet {
  readonly markType: string;
  create?(
    ctx: FeatureStructuredMarkCreateCtx,
  ): FeatureStructuredMarkCreateResult | undefined;
  /** Return undefined when the compatibility characters remain authoritative. */
  resolve?(ctx: FeatureStructuredMarkResolveCtx): string | undefined;
  /**
   * Rewrite attachment references after snapshot/import cloned each source
   * document exactly once. Return undefined when this mark needs no rewrite.
   */
  clone?(ctx: FeatureStructuredMarkCloneCtx): Mark | undefined;
  /**
   * Attachment content ids this mark references. Core lifecycle code uses
   * these to delete a mark's attachments in the same transaction that deletes
   * the whole mark, so no block accumulates unreachable structured content.
   */
  references?(ctx: FeatureStructuredMarkResolveCtx): readonly string[];
}

/** Context for cloning one attachment onto a block with a fresh identity. */
export interface FeatureStructuredContentCloneCtx {
  readonly document: StructuredDocument;
  readonly sourceBlockId: string;
  readonly targetBlockId: string;
  readonly sourceContentId: string;
  /** The destination document's single persisted identity allocator. */
  readonly identities: IdentityAllocator;
}

export interface FeatureStructuredContentCloneResult {
  readonly contentId: string;
  readonly document: StructuredDocument;
}

/**
 * Rewrite attachment addressing when a snapshot/import mints a new block id.
 *
 * Core defaults to copying an attachment unchanged. A document kind whose
 * addressing derives from the containing block (for example display math)
 * contributes this facet so snapshot code remains node/feature agnostic.
 */
export interface FeatureStructuredContentCloneFacet extends OrderedFeatureFacet {
  readonly kind: string;
  clone(
    ctx: FeatureStructuredContentCloneCtx,
  ): FeatureStructuredContentCloneResult | undefined;
}

/**
 * Open theme fragments contributed by a feature.
 *
 * These are defaults, not host overrides. The theme resolver folds registered
 * fragments in installation order (later values win) before applying the host
 * theme. Objects merge recursively; arrays and scalar leaves replace. Keeping
 * the trees open lets an optional package own keys such as a diagram palette or
 * equation surface without adding them to the core EditorStyles interface.
 */
export interface FeatureThemeDefaults {
  /** Stable id used for intentional replacement by a later feature. */
  readonly id: string;
  readonly tokens?: Readonly<Record<string, unknown>>;
  readonly styles?: Readonly<Record<string, unknown>>;
  readonly strings?: Readonly<Record<string, unknown>>;
  readonly nodeStrings?: Readonly<Record<string, unknown>>;
}

/** The non-node/mark facets accepted by a reusable feature bundle. */
export interface FeatureFacets {
  readonly inputRules?: readonly FeatureInputRule[];
  readonly markdownSyntax?: readonly FeatureSyntaxRule[];
  readonly actions?: readonly FeatureActionHook[];
  readonly contentSelections?: readonly FeatureContentSelectionSerializer[];
  readonly contentSelectionResolvers?: readonly FeatureContentSelectionResolver[];
  readonly structuredMarks?: readonly FeatureStructuredMarkFacet[];
  readonly structuredContentClones?: readonly FeatureStructuredContentCloneFacet[];
  readonly theme?: FeatureThemeDefaults;
}

/** A feature-shaped value accepted by the facet registry. */
export interface FeatureFacetSource extends FeatureFacets {
  /** Metadata only; never used as a global registration/deduplication key. */
  readonly name?: string;
}

export interface ResolvedFeatureThemeDefaults {
  readonly tokens: Readonly<Record<string, unknown>>;
  readonly styles: Readonly<Record<string, unknown>>;
  readonly strings: Readonly<Record<string, unknown>>;
  readonly nodeStrings: Readonly<Record<string, unknown>>;
}

/**
 * Immutable, deterministic collection of feature-wide facets.
 *
 * `Schema` owns one of these alongside its DataSchema/node/mark lists. Public
 * arrays are returned as copies so consumers cannot mutate later editor mounts.
 */
export class FeatureFacetRegistry {
  private readonly inputs: readonly FeatureInputRule[];
  private readonly syntax: readonly FeatureSyntaxRule[];
  private readonly actionHooks: readonly FeatureActionHook[];
  private readonly themes: readonly FeatureThemeDefaults[];
  private readonly selectionSerializers: readonly FeatureContentSelectionSerializer[];
  private readonly selectionResolvers: readonly FeatureContentSelectionResolver[];
  private readonly structuredMarkFacets: readonly FeatureStructuredMarkFacet[];
  private readonly structuredContentCloneFacets: readonly FeatureStructuredContentCloneFacet[];

  constructor(
    inputs: readonly FeatureInputRule[] = [],
    syntax: readonly FeatureSyntaxRule[] = [],
    actionHooks: readonly FeatureActionHook[] = [],
    themes: readonly FeatureThemeDefaults[] = [],
    selectionSerializers: readonly FeatureContentSelectionSerializer[] = [],
    structuredMarkFacets: readonly FeatureStructuredMarkFacet[] = [],
    structuredContentCloneFacets: readonly FeatureStructuredContentCloneFacet[] = [],
    selectionResolvers: readonly FeatureContentSelectionResolver[] = [],
  ) {
    this.inputs = [...inputs];
    this.syntax = [...syntax];
    this.actionHooks = [...actionHooks];
    this.themes = [...themes];
    this.selectionSerializers = [...selectionSerializers];
    this.selectionResolvers = [...selectionResolvers];
    this.structuredMarkFacets = [...structuredMarkFacets];
    this.structuredContentCloneFacets = [...structuredContentCloneFacets];
  }

  /** Return a new registry with this feature's facets installed. */
  extend(feature: FeatureFacetSource): FeatureFacetRegistry {
    return new FeatureFacetRegistry(
      upsertById(this.inputs, feature.inputRules ?? []),
      upsertById(this.syntax, feature.markdownSyntax ?? []),
      upsertById(this.actionHooks, feature.actions ?? []),
      feature.theme ? upsertById(this.themes, [feature.theme]) : this.themes,
      upsertById(this.selectionSerializers, feature.contentSelections ?? []),
      upsertById(this.structuredMarkFacets, feature.structuredMarks ?? []),
      upsertById(
        this.structuredContentCloneFacets,
        feature.structuredContentClones ?? [],
      ),
      upsertById(
        this.selectionResolvers,
        feature.contentSelectionResolvers ?? [],
      ),
    );
  }

  /** Input rules for one phase in deterministic dispatch order. */
  inputRules(phase: FeatureInputPhase): readonly FeatureInputRule[] {
    return ordered(this.inputs.filter((rule) => rule.phase === phase));
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

  /** Syntax recognizers in deterministic dispatch order. */
  syntaxRules(
    scope?: FeatureSyntaxRule["scope"],
  ): readonly FeatureSyntaxRule[] {
    const rules = scope
      ? this.syntax.filter((rule) => rule.scope === scope)
      : this.syntax;
    return ordered(rules);
  }

  /** Action hooks in deterministic registration order. */
  actions(): readonly FeatureActionHook[] {
    return ordered(this.actionHooks);
  }

  /** Install every feature-level action hook into one editor's action bus. */
  registerActions(bus: ActionBus): void {
    for (const hook of this.actions()) hook.register(bus);
  }

  /** Structured-selection serializers in deterministic dispatch order. */
  contentSelections(
    kind?: string,
  ): readonly FeatureContentSelectionSerializer[] {
    const serializers = kind
      ? this.selectionSerializers.filter((entry) => entry.kind === kind)
      : this.selectionSerializers;
    return ordered(serializers);
  }

  /** Ask the installed feature for a lossless encoding of one nested range. */
  serializeContentSelection(
    document: StructuredDocument,
    selection: ContentSelection,
  ): FeatureContentSelectionSlice | undefined {
    for (const serializer of this.contentSelections(document.kind)) {
      const slice = serializer.serialize({ document, selection });
      if (slice) return slice;
    }
    return undefined;
  }

  /** Let the owning feature adjust one nested range before it becomes active. */
  resolveContentSelection(
    document: StructuredDocument,
    selection: ContentSelection,
  ): ContentSelection | undefined {
    for (const resolver of ordered(
      this.selectionResolvers.filter((entry) => entry.kind === document.kind),
    )) {
      const resolved = resolver.resolve({ document, selection });
      if (resolved) return resolved;
    }
    return undefined;
  }

  /** Highest-priority structured initializer for one newly-created mark. */
  createStructuredMark(
    markType: string,
    ctx: FeatureStructuredMarkCreateCtx,
  ): FeatureStructuredMarkCreateResult | undefined {
    for (const facet of ordered(
      this.structuredMarkFacets.filter(
        (candidate) => candidate.markType === markType,
      ),
    )) {
      const created = facet.create?.(ctx);
      if (created) return created;
    }
    return undefined;
  }

  /** Resolve a structured mark's canonical source without a feature import. */
  resolveStructuredMark(
    markType: string,
    ctx: FeatureStructuredMarkResolveCtx,
  ): string | undefined {
    for (const facet of ordered(
      this.structuredMarkFacets.filter(
        (candidate) => candidate.markType === markType,
      ),
    )) {
      const source = facet.resolve?.(ctx);
      if (source !== undefined) return source;
    }
    return undefined;
  }

  /** Attachment content ids referenced by one mark, across its facets. */
  structuredMarkReferences(
    markType: string,
    ctx: FeatureStructuredMarkResolveCtx,
  ): readonly string[] {
    const ids = new Set<string>();
    for (const facet of ordered(
      this.structuredMarkFacets.filter(
        (candidate) => candidate.markType === markType,
      ),
    )) {
      for (const id of facet.references?.(ctx) ?? []) ids.add(id);
    }
    return [...ids];
  }

  /** Rewrite a structured mark to the attachment ids cloned for its block. */
  cloneStructuredMark(
    markType: string,
    ctx: FeatureStructuredMarkCloneCtx,
  ): Mark | undefined {
    for (const facet of ordered(
      this.structuredMarkFacets.filter(
        (candidate) => candidate.markType === markType,
      ),
    )) {
      const cloned = facet.clone?.(ctx);
      if (cloned) return cloned;
    }
    return undefined;
  }

  /** Ask a document-kind adapter to re-address one cloned attachment. */
  cloneStructuredContent(
    ctx: FeatureStructuredContentCloneCtx,
  ): FeatureStructuredContentCloneResult | undefined {
    for (const facet of ordered(
      this.structuredContentCloneFacets.filter(
        (candidate) => candidate.kind === ctx.document.kind,
      ),
    )) {
      const cloned = facet.clone(ctx);
      if (cloned) return cloned;
    }
    return undefined;
  }

  /** Resolve all feature theme defaults, with later installations winning. */
  resolveThemeDefaults(): ResolvedFeatureThemeDefaults {
    let tokens: Record<string, unknown> = {};
    let styles: Record<string, unknown> = {};
    let strings: Record<string, unknown> = {};
    let nodeStrings: Record<string, unknown> = {};
    for (const theme of this.themes) {
      tokens = mergeTree(tokens, theme.tokens);
      styles = mergeTree(styles, theme.styles);
      strings = mergeTree(strings, theme.strings);
      nodeStrings = mergeTree(nodeStrings, theme.nodeStrings);
    }
    return { tokens, styles, strings, nodeStrings };
  }
}

/** A shared empty value; safe because registries are immutable. */
export const emptyFeatureFacets = new FeatureFacetRegistry();

/**
 * Run one live-input phase, threading state and accumulating CRDT ops.
 * Intended for the core input action once a Schema carries the registry.
 */
export function runFeatureInputRules(
  registry: FeatureFacetRegistry,
  phase: FeatureInputPhase,
  state: EditorState,
  input: string,
): StateResult & { readonly handled: boolean } {
  let current = state;
  const ops: StateResult["ops"] = [];
  for (const rule of registry.inputRules(phase)) {
    const result = rule.apply({ state: current, input });
    if (!result) continue;
    current = result.state;
    ops.push(...result.ops);
    if (result.handled) return { state: current, ops, handled: true };
  }
  return { state: current, ops, handled: false };
}

/**
 * Ask registered syntax rules for the first valid match at a source position.
 * Invalid zero-length/overrun matches fail loudly instead of hanging the
 * tokenizer or consuming source nondeterministically.
 */
export function matchFeatureSyntax(
  registry: FeatureFacetRegistry,
  scope: FeatureSyntaxRule["scope"],
  ctx: FeatureSyntaxCtx,
): {
  readonly rule: FeatureSyntaxRule;
  readonly match: FeatureSyntaxMatch;
} | null {
  for (const rule of registry.syntaxRules(scope)) {
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
        `Feature syntax rule "${rule.id}" returned an invalid match at offset ${ctx.offset}`,
      );
    }
    return { rule, match };
  }
  return null;
}

function upsertById<T extends { readonly id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  if (incoming.length === 0) return [...existing];
  const next = [...existing];
  for (const facet of incoming) {
    const previous = next.findIndex((entry) => entry.id === facet.id);
    if (previous >= 0) next.splice(previous, 1);
    next.push(facet);
  }
  return next;
}

function ordered<T extends OrderedFeatureFacet>(facets: readonly T[]): T[] {
  return facets
    .map((facet, index) => ({ facet, index }))
    .sort(
      (a, b) =>
        (b.facet.priority ?? 0) - (a.facet.priority ?? 0) || a.index - b.index,
    )
    .map(({ facet }) => facet);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeTree(
  base: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!patch) return { ...base };
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const before = out[key];
    out[key] =
      isRecord(before) && isRecord(value) ? mergeTree(before, value) : value;
  }
  return out;
}
