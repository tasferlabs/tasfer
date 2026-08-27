/**
 * Content expressions — the ProseMirror-style shape rule for a document's flat
 * block sequence.
 *
 * `Schema.restrict({ content })` compiles a small regular expression over BLOCK
 * TYPES into the deterministic matcher in this file:
 *
 *   "heading1 paragraph+"            a heading, then one or more paragraphs
 *   "heading1 (paragraph|image){1,3}"  a heading, then one to three of either
 *   "heading1 block*"                a heading, then anything (group name)
 *
 * Grammar (ProseMirror's, minus node-type attributes):
 *
 *   expr    := seq ("|" seq)*
 *   seq     := postfix+
 *   postfix := atom ("+" | "*" | "?" | "{" n ("," n?)? "}")*
 *   atom    := name | "(" expr ")"
 *
 * A `name` is a registered block type or a group (`block`, `text`, `heading`,
 * `list`, `void`, plus any `groups` a spec declares); the resolver supplied by
 * the schema turns it into the set of types it stands for.
 *
 * Compilation is expression → NFA → DFA, so matching a document is a linear
 * walk with no backtracking. The result is IMMUTABLE and canvas-free: it is
 * built once inside `DataSchema` and shared by every query, and this module
 * imports nothing from the editor (the sync/fuzz import graph stays clean).
 *
 * This is an AUTHORING constraint only. Nothing here reaches the reducer or the
 * op log — see `DataSchema`'s allow-list section for the same contract.
 */

import { invariant } from "@shared/invariant";

/**
 * Resolves an expression name to the block types it stands for — a single type
 * for a type name, several for a group. `undefined` means the name is unknown,
 * which fails compilation.
 */
export type ResolveContentName = (
  name: string,
) => readonly string[] | undefined;

/** One outgoing edge of a {@link ContentMatch} state. */
export interface ContentEdge {
  readonly type: string;
  readonly next: ContentMatch;
}

/**
 * One state of the compiled matcher. `matchType` walks an edge; `validEnd` says
 * whether a document may stop here. States are shared and never mutated after
 * compilation, so a matcher is safe to hold on an immutable schema.
 */
export class ContentMatch {
  readonly validEnd: boolean;
  /** @internal Populated during DFA construction, frozen immediately after. */
  readonly next: ContentEdge[] = [];

  constructor(validEnd: boolean) {
    this.validEnd = validEnd;
  }

  /** The state reached by consuming one block of `type`, or null if illegal. */
  matchType(type: string): ContentMatch | null {
    for (const edge of this.next) {
      if (edge.type === type) return edge.next;
    }
    return null;
  }

  /** The state reached by consuming `types` in order, or null if illegal. */
  matchSequence(
    types: readonly string[],
    start = 0,
    end = types.length,
  ): ContentMatch | null {
    let match: ContentMatch | null = this;
    for (let i = start; match && i < end; i++) {
      match = match.matchType(types[i]);
    }
    return match;
  }

  /** The block types this state can consume next, in expression order. */
  allowedTypes(): readonly string[] {
    return this.next.map((edge) => edge.type);
  }

  /**
   * The shortest run of block types that must be inserted here for `after` to
   * become legal — and, when `toEnd`, for the document to be able to stop after
   * it. `[]` means nothing is missing; `null` means no run can rescue it.
   *
   * `fillBefore(after, true)` from the start state is also the satisfiability
   * check: an expression no document can ever satisfy returns null.
   */
  fillBefore(after: readonly string[], toEnd = false): string[] | null {
    const seen = new Set<ContentMatch>([this]);
    const search = (match: ContentMatch, types: string[]): string[] | null => {
      const finished = match.matchSequence(after);
      if (finished && (!toEnd || finished.validEnd)) return types;
      for (const edge of match.next) {
        if (seen.has(edge.next)) continue;
        seen.add(edge.next);
        const found = search(edge.next, [...types, edge.type]);
        if (found) return found;
      }
      return null;
    };
    return search(this, []);
  }
}

