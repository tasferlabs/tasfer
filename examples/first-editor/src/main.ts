// The plain TypeScript code from the "Your first editor" tutorial, steps 1 to 4,
// copied as written in apps/site/src/views/DocsPage/pages/editor/first-editor.mdx.
// The only difference: `relay` points at the local relay from vite.config.ts.

// ── Step 1. Mount the editor ────────────────────────────────────────────────
import { createEditor } from "@tasfer/editor";

// <div id="editor" style="height: 70vh"></div>
const editor = createEditor({
  element: document.querySelector("#editor")!,
  markdown: "# My notes\n\nWrite something.",
  placeholder: "Start writing…",
  autofocus: true,
});

// ── Step 2. Add a toolbar ───────────────────────────────────────────────────
const toolbar = document.querySelector("#toolbar")!;

const buttons = ([
  { label: "B", mark: "strong" },
  { label: "i", mark: "emphasis" },
  { label: "</>", mark: "code" },
] as const).map((b) => {
  const el = document.createElement("button");
  el.textContent = b.label;
  el.onclick = () => editor.change((c) => c.setMark(b.mark));
  toolbar.append(el);
  return { ...b, el };
});

function paint() {
  const active = editor.state.activeMarks;
  for (const b of buttons) {
    b.el.classList.toggle("is-active", active.has(b.mark));
  }
}
editor.on("change", paint);
editor.on("selectionchange", paint);
paint();

// ── Step 3. Save locally ────────────────────────────────────────────────────
// load
const saved = localStorage.getItem("draft");
if (saved) editor.setMarkdown(saved);

// save; `change` fires on every edit, so debounce this if it is too much
editor.on("change", (tx) => {
  if (tx.isRemote) return;
  localStorage.setItem("draft", editor.getMarkdown());
});

// ── Step 4. Edit together ───────────────────────────────────────────────────
import { createRelayProvider } from "@tasfer/provider-relay";

const status = document.querySelector("#status")!;

const provider = createRelayProvider({
  doc: editor.doc,                      // this editor's document
  room: "my-notes-demo",                // same room, same document
  relay: `ws://${location.host}/relay`, // docs: "wss://relay.tasfer.app"
  secret: "change-me-before-you-ship",  // room password; never give it to the relay
});

// connection status comes from the provider, not the editor
provider.on("sync", (s) => {
  status.textContent = s.connected ? `live · ${s.peers} peer(s)` : "offline";
});
