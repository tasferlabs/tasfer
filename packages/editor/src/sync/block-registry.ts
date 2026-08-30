/**
 * Block Type Registry — the built-in block-type metadata: defaults,
 * capabilities, settable fields (with validators), and safe type-morph targets.
 *
 * This is the BUILT-IN data the default schema is assembled from
 * (`baseDataSchema` in ./schema wraps `BLOCK_REGISTRY` + the codecs). The
 * reducer/serializers dispatch through a per-instance `DataSchema` so custom
 * types work; the free helpers here read the built-in table directly and are
 * null-safe for unknown types (the not-yet-schema-threaded paths — inverse,
 * snapshot-diff — degrade rather than throw when they meet a custom block).
 */

import type { TextualBlock } from "../nodes/TextNode";
import type { Block } from "../serlization/loadPage";
import type { BlockType } from "../state-types";

// =============================================================================
// Field descriptors
// =============================================================================

export interface FieldDescriptor {
  readonly validate: (value: unknown) => boolean;
  /**
   * Captures the value of this field on a block for inverse-op generation.
   * Most fields just return `block[field]`; encoded as a function so that
   * future fields can derive values (e.g. defaulting undefined → "full").
   */
  readonly extractForInverse: (block: Block) => unknown;
}

// =============================================================================
// Capabilities
// =============================================================================

export interface BlockCapabilities {
  readonly hasText: boolean;
  readonly hasFormats: boolean;
  readonly indentable: boolean;
  readonly togglable: boolean;
  /**
   * Which list family the block belongs to, if any. Drives serializer
   * numbering and HTML <ul>/<ol> grouping without per-type switches.
   */
  readonly listKind?: "bullet" | "numbered" | "todo";
  /** Heading-role block: preferred source when extracting a page title. */
  readonly isHeading?: boolean;
  /**
   * Raw/verbatim text block (e.g. a code block): the Tab key inserts literal
   * indentation rather than moving focus, newlines are kept verbatim, and no
   * inline marks apply. Lets the Tab handler stay type-agnostic — a new
   * code-like block opts in here instead of being named in events/keysEvents.
   */
  readonly preformatted?: boolean;
  /**
   * Self-contained block you "fall out of" at the document edge. When the caret
   * is on the block's first/last line and the block is the first/last in the
   * document, a vertical caret move (ArrowUp/Down, PageUp/Down) or a click in the
   * empty area above/below it starts a fresh paragraph there and places the caret
   * in it, instead of clamping to the block's own text. Set on code / math /
   * quote; left off for paragraph / heading / list, whose edge lines are ordinary
   * continuable text.
   *
   * This flag is only needed by blocks that DO store text. A block with no flat
   * text of its own (image / line / table, and any host-registered block) has no
   * edge to clamp to and escapes anyway — see {@link escapesAtDocumentEdge},
   * which is the predicate the edge helpers actually ask.
   */
  readonly selfContained?: boolean;
  /**
   * Interchangeability group for SUBSTITUTION: two types share one when a block
   * of either reads as the same content in the other, so a schema that forbids
   * one may coerce it to the other instead of dropping it (see
   * `normalizeBlocks`). The built-in rich-text family (paragraph, headings,
   * lists, math) shares group `"text"`; visual blocks and code omit it —
   * a code block's text is source, not prose, so a schema that bans code drops
   * it rather than flattening it into a paragraph.
   *
   * This does NOT gate whether a `block_set { field: "type" }` morph carries
   * charRuns: it always does between two text-storing types, matching what the
   * local convert actions do (see the `type` branch of `applyBlockSet`).
   */
  readonly morphGroup?: string;
  /**
   * Projects this block's raw text into a ONE-LINE INLINE markdown context —
   * page-title extraction, where a whole block becomes a single title line.
   * A math block's text is LaTeX source, so it projects as an inline math run
   * (`$…$`): title previews then typeset the formula instead of leaking raw
   * source to the reader. Absent → the text passes through unprojected.
   */
  readonly titleInlineMarkdown?: (text: string) => string;
}

// =============================================================================
// Block type descriptor
// =============================================================================

export interface BlockTypeDescriptor {
  readonly type: BlockType;
  readonly capabilities: BlockCapabilities;
  readonly defaults: (id: string, orderKey: string) => Block;
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
}

// =============================================================================
// Shared field descriptors
// =============================================================================

const typeField: FieldDescriptor = {
  validate: (value): boolean => isValidBlockType(value),
  extractForInverse: (block) => block.type,
};

const indentField: FieldDescriptor = {
  validate: (value): boolean =>
    typeof value === "number" && Number.isInteger(value) && value >= 0,
  extractForInverse: (block) =>
    "indent" in block ? (block as { indent: number }).indent : 0,
};

