/**
 * Minimal @cypherkit/editor host.
 *
 * Framework-agnostic — no React. Built on the convenience `createEditor()`
 * facade, which parses Markdown and mounts the canvas editor in a single call.
 * We then:
 *   1. wire a tiny toolbar to the editor's imperative commands,
 *   2. round-trip to Markdown with getMarkdown() / setMarkdown(),
 *   3. auto-save a draft with on("change") + getMarkdown().
 *
 * See the README for a short walkthrough of each step.
 */
import { createEditor } from "@cypherkit/editor";

import { loadFonts } from "./fonts";

const DRAFT_KEY = "cypher-minimal-draft";

const INITIAL_MARKDOWN = `# Welcome to Cypher

This is a **canvas-rendered** block editor — every glyph you see is painted onto
an HTML5 \`<canvas>\`, not laid out by the DOM.

Try it:

- type here, and use **⌘B / Ctrl+B** to bold a selection
- press **/** on an empty line to open the slash menu
- hit **⌘Z / Ctrl+Z** to undo (it's CRDT-aware undo, not a text diff)

> The whole engine is headless: it knows nothing about React, your fonts, or
> where your assets live. The host wires those in.
`;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

async function main() {
  // 1. Fonts first — the canvas can't measure text until faces are ready.
  await loadFonts();

  // 2. Parse Markdown + mount the editor in one call. Restore a saved draft if
  //    there is one, else start from the welcome text. `autofocus` drops a caret
  //    in so typing works immediately.
  const editor = createEditor({
    element: byId<HTMLDivElement>("editor"),
    value: localStorage.getItem(DRAFT_KEY) ?? INITIAL_MARKDOWN,
    pageId: "minimal-demo",
    padding: { paddingTop: 32, paddingBottom: 120, paddingLeft: 8, paddingRight: 8 },
    autofocus: true,
  });

  // 3. Toolbar. Each button maps to one imperative command. We preventDefault on
  //    mousedown so clicking a button doesn't blur the canvas and collapse the
  //    current text selection.
  const keepFocus = (el: HTMLElement, run: () => void) => {
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => {
      run();
      editor.refocus();
    });
  };

  keepFocus(byId("undo"), () => editor.undo());
  keepFocus(byId("redo"), () => editor.redo());
  // setMarkdown() replaces the whole document — and it's a single undoable step,
  // so ⌘Z / the Undo button brings the content right back.
  keepFocus(byId("clear"), () => editor.setMarkdown(""));
  // getMarkdown() serializes the live document back to Markdown.
  keepFocus(byId("save"), () => {
    console.log("--- serialized markdown ---\n" + editor.getMarkdown());
  });

  // 4. Auto-save a draft on every content change — the canonical createEditor
  //    pattern: on("change") + getMarkdown().
  editor.on("change", () => {
    localStorage.setItem(DRAFT_KEY, editor.getMarkdown());
  });

  // Tear down on hot-reload / navigation so we don't leak listeners or canvases.
  // createEditor's destroy() does the full teardown (layers, listeners, portal).
  if (import.meta.hot) {
    import.meta.hot.dispose(() => editor.destroy());
  }
}

void main();
