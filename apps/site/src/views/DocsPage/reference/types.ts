/* Shape of the generated API reference data (./data/*.json), written by
 * scripts/generate-api.mjs. Keep the two in step: the script is the only
 * writer, this file is what the page reads it as. */

/** A markdown node, cut down to what a doc comment uses (mdast). */
export interface MdNode {
  type: string;
  value?: string;
  url?: string;
  lang?: string;
  depth?: number;
  ordered?: boolean;
  children?: MdNode[];
}

export interface ApiExample {
  lang: string;
  code: string;
  title?: string;
}

/** What a doc comment contributes, on an export and on a member alike. */
export interface ApiDocFields {
  /** First sentence of the comment; inline code is still in backticks. */
  summary?: string;
  doc?: MdNode[];
  /** Package version the item arrived in (`@since`). */
  since?: string;
  deprecated?: MdNode[] | true;
  experimental?: true;
  examples?: ApiExample[];
  params?: { name: string; doc: MdNode[] }[];
  returns?: MdNode[];
  default?: string;
}

export interface ApiMember extends ApiDocFields {
  name: string;
  kind: string;
  sig: string;
  optional?: true;
}

export type ApiKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "enum"
  | "namespace";

export interface ApiSymbol extends ApiDocFields {
  name: string;
  /** Set only when two entries of one package use the same name. */
  anchor?: string;
  kind: ApiKind;
  /** The topic it is filed under (`@group`), in a package that has topics. */
  group?: string;
  /** One per declaration: several for overloads. */
  sigs: string[];
  members?: ApiMember[];
  /** Repo-relative source file. */
  src?: string;
  /** Entry points that export it; the first is the one it is listed under. */
  from: string[];
}

export interface ApiEntry {
  id: string;
  symbols: ApiSymbol[];
}

export interface ApiPackage {
  name: string;
  /** The package's topics in page order; absent when it is listed by kind. */
  groups?: string[];
  entries: ApiEntry[];
}

export interface ApiIndex {
  version: string;
  packages: {
    slug: string;
    name: string;
    description: string;
    entries: string[];
    names: string[];
    /** Declared name → exported name, for exports renamed on the way out. */
    aliases: Record<string, string>;
  }[];
}
