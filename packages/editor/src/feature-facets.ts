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
 * blocks, whole-payload paste recognition, feature-level action hooks, and
 * theme defaults. Those are ordered by explicit priority (high first), then
 * installation order; reusing a facet id replaces the earlier definition at
 * the later installation position, which makes overrides deterministic without
 * deduplicating by feature name.
 *
 * Input-rule ids are load-bearing: dispatch gates match on `rule.id` (for
 * example math's tree-migration gate checks that its migration rule is
 * installed), so a feature must keep its rule ids stable.
 */

import type { ActionBus, StateResult } from "./action-bus";
import type { Block, Mark } from "./serlization/loadPage";
import type { EditorState } from "./state-types";
import type { ContentPoint, ContentSelection } from "./structured-selection";
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

/**
 * When an input rule runs: before the typed text is inserted, or after.
 *
 * @group Features
 */
export type FeatureInputPhase = "before-insert" | "after-insert";

/**
 * Context passed to a feature-owned live-input rule.
 *
 * @group Features
 */
export interface FeatureInputRuleCtx {
  /** The current editor state, including changes made by earlier rules. */
  readonly state: EditorState;
  /** The exact text supplied by the input event. */
  readonly input: string;
  /**
   * How the insert was asked for, such as `wrapSelection` when typing. If your
   * rule passes the input on to `insertText`, pass these options too. Then the
   * keystroke behaves as it does in a paragraph.
   */
  readonly options?: FeatureInputOptions;
}

/** The `insertText` options an input rule sees (see `InsertTextOptions`). */
export interface FeatureInputOptions {
  readonly wrapSelection?: boolean;
  /**
   * `false` means Markdown shortcuts are off for this text, as in a table cell
   * without them. A rule that adds a shortcut of its own, such as `$x$` for
   * math, should then leave the typed text as it is.
   */
  readonly inlineMarkdown?: boolean;
}

/**
 * A rule that runs on text input in any block. `phase` says whether it runs
 * before or after the text is inserted. Rules with a higher `priority` run
 * first.
 *
 * @group Features
 */
export interface FeatureInputRule extends OrderedFeatureFacet {
  readonly phase: FeatureInputPhase;
  /**
   * Return `true` when this rule must handle the input before the editor
   * changes the text itself. The editor asks this for edits that skip normal
   * typing, such as paste, cut, and inserting text at a range through the API.
   *
   * Only answer the question here. Do not change state or create ids.
   * {@link apply} makes the edit.
   */
  readonly owns?: (ctx: FeatureInputRuleCtx) => boolean;
  /**
   * Return `undefined` when the rule does not match. Otherwise return the new
   * state and its ops. The next rule sees that state, and the ops join the
   * current edit.
   *
   * Set `handled` to stop the rules with a lower priority in this phase. In the
   * `before-insert` phase it also skips the editor's own insert. Edits from
   * earlier rules are kept.
   *
   * The result must depend only on the arguments. Every change that must be
   * saved has to be in the returned ops.
   */
  apply(
    ctx: FeatureInputRuleCtx,
  ): (StateResult & { readonly handled?: boolean }) | undefined;
}

/**
 * A feature-owned rewrite of clipboard text before Markdown parsing.
 *
 * @group Features
 */
export interface FeaturePasteRule extends OrderedFeatureFacet {
  /** Skip this rule when the schema forbids authoring the named mark. */
  readonly requiresMark?: string;
  /**
   * Return the rewritten text, or `undefined` when this rule does not recognize
   * the whole clipboard text. Rules run highest priority first, and the first
   * one that returns text wins.
   */
  transform(text: string): string | undefined;
}

/**
 * Token emitted by a spec-owned markdown recognizer.
 *
 * @group Features
 */
export interface SyntaxToken {
  /**
   * The token's kind. It can be any string. A codec reads the kinds it knows.
   */
  readonly type: string;
  /** Decoded token payload, when the token carries content. */
  readonly content?: string;
  /** Exact consumed source, used when the active schema does not claim it. */
  readonly raw?: string;
}

/**
 * Where a Markdown rule is asked to match: the whole `source`, the `offset` to
 * match at, and whether that offset starts a line (`startOfLine`).
 *
 * @group Features
 */
export interface SyntaxCtx {
  readonly source: string;
  readonly offset: number;
  readonly startOfLine: boolean;
}

/**
 * What a Markdown rule returns when it matches at the current offset. `length`
 * must be positive and stay inside the source, and `tokens` must not be empty.
 * Otherwise the parser throws.
 *
 * @group Features
 */
