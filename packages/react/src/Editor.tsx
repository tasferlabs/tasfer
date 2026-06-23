import type { CreateEditorOptions, CypherEditor } from "@cypherkit/editor";
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { useEditor, type UseEditorOptions } from "./useEditor";

/**
 * Props for the {@link Editor} component: every {@link CreateEditorOptions}
 * field except `element` (the component renders and owns the host `<div>`), plus
 * styling hooks, a one-shot ready callback, and the controlled-component sugar
 * (`value` / `onChange`).
 *
 * A type alias rather than an `interface extends UseEditorOptions` because the
 * content sources make `UseEditorOptions` a discriminated union, which an
 * interface can't extend — intersecting preserves the union's exclusivity.
 */
export type EditorProps = UseEditorOptions & {
  /**
   * Controlled markdown, the React-idiomatic sugar. It seeds the initial content
   * (when no `markdown` / `blocks` / `doc` is given) and is pushed into the
   * editor whenever it changes after mount — so `<Editor value={md} onChange={setMd} />`
   * behaves like a controlled `<textarea>`. Echoing `onChange`'s own output back
   * into `value` is a no-op, so it never fights the caret on a keystroke. For a
   * large or collaborative document, prefer the uncontrolled `markdown` plus the
   * imperative handle — pushing a fresh `value` reloads the document.
   */
  value?: string;
  /**
   * Called with the document's markdown after every change — local edits, paste,
   * undo, or a remote sync. The controlled-input partner of `value`. For finer
   * control (the {@link import("@cypherkit/editor").ChangeTransaction}, or to
   * ignore remote edits via `tx.isRemote`) subscribe through `onReady` instead.
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
 * Most options are read once at mount (see {@link useEditor}); change the editor
 * at runtime through the handle delivered by `onReady`, not by re-passing props.
 * The exception is the controlled `value` / `onChange` sugar, which stays in sync
 * by design. The host `<div>` must be sized — pass a height via `style` or
 * `className`.
 *
 * @example
 * // Uncontrolled: seed once, react to edits.
 * <Editor markdown="# Hello" onChange={save} style={{ height: "100vh" }} />
 *
 * @example
 * // Controlled, like a textarea.
 * const [md, setMd] = useState("# Hello");
 * <Editor value={md} onChange={setMd} style={{ height: "100vh" }} />
 */
export function Editor(props: EditorProps): React.JSX.Element {
  const { className, style, onReady, value, onChange, ...rest } = props;

  // `value` is the controlled-markdown sugar: when no explicit content source is
  // given, it seeds the initial document. (After mount it's pushed in via the
  // effect below.) Reading the content source off the discriminated union needs a
  // loose view — a plain runtime presence check is all we want.
  const content = rest as {
    markdown?: unknown;
    blocks?: unknown;
    doc?: unknown;
  };
  const hasExplicitContent =
    content.markdown !== undefined ||
    content.blocks !== undefined ||
    content.doc !== undefined;
  const options = (
    value !== undefined && !hasExplicitContent ? { ...rest, markdown: value } : rest
  ) as UseEditorOptions;

  const { containerRef, editor } = useEditor(options);

  // Keep the callbacks in refs so the change subscription is wired exactly once
  // per editor and never re-subscribes when a new callback identity arrives.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The markdown we believe the editor currently holds — what we last emitted to
  // `onChange` or last pushed via `value`. It's how the controlled loop is broken:
  // when `value` comes back equal to this, there's nothing to do.
  const lastMarkdownRef = useRef(value);

  useEffect(() => {
    if (!editor) return;
    onReadyRef.current?.(editor);
    return editor.on("change", () => {
      const markdown = editor.getMarkdown();
      lastMarkdownRef.current = markdown;
      onChangeRef.current?.(markdown);
    });
    // Wire once per editor instance: `onReady`/`onChange` are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Controlled `value`: push it in only when it differs from what the editor is
  // already showing. Echoing our own `onChange` output back is therefore a no-op,
  // so this never resets the caret on a keystroke; a genuinely new `value`
  // (programmatic reset, loading another document) reloads the editor.
  useEffect(() => {
    if (!editor || value === undefined || value === lastMarkdownRef.current) return;
    if (value === editor.getMarkdown()) {
      lastMarkdownRef.current = value;
      return;
    }
    lastMarkdownRef.current = value;
    editor.setMarkdown(value);
  }, [editor, value]);

  return <div ref={containerRef} className={className} style={style} />;
}
