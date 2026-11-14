import {
  createEditor,
  type CreateEditorBaseOptions,
  type CreateEditorContent,
  type CreateEditorOptions,
  type TasferEditor,
  type BaseSchemaDefinition,
  type SchemaDefinition,
} from "@tasfer/editor";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/**
 * Options for {@link useEditor}: every {@link CreateEditorOptions} field except
 * `element`. The hook mounts the editor into the `<div>` you attach with
 * `containerRef` instead.
 */
// Built by omitting `element` from the base options and re-intersecting the
// CreateEditorContent union, NOT `Omit<CreateEditorOptions, "element">`: `Omit`
// over a union collapses it, which would silently drop the markdown/blocks/doc
// exclusivity at the React layer.
export type UseEditorOptions<
  D extends SchemaDefinition = BaseSchemaDefinition,
> = Omit<CreateEditorBaseOptions<D>, "element"> & CreateEditorContent<D>;

/**
 * Return value of {@link useEditor}.
 */
export interface UseEditorResult<
  D extends SchemaDefinition = BaseSchemaDefinition,
> {
  /**
   * Attach to the host element the editor mounts into:
   * `<div ref={containerRef} />`. The editor sizes itself to fill this element,
   * so the host must give it a height (e.g. via CSS) — an unsized div renders
   * nothing visible.
   */
  containerRef: RefObject<HTMLDivElement | null>;
  /**
   * The editor, or `null` on the first render and on the server. Call its
   * methods to change it, such as `editor.setMarkdown(...)` or
   * `editor.change(...)`.
   */
  editor: TasferEditor<D> | null;
}

// `useLayoutEffect` warns when run on the server (no DOM). The editor only ever
// mounts in the browser, so fall back to `useEffect` where `window` is absent.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Create a {@link TasferEditor} and mount it into a `<div>` you render with the
 * returned `containerRef`.
 *
 * The editor is created once, when the component mounts, and destroyed when it
 * unmounts. Options you pass later are ignored, because a new editor would
 * throw away the document. To change the editor while it runs, call its
 * methods, such as `editor.setTheme(...)` or `editor.setMarkdown(...)`.
 *
 * @example
 * function MyEditor() { const { containerRef, editor } = useEditor({ markdown:
 * "# Hello" }); useEffect(() => { if (editor) editor.focus("end"); },
 * [editor]); return <div ref={containerRef} style={{ height: "100%" }} />; }
 */
// Created in a layout effect; correct under React 18/19 StrictMode's
// double-invoke because each create is paired with its destroy. The latest
// options are read at mount time, so prop drift between render and the effect
// is handled.
export function useEditor<D extends SchemaDefinition = BaseSchemaDefinition>(
  options: UseEditorOptions<D>,
): UseEditorResult<D> {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<TasferEditor<D> | null>(null);

  // Hold the latest options in a ref so the mount-only effect reads current
  // values at create time without listing `options` in its deps (which would
  // recreate the editor on every render and destroy its state).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useIsomorphicLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    // `optionsRef.current` is a `UseEditorOptions` — itself the discriminated
    // content-source union, so the caller already satisfied the
    // markdown/blocks/doc exclusivity at their own call site. Object-spreading a
    // union widens away the discriminant (TS can no longer prove which variant
    // survived `{ ...x }`), so we reassert the type here. `createEditor`'s
    // runtime guard still backstops a genuinely-conflicting object.
    const instance = createEditor({
      ...optionsRef.current,
      element,
    } as CreateEditorOptions<D>);
    setEditor(instance);

    return () => {
      instance.destroy();
      setEditor(null);
    };
    // Mount-only: the editor is created once and reconfigured imperatively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { containerRef, editor };
}
