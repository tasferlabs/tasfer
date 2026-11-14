import { createDoc, type Doc } from "../doc";
import type { DocPoint } from "../positions";
import { baseSchema, type Schema } from "../schema";
import type { BaseSchemaDefinition, SchemaDefinition } from "../schema-types";
import { type Block, loadPage } from "../serlization/loadPage";
import type { EditorApi, EditorStateSnapshot } from "./editor";
import { mountEditor, type MountEditorOptions } from "./mount";

/**
 * Where {@link createEditor} gets its content: `markdown`, `blocks`, or an
 * existing `doc`. Pass at most one. TypeScript rejects two, and `createEditor`
 * throws if two reach it at runtime. Pass none for a blank document.
 *
 * @group Editor
 */
// The `?: never` siblings on each variant enforce the exclusivity: setting
// `doc` narrows to the third variant, where `markdown`/`blocks` are typed
// `never`.
export type CreateEditorContent<
  D extends SchemaDefinition = BaseSchemaDefinition,
> =
  | {
      /**
       * Initial document as a Markdown string. Windows line endings (`\r\n`)
       * are fine. `getMarkdown()` always writes plain `\n` line endings.
       */
      markdown?: string;
      blocks?: never;
      doc?: never;
    }
  | {
      /**
       * Pre-parsed blocks to mount instead of `markdown` (e.g. restored from a
       * snapshot).
       */
      blocks: Block[];
      markdown?: never;
      doc?: never;
    }
  | {
      /**
       * An existing document to show (see {@link createDoc}). Edits in the
       * editor go into the doc. Updates applied to the doc with
       * `doc.applyUpdate` show up in the editor. The doc brings its own content
       * and identity, so `pageId` and `crdtBinding` are not used.
       * `editor.destroy()` leaves a doc you passed in working.
       *
       * When you leave `doc` out, the editor makes its own from `blocks` or
       * `markdown` and exposes it as `editor.doc`.
       */
      doc: Doc<D>;
      markdown?: never;
      blocks?: never;
    };

/**
 * The {@link createEditor} options other than content. They work with every
 * {@link CreateEditorContent} choice.
 *
 * @group Editor
 */
// `doc` is omitted from the inherited MountEditorOptions because it is one of
// the content sources; the CreateEditorContent union owns it so the exclusivity
// holds.
export type CreateEditorBaseOptions<
  D extends SchemaDefinition = BaseSchemaDefinition,
> = Omit<MountEditorOptions<D>, "doc" | "schema"> & {
  /**
   * The host element the canvas mounts into. The canvas fills this element, so
   * give it a height (or use `autoHeight`).
   */
  element: HTMLElement;
  /**
   * The block and mark types this editor understands (see `defineNode` and
   * `baseSchema.extend`). It decides how Markdown is read and written and which
   * nodes are drawn. Its nodes and marks are used unless you pass `nodes` or
   * `marks`. Defaults to `baseSchema`.
   *
   * When you pass a `doc`, the doc's own schema checks its content, but the
   * editor still draws and edits with this one. So pass the same schema to
   * both.
   */
  schema?: Schema<D>;
  /** Focus the editor and drop a caret in on mount. Default false. */
  autofocus?: boolean;
};

/**
 * Options for {@link createEditor}: the {@link CreateEditorBaseOptions} plus at
 * most one of the {@link CreateEditorContent} sources.
 *
 * @group Editor
 */
export type CreateEditorOptions<
  D extends SchemaDefinition = BaseSchemaDefinition,
> = CreateEditorBaseOptions<D> & CreateEditorContent<D>;

/**
 * The handle {@link createEditor} returns. It has every {@link Editor} method,
 * plus `doc`, `focus`, `blur`, `portalContainer` and a full `destroy`.
 *
 * Always call `destroy()` when you remove the editor. It replaces the plain
 * `Editor.destroy` and also removes the canvas layers, page listeners, the
 * portal and the render loop.
 *
 * @group Editor
 */
export interface TasferEditor<
  D extends SchemaDefinition = BaseSchemaDefinition,
> extends EditorApi<D> {
  /**
   * The document this editor shows and edits: the `doc` you passed in, or one
   * the editor made for itself. Sync and saving go only through it:
   * `doc.applyUpdate(ops)` for incoming edits, `doc.on("update", …)` for
   * outgoing ones, and `doc.encodeState()` to save. Sync and storage providers
   * attach to this doc, not to the editor.
   */
  readonly doc: Doc<D>;
  /**
   * `editor.state` tells you what is selected, which marks are active, the
   * block type at the caret, whether undo and redo are possible, and whether
   * the editor has focus (see {@link EditorStateSnapshot}). It also holds the
   * attached `doc`. It is a snapshot: every edit makes a new one. So read
   * `editor.state` when you need it, and do not keep an old copy.
   */
  // The raw internal EditorState is not on this public handle. A first-party
  // host that needs it diffs via the internal subscribeRaw
  // (@tasfer/editor/internal).
  readonly state: EditorStateSnapshot & { readonly doc: Doc<D> };
  /**
   * Container to mount React popovers/overlays into (slash menu, link editor).
   * It floats over the canvas. It ignores pointer events, so set
   * `pointer-events: auto` on what you put inside.
   */
  readonly portalContainer: HTMLDivElement;
  /**
   * Gives the editor keyboard focus, so it gets typing and IME input. If the
   * editor is editable and has no caret or selection yet, a caret is placed at
   * the start. An existing caret or selection stays where it is.
   */
  focus: () => void;
  /**
   * Takes focus away from the editor and closes the soft keyboard. A selected
   * range is cleared a moment later, unless focus comes back or a host menu is
   * open.
   */
  blur: () => void;
  /**
   * Removes the editor completely: canvas layers, page listeners, the portal
   * and the render loop. If the editor made its own doc, that doc is destroyed
   * too. A doc you passed in keeps working.
   */
  destroy: () => void;
}

