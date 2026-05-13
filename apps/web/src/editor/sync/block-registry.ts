/**
 * Block Type Registry
 *
 * Single source of truth for per-block-type metadata: defaults, capabilities,
 * settable fields (with validators), and safe type-morph targets.
 *
 * This file is additive — consumers (reducer, inverse, snapshot-diff, etc.)
 * have not yet been migrated. See follow-up task for routing through the
 * registry.
 */

import type { Block } from "@/deserializer/loadPage";
import type { BlockType } from "./types";

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
  validate: (value): boolean =>
    value === "full" || typeof value === "number",
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

const LIST_CAPS: BlockCapabilities = {
  hasText: true,
  hasFormats: true,
  indentable: true,
  togglable: false,
};

const TODO_CAPS: BlockCapabilities = {
  hasText: true,
  hasFormats: true,
  indentable: true,
  togglable: true,
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
  capabilities: TEXTUAL_CAPS,
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
  capabilities: TEXTUAL_CAPS,
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
  capabilities: TEXTUAL_CAPS,
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
  capabilities: LIST_CAPS,
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
  capabilities: LIST_CAPS,
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

const REGISTRY: Readonly<Record<BlockType, BlockTypeDescriptor>> = BLOCK_REGISTRY;

export function getBlockDescriptor(type: BlockType): BlockTypeDescriptor {
  return REGISTRY[type];
}

export function hasTextContent(type: BlockType): boolean {
  return REGISTRY[type].capabilities.hasText;
}

export function canHaveFormats(type: BlockType): boolean {
  return REGISTRY[type].capabilities.hasFormats;
}

export function isIndentable(type: BlockType): boolean {
  return REGISTRY[type].capabilities.indentable;
}

export function isTogglable(type: BlockType): boolean {
  return REGISTRY[type].capabilities.togglable;
}

export function createDefaultBlock(
  type: BlockType,
  id: string,
  afterId: string | null,
): Block {
  return REGISTRY[type].defaults(id, afterId);
}

export function validateBlockField(
  type: BlockType,
  field: string,
  value: unknown,
): boolean {
  const descriptor = REGISTRY[type].fields[field];
  if (!descriptor) return false;
  return descriptor.validate(value);
}

export function getBlockFieldNames(type: BlockType): readonly string[] {
  return Object.keys(REGISTRY[type].fields);
}

export function canMorphTo(from: BlockType, to: BlockType): boolean {
  return REGISTRY[from].textPreservingMorphs.includes(to);
}

export function isValidBlockType(value: unknown): value is BlockType {
  return (
    typeof value === "string" && ALL_BLOCK_TYPES_SET.has(value as BlockType)
  );
}
