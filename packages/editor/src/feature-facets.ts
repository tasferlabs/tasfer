/**
 * Extension facets — the behavior a document type or feature contributes
 * beyond rendering.
 *
 * Type- and kind-owned behavior is registered exactly once, on the spec that
 * owns it, and the schema derives keyed dispatch from those specs (see
 * `sync/schema.ts`); there is no separate facet registry to keep in sync:
 *
 *   - `BlockSpecCore.markdownSyntax` / `MarkSpec.markdownSyntax` — Markdown
 *     recognizers ({@link SyntaxRule}) for that type's syntax.
 *   - `MarkSpec.structured` — structured-content behavior of one mark type
 *     ({@link StructuredMarkFacet}), keyed by the spec's own `type`.
 *   - `DataSchemaExtension.structuredKinds` — adapters for one structured
 *     document kind ({@link ContentSelectionSerializer},
 *     {@link ContentSelectionResolver}, {@link StructuredContentClone}). A
 *     kind is its own entity: display math and inline math share the `"math"`
 *     kind, so these adapters are not owned by a single block or mark type.
 *
 * What remains a *feature bundle* surface ({@link FeatureFacets}, installed
 * with `Schema.use` / `DataSchema.withFeatures`) is only the genuinely
 * cross-type pieces: live-input rules that must fire while typing in other
 * blocks, feature-level action hooks, and theme defaults. Those are ordered by
 * explicit priority (high first), then installation order; reusing a facet id
 * replaces the earlier definition at the later installation position, which
 * makes overrides deterministic without deduplicating by feature name.
 *
 * Input-rule ids are load-bearing: dispatch gates match on `rule.id` (for
 * example math's tree-migration gate checks that its migration rule is
 * installed), so a feature must keep its rule ids stable.
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

/** Shared identity/order fields for dispatchable, list-ordered facets. */
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

/** Token emitted by a spec-owned markdown recognizer. */
export interface SyntaxToken {
  /** Open token vocabulary; codecs claim the strings they understand. */
  readonly type: string;
  /** Decoded token payload, when the token carries content. */
  readonly content?: string;
  /** Exact consumed source, used when the active schema does not claim it. */
  readonly raw?: string;
}

/** Read-only cursor passed to a markdown recognizer. */
export interface SyntaxCtx {
  readonly source: string;
  readonly offset: number;
  readonly startOfLine: boolean;
}

/** A successful syntax recognition at the current source offset. */
export interface SyntaxMatch {
  /** Number of UTF-16 code units consumed; must be a positive integer. */
  readonly length: number;
  readonly tokens: readonly SyntaxToken[];
}

/**
 * A tokenizer extension, carried on the block or mark spec whose codec claims
 * the emitted tokens. Block rules are considered only at start-of-line; inline
 * rules are considered everywhere the core tokenizer asks extensions. The
 * schema folds every spec's rules into one deterministic dispatch list.
 */
export interface SyntaxRule extends OrderedFeatureFacet {
  readonly scope: "block" | "inline";
  match(ctx: SyntaxCtx): SyntaxMatch | undefined;
}

/** A feature-level action-bus installer not naturally owned by one node/mark. */
export interface FeatureActionHook extends OrderedFeatureFacet {
  register(bus: ActionBus): void;
}

/** Clipboard-safe representations of a selected slice of structured content. */
export interface ContentSelectionSlice {
  readonly plainText: string;
  /** Falls back to `plainText` when omitted. */
  readonly markdown?: string;
  /** Falls back to escaped `plainText` when omitted. */
  readonly html?: string;
}

/** Data-only context for serializing an extension-owned nested selection. */
export interface ContentSelectionCtx {
  readonly document: StructuredDocument;
  readonly selection: ContentSelection;
}

/**
 * Serialize a range inside one structured-document kind, registered on the
 * schema through a `structuredKinds` entry.
 *
 * This is a schema facet rather than a core switch on node names: an editor
 * without that feature installs no serializer, while any future structured
 * block can add clipboard support without changing the editor engine. Return
 * `undefined` when the range cannot be losslessly encoded.
 */
export type ContentSelectionSerializer = (
  ctx: ContentSelectionCtx,
) => ContentSelectionSlice | undefined;

/**
 * Adjust a nested range before it becomes the active selection, registered on
 * the schema through a `structuredKinds` entry.
 *
 * Core commits every non-collapsed nested selection through this adapter, so a
 * kind keeps its ranges structurally valid no matter which gesture produced
 * them — a drag, shift+click, keyboard extension, or the public API. Display
 * math uses it to snap a range so it never partially covers a construct. Like
 * the serializer above, this is a schema facet rather than a core switch on
 * document kinds. Return `undefined` to keep the range exactly as produced.
 */
export type ContentSelectionResolver = (
  ctx: ContentSelectionCtx,
) => ContentSelection | undefined;

/** One supplemental attachment initialized alongside a newly-created mark. */
export interface StructuredMarkAttachment {
  readonly contentId: string;
  readonly edit: StructuredMutation;
}

/** Data-only context for feature initialization of a new inline mark. */
export interface StructuredMarkCreateCtx {
  /** Mark requested by the generic authoring action. */
  readonly mark: Mark;
  /** Visible text that the new mark will cover. */
  readonly text: string;
  /** The document's single live persisted identity allocator. */
  readonly identities: IdentityAllocator;
}

export interface StructuredMarkCreateResult {
  /** Mark persisted by `mark_set`, normally enriched with a contentId attr. */
  readonly mark: Mark;
  /** Initializers emitted in the same transaction before the mark operation. */
  readonly attachments: readonly StructuredMarkAttachment[];
}

