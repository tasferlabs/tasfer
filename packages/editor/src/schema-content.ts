/**
 * schema-content — the authoring guards for a schema's `content` expression.
 *
 * `DataSchema` owns the compiled matcher and answers two questions about a
 * whole block-type sequence (`contentAccepts`, `contentFill`). This module is
 * the editor-side adapter: it projects the document to that sequence, applies
 * the edit a call site is about to make, and reports whether the result still
 * fits the shape. Each guard sits beside the `isBlockAllowed` / `coerceCreatable`
 * check the same call site already performs.
 *
 * Two properties every guard here keeps:
 *
 *  - **Exact no-op when unshaped.** With no `content` expression every function
 *    returns `true` (or the caller's preferred type) after a single field read,
 *    so the default editor's code paths are unchanged.
 *  - **Never strand the user.** A document can legitimately arrive already
 *    violating the shape — synced from a peer on a looser schema, or stored
 *    before the host tightened it. Refusing every edit there would lock the
 *    surface, so an edit is refused only when it turns a *satisfying* document
 *    into a non-satisfying one.
 *
 * Positions are VISIBLE indices (deleted blocks skipped), which is what the
 * shape rule is written against; `visibleIndex` converts a raw `page.blocks`
 * index for the call sites that hold one.
 *
 * The per-edit guards are the *coercing* half — they let a call site pick a type
 * the shape permits instead of the one it wanted (`contentSplitType`,
 * `contentInsertType`) or skip a branch it cannot take. They are advisory by
 * nature: a transform that never asks is never stopped. {@link editSatisfiesSchema}
 * is the backstop that does not depend on anyone asking; see its own doc.
 */

import type { Page } from "./serlization/loadPage";
import type { EditorState, Operation } from "./state-types";

/** The document's block types in order, deleted blocks skipped. */
export function documentBlockTypes(page: Page): string[] {
  const types: string[] = [];
  for (const block of page.blocks) {
    if (!block.deleted) types.push(block.type);
  }
  return types;
}

/**
 * The visible position of a raw `page.blocks` index — the index the shape rule
 * addresses that block by. A deleted block reports the position it would occupy.
 */
export function visibleIndex(page: Page, rawIndex: number): number {
  let visible = 0;
  for (let i = 0; i < rawIndex && i < page.blocks.length; i++) {
    if (!page.blocks[i].deleted) visible++;
  }
  return visible;
}

/**
 * Whether `next` may replace the document's current type sequence. Accepts any
 * sequence when the schema is unshaped, and accepts every sequence when the
 * document does not satisfy the shape to begin with (see the module header).
 */
function accepts(state: EditorState, next: readonly string[]): boolean {
  const { schema } = state;
  if (!schema.content) return true;
  if (schema.contentAccepts(next)) return true;
  return !schema.contentAccepts(documentBlockTypes(state.document.page));
}

/**
 * The central authoring guard: whether a local edit may be committed.
 *
 * The rest of this module is consulted *before* a transform runs, by the
 * transform itself. That only holds the line as long as every path remembers to
 * ask — and there are many (each delete variant, paste, drag-reorder, a node's
 * own key handler, a host's `change()` batch), each free to build blocks
 * directly. This answers the same question *after* the fact, over whatever the
 * edit actually produced, and is applied at the funnels a local edit commits
 * through. An edit that fails it is rolled back whole, so the gesture behind it
 * simply does nothing.
 *
 * Two axes, matching `restrict`:
 *
 *  - **Allow-list.** A `block_insert`, or a `block_set` of `type`, may only mint
 *    a type the local user is allowed to create. Judged per op — it asks what
 *    the edit made, not what the document already holds, so a document that
 *    arrived holding disallowed types (synced from a peer on a looser schema)
 *    still can't have more authored into it.
 *  - **Shape.** The resulting block sequence must satisfy `content` — unless the
 *    document already failed to, which would otherwise lock the surface (see the
 *    module header). Read off the two documents rather than the ops, so it also
 *    catches a transform that reshapes the page without emitting one.
 *
 * Remote ops are never judged here: the reducer stays allow-list-agnostic so
 * peers converge (see `sync/reducer`). Undo/redo is exempt at the call site for
 * the same reason — it restores a state this document was already in.
 *
 * Both axes are vacuous for an unrestricted schema, and the shape half stops at
 * a pointer compare for an edit that left the block sequence alone.
 */
