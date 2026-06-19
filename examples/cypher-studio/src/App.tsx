import type { CypherEditor } from "@cypherkit/editor";
import { useEditorMarkdown } from "@cypherkit/react";
import { useMemo, useState } from "react";
import { EditorPane } from "./components/EditorPane";
import { FileTree } from "./components/FileTree";
import { RightPanel } from "./components/RightPanel";
import { TabsBar } from "./components/TabsBar";
import { TopBar } from "./components/TopBar";
import { countWords, parseOutline } from "./util";

// The open document. It is a *real* editable canvas — type, use markdown
// shortcuts (`#`, `-`, `>`, `**bold**`), and the outline + word count on the
// right update live from what you write.
const README = `# How Cypher works

Cypher is a markdown editor that renders directly on **HTML5 Canvas** — every glyph is painted into a single \`<canvas>\`, not laid out by the DOM. Fast, precise, identical across platforms.

## Core pieces

- **Canvas engine** — manual keyboard, mouse, touch and IME handling.
- **CRDT sync** — an operation log stamped with a Hybrid Logical Clock.
- **Platform layer** — one API over OPFS, better-sqlite3 and native SQLite.

> The whole engine is headless: it knows nothing about React, your fonts, or where your assets live. The host wires those in — which is exactly why it drops into any shell.

Peers discover each other through a stateless relay, then talk over [encrypted WebRTC channels](https://cypher.example).`;

export function App() {
  const [editor, setEditor] = useState<CypherEditor | null>(null);
  const markdown = useEditorMarkdown(editor);
  const source = editor ? markdown : README;

  const words = useMemo(() => countWords(source), [source]);
  const outline = useMemo(() => parseOutline(source), [source]);

  return (
    <div className="studio">
      <TopBar />
      <TabsBar />
      <div className="studio__body">
        <FileTree />
        <EditorPane value={README} words={words} synced onReady={setEditor} />
        <RightPanel outline={outline} />
      </div>
    </div>
  );
}