export interface SyntaxMatch {
  /** Number of UTF-16 code units consumed; must be a positive integer. */
  readonly length: number;
  readonly tokens: readonly SyntaxToken[];
}

/**
 * A Markdown rule. Put it in `markdownSyntax` on the block or mark spec that
 * reads the tokens it emits.
 *
 * Block rules run only at the start of a line. Inline rules run wherever the
 * parser checks for inline syntax. Rules with a higher `priority` run first,
 * and the first match wins. Return `undefined` from `match` when nothing
 * matches.
 *
 * Each rule's `id` must be unique in the schema. If two specs use the same id,
 * building the schema throws.
 *
 * @group Features
 */
export interface SyntaxRule extends OrderedFeatureFacet {
  readonly scope: "block" | "inline";
  match(ctx: SyntaxCtx): SyntaxMatch | undefined;
}

/**
 * Adds a feature's own actions to an editor. `register` runs once for each
 * editor as it is set up, after the editor's nodes and marks add theirs. Use it
 * for actions that do not belong to one node or mark.
 *
 * @group Features
 */
export interface FeatureActionHook extends OrderedFeatureFacet {
  register(bus: ActionBus): void;
}

/**
 * Clipboard-safe representations of a selected slice of structured content.
 *
 * @group Features
 */
export interface ContentSelectionSlice {
  readonly plainText: string;
  /**
   * The Markdown to copy. When left out, it is made from {@link blocks}, or is
   * `plainText` when there are no blocks.
   */
  readonly markdown?: string;
  /**
   * The HTML to copy. When left out, it is made from {@link blocks}, or from
   * the escaped `plainText` when there are no blocks.
   */
  readonly html?: string;
  /**
   * The selected part as standalone blocks. For example, a table's selected
   * cells become a smaller table, and a cell's selected text becomes a
   * paragraph.
   *
   * The editor builds any Markdown or HTML you leave out from these blocks, so
   * formatting is kept. Pasting into normal text rebuilds these same blocks.
   */
  readonly blocks?: readonly Block[];
}

/**
 * What a kind's selection adapters get: the structured `document` and the
 * `selection` inside it.
 *
 * @group Features
 */
export interface ContentSelectionCtx {
  readonly document: StructuredDocument;
  readonly selection: ContentSelection;
}

/**
 * Turns a range inside a structured document into clipboard content. Register
 * it as `contentSelection` on a `structuredKinds` entry.
 *
 * Return `undefined` when the range cannot be copied without losing something.
 *
 * @group Features
 */
// This is a schema facet rather than a core switch on node names: an editor
// without that feature installs no serializer, while any future structured
// block can add clipboard support without changing the editor engine.
export type ContentSelectionSerializer = (
  ctx: ContentSelectionCtx,
) => ContentSelectionSlice | undefined;

/**
 * What a paste into an extension-owned nested selection carries.
 *
 * @group Features
 */
export interface ContentSelectionPasteCtx extends ContentSelectionCtx {
  /** The editor state the paste applies to. */
  readonly state: EditorState;
  /** The clipboard's plain-text flavor (possibly empty). */
  readonly text: string;
  /**
   * The Markdown of a copy made in Tasfer, or `undefined` when it was copied
   * from somewhere else. Read it to keep the formatting. A copy from outside
   * only gives {@link text}.
   */
  readonly markdown?: string;
}

/**
 * Handles a paste into a range inside a structured document. Register it as
 * `paste` on a `structuredKinds` entry.
 *
 * The editor offers every paste into such a range here first. Return
 * `undefined` to let the editor insert the plain text as if it were typed. A
 * table uses this to spread a copied grid across cells. The returned ops are
 * the whole paste.
 *
 * @group Features
 */
export type ContentSelectionPaste = (
  ctx: ContentSelectionPasteCtx,
) => StateResult | undefined;

/**
 * Adjusts a range inside a structured document before it becomes the selection.
 * Register it as `resolveSelection` on a `structuredKinds` entry.
 *
 * The editor runs every non-empty range through it, whether it came from a
 * drag, shift+click, the keyboard or the API. Display math uses it so a range
 * never covers only part of a construct. Return `undefined` to keep the range
 * as it is.
 *
 * @group Features
 */
export type ContentSelectionResolver = (
  ctx: ContentSelectionCtx,
) => ContentSelection | undefined;

