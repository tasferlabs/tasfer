import { createDoc, type Doc } from "../doc";
import { baseSchema, type Schema } from "../schema";
import { type Block, loadPage } from "../serlization/loadPage";
import type { EditorApi, EditorStateSnapshot } from "./editor";
import { mountEditor, type MountEditorOptions } from "./mount";

/**
 * The three mutually exclusive content sources for {@link createEditor}. Supply
 * **at most one** of `value` / `blocks` / `doc` — the discriminated union makes
 * passing two a compile-time error (and `createEditor` also throws at runtime,
 * to backstop untyped JS callers). Passing none yields a blank document.
 *
 * The `?: never` siblings on each variant are what enforce the exclusivity: if
 * you set `doc`, TypeScript narrows to the third variant, where `value`/`blocks`
 * are typed `never` and so can't also be set.
 */
export type CreateEditorContent =
  | {
      /** Initial document as a Markdown string. */
      value?: string;
      blocks?: never;
      doc?: never;
    }
  | {
      /**
       * Pre-parsed blocks to mount instead of `value` (e.g. restored from a
       * snapshot).
       */
      blocks: Block[];
      value?: never;
      doc?: never;
    }
  | {
      /**
       * Attach an existing CRDT document (see `createDoc`). The editor renders
       * and edits this doc: its local edits flow into the doc, and updates
       * applied to the doc from elsewhere (`doc.applyUpdate`) flow into the
       * editor. A doc already carries its content, and supersedes
       * `crdtBinding`/`pageId` (it carries its own identity). When omitted, a
       * private doc is created from `blocks`/`value` and exposed as
       * `editor.doc`.
       */
      doc: Doc;
      value?: never;
      blocks?: never;
    };

/**
 * The non-content {@link createEditor} options, shared by every
 * {@link CreateEditorContent} variant. (`doc` is omitted from the inherited
 * `MountEditorOptions` here because it's one of the content sources above — the
 * union owns it so the exclusivity holds.)
 */
export type CreateEditorBaseOptions = Omit<MountEditorOptions, "doc"> & {
  /** The host element the canvas mounts into. Sized to fill this element. */
  element: HTMLElement;
  /**
   * The block/mark types this editor understands (see `defineNode` /
   * `baseSchema.extend`). Drives parsing, serialization, CRDT validation, and
   * which nodes render. Defaults to the built-in `baseSchema`. Ignored when a
   * `doc` is supplied (the doc already carries its own schema) — but the
   * `nodes` still take effect for rendering; pass a matching schema to both.
   */
  schema?: Schema;
  /** Focus the editor and drop a caret in on mount. Default false. */
  autofocus?: boolean;
};

/**
 * Options for {@link createEditor}: the {@link CreateEditorBaseOptions} plus at
 * most one of the {@link CreateEditorContent} sources.
 */
export type CreateEditorOptions = CreateEditorBaseOptions & CreateEditorContent;

/**
 * The handle returned by {@link createEditor}: the full {@link Editor} action
 * surface plus the mount-level conveniences (focus / blur / teardown / portal).
 *
 * Its `destroy()` performs the *complete* teardown — canvas layers, global
 * listeners, the portal, and the render loop — so always call it when removing
 * the editor (it supersedes the core `Editor.destroy`).
 */
export interface CypherEditor extends EditorApi {
  /**
   * The CRDT document this editor renders and edits — the one passed via
   * `CreateEditorOptions.doc`, or a private one created on mount. Sync and
   * persistence go through it exclusively: `doc.applyUpdate(ops)` for inbound
   * ops, `doc.on("update", …)` for outbound, `doc.encodeState()` to persist.
   */
  readonly doc: Doc;
  /**
   * Read-only state snapshot for UI binding: `{ selection, activeMarks, doc }`.
   * The raw internal {@link EditorState} stays available via {@link getState}.
   */
  readonly state: EditorStateSnapshot & { readonly doc: Doc };
  /** Container to mount React popovers/overlays into (slash menu, link editor). */
  readonly portalContainer: HTMLDivElement;
  /**
   * Focus the editor. With no argument, places a caret only if there isn't one
   * yet; pass `"start"` / `"end"` to force the caret to the document boundary.
   */
  focus: (at?: "start" | "end") => void;
  /** Blur the editor / dismiss the soft keyboard. */
  blur: () => void;
  /** Refocus the hidden input (e.g. after closing a dialog or drawer). */
  refocus: () => void;
  /** Feed the current soft-keyboard height (px) for mobile layout. */
  setKeyboardHeight: (height: number) => void;
  /** Full teardown: canvas layers, global listeners, portal, render loop. */
  destroy: () => void;
}

