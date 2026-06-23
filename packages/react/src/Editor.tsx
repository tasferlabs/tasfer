import type { CreateEditorOptions, CypherEditor } from "@cypherkit/editor";
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { useEditor, type UseEditorOptions } from "./useEditor";

/**
 * Props for the {@link Editor} component: every {@link CreateEditorOptions}
 * field except `element` (the component renders and owns the host `<div>`), plus
 * styling hooks, an `onChange` edit callback, and a one-shot ready callback.
 *
 * A type alias rather than an `interface extends UseEditorOptions` because the
 * content sources make `UseEditorOptions` a discriminated union, which an
 * interface can't extend — intersecting preserves the union's exclusivity.
 */
export type EditorProps = UseEditorOptions & {
  /**
   * Notify-only callback fired with the document's serialized markdown after
   * every change — local edits, paste, undo, or a remote sync. It is sugar over
   * `editor.on("change", …)` and never pushes content back into the editor, so
   * it can't fight the caret. The document is owned by the CRDT, not by a prop:
   * to *replace* content at runtime, call `editor.setMarkdown(...)` (or any
   * `editor.change(...)`) on the handle from `onReady`. For finer control — the
   * {@link import("@cypherkit/editor").ChangeTransaction}, or ignoring remote
   * edits via `tx.isRemote` — subscribe through `onReady` instead.
   */
  onChange?: (markdown: string) => void;
  /** Class name forwarded to the host `<div>`. */
  className?: string;
  /**
   * Inline styles forwarded to the host `<div>`. The editor fills its container,
   * so give the host a height here (or via `className`) — otherwise it collapses
   * to zero height and renders nothing visible.
   */
  style?: CSSProperties;
  /**
   * Called once with the {@link CypherEditor} as soon as it has mounted. Use it
   * to grab the imperative handle (focus, change, event subscriptions, …).
   */
  onReady?: (editor: CypherEditor) => void;
};

/**
 * A thin React wrapper over {@link useEditor} that renders the host element and
 * mounts the canvas editor into it.
 *
 * Editor options are read once at mount (see {@link useEditor}); change the
 * editor at runtime through the handle delivered by `onReady`, not by re-passing
 * props. `onChange` is the one live prop, but it's notify-only — it reports
 * edits and never drives content. The host `<div>` must be sized — pass a height
 * via `style` or `className`.
 *
 * @example
 * <Editor
 *   markdown="# Hello"
 *   onChange={save}
 *   style={{ height: "100vh" }}
 *   onReady={(editor) => editor.focus("end")}
 * />
 */
export function Editor(props: EditorProps): React.JSX.Element {
  const { className, style, onReady, onChange, ...options } = props;
  const { containerRef, editor } = useEditor(options);

  // Keep the callbacks in refs so the change subscription is wired exactly once
  // per editor and never re-subscribes when a new callback identity arrives.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!editor) return;
    onReadyRef.current?.(editor);
    return editor.on("change", () => {
      // Serialize only when someone is listening: `getMarkdown()` walks the
      // whole document, and the subscription is wired even when `onChange` is
      // absent (it may be supplied on a later render, read here through the ref).
      const cb = onChangeRef.current;
      if (cb) cb(editor.getMarkdown());
    });
    // Wire once per editor instance: `onReady`/`onChange` are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return <div ref={containerRef} className={className} style={style} />;
}