/**
 * Cuts a copy of a structured document down to a range inside it. Register it
 * as `sliceSelection` on a `structuredKinds` entry.
 *
 * Return a separate copy that holds only what `selection` covers, under the
 * same root id. Do not edit the live document. The editor uses this when a
 * copied text selection takes only part of an inline formula, so the clipboard
 * gets just that part.
 *
 * Return `undefined` when the range cannot stand on its own. The whole formula
 * is then copied.
 *
 * @group Features
 */
export type ContentSelectionSlicer = (
  ctx: ContentSelectionCtx,
) => StructuredDocument | undefined;

/**
 * What a kind is asked when a text selection stops inside one of its documents.
 *
 * @group Features
 */
export interface ContentEdgeRangeCtx {
  readonly document: StructuredDocument;
  readonly blockId: string;
  readonly contentId: string;
  /** The stop inside the document where the selection begins or ends. */
  readonly point: ContentPoint;
  /** The edge of the document the selected part runs to, in reading order. */
  readonly edge: "start" | "end";
}

/**
 * The part of a structured document between a stop inside it and one edge.
 *
 * @group Features
 */
export interface ContentEdgeRange {
  /**
   * The selected part. `anchor` is on the side of the stop and `focus` on the
   * side of the edge. Widen it to cover anything the kind only takes whole.
   */
  readonly selection: ContentSelection;
  /** How much of the document the part holds. */
  readonly covers: "none" | "part" | "all";
}

/**
 * Decides how much of a structured document a text selection takes when it
 * starts or ends inside it. Register it as `edgeRange` on a `structuredKinds`
 * entry.
 *
 * For example, a selection can start in the middle of an inline formula and run
 * into the text around it. The editor asks the formula's kind what lies between
 * that point and the formula's edge. It then highlights, copies and deletes
 * just that part. A kind without this adapter is always taken whole.
 *
 * Return `undefined` when the point no longer exists in the document.
 *
 * @group Features
 */
export type ContentEdgeRangeResolver = (
  ctx: ContentEdgeRangeCtx,
) => ContentEdgeRange | undefined;

/**
 * The single flat character anchoring a structured mark's run.
 *
 * A structured mark never stores its source in block characters: its content
 * lives wholly in the referenced attachment, and one U+FFFC object-replacement
 * character holds the mark's place in the flat text. Hosts without the owning
 * feature render that placeholder glyph.
 */
export const STRUCTURED_MARK_ANCHOR_CHAR = "￼";

/**
 * One attachment created with a new structured mark: its id (`contentId`) and
 * the edit that fills it (`edit`).
 *
 * @group Features
 */
export interface StructuredMarkAttachment {
  readonly contentId: string;
  readonly edit: StructuredMutation;
}

/**
 * What a structured mark's `create` hook gets when a new mark is made.
 *
 * @group Features
 */
export interface StructuredMarkCreateCtx {
  /** Mark requested by the generic authoring action. */
  readonly mark: Mark;
  /**
   * The text to put in the new attachment, such as the selected text being
   * wrapped.
   */
  readonly text: string;
  /**
   * Makes new ids in this document. Use it for any id the new attachment needs.
   */
  readonly identities: IdentityAllocator;
}

/**
 * What a structured mark's `create` hook returns (see
 * {@link StructuredMarkFacet}): the mark to store, and the attachments that
 * hold its content. They are all created in the same change, before the mark.
 *
 * The mark must keep the type that was asked for. Each attachment needs its own
 * non-empty `contentId`, and the document must accept it. Otherwise applying
 * the mark throws.
 *
 * @group Features
 */
export interface StructuredMarkCreateResult {
  /**
   * The mark to store. It usually has a `contentId` attribute that points at
   * its attachment.
   */
  readonly mark: Mark;
  /**
   * The attachments to create. They are created in the same change, before the
   * mark is set.
   */
  readonly attachments: readonly StructuredMarkAttachment[];
}

/**
 * What a structured mark's `resolve` and `references` hooks get: the `mark` and
 * its block's `attachments`.
 *
 * @group Features
 */
export interface StructuredMarkResolveCtx {
  readonly mark: Mark;
  readonly attachments: StructuredContentMap | undefined;
}

/**
 * Canonical sources that became adjacent while creating one structured mark.
 *
 * @group Features
 */
export interface StructuredMarkJoinCtx {
  readonly left: string;
  readonly right: string;
}

/**
 * What a structured mark's `clone` hook gets after its block and the block's
 * attachments were copied.
 *
 * @group Features
 */
