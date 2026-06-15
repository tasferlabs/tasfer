import type { CreateEditorOptions, CypherEditor } from "@cypherkit/editor";
import { useEffect } from "react";
import type { CSSProperties } from "react";
import { useEditor, type UseEditorOptions } from "./useEditor";

/**
 * Props for the {@link Editor} component: every {@link CreateEditorOptions}
 * field except `element` (the component renders and owns the host `<div>`), plus
 * styling hooks and a one-shot ready callback.
 */
export interface EditorProps extends UseEditorOptions {
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
}

/**
 * A thin React wrapper over {@link useEditor} that renders the host element and
 * mounts the canvas editor into it.
 *
 * Editor options are read once at mount (see {@link useEditor}); change the
 * editor at runtime through the handle delivered by `onReady`, not by re-passing
 * props. The host `<div>` must be sized — pass a height via `style` or
 * `className`.
 *
 * @example
 * <Editor
 *   value="# Hello"
 *   autofocus
 *   className="prose"
 *   style={{ height: "100vh" }}
 *   onReady={(editor) => editor.on("change", () => save(editor.getMarkdown()))}
 * />
 */
export function Editor(props: EditorProps): React.JSX.Element {
  const { className, style, onReady, ...options } = props;
  const { containerRef, editor } = useEditor(options);

  useEffect(() => {
    if (editor) onReady?.(editor);
    // Fire once per editor instance. `onReady` is treated as a stable callback;
    // re-subscribing on its identity would re-invoke it on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return <div ref={containerRef} className={className} style={style} />;
}
