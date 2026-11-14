// Toolbar.tsx from step 2 of the tutorial, copied as written. The only
// difference: a className on the wrapping div, for the page styles.
import { useEditorState, type TasferEditor } from "@tasfer/react";

const MARKS = [
  { label: "B", mark: "strong" },
  { label: "i", mark: "emphasis" },
  { label: "</>", mark: "code" },
] as const;

export function Toolbar({ editor }: { editor: TasferEditor | null }) {
  const active = useEditorState(editor)?.activeMarks ?? new Set();
  return (
    <div className="toolbar">
      {MARKS.map((b) => (
        <button
          key={b.mark}
          className={active.has(b.mark) ? "is-active" : ""}
          onClick={() => editor?.change((c) => c.setMark(b.mark))}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