const checkedField: FieldDescriptor = {
  validate: (value): boolean => typeof value === "boolean",
  extractForInverse: (block) =>
    "checked" in block ? (block as { checked: boolean }).checked : false,
};

/**
 * A field whose inverse value is just the named property, read generically.
 *
 * A field descriptor is only ever applied to blocks of the type that owns it —
 * `inverse`/`snapshot-diff` look fields up through the block's own descriptor
 * (`getBlockFieldNames(block.type)` / `descriptor.fields[op.field]`) — so no
 * per-type `block.type === …` narrowing is needed to reach the property. This
 * mirrors how `defineNode` generates the field descriptors for a custom node's
 * declared attrs, keeping built-in and custom types on one extraction path.
 */
function propField(
  name: string,
  validate: (value: unknown) => boolean,
): FieldDescriptor {
  return {
    validate,
    extractForInverse: (block) =>
      (block as unknown as Record<string, unknown>)[name],
  };
}

const urlField = propField("url", (value) => typeof value === "string");

const altField = propField(
  "alt",
  (value) => typeof value === "string" || value === undefined,
);

const widthField = propField(
  "width",
  (value) => value === "full" || typeof value === "number",
);

const heightField = propField("height", (value) => typeof value === "number");

const objectFitField = propField(
  "objectFit",
  (value) => value === "cover" || value === "contain",
);

/**
 * The cover crop origin, as a pair of `[0, 1]` fractions. Both axes travel in
 * ONE field so the CRDT's per-field last-writer-wins keeps them atomic: two
 * peers repositioning the same cover converge on one of the two positions
 * actually chosen, instead of interleaving into an x/y pair neither picked.
 */
const objectPositionField = propField("objectPosition", (value) => {
  if (typeof value !== "object" || value === null) return false;
  const { x, y } = value as { x: unknown; y: unknown };
  const inRange = (n: unknown): boolean =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  return inRange(x) && inRange(y);
});

const displayModeField = propField(
  "displayMode",
  (value) => typeof value === "boolean",
);

const languageField = propField(
  "language",
  (value) => typeof value === "string" || value === undefined,
);

// =============================================================================
// Base block shape — matches `createEmptyBlock`'s base in reducer.ts
// =============================================================================

interface BaseBlockShape {
  readonly id: string;
  readonly orderKey: string;
  readonly deleted: false;
}

function makeBase(id: string, orderKey: string): BaseBlockShape {
  return { id, orderKey, deleted: false };
}

// =============================================================================
// Descriptors
// =============================================================================

const TEXTUAL_CAPS: BlockCapabilities = {
  hasText: true,
  hasFormats: true,
  indentable: false,
  togglable: false,
  morphGroup: "text",
};

const HEADING_CAPS: BlockCapabilities = {
  ...TEXTUAL_CAPS,
  isHeading: true,
};

// A quote is ordinary rich text in a card, but it reads as a self-contained
// block: at the document's end you "fall out of" it into a fresh paragraph
// rather than continuing inside the card.
const QUOTE_CAPS: BlockCapabilities = {
  ...TEXTUAL_CAPS,
  selfContained: true,
};

const BULLET_CAPS: BlockCapabilities = {
  hasText: true,
  hasFormats: true,
  indentable: true,
  togglable: false,
  listKind: "bullet",
  morphGroup: "text",
};

const NUMBERED_CAPS: BlockCapabilities = {
  ...BULLET_CAPS,
  listKind: "numbered",
};

const TODO_CAPS: BlockCapabilities = {
  hasText: true,
  hasFormats: true,
  indentable: true,
  togglable: true,
  listKind: "todo",
  morphGroup: "text",
};

const VISUAL_CAPS: BlockCapabilities = {
  hasText: false,
  hasFormats: false,
  indentable: false,
  togglable: false,
};

// Code blocks hold editable text (so they are "textual" for cursor/selection/
// hit-test purposes) but carry NO inline marks — formatting toggles are gated
// off by `hasFormats: false`, so bold/italic/etc. never apply inside code.
const CODE_CAPS: BlockCapabilities = {
  hasText: true,
  hasFormats: false,
  indentable: false,
  togglable: false,
  preformatted: true,
  selfContained: true,
};