export interface StructuredMarkCloneCtx {
  readonly mark: Mark;
  readonly sourceBlockId: string;
  readonly targetBlockId: string;
  readonly attachments: StructuredContentMap | undefined;
  /** Maps each old attachment id to its new id in the copied block. */
  readonly clonedContentIds: Readonly<Record<string, string>>;
}

/**
 * Extra behavior for a mark whose content lives in an attachment instead of the
 * text, like inline math. Put it on the mark's spec as `MarkSpec.structured`.
 *
 * In the text, the mark takes one {@link STRUCTURED_MARK_ANCHOR_CHAR}. Its
 * content lives only in the attachment. `create` runs only when a new mark is
 * made, not when an existing one is extended, so it never replaces an existing
 * attachment.
 *
 * The same mark can also sit in a text field of a structured document, such as
 * a table cell, and point at another attachment on the same block. When the
 * block is copied (paste, snapshot restore), the editor updates those marks
 * with `clone` too, and copies their attachments to the clipboard. So a node
 * with rich-text fields needs no extra code for them.
 *
 * @group Features
 */
export interface StructuredMarkFacet {
  create?(ctx: StructuredMarkCreateCtx): StructuredMarkCreateResult | undefined;
  /**
   * Joins the sources of two runs that become one mark. By default they are
   * joined as they are. Use it to add a separator your syntax needs.
   */
  joinSources?(ctx: StructuredMarkJoinCtx): string;
  /**
   * Returns the mark's source (for math, its LaTeX) from its attachment. Return
   * `undefined` when the attachment is missing or broken. The run then shows
   * its placeholder and stays one unit.
   */
  resolve?(ctx: StructuredMarkResolveCtx): string | undefined;
  /**
   * Returns the mark with its attachment ids updated after its block was
   * copied, for example on paste or import. Return `undefined` when the mark
   * needs no change.
   */
  clone?(ctx: StructuredMarkCloneCtx): Mark | undefined;
  /**
   * Returns the ids of the attachments this mark uses. When the whole mark is
   * deleted, the editor deletes these attachments in the same change, so no
   * unused content is left behind.
   */
  references?(ctx: StructuredMarkResolveCtx): readonly string[];
}

/**
 * What a {@link StructuredContentClone} gets when a block is copied under a new
 * id: the attachment, the old and new block ids, the attachment's old id, and a
 * way to make new ids.
 *
 * @group Features
 */
export interface StructuredContentCloneCtx {
  readonly document: StructuredDocument;
  readonly sourceBlockId: string;
  readonly targetBlockId: string;
  readonly sourceContentId: string;
  /**
   * Makes new ids in the document you are copying into. Use it for any new id
   * you need.
   */
  readonly identities: IdentityAllocator;
}

/**
 * What a {@link StructuredContentClone} returns: the copied attachment
 * (`document`) and the id it is stored under on the new block (`contentId`).
 *
 * @group Features
 */
export interface StructuredContentCloneResult {
  readonly contentId: string;
  readonly document: StructuredDocument;
}

/**
 * Updates an attachment's ids when its block is copied under a new id, for
 * example on import or when a block is split. Register it as `clone` on a
 * `structuredKinds` entry.
 *
 * By default the editor copies the attachment unchanged. A kind whose ids
 * depend on the block it sits in, like display math, uses this to update them.
 * The returned document's root id must equal the returned `contentId`, or the
 * copy fails. Return `undefined` to keep the unchanged copy.
 *
 * @group Features
 */
export type StructuredContentClone = (
  ctx: StructuredContentCloneCtx,
) => StructuredContentCloneResult | undefined;

/**
 * Theme defaults a feature adds, such as a diagram palette. The host's theme
 * applies on top, so the host can still change them.
 *
 * Features merge in install order, and later ones win. Objects merge key by
 * key. Arrays and plain values are replaced.
 *
 * @group Features
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
 * The parts of a feature bundle that no single node, mark or structured kind
 * owns: input rules, paste rules, actions and theme defaults. Everything else
 * goes on the spec that owns it.
 *
 * The removed keys below are kept so an old bundle that still sets them fails
 * to compile. In JavaScript it throws an error instead.
 *
 * @group Features
 */
export interface FeatureFacets {
  readonly inputRules?: readonly FeatureInputRule[];
  readonly pasteRules?: readonly FeaturePasteRule[];
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

/**
 * The theme defaults of every installed feature, merged into one (later
 * features win). The editor applies the host's own theme on top of it. Returned
 * by `DataSchema.resolveThemeDefaults()`.
 */
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
