import type { TasferEditor } from "@tasfer/editor";
import { Editor } from "@tasfer/react";
import { studioTheme } from "../theme";

interface EditorPaneProps {
  value: string;
  words: number;
  synced: boolean;
  onReady: (editor: TasferEditor) => void;
}

export function EditorPane({ value, words, synced, onReady }: EditorPaneProps) {
  return (
    <main className="pane">
      <div className="pane__breadcrumb">
        <span>docs</span>
        <span className="pane__sep">›</span>
        <span className="pane__file">README.md</span>
        <span className="pane__badge">PREVIEW · WYSIWYG</span>
      </div>

      <div className="pane__editor">
        <Editor
          markdown={value}
          theme={studioTheme}
          autofocus
          ariaLabel="README.md"
          onReady={onReady}
          style={{ height: "100%" }}
        />
      </div>

      <div className="pane__status">
        <span className={"pane__status-sync" + (synced ? "" : " pane__status-sync--off")}>
          <span className="pane__status-dot" />
          {synced ? "synced" : "syncing…"}
        </span>
        <span>{words} words</span>
        <span>Markdown</span>
        <span className="pane__status-spacer" />
        <span>UTF-8</span>
        <span>⌘ Midnight</span>
      </div>
    </main>
  );
}