// Math blocks are textual too — their char-run text IS the LaTeX, so the caret
// lives inside the equation (canvas-native editing). Like code, they carry NO
// inline marks (`hasFormats: false`): the whole content is one equation rendered
// through the tex bridge, not bold/italic-able text. `preformatted` keeps the
// LaTeX verbatim (no markdown auto-format) the way code keeps source verbatim.
// Unlike code, math joins the text morph group: its LaTeX reads as one line of
// prose, so a schema that bans math coerces it to a paragraph instead of losing
// the formula. Callers clear or add marks explicitly in the same op batch.
const MATH_CAPS: BlockCapabilities = {
  hasText: true,
  hasFormats: false,
  indentable: false,
  togglable: false,
  preformatted: true,
  selfContained: true,
  morphGroup: "text",
  // As a page title, a display equation becomes an inline math run — the same
  // `$…$` delimiters the inline math MarkCodec emits — so previews typeset it.
  titleInlineMarkdown: (text) => `$${text}$`,
};

// A table block stores nothing flat: its columns, rows and cells all live in
// its authoritative structured attachment, so the block itself is a bare
// identity. It is non-textual, which is what makes a caret move or a click past
// the document edge escape into a fresh paragraph rather than land inside it —
// though the grid owns its own caret, so it answers the keyboard half itself
// (see `exitTable` in `@tasfer/table`).
const TABLE_CAPS: BlockCapabilities = {
  hasText: false,
  hasFormats: false,
  indentable: false,
  togglable: false,
  // No `morphGroup`: a grid does not read as prose in any other type, so a
  // schema that bans tables drops the block rather than flattening it.
};

// Each descriptor uses `satisfies BlockTypeDescriptor` so it is checked against
// the descriptor shape while keeping its own inferred type for local reads.

const paragraphDescriptor = {
  type: "paragraph",
  capabilities: TEXTUAL_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "paragraph",
    charRuns: [],
    formats: [],
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const quoteDescriptor = {
  type: "quote",
  capabilities: QUOTE_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "quote",
    charRuns: [],
    formats: [],
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const heading1Descriptor = {
  type: "heading1",
  capabilities: HEADING_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "heading1",
    charRuns: [],
    formats: [],
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const heading2Descriptor = {
  type: "heading2",
  capabilities: HEADING_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "heading2",
    charRuns: [],
    formats: [],
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const heading3Descriptor = {
  type: "heading3",
  capabilities: HEADING_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "heading3",
    charRuns: [],
    formats: [],
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const bulletListDescriptor = {
  type: "bullet_list",
  capabilities: BULLET_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "bullet_list",
    charRuns: [],
    formats: [],
    indent: 0,
  }),
  fields: { type: typeField, indent: indentField },
} satisfies BlockTypeDescriptor;

const numberedListDescriptor = {
  type: "numbered_list",
  capabilities: NUMBERED_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "numbered_list",
    charRuns: [],
    formats: [],
    indent: 0,
  }),
  fields: { type: typeField, indent: indentField },
} satisfies BlockTypeDescriptor;

const todoListDescriptor = {
  type: "todo_list",
  capabilities: TODO_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "todo_list",
    charRuns: [],
    formats: [],
    checked: false,
    indent: 0,
  }),
  fields: { type: typeField, indent: indentField, checked: checkedField },
} satisfies BlockTypeDescriptor;

const imageDescriptor = {
  type: "image",
  capabilities: VISUAL_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "image",
    url: "",
  }),
  fields: {
    type: typeField,
    url: urlField,
    alt: altField,
    width: widthField,
    height: heightField,
    objectFit: objectFitField,
    objectPosition: objectPositionField,
  },
} satisfies BlockTypeDescriptor;