/** Data-only context for resolving a structured mark's canonical source. */
export interface StructuredMarkResolveCtx {
  readonly mark: Mark;
  readonly compatibilityText: string;
  readonly attachments: StructuredContentMap | undefined;
}

/** Context for rewriting a mark after its block attachments were cloned once. */
export interface StructuredMarkCloneCtx {
  readonly mark: Mark;
  readonly sourceBlockId: string;
  readonly targetBlockId: string;
  readonly attachments: StructuredContentMap | undefined;
  /** Stable source-content-id to cloned-content-id map for this block clone. */
  readonly clonedContentIds: Readonly<Record<string, string>>;
}

/**
 * Optional structured-content behavior owned by one mark type, carried on that
 * mark's spec (`MarkSpec.structured`) and keyed by the spec's own `type`.
 *
 * Core authoring and serializers dispatch this facet through the schema; they
 * never import the feature. `create` runs only for an explicitly new mark,
 * avoiding accidental replacement of an existing attachment when a range is
 * extended.
 */
export interface StructuredMarkFacet {
  create?(ctx: StructuredMarkCreateCtx): StructuredMarkCreateResult | undefined;
  /** Return undefined when the compatibility characters remain authoritative. */
  resolve?(ctx: StructuredMarkResolveCtx): string | undefined;
  /**
   * Rewrite attachment references after snapshot/import cloned each source
   * document exactly once. Return undefined when this mark needs no rewrite.
   */
  clone?(ctx: StructuredMarkCloneCtx): Mark | undefined;
  /**
   * Attachment content ids this mark references. Core lifecycle code uses
   * these to delete a mark's attachments in the same transaction that deletes
   * the whole mark, so no block accumulates unreachable structured content.
   */
  references?(ctx: StructuredMarkResolveCtx): readonly string[];
}

/** Context for cloning one attachment onto a block with a fresh identity. */
export interface StructuredContentCloneCtx {
  readonly document: StructuredDocument;
  readonly sourceBlockId: string;
  readonly targetBlockId: string;
  readonly sourceContentId: string;
  /** The destination document's single persisted identity allocator. */
  readonly identities: IdentityAllocator;
}

export interface StructuredContentCloneResult {
  readonly contentId: string;
  readonly document: StructuredDocument;
}

/**
 * Rewrite attachment addressing when a snapshot/import mints a new block id,
 * registered on the schema through a `structuredKinds` entry.
 *
 * Core defaults to copying an attachment unchanged. A document kind whose
 * addressing derives from the containing block (for example display math)
 * contributes this adapter so snapshot code remains node/feature agnostic.
 * Return `undefined` to fall back to the unchanged copy.
 */
export type StructuredContentClone = (
  ctx: StructuredContentCloneCtx,
) => StructuredContentCloneResult | undefined;

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

/**
 * The cross-type facets accepted by a reusable feature bundle — the pieces no
 * single node, mark, or structured kind can own. Everything else registers on
 * the owning spec (see the module doc); the tombstoned keys below make a
 * bundle still carrying the old shape fail to compile.
 */
export interface FeatureFacets {
  readonly inputRules?: readonly FeatureInputRule[];
  readonly actions?: readonly FeatureActionHook[];
  readonly theme?: FeatureThemeDefaults;
  /** Removed — Markdown recognizers ride the owning spec's `markdownSyntax`. */
  readonly markdownSyntax?: never;
  /** Removed — selection serializers ride `structuredKinds[].contentSelection`. */
  readonly contentSelections?: never;
  /** Removed — selection resolvers ride `structuredKinds[].resolveSelection`. */
  readonly contentSelectionResolvers?: never;
  /** Removed — structured-mark behavior rides the mark spec's `structured`. */
  readonly structuredMarks?: never;
  /** Removed — clone adapters ride `structuredKinds[].clone`. */
  readonly structuredContentClones?: never;
}

/** A feature-shaped value accepted by `DataSchema.withFeatures`. */
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
 * Upsert facets by id: a reused id replaces the earlier definition at the
 * later installation position. @internal — schema derivation helper.
 */
export function upsertFacetsById<T extends { readonly id: string }>(
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

/**
 * Deterministic dispatch order: priority descending, then installation order.
 * @internal — schema derivation helper.
 */
export function orderedFacets<T extends OrderedFeatureFacet>(
  facets: readonly T[],
): T[] {
  return facets
    .map((facet, index) => ({ facet, index }))
    .sort(
      (a, b) =>
        (b.facet.priority ?? 0) - (a.facet.priority ?? 0) || a.index - b.index,
    )
    .map(({ facet }) => facet);
}

/**
 * Fold feature theme defaults in installation order (later wins per leaf).
 * @internal — schema derivation helper.
 */
export function resolveFeatureThemeDefaults(
  themes: readonly FeatureThemeDefaults[],
): ResolvedFeatureThemeDefaults {
  let tokens: Record<string, unknown> = {};
  let styles: Record<string, unknown> = {};
  let strings: Record<string, unknown> = {};
  let nodeStrings: Record<string, unknown> = {};
  for (const theme of themes) {
    tokens = mergeTree(tokens, theme.tokens);
    styles = mergeTree(styles, theme.styles);
    strings = mergeTree(strings, theme.strings);
    nodeStrings = mergeTree(nodeStrings, theme.nodeStrings);
  }
  return { tokens, styles, strings, nodeStrings };
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
