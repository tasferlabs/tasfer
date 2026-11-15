/**
 * Compile-time description of a document schema.
 *
 * Runtime schema objects still use strings and unknown values internally. This
 * type layer is carried by `Schema`, `DataSchema`, `Doc`, and `Editor` so a
 * schema assembled with `defineNode` / `defineMark` produces a typed public API.
 */
import type { ContentSelection } from "./structured-selection";

/**
 * The type-level description of a schema: every block name and every mark name,
 * each mapped to the shape of its attributes. It exists only for TypeScript; it
 * is what lets `Doc`, `Schema` and the editor API know about your custom types.
 *
 * @group Schema
 */
export interface SchemaDefinition {
  readonly blocks: Record<string, Record<string, unknown>>;
  readonly marks: Record<string, Record<string, unknown>>;
}

/**
 * A schema description that allows any block or mark name with any attributes.
 * Use it where the exact schema is not known.
 *
 * @group Schema
 */
export type AnySchemaDefinition = {
  readonly blocks: Record<string, Record<string, unknown>>;
  readonly marks: Record<string, Record<string, unknown>>;
};

/**
 * The type-level description of `baseSchema`: the built-in block and mark
 * types. The list of names is fixed. Built-in block attributes are loosely
 * typed, while the `link` mark has `{ url: string }`. Types you add with
 * `Schema.extend()` get exact attribute types.
 *
 * @group Schema
 */
export interface BaseSchemaDefinition extends SchemaDefinition {
  readonly blocks: {
    readonly paragraph: Record<string, unknown>;
    readonly heading1: Record<string, unknown>;
    readonly heading2: Record<string, unknown>;
    readonly heading3: Record<string, unknown>;
    readonly bullet_list: Record<string, unknown>;
    readonly numbered_list: Record<string, unknown>;
    readonly todo_list: Record<string, unknown>;
    readonly code: Record<string, unknown>;
    readonly image: Record<string, unknown>;
    readonly quote: Record<string, unknown>;
    readonly line: Record<string, unknown>;
  };
  readonly marks: {
    readonly strong: Record<never, never>;
    readonly emphasis: Record<never, never>;
    readonly strike: Record<never, never>;
    readonly code: Record<never, never>;
    readonly link: { readonly url: string };
  };
}

/**
 * The block type names of schema `S`, as a union of string literals
 * (`"paragraph" | "heading1" | …`).
 *
 * @group Schema
 */
export type BlockName<S extends SchemaDefinition> = Extract<
  keyof S["blocks"],
  string
>;

/**
 * The mark type names of schema `S`, as a union of string literals
 * (`"strong" | "link" | …`).
 *
 * @group Schema
 */
export type MarkNameOf<S extends SchemaDefinition> = Extract<
  keyof S["marks"],
  string
>;

/**
 * The shape of the attributes (the type-specific fields) that block type `T`
 * carries in schema `S`.
 *
 * @group Schema
 */
export type BlockAttrs<
  S extends SchemaDefinition,
  T extends BlockName<S>,
> = S["blocks"][T];

/**
 * The shape of the data that mark type `T` carries in schema `S`, such as
 * `{ url: string }` for a link.
 *
 * @group Schema
 */
export type MarkAttrs<
  S extends SchemaDefinition,
  T extends MarkNameOf<S>,
> = S["marks"][T];

/**
 * A plain-data snapshot of one block of type `T`: its `id`, `type`, visible
 * `text`, and `attrs` typed for that block type. See {@link BlockData}.
 *
 * @group Schema
 */
export type BlockDataFor<S extends SchemaDefinition, T extends BlockName<S>> = {
  readonly id: string;
  readonly type: T;
  readonly text: string;
  readonly attrs: Readonly<BlockAttrs<S, T>>;
};

/**
 * A {@link BlockDataFor} for any block type in schema `S`, as one union.
 * Checking `type` narrows `attrs` to that block type's attributes.
 *
 * @group Schema
 */
export type SchemaBlockData<S extends SchemaDefinition> = {
  [T in BlockName<S>]: BlockDataFor<S, T>;
}[BlockName<S>];

/**
 * A mark of type `T` found in the document: its `name`, its `attrs` typed for
 * that mark, and the block, offsets and text of the run it covers. See
 * {@link MarkInfo}.
 *
 * @group Schema
 */
export type MarkInfoFor<S extends SchemaDefinition, T extends MarkNameOf<S>> = {
  readonly name: T;
  readonly attrs: Readonly<MarkAttrs<S, T>>;
  readonly block: string;
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /**
   * Set when the mark is in nested text, such as a table cell. Then `from` and
   * `to` count from the start of that text. Pass `content` as the `range` of
   * `setMark` to change this mark.
   */
  readonly content?: ContentSelection;
};

export type MergeRecords<A, B> = Omit<A, keyof B> & B;

/**
 * Combines two schema descriptions into one. Where both define the same block
 * or mark name, `B` wins. This is how `extend()` types the schema it returns.
 *
 * @group Schema
 */
export type MergeSchema<
  A extends SchemaDefinition,
  B extends SchemaDefinition,
> = {
  readonly blocks: MergeRecords<A["blocks"], B["blocks"]>;
  readonly marks: MergeRecords<A["marks"], B["marks"]>;
};

type WidenPrimitive<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T;

export type InferAttr<S> = S extends {
  validate(value: unknown): value is infer T;
}
  ? T
  : S extends { default: infer T }
    ? WidenPrimitive<T>
    : unknown;

export type InferAttrs<A extends Record<string, unknown>> = {
  readonly [K in keyof A]: InferAttr<A[K]>;
};

export type EmptySchemaDefinition = {
  readonly blocks: {};
  readonly marks: {};
};