/**
 * Convenience constructor: parse Markdown, mount the canvas editor into an
 * element, and return a single handle that merges the editor action API with
 * the mount lifecycle.
 *
 * A thin wrapper over `loadPage` + `mountEditor` — reach for `mountEditor`
 * directly when you want the lower-level split (e.g. to keep the `MountedEditor`
 * and `Editor` handles separate).
 *
 * @example
 * const editor = createEditor({
 *   element: document.querySelector("#editor")!,
 *   value: "# Hello\n\nStart typing — **markdown** shortcuts work.",
 *   autofocus: true,
 * });
 *
 * editor.on("change", () => localStorage.setItem("draft", editor.getMarkdown()));
 * // …later
 * editor.destroy();
 */
export function createEditor(options: CreateEditorOptions): CypherEditor {
  const {
    element,
    value,
    blocks,
    doc: docOption,
    schema = baseSchema,
    autofocus,
    ...mountOptions
  } = options;

  // Content comes from exactly one source — `value` (markdown), `blocks`
  // (pre-parsed), or `doc` (an existing CRDT document). They don't layer:
  // supplying more than one is a host mistake (one would silently win and the
  // rest vanish). The `CreateEditorContent` union already rejects this at
  // compile time for TypeScript callers; this runtime check backstops untyped
  // JS callers (and `as`-casts), rejecting it loudly rather than guessing.
  if (
    (value !== undefined ? 1 : 0) +
      (blocks !== undefined ? 1 : 0) +
      (docOption !== undefined ? 1 : 0) >
    1
  ) {
    throw new Error(
      "createEditor: pass at most one content source — `value`, `blocks`, or " +
        "`doc`. A `doc` already carries its content; `blocks`/`value` seed a " +
        "fresh one.",
    );
  }

  // The doc is the source of truth the editor renders. An explicit `doc` is
  // used as-is; otherwise a private one is created from `blocks`/`value`
  // (loadPage always returns ≥1 block, so an empty/omitted string is a valid
  // blank document). The doc carries the data half of the schema so its reducer
  // and markdown projection honor custom block types.
  const doc =
    docOption ??
    createDoc({
      blocks: blocks ?? loadPage(value ?? "", schema.data).blocks,
      pageId: mountOptions.pageId,
      schema: schema.data,
    });
  const ownsDoc = !docOption;

  const mounted = mountEditor(element, doc.getBlocks(), {
    ...mountOptions,
    // Render with the schema's nodes (built-ins + any custom), unless the host
    // passed an explicit `nodes` list (which then wins).
    nodes: mountOptions.nodes ?? schema.nodes,
    // Same for inline marks — schema's marks unless the host overrode them.
    marks: mountOptions.marks ?? schema.marks,
    // Attach the doc: mountEditor mounts from its blocks, shares its binding,
    // and owns the doc↔editor wiring (local edits → doc, doc updates → editor).
    doc,
  });
  const { editor } = mounted;

  const focus = (at?: "start" | "end") => {
    mounted.refocus();
    if (at) editor.setCaret(at);
    else editor.setInitialCursor();
  };

  const destroy = () => {
    // mounted.destroy() detaches the doc↔editor wiring it installed.
    mounted.destroy();
    // A doc passed in by the host outlives the editor; a private one doesn't.
    if (ownsDoc) doc.destroy();
  };

  const handle: CypherEditor = {
    // Spread the core editor action surface (change, run, undo, on,
    // getMarkdown, …) onto the returned handle. (The doc↔editor wiring methods
    // are engine-internal — kept off the public `CypherEditor`/`EditorApi`
    // type; hosts sync through `doc` exclusively.)
    ...editor,
    // Re-expose `state` as a live getter: object spread above evaluates the
    // core getter once and would otherwise freeze it to a stale snapshot.
    // Adds `doc` so the documented `{ selection, activeMarks, doc }` shape works.
    get state() {
      return { ...editor.state, doc };
    },
    doc,
    portalContainer: mounted.portalContainer,
    refocus: mounted.refocus,
    setKeyboardHeight: mounted.setKeyboardHeight,
    focus,
    blur: mounted.blurInput,
    // Override the core `editor.destroy` with the full mount teardown.
    // (mounted.destroy calls the original editor.destroy internally — the
    // spread copies a reference, it isn't reassigned, so there's no recursion.)
    destroy,
  };

  if (autofocus) focus();

  return handle;
}
