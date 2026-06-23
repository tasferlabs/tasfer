/**
 * Compile-time description of a document schema.
 *
 * Runtime schema objects still use strings and unknown values internally. This
 * type layer is carried by `Schema`, `DataSchema`, `Doc`, and `Editor` so a
 * schema assembled with `defineNode` / `defineMark` produces a typed public API.
 */
export interface SchemaDefinition {
  readonly blocks: Record<string, Record<string, unknown>>;
  readonly marks: Record<string, Record<string, unknown>>;
}

/** Explicitly dynamic schema used by erased runtime implementation code. */
export type AnySchemaDefinition = {
  readonly blocks: Record<string, Record<string, unknown>>;
  readonly marks: Record<string, Record<string, unknown>>;
};

/**
 * Built-in names are closed, while their existing attribute bags remain open.
 * Custom definitions added through `Schema.extend()` are precise.
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
    readonly math: Record<string, unknown>;
    readonly line: Record<string, unknown>;
  };
  readonly marks: {
    readonly strong: Record<never, never>;
    readonly emphasis: Record<never, never>;
    readonly strike: Record<never, never>;
    readonly code: Record<never, never>;
    readonly link: { readonly url: string };
    readonly math: Record<never, never>;
  };
}

export type BlockName<S extends SchemaDefinition> = Extract<
  keyof S["blocks"],
  string
>;

export type MarkNameOf<S extends SchemaDefinition> = Extract<
  keyof S["marks"],
  string
>;

export type BlockAttrs<
  S extends SchemaDefinition,
  T extends BlockName<S>,
> = S["blocks"][T];

export type MarkAttrs<
  S extends SchemaDefinition,
  T extends MarkNameOf<S>,
> = S["marks"][T];

export type BlockDataFor<S extends SchemaDefinition, T extends BlockName<S>> = {
  readonly id: string;
  readonly type: T;
  readonly text: string;
  readonly attrs: Readonly<BlockAttrs<S, T>>;
};

export type SchemaBlockData<S extends SchemaDefinition> = {
  [T in BlockName<S>]: BlockDataFor<S, T>;
}[BlockName<S>];

export type MarkInfoFor<S extends SchemaDefinition, T extends MarkNameOf<S>> = {
  readonly name: T;
  readonly attrs: Readonly<MarkAttrs<S, T>>;
  readonly block: string;
  readonly from: number;
  readonly to: number;
  readonly text: string;
};

export type SchemaMarkInfo<S extends SchemaDefinition> = {
  [T in MarkNameOf<S>]: MarkInfoFor<S, T>;
}[MarkNameOf<S>];

export type MergeRecords<A, B> = Omit<A, keyof B> & B;

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
