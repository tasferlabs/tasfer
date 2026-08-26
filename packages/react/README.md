# @tasfer/editor-binding

**React 19 bindings** for [`@tasfer/editor`](https://www.npmjs.com/package/@tasfer/editor),
the headless canvas editor engine. A thin layer over the same imperative
handle — not a fork of it.

Everything is per-instance: no module-level state, so multiple editors can live
on one page.

## Install

```bash
npm install @tasfer/editor @tasfer/editor-binding
```

`react` and `react-dom` are peer dependencies, not a bundled copy.

## Usage

The `<Editor>` component owns and sizes its host element for you:

```tsx
import { Editor } from "@tasfer/editor-binding";

export default function App() {
  return (
    <Editor
      markdown={"# Hello\n\nStart typing — *markdown* shortcuts just work."}
      autofocus
      style={{ height: "70vh" }}
      onChange={(markdown) => localStorage.setItem("draft", markdown)}
    />
  );
}
```

For full control over the host element, use the hook and render the container
yourself:

```tsx
import { useEditor } from "@tasfer/editor-binding";

const { containerRef, editor } = useEditor({ markdown: "# Title" });
return <div ref={containerRef} className="my-editor" />;
```

## Reading state

`useEditorState` is a `useSyncExternalStore` subscription — it re-renders your
component whenever the editor's snapshot is replaced, so a toolbar stays in sync
without any subscription of your own. It is `null` until the editor exists.

```tsx
import { useEditorState } from "@tasfer/editor-binding";

function Toolbar({ editor }) {
  const state = useEditorState(editor);
  const active = state?.activeMarks ?? new Set();

  return (
    <button
      aria-pressed={active.has("strong")}
      onClick={() => editor?.change((c) => c.setMark("strong"))}
    >
      Bold
    </button>
  );
}
```

There is no separate React command API: you call `change` on the same handle —
the `editor` from `useEditor`, or the one `onReady` gives you.

## Exports

- `useEditor` — creates and owns a `TasferEditor`, returns `{ containerRef, editor }`.
- `Editor` — drop-in component wrapping `useEditor`; reports the editor via `onReady`.
- `useEditorState` — live selection / active-mark snapshot.
- `useEditorMarkdown` — the document as markdown, re-read on every edit.

Editor options are read once at mount; reconfigure at runtime through the
imperative handle (`setTheme`, `setMarkdown`, `change`, …).

## Documentation

[tasfer.app/docs/editor/api-react](https://www.tasfer.app/docs/editor/api-react)

## License

MIT
