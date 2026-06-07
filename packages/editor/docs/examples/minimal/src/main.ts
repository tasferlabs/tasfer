/**
 * Minimal @cypherkit/editor host.
 *
 * Everything here is framework-agnostic — no React. We:
 *   1. parse some Markdown into blocks,
 *   2. mount the canvas editor into a <div>,
 *   3. wire a tiny toolbar to the editor's imperative command API,
 *   4. serialize back to Markdown on demand.
 *
 * Read alongside docs/getting-started.md — the steps map 1:1.
 */
import { mountEditor } from "@cypherkit/editor";
// NOTE: the serialization folder is spelled "serlization" in the source tree.
import { loadPage } from "@cypherkit/editor/serlization/loadPage";
import { serializeToMarkdown } from "@cypherkit/editor/serlization/serializer";
import type { EditorState } from "@cypherkit/editor/state-types";

import { loadFonts } from "./fonts";

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

  // 2. Markdown -> blocks. `loadPage` always returns at least one block, so an
  //    empty string is a valid "blank document".
  const { blocks } = loadPage(INITIAL_MARKDOWN);

  // 3. Mount. The editor fills the container and watches it for resize.
  const container = byId<HTMLDivElement>("editor");
  const mounted = mountEditor(container, blocks, {
    pageId: "minimal-demo",
    padding: { paddingTop: 32, paddingBottom: 120, paddingLeft: 8, paddingRight: 8 },
  });
  const { editor } = mounted;

  // Focus the editor and drop a caret in so typing works immediately.
  mounted.refocus();
  editor.setInitialCursor();

  // 4. Toolbar. Each button maps to one imperative command on `editor`.
  //    We preventDefault on mousedown so clicking a button doesn't blur the
  //    canvas and collapse the current text selection.
  const keepFocus = (el: HTMLElement, run: () => void) => {
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => {
      run();
      mounted.refocus();
    });
  };

  keepFocus(byId("bold"), () => editor.toggleBold());
  keepFocus(byId("undo"), () => editor.undo());
  keepFocus(byId("redo"), () => editor.redo());
  keepFocus(byId("save"), () => {
    const state = editor.getState();
    if (!state) return;
    const md = serializeToMarkdown(state.document.page.blocks);
    console.log("--- serialized markdown ---\n" + md);
  });

  // 5. Observe state. `subscribe` fires on every change — content, selection,
  //    menus, focus. Here we just reflect the bold button's active state.
  const boldButton = byId("bold");
  editor.subscribe((state: EditorState) => {
    const isBold = state.ui.activeFormatsMode.type === "explicit"
      ? state.ui.activeFormatsMode.formats.some((f) => f.type === "bold")
      : false;
    boldButton.style.background = isBold ? "rgba(64,120,255,0.25)" : "transparent";
  });

  // Tear down on hot-reload / navigation so we don't leak listeners or canvases.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => mounted.destroy());
  }
}

void main();