/**
 * Creates an editor inside `element` and returns its handle. Give it content as
 * `markdown`, `blocks`, or an existing `doc`. Pass at most one: passing two or
 * more throws. With none, the editor starts blank.
 *
 * @example
 * ```ts
 * const editor = createEditor({
 *   element: document.querySelector("#editor")!,
 *   markdown: "# Hello\n\nStart typing — **markdown** shortcuts work.",
 *   autofocus: true,
 * });
 *
 * editor.on("change", () => {
 *   localStorage.setItem("draft", editor.getMarkdown());
 * });
 * // …later
 * editor.destroy();
 * ```
 * @group Editor
 */
export function createEditor<D extends SchemaDefinition = BaseSchemaDefinition>(
  options: CreateEditorOptions<D>,
): TasferEditor<D> {
  const {
    element,
    markdown,
    blocks,
    doc: docOption,
    schema = baseSchema,
    autofocus,
    ...mountOptions
  } = options;

  // Content comes from exactly one source — `markdown` (a markdown string),
  // `blocks` (pre-parsed), or `doc` (an existing CRDT document). They don't
  // layer: supplying more than one is a host mistake (one would silently win
  // and the rest vanish). The `CreateEditorContent` union already rejects this
  // at compile time for TypeScript callers; this runtime check backstops untyped
  // JS callers (and `as`-casts), rejecting it loudly rather than guessing.
  if (
    (markdown !== undefined ? 1 : 0) +
      (blocks !== undefined ? 1 : 0) +
      (docOption !== undefined ? 1 : 0) >
    1
  ) {
    throw new Error(
      "createEditor: pass at most one content source — `markdown`, `blocks`, " +
        "or `doc`. A `doc` already carries its content; `blocks`/`markdown` " +
        "seed a fresh one.",
    );
  }

  // The doc is the source of truth the editor renders. An explicit `doc` is
  // used as-is; otherwise a private one is created from `blocks`/`markdown`
  // (loadPage always returns ≥1 block, so an empty/omitted string is a valid
  // blank document). The doc carries the data half of the schema so its reducer
  // and markdown projection honor custom block types.
  const doc: Doc<D> =
    docOption ??
    createDoc<D>({
      blocks: blocks ?? loadPage(markdown ?? "", schema.data).blocks,
      pageId: mountOptions.pageId,
      schema: schema.data,
    });
  const ownsDoc = !docOption;

  const mounted = mountEditor<D>(element, doc.getRawBlocks(), {
    ...mountOptions,
    // Render with the schema's nodes (built-ins + any custom), unless the host
    // passed an explicit `nodes` list (which then wins).
    nodes: mountOptions.nodes ?? schema.nodes,
    // Same for inline marks — schema's marks unless the host overrode them.
    marks: mountOptions.marks ?? schema.marks,
    // Carry the canvas-free schema onto the editor state so authoring honors the
    // allow-list (Schema.restrict). Same DataSchema the doc's reducer uses, so
    // authoring and materialization stay consistent.
    schema: schema.data,
    // Attach the doc: mountEditor mounts from its blocks, shares its binding,
    // and owns the doc↔editor wiring (local edits → doc, doc updates → editor).
    doc,
  });
  const { editor } = mounted;

  // Alias for `setCaret` that also restores DOM focus to the input surface.
  const focus = (
    point?: Exclude<DocPoint, "caret">,
    opts?: { onlyIfUnset?: boolean },
  ) => {
    mounted.refocus();
    editor.setCaret(point, opts);
  };

  const destroy = () => {
    // mounted.destroy() detaches the doc↔editor wiring it installed.
    mounted.destroy();
    // A doc passed in by the host outlives the editor; a private one doesn't.
    if (ownsDoc) doc.destroy();
  };

  const handle: TasferEditor<D> = {
    // Spread the core editor action surface (change, dispatch, undo, on,
    // getMarkdown, …) onto the returned handle. (The doc↔editor wiring methods
    // are engine-internal — kept off the public `TasferEditor`/`EditorApi`
    // type; hosts sync through `doc` exclusively.)
    ...editor,
    // Re-expose `state` as a live getter: object spread above evaluates the
    // core getter once and would otherwise freeze it to a stale snapshot.
    // Adds `doc` to the engine snapshot to complete the documented shape.
    get state() {
      return { ...editor.state, doc };
    },
    doc,
    portalContainer: mounted.portalContainer,
    // Override the core `editor.destroy` with the full mount teardown.
    // (mounted.destroy calls the original editor.destroy internally — the
    // spread copies a reference, it isn't reassigned, so there's no recursion.)
    destroy,
  };

  if (autofocus) focus();

  return handle;
}