/** A compiled `content` expression, as carried by a restricted schema. */
export interface CompiledContent {
  /** The matcher's start state. */
  readonly match: ContentMatch;
  /** Every block type the expression can emit — for allow-list cross-checks. */
  readonly types: ReadonlySet<string>;
  /** The original expression, for diagnostics. */
  readonly source: string;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

type Expr =
  | { readonly kind: "choice"; readonly exprs: readonly Expr[] }
  | { readonly kind: "seq"; readonly exprs: readonly Expr[] }
  | { readonly kind: "plus"; readonly expr: Expr }
  | { readonly kind: "star"; readonly expr: Expr }
  | { readonly kind: "opt"; readonly expr: Expr }
  | {
      readonly kind: "range";
      readonly min: number;
      /** -1 for an open upper bound (`{2,}`). */
      readonly max: number;
      readonly expr: Expr;
    }
  | { readonly kind: "name"; readonly types: readonly string[] };

const TOKEN_RE = /[\w-]+|[()|+*?{},]|\S/g;

/**
 * Reject a malformed expression. A module-level function declaration (rather
 * than a method) because TypeScript only narrows through assertion calls made
 * on an explicitly typed target.
 */
function fail(
  stream: TokenStream,
  condition: unknown,
  detail: string,
  ...args: string[]
): asserts condition {
  invariant(
    condition,
    `restrict(): invalid content expression "%s" — ${detail}.`,
    stream.source,
    ...args,
  );
}

/** Splits an expression into names, numbers and single-character operators. */
class TokenStream {
  readonly source: string;
  private readonly tokens: readonly string[];
  private pos = 0;

  constructor(source: string) {
    this.source = source;
    this.tokens = source.match(TOKEN_RE) ?? [];
  }

  get next(): string | undefined {
    return this.tokens[this.pos];
  }

  eat(token: string): boolean {
    if (this.next !== token) return false;
    this.pos++;
    return true;
  }