const lineDescriptor = {
  type: "line",
  capabilities: VISUAL_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "line",
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const mathDescriptor = {
  type: "math",
  capabilities: MATH_CAPS,
  defaults: (id: string, orderKey: string): Block =>
    ({
      ...makeBase(id, orderKey),
      type: "math",
      charRuns: [],
      formats: [],
      displayMode: true,
    }) as unknown as Block,
  fields: {
    type: typeField,
    displayMode: displayModeField,
  },
} satisfies BlockTypeDescriptor;

const codeDescriptor = {
  type: "code",
  capabilities: CODE_CAPS,
  defaults: (id: string, orderKey: string): Block => ({
    ...makeBase(id, orderKey),
    type: "code",
    charRuns: [],
    formats: [],
    language: "",
  }),
  fields: {
    type: typeField,
    language: languageField,
  },
  // Code omits a `morphGroup`: its text is source, not prose, so a schema that
  // bans code drops the block rather than flattening its "\n"-separated lines
  // into a paragraph. Converting to/from code on purpose still keeps the text —
  // that path doesn't consult `morphGroup`.
} satisfies BlockTypeDescriptor;

const tableDescriptor = {
  type: "table",
  capabilities: TABLE_CAPS,
  defaults: (id: string, orderKey: string): Block =>
    ({
      ...makeBase(id, orderKey),
      type: "table",
    }) as unknown as Block,
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

// The built-in block-type table — the single runtime source of truth for the
// built-in set. Every "what block types exist" query (validation, the "type"
// field's validator, morph compatibility) derives from this map; there is no
// separate hand-listed enumeration to keep in sync.
export const BLOCK_REGISTRY = {
  paragraph: paragraphDescriptor,
  quote: quoteDescriptor,
  heading1: heading1Descriptor,
  heading2: heading2Descriptor,
  heading3: heading3Descriptor,
  bullet_list: bulletListDescriptor,
  numbered_list: numberedListDescriptor,
  todo_list: todoListDescriptor,
  image: imageDescriptor,
  line: lineDescriptor,
  math: mathDescriptor,
  code: codeDescriptor,
  table: tableDescriptor,
} satisfies Record<BlockType, BlockTypeDescriptor>;

// =============================================================================
// Helpers
// =============================================================================
//
// All helpers below access the registry through the wide BlockTypeDescriptor
// view so that runtime-string indexing into `fields`/capabilities works.

const REGISTRY: Readonly<Record<string, BlockTypeDescriptor>> = BLOCK_REGISTRY;

/**
 * The descriptor for a built-in block type, or `undefined` for any type not
 * in the built-in registry (a custom type registered only on an instance
 * schema). Callers in the not-yet-schema-threaded paths (inverse, snapshot
 * diff) treat `undefined` as "can't model this here" and degrade rather than
 * throw — custom blocks are simply skipped by those paths.
 */
export function getBlockDescriptor(
  type: string,
): BlockTypeDescriptor | undefined {
  return REGISTRY[type];
}

export function hasTextContent(type: string): boolean {
  return REGISTRY[type]?.capabilities.hasText ?? false;
}

/**
 * Type guard for textual blocks (headings, paragraph, and the list family).
 *
 * Lives here — with the registry it queries — rather than in `TextNode`,
 * for the same reason `isListBlock` lives in `loadPage`: the view extends
 * `TextNode`, so co-locating the predicate there made every lightweight
 * consumer (state-utils, sync/*, serializers, events, …) pull in the whole
 * view inheritance chain and created an init-time import cycle
 * (TextNode → state-utils → blocks barrel → ListNode → TextNode).
 * `block-registry` is a runtime leaf (only `import type`), so importing the
 * guard from here can never form such a cycle.
 */
export function isTextualBlock(block: Block): block is TextualBlock {
  return hasTextContent(block.type);
}

export function canHaveFormats(type: string): boolean {
  return REGISTRY[type]?.capabilities.hasFormats ?? false;
}

/**
 * The block type's title projection (see
 * {@link BlockCapabilities.titleInlineMarkdown}), or undefined when its text
 * needs none.
 */
export function titleInlineMarkdownProjection(
  type: string,
): ((text: string) => string) | undefined {
  return REGISTRY[type]?.capabilities.titleInlineMarkdown;
}

/**
 * Whether a vertical caret move or a click past the edge of this block should
 * escape into a fresh paragraph above/below it rather than land inside the block
 * (see {@link BlockCapabilities.selfContained}). True for code / math / quote;
 * false for ordinary text blocks. Non-textual blocks report false here and
 * escape through the other arm of {@link escapesAtDocumentEdge}.
 */
export function isSelfContained(block: Block): boolean {
  return REGISTRY[block.type]?.capabilities.selfContained ?? false;
}

/**
 * Whether a caret move or a click *past* this block, while it sits at the
 * document's edge, should grow a fresh paragraph there rather than land back
 * inside the block. True for two families, for the same reason:
 *
 *   - `selfContained` text blocks (code / math / quote) — their edge line is
 *     not continuable prose, so you fall out of them rather than typing on;
 *   - every non-textual block (image / line / table, and any block a host
 *     registers that stores no flat text) — there is no text to land in at all.
 *
 * The second arm is the default for unknown types, which is deliberate: a
 * custom block gets the escape without opting in, so a document whose only
 * block is one is never a trap with nowhere to type. Ordinary text blocks
 * (paragraph / heading / list) report false — their edge is continuable, and a
 * click past it belongs at the end of their own text.
 */
export function escapesAtDocumentEdge(block: Block): boolean {
  return !isTextualBlock(block) || isSelfContained(block);
}

export function isIndentable(type: string): boolean {
  return REGISTRY[type]?.capabilities.indentable ?? false;
}

export function isTogglable(type: string): boolean {
  return REGISTRY[type]?.capabilities.togglable ?? false;
}

/**
 * The list family a block type belongs to ("bullet" | "numbered" | "todo"),
 * or undefined for non-list blocks. Replaces the per-type comparisons that
 * drove serializer numbering and HTML <ul>/<ol> grouping.
 */
export function getListKind(
  type: string,
): "bullet" | "numbered" | "todo" | undefined {
  return REGISTRY[type]?.capabilities.listKind;
}

/** Whether a block type renders as any kind of list item. */
export function isListType(type: string): boolean {
  return REGISTRY[type]?.capabilities.listKind !== undefined;
}

/** Whether a block type is a heading (the preferred page-title source). */
export function isHeadingType(type: string): boolean {
  return REGISTRY[type]?.capabilities.isHeading === true;
}

/**
 * Whether a block type holds raw/verbatim text (e.g. code): Tab inserts literal
 * indentation rather than moving focus. Drives the type-agnostic Tab handler.
 */
export function isPreformattedType(type: string): boolean {
  return REGISTRY[type]?.capabilities.preformatted === true;
}

export function createDefaultBlock(
  type: string,
  id: string,
  orderKey: string,
): Block | undefined {
  return REGISTRY[type]?.defaults(id, orderKey);
}

export function validateBlockField(
  type: string,
  field: string,
  value: unknown,
): boolean {
  if (isStyleField(field)) return isValidStyleValue(value);
  const descriptor = REGISTRY[type]?.fields[field];
  if (!descriptor) return false;
  return descriptor.validate(value);
}

// =============================================================================
// Per-block style namespace
//
// A block carries arbitrary visual overrides in `block.style` — an open bag of
// `key → value`. Each property syncs as its OWN `block_set` whose `field` is
// namespaced `style.<key>`, so concurrent edits to *different* properties are
// independent LWW registers and merge instead of clobbering. The reducer,
// inverse, snapshot/import, and the write API all route the `style.` namespace
// through these helpers — no block type is ever named, so every block (built-in
// or custom) can carry style and any node may choose to honor it.
// =============================================================================

export const STYLE_FIELD_PREFIX = "style.";

/** Whether a `block_set` field addresses a per-block style property. */
export function isStyleField(field: string): boolean {
  return field.startsWith(STYLE_FIELD_PREFIX);
}

/** The wire field name for a style property key (`color` → `style.color`). */
export function styleField(key: string): string {
  return STYLE_FIELD_PREFIX + key;
}

/** The style property key a `style.<key>` field addresses. */
export function styleKeyOf(field: string): string {
  return field.slice(STYLE_FIELD_PREFIX.length);
}

/** A block's own style bag, or an empty object when it has none. */
export function readBlockStyle(block: Block): Record<string, unknown> {
  const style = (block as { style?: unknown }).style;
  return isPlainStyleObject(style) ? style : {};
}

/** A plain (non-array) object usable as a style bag. */
export function isPlainStyleObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Whether `value` is a legal style-property value. Deliberately permissive — the
 * style vocabulary is open (a host paints whatever keys it understands) — but
 * JSON-serializable, so it round-trips through the wire/snapshot untouched.
 * `null` is allowed and means "no override" (a render merge skips it); it is the
 * sentinel an inverse uses to clear a key the block had not previously set,
 * since a `block_set` whose `value` is `undefined` is a defined no-op.
 */
export function isValidStyleValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) return value.every(isValidStyleValue);
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      return Object.values(value as Record<string, unknown>).every(
        isValidStyleValue,
      );
    }
    default:
      return false; // undefined, function, symbol, bigint
  }
}

export function getBlockFieldNames(type: string): readonly string[] {
  const descriptor = REGISTRY[type];
  return descriptor ? Object.keys(descriptor.fields) : [];
}

/**
 * Whether a block of type `from` may be SUBSTITUTED by type `to` without
 * misreading its content — the test a schema restriction uses to coerce a
 * disallowed block instead of dropping it. True for a no-op self-morph, or when
 * both types share the same non-empty `morphGroup` capability (the rich-text
 * family). Derived purely from capabilities — no per-type morph list.
 *
 * Not a gate on type morphs themselves: the reducer carries text between any
 * two text-storing types, because the local convert actions do.
 */
export function canMorphTo(from: string, to: string): boolean {
  if (from === to) return REGISTRY[from] !== undefined;
  const fromGroup = REGISTRY[from]?.capabilities.morphGroup;
  const toGroup = REGISTRY[to]?.capabilities.morphGroup;
  return fromGroup !== undefined && fromGroup === toGroup;
}

export function isValidBlockType(value: unknown): value is BlockType {
  return typeof value === "string" && REGISTRY[value] !== undefined;
}
