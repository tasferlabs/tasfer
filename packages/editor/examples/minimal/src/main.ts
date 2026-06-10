/**
 * Minimal @cypherkit/editor host.
 *
 * Framework-agnostic — no React. Built on the convenience `createEditor()`
 * facade, which parses Markdown and mounts the canvas editor in a single call.
 * It exercises the real public API:
 *   - Tier A: getMarkdown() / setMarkdown(), on("change"/"selectionchange")
 *   - Tier B: editor.commands.*, editor.chain()…run(), and the read-model
 *             helpers getActiveFormats() / isSelectionEmpty() / getWordCount()
 *
 * See the README for a short walkthrough.
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
    padding: {
      paddingTop: 32,
      paddingBottom: 120,
      paddingLeft: 8,
      paddingRight: 8,
    },
    autofocus: true,
  });

  // 3. Toolbar. Each button maps to one command. We preventDefault on mousedown
  //    so clicking a button doesn't blur the canvas and collapse the selection
  //    (so e.g. Bold applies to the text you have selected).
  const keepFocus = (id: string, run: () => void) => {
    const el = byId(id);
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => {
      run();
      editor.refocus();
    });
  };

  // Tier B — the commands namespace. Each returns whether it changed anything.
  keepFocus("bold", () => editor.commands.toggleMark("bold"));
  keepFocus("h1", () => editor.commands.setBlock("heading1"));
  keepFocus("bullet", () => editor.commands.setBlock("bullet_list"));
  keepFocus("undo", () => editor.commands.undo());
  keepFocus("redo", () => editor.commands.redo());

  // Tier B — chain(): set the block to a heading AND type its text as a single
  // undoable step (one ⌘Z reverts the whole thing, not just the text).
  keepFocus("section", () =>
    editor.chain().setBlock("heading2").insertText("New section").run(),
  );

  // setMarkdown() replaces the whole document — and it's a single undoable step,
  // so ⌘Z / the Undo button brings the content right back.
  keepFocus("clear", () => editor.setMarkdown(""));
  // getMarkdown() serializes the live document back to Markdown.
  keepFocus("save", () => {
    console.log("--- serialized markdown ---\n" + editor.getMarkdown());
  });

  // 4. Live read-model. Reflect word count, selection state, and the active
  //    inline formats in the status bar + light up the Bold button. These are
  //    pure functions of editor state — recompute on every change / caret move.
  const wordsEl = byId("status-words");
  const selectionEl = byId("status-selection");
  const formatsEl = byId("status-formats");
  const boldBtn = byId("bold");

  const paintStatus = () => {
    const words = editor.getWordCount();
    const formats = [...editor.getActiveFormats()];
    wordsEl.textContent = `${words} word${words === 1 ? "" : "s"}`;
    selectionEl.textContent = editor.isSelectionEmpty() ? "caret" : "selection";
    formatsEl.textContent = formats.length
      ? `formats: ${formats.join(", ")}`
      : "";
    boldBtn.classList.toggle(
      "is-active",
      editor.getActiveFormats().has("bold"),
    );
  };
  editor.on("change", paintStatus);
  editor.on("selectionchange", paintStatus);
  paintStatus();

  // 5. Auto-save a draft on every content change — the canonical createEditor
  //    pattern: on("change") + getMarkdown().
  editor.on("change", (state) => {
    localStorage.setItem(DRAFT_KEY, editor.getMarkdown());
  });

  // Tear down on hot-reload / navigation so we don't leak listeners or canvases.
  // createEditor's destroy() does the full teardown (layers, listeners, portal).
  if (import.meta.hot) {
    import.meta.hot.dispose(() => editor.destroy());
  }
}

void main();
