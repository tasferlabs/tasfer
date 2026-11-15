import type {
  BaseSchemaDefinition,
  TasferEditor,
  SchemaDefinition,
} from "@tasfer/editor";
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { useEditor, type UseEditorOptions } from "./useEditor";

/**
 * Props for the {@link Editor} component: every {@link CreateEditorOptions}
 * field except `element`, because the component renders its own `<div>`. It
 * adds `className`, `style`, an `onChange` callback for edits, and an `onReady`
 * callback that runs once.
 */
// A type alias rather than an `interface extends UseEditorOptions` because the
// content sources make `UseEditorOptions` a discriminated union, which an
// interface can't extend; intersecting preserves the union's exclusivity.
export type EditorProps<D extends SchemaDefinition = BaseSchemaDefinition> =
  UseEditorOptions<D> & {
    /**
     * Called with the document as Markdown after every change: typing, paste,
     * undo, or an edit from another person. It only reports changes. It never
     * puts content back into the editor. Each call turns the whole document
     * into Markdown.
     *
     * To replace the content, call `editor.setMarkdown(...)` on the handle from
     * `onReady`. To read each {@link ChangeTransaction}, or to skip edits from
     * other people with `tx.isRemote`, call `editor.on("change", …)` from
     * `onReady` instead.
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
     * Called once with the {@link TasferEditor} as soon as it has mounted. Use
     * it to focus the editor, change it, or listen to its events.
     */
    onReady?: (editor: TasferEditor<D>) => void;
  };

/**
 * A React component that renders a `<div>` and mounts the editor in it. It is
 * built on {@link useEditor}.
 *
 * Options are read once, when it mounts. Changing them later does nothing. To
 * change the editor afterwards, use the editor you get from `onReady`.
 * `onChange` is the one prop that can change, and it only reports edits. There
 * is no `value` prop: the editor owns its content. Give the component a height
 * with `style` or `className`, or it shows nothing.
 *
 * @example
 * ```tsx
 * <Editor
 *   markdown="# Hello"
 *   onChange={save}
 *   style={{ height: "100vh" }}
 *   onReady={(editor) => {
 *     editor.focus();
 *     editor.setCaret("end");
 *   }}
 * />
 * ```
 */
export function Editor<D extends SchemaDefinition = BaseSchemaDefinition>(
  props: EditorProps<D>,
): React.JSX.Element {
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