  take(): string {
    const token = this.next;
    fail(this, token !== undefined, "unexpected end of expression");
    this.pos++;
    return token;
  }
}

function parseExpr(stream: TokenStream, resolve: ResolveContentName): Expr {
  const exprs: Expr[] = [parseSeq(stream, resolve)];
  while (stream.eat("|")) exprs.push(parseSeq(stream, resolve));
  return exprs.length === 1 ? exprs[0] : { kind: "choice", exprs };
}

function parseSeq(stream: TokenStream, resolve: ResolveContentName): Expr {
  const exprs: Expr[] = [];
  do {
    exprs.push(parsePostfix(stream, resolve));
  } while (
    stream.next !== undefined &&
    stream.next !== ")" &&
    stream.next !== "|"
  );
  return exprs.length === 1 ? exprs[0] : { kind: "seq", exprs };
}

function parsePostfix(stream: TokenStream, resolve: ResolveContentName): Expr {
  let expr = parseAtom(stream, resolve);
  for (;;) {
    if (stream.eat("+")) expr = { kind: "plus", expr };
    else if (stream.eat("*")) expr = { kind: "star", expr };
    else if (stream.eat("?")) expr = { kind: "opt", expr };
    else if (stream.eat("{")) expr = parseRange(stream, expr);
    else return expr;
  }
}

function parseRange(stream: TokenStream, expr: Expr): Expr {
  const min = parseCount(stream);
  let max = min;
  if (stream.eat(",")) max = stream.next === "}" ? -1 : parseCount(stream);
  fail(stream, stream.eat("}"), 'expected "}" to close a repetition count');
  fail(
    stream,
    min >= 0 && (max === -1 || max >= min),
    "a repetition count must be non-negative and its upper bound at least its lower",
  );
  return { kind: "range", min, max, expr };
}

function parseCount(stream: TokenStream): number {
  const token = stream.take();
  fail(
    stream,
    /^\d+$/.test(token),
    'expected a number in a repetition count, got "%s"',
    token,
  );
  return Number(token);
}

function parseAtom(stream: TokenStream, resolve: ResolveContentName): Expr {
  if (stream.eat("(")) {
    const expr = parseExpr(stream, resolve);
    fail(stream, stream.eat(")"), 'expected ")" to close a group');
    return expr;
  }
  const name = stream.take();
  fail(
    stream,
    /^[\w-]+$/.test(name),
    'expected a block type or group name, got "%s"',
    name,
  );
  const types = resolve(name);
  fail(
    stream,
    types !== undefined,
    '"%s" is neither a registered block type nor a known group',
    name,
  );
  fail(
    stream,
    types.length > 0,
    'the group "%s" is empty in this schema',
    name,
  );
  return { kind: "name", types };
}

// ─── NFA ─────────────────────────────────────────────────────────────────────

interface NfaEdge {
  readonly term?: string;
  /** Patched by `connect` while the NFA is under construction. */
  to: number;
}

/**
 * Compile the parsed expression to an NFA: an array of states, each a list of
 * edges. An edge with no `term` is an epsilon transition. Ported from
 * ProseMirror's `nfa`, with block-type strings in place of node types.
 */
function buildNfa(expr: Expr): NfaEdge[][] {
  const nfa: NfaEdge[][] = [[]];
  const node = (): number => nfa.push([]) - 1;
  const edge = (from: number, to = -1, term?: string): NfaEdge => {
    const created: NfaEdge = { term, to };
    nfa[from].push(created);
    return created;
  };
  const connect = (edges: readonly NfaEdge[], to: number): void => {
    for (const e of edges) e.to = to;
  };

  const compile = (node_: Expr, from: number): NfaEdge[] => {
    switch (node_.kind) {
      case "choice":
        return node_.exprs.flatMap((sub) => compile(sub, from));
      case "seq": {
        let cursor = from;
        for (let i = 0; ; i++) {
          const next = compile(node_.exprs[i], cursor);
          if (i === node_.exprs.length - 1) return next;
          cursor = node();
          connect(next, cursor);
        }
      }
      case "star": {
        const loop = node();
        edge(from, loop);
        connect(compile(node_.expr, loop), loop);
        return [edge(loop)];
      }
      case "plus": {
        const loop = node();
        connect(compile(node_.expr, from), loop);
        connect(compile(node_.expr, loop), loop);
        return [edge(loop)];
      }
      case "opt":
        return [edge(from), ...compile(node_.expr, from)];
      case "range": {
        let cursor = from;
        for (let i = 0; i < node_.min; i++) {
          const next = node();
          connect(compile(node_.expr, cursor), next);
          cursor = next;
        }
        if (node_.max === -1) {
          connect(compile(node_.expr, cursor), cursor);
        } else {
          for (let i = node_.min; i < node_.max; i++) {
            const next = node();
            edge(cursor, next);
            connect(compile(node_.expr, cursor), next);
            cursor = next;
          }
        }
        return [edge(cursor)];
      }
      case "name":
        return node_.types.map((type) => edge(from, -1, type));
    }
  };

  connect(compile(expr, 0), node());
  return nfa;
}

/** Every state reachable from `state` through epsilon edges only, sorted. */
function nullFrom(nfa: readonly NfaEdge[][], state: number): number[] {
  const result: number[] = [];
  const scan = (current: number): void => {
    const edges = nfa[current];
    // A lone epsilon edge is a pure pass-through; skip past it so the closure
    // stays small (ProseMirror's same short-circuit).
    if (edges.length === 1 && !edges[0].term) {
      scan(edges[0].to);
      return;
    }
    result.push(current);
    for (const { term, to } of edges) {
      if (!term && !result.includes(to)) scan(to);
    }
  };
  scan(state);
  return result.sort((a, b) => a - b);
}

/** Subset-construct the DFA: one {@link ContentMatch} per reachable NFA state set. */
function buildDfa(nfa: readonly NfaEdge[][]): ContentMatch {
  const labeled = new Map<string, ContentMatch>();
  const accepting = nfa.length - 1;

  const explore = (states: readonly number[]): ContentMatch => {
    // Group the outgoing labelled edges by term, preserving expression order so
    // `allowedTypes()` (and therefore the type Enter picks) is predictable.
    const out: [string, number[]][] = [];
    for (const state of states) {
      for (const { term, to } of nfa[state]) {
        if (!term) continue;
        let set = out.find(([type]) => type === term)?.[1];
        if (!set) {
          set = [];
          out.push([term, set]);
        }
        for (const reached of nullFrom(nfa, to)) {
          if (!set.includes(reached)) set.push(reached);
        }
      }
    }
    const match = new ContentMatch(states.includes(accepting));
    labeled.set(states.join(","), match);
    for (const [type, reached] of out) {
      const sorted = [...reached].sort((a, b) => a - b);
      const key = sorted.join(",");
      match.next.push({
        type,
        next: labeled.get(key) ?? explore(sorted),
      });
    }
    Object.freeze(match.next);
    return match;
  };

  return explore(nullFrom(nfa, 0));
}

/** Collect every block type an expression can emit. */
function collectTypes(expr: Expr, into: Set<string>): void {
  switch (expr.kind) {
    case "choice":
    case "seq":
      for (const sub of expr.exprs) collectTypes(sub, into);
      return;
    case "plus":
    case "star":
    case "opt":
    case "range":
      collectTypes(expr.expr, into);
      return;
    case "name":
      for (const type of expr.types) into.add(type);
  }
}

/**
 * Compile a `content` expression against a schema's names. Throws (an
 * `InvariantError`, like the rest of `restrict()`) on a malformed expression,
 * an unknown name, or an empty group.
 */
export function parseContentExpression(
  source: string,
  resolve: ResolveContentName,
): CompiledContent {
  const stream = new TokenStream(source);
  fail(stream, stream.next !== undefined, "the expression is empty");
  const expr = parseExpr(stream, resolve);
  fail(
    stream,
    stream.next === undefined,
    'unexpected trailing input at "%s"',
    stream.next ?? "",
  );
  const types = new Set<string>();
  collectTypes(expr, types);
  return {
    match: buildDfa(buildNfa(expr)),
    types,
    source,
  };
}
