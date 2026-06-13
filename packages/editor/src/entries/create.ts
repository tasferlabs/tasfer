import { createDoc, type Doc } from "../doc";
import { baseSchema, type Schema } from "../schema";
import { type Block, loadPage } from "../serlization/loadPage";
import type { Operation } from "../state-types";
import type { Editor, EditorStateSnapshot } from "./editor";
import { mountEditor, type MountEditorOptions } from "./mount";

export interface CreateEditorOptions extends MountEditorOptions {
  /** The host element the canvas mounts into. Sized to fill this element. */
  element: HTMLElement;
  /** Initial document as a Markdown string. Ignored when `blocks` is provided. */
  value?: string;
  /**
   * Pre-parsed blocks to mount instead of `value` (e.g. restored from a
   * snapshot). Takes precedence over `value`.
   */
  blocks?: Block[];
  /**
   * Attach an existing CRDT document (see `createDoc`). The editor renders
   * and edits this doc: its local edits flow into the doc, and updates
   * applied to the doc from elsewhere (`doc.applyUpdate`) flow into the
   * editor. Takes precedence over `blocks`/`value`/`crdtBinding`/`pageId`.
   * When omitted, a private doc is created from `blocks`/`value` and exposed
   * as `editor.doc`.
   */
  doc?: Doc;
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
}

/**
 * The handle returned by {@link createEditor}: the full {@link Editor} command
 * surface plus the mount-level conveniences (focus / blur / teardown / portal).
 *
 * Its `destroy()` performs the *complete* teardown — canvas layers, global
 * listeners, the portal, and the render loop — so always call it when removing
 * the editor (it supersedes the core `Editor.destroy`).
 */
export interface CypherEditor extends Editor {
  /**
   * The CRDT document this editor renders and edits — the one passed via
   * `CreateEditorOptions.doc`, or a private one created on mount. Sync and
   * persistence go through it: `doc.applyUpdate(ops)` for inbound ops,
   * `doc.on("update", …)` for outbound, `doc.encodeState()` to persist.
   * (The legacy `setBroadcast`/`applyRemoteOperations` shims below still work
   * but are routed through the doc; prefer the doc API in new code.)
   */
  readonly doc: Doc;
  /**
   * Apply remote operations to the document.
   * @deprecated Use the doc directly: `editor.doc.applyUpdate(ops)`. Kept as a
   * thin alias that routes through the doc so the log/version vector stay
   * consistent and the editor re-renders.
   */
  applyRemoteOperations: (ops: Operation[]) => void;
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
 * element, and return a single handle that merges the editor command API with
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

  // The doc is the source of truth the editor renders. An explicit `doc`
  // wins; otherwise a private one is created from `blocks`/`value` (loadPage
  // always returns ≥1 block, so an empty/omitted string is a valid blank
  // document). The doc carries the data half of the schema so its reducer and
  // markdown projection honor custom block types.
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

  // Unsubscriber for the host-facing legacy `setBroadcast` shim below.
  let offHostBroadcast: (() => void) | null = null;

  const focus = (at?: "start" | "end") => {
    mounted.refocus();
    if (at) editor.setCaret(at);
    else editor.setInitialCursor();
  };

  const destroy = () => {
    offHostBroadcast?.();
    offHostBroadcast = null;
    // mounted.destroy() detaches the doc↔editor wiring it installed.
    mounted.destroy();
    // A doc passed in by the host outlives the editor; a private one doesn't.
    if (ownsDoc) doc.destroy();
  };

  const handle: CypherEditor = {
    // Spread the core editor command surface (toggleBold, undo, on,
    // getMarkdown, commands, chain, sync methods, …) onto the returned handle.
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
    // ── Legacy sync surface, rerouted through the doc ─────────────────────
    // mountEditor owns the editor's broadcast slot (the doc↔editor wiring);
    // a host must not reinstall it there or the doc would disconnect. So a host
    // `setBroadcast` becomes a doc subscription over this editor's own local
    // batches — same observable behavior as before. Prefer the doc API
    // (`editor.doc.on("update", …)`) in new code.
    setBroadcast: (fn) => {
      offHostBroadcast?.();
      offHostBroadcast = fn
        ? doc.on("update", (u) => {
            if (u.local) fn(u.ops);
          })
        : null;
    },
    // Routed through the doc so its log/version-vector stay consistent (the
    // doc's update event then applies the ops to the editor, deduplicated).
    applyRemoteOperations: (ops: Operation[]) => {
      doc.applyUpdate(ops, "applyRemoteOperations");
    },
  };

  if (autofocus) focus();

  return handle;
}
