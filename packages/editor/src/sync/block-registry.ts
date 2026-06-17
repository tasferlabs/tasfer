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
   * Text-morph compatibility group. A block can be morphed to another via
   * `block_set { field: "type" }` without orphaning CRDT-tracked content
   * (charRuns/formats) exactly when both share the same non-empty `morphGroup`
   * (or it's a no-op self-morph). The built-in rich-text family (paragraph,
   * headings, lists) shares group `"text"`; visual and preformatted blocks omit
   * it (they only morph to themselves). This replaces the hand-listed
   * `textPreservingMorphs` set — a custom block joins the family by declaring
   * the same group, with no global enumeration to edit.
   */
  readonly morphGroup?: string;
}

// =============================================================================
// Block type descriptor
// =============================================================================

export interface BlockTypeDescriptor {
  readonly type: BlockType;
  readonly capabilities: BlockCapabilities;
  readonly defaults: (id: string, afterId: string | null) => Block;
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

const latexField = propField("latex", (value) => typeof value === "string");

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
  readonly afterId: string | null;
  readonly deleted: false;
}

function makeBase(id: string, afterId: string | null): BaseBlockShape {
  return { id, afterId, deleted: false };
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
};

// Each descriptor uses `satisfies BlockTypeDescriptor` so it is checked against
// the descriptor shape while keeping its own inferred type for local reads.

const paragraphDescriptor = {
  type: "paragraph",
  capabilities: TEXTUAL_CAPS,
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
    type: "paragraph",
    charRuns: [],
    formats: [],
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const heading1Descriptor = {
  type: "heading1",
  capabilities: HEADING_CAPS,
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
    type: "heading1",
    charRuns: [],
    formats: [],
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const heading2Descriptor = {
  type: "heading2",
  capabilities: HEADING_CAPS,
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
    type: "heading2",
    charRuns: [],
    formats: [],
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const heading3Descriptor = {
  type: "heading3",
  capabilities: HEADING_CAPS,
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
    type: "heading3",
    charRuns: [],
    formats: [],
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const bulletListDescriptor = {
  type: "bullet_list",
  capabilities: BULLET_CAPS,
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
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
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
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
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
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
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
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
  },
} satisfies BlockTypeDescriptor;

const lineDescriptor = {
  type: "line",
  capabilities: VISUAL_CAPS,
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
    type: "line",
  }),
  fields: { type: typeField },
} satisfies BlockTypeDescriptor;

const mathDescriptor = {
  type: "math",
  capabilities: VISUAL_CAPS,
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
    type: "math",
    latex: "",
    displayMode: true,
  }),
  fields: {
    type: typeField,
    latex: latexField,
    displayMode: displayModeField,
  },
} satisfies BlockTypeDescriptor;

const codeDescriptor = {
  type: "code",
  capabilities: CODE_CAPS,
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
    type: "code",
    charRuns: [],
    formats: [],
    language: "",
  }),
  fields: {
    type: typeField,
    language: languageField,
  },
  // Code omits a `morphGroup`, so it can only morph to itself: morphing into a
  // paragraph would orphan its `language` field and reinterpret embedded "\n"
  // chars (which a code block renders as hard line breaks) as run-on text.
} satisfies BlockTypeDescriptor;

// The built-in block-type table — the single runtime source of truth for the
// built-in set. Every "what block types exist" query (validation, the "type"
// field's validator, morph compatibility) derives from this map; there is no
// separate hand-listed enumeration to keep in sync.
export const BLOCK_REGISTRY = {
  paragraph: paragraphDescriptor,
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
  afterId: string | null,
): Block | undefined {
  return REGISTRY[type]?.defaults(id, afterId);
}

export function validateBlockField(
  type: string,
  field: string,
  value: unknown,
): boolean {
  const descriptor = REGISTRY[type]?.fields[field];
  if (!descriptor) return false;
  return descriptor.validate(value);
}

export function getBlockFieldNames(type: string): readonly string[] {
  const descriptor = REGISTRY[type];
  return descriptor ? Object.keys(descriptor.fields) : [];
}

/**
 * Whether `from` can be morphed to `to` via `block_set { field: "type" }`
 * without orphaning CRDT-tracked content. True for a no-op self-morph, or when
 * both types share the same non-empty `morphGroup` capability (the rich-text
 * family). Derived purely from capabilities — no per-type morph list.
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
