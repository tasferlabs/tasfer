// App.tsx from the "Your first editor" tutorial: the React snippets of steps 1,
// 3 and 4 put together as the tutorial describes. The only differences: `relay`
// points at the local relay from vite.config.ts, and the header that shows the
// status and the link to the plain TypeScript page.
import { useState, useEffect } from "react";
import { useEditor } from "@tasfer/react";
import { createRelayProvider } from "@tasfer/provider-relay";

import { Toolbar } from "./Toolbar";

export default function App() {
  // ── Step 1. Mount the editor ──────────────────────────────────────────────
  const { containerRef, editor } = useEditor({
    markdown: "# My notes\n\nWrite something.",
    placeholder: "Start writing…",
    autofocus: true,
  });

  // ── Step 3. Save locally ──────────────────────────────────────────────────
  useEffect(() => {
    if (!editor) return;

    // load
    const saved = localStorage.getItem("draft");
    if (saved) editor.setMarkdown(saved);

    // save; `change` fires on every edit, so debounce this if it is too much
    return editor.on("change", (tx) => {
      if (tx.isRemote) return;
      localStorage.setItem("draft", editor.getMarkdown());
    });
  }, [editor]);

  // ── Step 4. Edit together ─────────────────────────────────────────────────
  const [status, setStatus] = useState("offline");

  useEffect(() => {
    if (!editor) return;
    const provider = createRelayProvider({
      doc: editor.doc,                      // this editor's document
      room: "my-notes-demo",                // same room, same document
      relay: `ws://${location.host}/relay`, // docs: "wss://relay.tasfer.app"
      secret: "change-me-before-you-ship",  // room password; never give it to the relay
    });
    // connection status comes from the provider, not the editor
    provider.on("sync", (s) =>
      setStatus(s.connected ? `live · ${s.peers} peer(s)` : "offline"),
    );
    return () => provider.destroy();
  }, [editor]);

  return (
    <>
      <header>
        <strong>Your first editor</strong>
        <nav>
          <a href="/">Plain TypeScript</a> · <b>React</b>
        </nav>
        <span className="status">{status}</span>
      </header>
      {/* ── Step 2. Add a toolbar ── */}
      <Toolbar editor={editor} />
      <div ref={containerRef} className="editor" style={{ height: "70vh" }} />
    </>
  );
}
