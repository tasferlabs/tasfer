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
}

// =============================================================================
// Block type descriptor
// =============================================================================

export interface BlockTypeDescriptor {
  readonly type: BlockType;
  readonly capabilities: BlockCapabilities;
  readonly defaults: (id: string, afterId: string | null) => Block;
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
  /**
   * Types this block can be morphed to via `block_set { field: "type" }`
   * without losing CRDT-tracked content (charRuns/formats). Visual blocks
   * list only themselves because morphing into a textual type would orphan
   * their props (url/latex/etc.).
   */
  readonly textPreservingMorphs: readonly BlockType[];
}

// =============================================================================
// Block type set (used by validators and the "type" field)
// =============================================================================

const ALL_BLOCK_TYPES: readonly BlockType[] = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bullet_list",
  "numbered_list",
  "todo_list",
  "image",
  "line",
  "math",
];

const ALL_BLOCK_TYPES_SET: ReadonlySet<BlockType> = new Set(ALL_BLOCK_TYPES);

const TEXTUAL_BLOCK_TYPES: readonly BlockType[] = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bullet_list",
  "numbered_list",
  "todo_list",
];

// =============================================================================
// Shared field descriptors
// =============================================================================

const typeField: FieldDescriptor = {
  validate: (value): boolean =>
    typeof value === "string" && ALL_BLOCK_TYPES_SET.has(value as BlockType),
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

const urlField: FieldDescriptor = {
  validate: (value): boolean => typeof value === "string",
  extractForInverse: (block) =>
    block.type === "image" ? block.url : undefined,
};

const altField: FieldDescriptor = {
  validate: (value): boolean =>
    typeof value === "string" || value === undefined,
  extractForInverse: (block) =>
    block.type === "image" ? block.alt : undefined,
};

const widthField: FieldDescriptor = {
  validate: (value): boolean => value === "full" || typeof value === "number",
  extractForInverse: (block) =>
    block.type === "image" ? block.width : undefined,
};

const heightField: FieldDescriptor = {
  validate: (value): boolean => typeof value === "number",
  extractForInverse: (block) =>
    block.type === "image" ? block.height : undefined,
};

const objectFitField: FieldDescriptor = {
  validate: (value): boolean => value === "cover" || value === "contain",
  extractForInverse: (block) =>
    block.type === "image" ? block.objectFit : undefined,
};

const latexField: FieldDescriptor = {
  validate: (value): boolean => typeof value === "string",
  extractForInverse: (block) =>
    block.type === "math" ? block.latex : undefined,
};

const displayModeField: FieldDescriptor = {
  validate: (value): boolean => typeof value === "boolean",
  extractForInverse: (block) =>
    block.type === "math" ? block.displayMode : undefined,
};

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
};

const VISUAL_CAPS: BlockCapabilities = {
  hasText: false,
  hasFormats: false,
  indentable: false,
  togglable: false,
};

// Each descriptor uses `satisfies BlockTypeDescriptor` (not a wide
// annotation) so that `typeof xDescriptor.fields` keeps its literal key
// type — that's what the cross-file compile-time check in sync.ts indexes
// into to detect BlockFieldsOf drift.

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
  textPreservingMorphs: TEXTUAL_BLOCK_TYPES,
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
  textPreservingMorphs: TEXTUAL_BLOCK_TYPES,
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
  textPreservingMorphs: TEXTUAL_BLOCK_TYPES,
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
  textPreservingMorphs: TEXTUAL_BLOCK_TYPES,
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
  textPreservingMorphs: TEXTUAL_BLOCK_TYPES,
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
  textPreservingMorphs: TEXTUAL_BLOCK_TYPES,
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
  textPreservingMorphs: TEXTUAL_BLOCK_TYPES,
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
  textPreservingMorphs: ["image"],
} satisfies BlockTypeDescriptor;

const lineDescriptor = {
  type: "line",
  capabilities: VISUAL_CAPS,
  defaults: (id: string, afterId: string | null): Block => ({
    ...makeBase(id, afterId),
    type: "line",
  }),
  fields: { type: typeField },
  textPreservingMorphs: ["line"],
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
  textPreservingMorphs: ["math"],
} satisfies BlockTypeDescriptor;

// `satisfies` (rather than a wide annotation) preserves the per-key
// inferred type, so `(typeof BLOCK_REGISTRY)["image"]["fields"]` carries
// the literal field keys `"type" | "url" | "alt" | ...`. That's what lets
// the compile-time check in sync.ts verify BlockFieldsOf against the
// registry without drift.
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
} satisfies Record<BlockType, BlockTypeDescriptor>;

// =============================================================================
// Helpers
// =============================================================================
//
// All helpers below access the registry through the wide BlockTypeDescriptor
// view so that runtime-string indexing into `fields` and runtime-typed
// `BlockType` indexing into `textPreservingMorphs` work. The narrow per-key
// inferred types are only needed for the compile-time check in sync.ts;
// callers want the homogeneous descriptor shape.

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

export function canMorphTo(from: string, to: string): boolean {
  const morphs = REGISTRY[from]?.textPreservingMorphs as
    | readonly string[]
    | undefined;
  return morphs?.includes(to) ?? false;
}

export function isValidBlockType(value: unknown): value is BlockType {
  return (
    typeof value === "string" && ALL_BLOCK_TYPES_SET.has(value as BlockType)
  );
}