export function editSatisfiesSchema(
  prev: EditorState,
  next: EditorState,
  ops: readonly Operation[],
): boolean {
  const { schema } = prev;
  for (const op of ops) {
    if (op.op === "block_insert") {
      if (!schema.isBlockAllowed(op.blockType)) return false;
    } else if (op.op === "block_set" && op.field === "type") {
      if (typeof op.value === "string" && !schema.isBlockAllowed(op.value)) {
        return false;
      }
    }
  }
  if (!schema.content) return true;
  if (next.document.page === prev.document.page) return true;
  const nextTypes = documentBlockTypes(next.document.page);
  const prevTypes = documentBlockTypes(prev.document.page);
  // Typing doesn't move the sequence; don't run the matcher over it.
  if (
    prevTypes.length === nextTypes.length &&
    prevTypes.every((type, i) => type === nextTypes[i])
  ) {
    return true;
  }
  if (schema.contentAccepts(nextTypes)) return true;
  return !schema.contentAccepts(prevTypes);
}

/** Whether inserting a block of `type` at visible position `at` is permitted. */
export function contentAllowsInsert(
  state: EditorState,
  at: number,
  type: string,
): boolean {
  if (!state.schema.content) return true;
  const types = documentBlockTypes(state.document.page);
  types.splice(at, 0, type);
  return accepts(state, types);
}

/** Whether changing the block at visible position `at` to `type` is permitted. */
export function contentAllowsMorph(
  state: EditorState,
  at: number,
  type: string,
): boolean {
  if (!state.schema.content) return true;
  const types = documentBlockTypes(state.document.page);
  if (at < 0 || at >= types.length) return true;
  if (types[at] === type) return true;
  types[at] = type;
  return accepts(state, types);
}

/**
 * Whether removing the blocks at visible positions `[at, at + count)` is
 * permitted — the guard for Backspace-merges and block deletion.
 */
export function contentAllowsRemove(
  state: EditorState,
  at: number,
  count = 1,
): boolean {
  if (!state.schema.content) return true;
  const types = documentBlockTypes(state.document.page);
  types.splice(at, count);
  return accepts(state, types);
}

/**
 * The continuation type an Enter-split may mint. A split both RETYPES the block
 * at `at` (`first` — a heading split at its start becomes a paragraph) and
 * inserts a new block after it (`second`), so the two are judged together.
 * Returns the continuation to use — `second` when the shape permits it, else the
 * first permitted alternative — or `undefined`, which the caller reads as
 * "Enter cannot split here" and no-ops.
 */
export function contentSplitType(
  state: EditorState,
  at: number,
  first: string,
  second: string,
): string | undefined {
  const { schema } = state;
  if (!schema.content) return second;
  const current = documentBlockTypes(state.document.page);
  const split = (continuation: string): string[] => {
    const types = [...current];
    if (at >= 0 && at < types.length) types[at] = first;
    types.splice(at + 1, 0, continuation);
    return types;
  };
  if (accepts(state, split(second))) return second;
  const prefix = split(second);
  for (const candidate of schema.contentTypesAt(prefix, at + 1) ?? []) {
    if (candidate === second) continue;
    if (!schema.isBlockAllowed(candidate)) continue;
    if (accepts(state, split(candidate))) return candidate;
  }
  return undefined;
}

/**
 * The type a new block at visible position `at` should take: `preferred` when
 * the shape permits it, otherwise the first type the shape does permit there,
 * otherwise `undefined` — which the caller reads as "no block may be created
 * here" and no-ops. The content analogue of `DataSchema.coerceCreatable`.
 */
export function contentInsertType(
  state: EditorState,
  at: number,
  preferred: string,
): string | undefined {
  const { schema } = state;
  if (!schema.content) return preferred;
  if (contentAllowsInsert(state, at, preferred)) return preferred;
  const types = documentBlockTypes(state.document.page);
  for (const candidate of schema.contentTypesAt(types, at) ?? []) {
    if (candidate === preferred) continue;
    if (!schema.isBlockAllowed(candidate)) continue;
    if (contentAllowsInsert(state, at, candidate)) return candidate;
  }
  return undefined;
}
