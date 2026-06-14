/**
 * @cypherkit/editor — custom inline marks example.
 *
 * Framework-agnostic, no React. The headline: define inline marks the editor
 * doesn't ship — a "highlight" and an "underline" — entirely in host code, and
 * have them render on the canvas, toggle by command, replicate through the
 * CRDT, and survive a reload. The two facets a custom mark needs (a DATA facet
 * and a RENDER facet) live in marks.ts; this file is the wiring.
 *
 * Two things to notice:
 *
 *   1. Both facets of each mark are declared in one `defineMark` call in
 *      marks.ts, and `extend()` folds them into the `schema` — so `createEditor`
 *      gets everything from `schema` alone, no separate `marks` option. A mark
 *      defined without a `render` would still replicate; it'd just paint as
 *      plain text.
 *
 *   2. Persistence is lossless via the CRDT: we save `doc.encodeState()` (the op
 *      log, not a Markdown flatten) and restore with `createDoc({ bytes })`, so
 *      a highlight you add comes back on reload. Markdown export DROPS custom
 *      marks today — there's no pluggable `==`-style delimiter yet — which is
 *      exactly why the CRDT, not Markdown, is the source of truth.
 */
import { createDoc, createEditor, type CypherEditor } from "@cypherkit/editor";

import { FONT_STYLES, loadFonts } from "./fonts";
import { schema } from "./marks";

const STORAGE_KEY = "cypher-marks-doc";
const PAGE_ID = "marks-demo";

// The lead paragraph we seed with a highlight + underline on first run so the
// demo opens "alive". It's a PLAIN paragraph (no inline markdown), so its
// on-canvas text equals this exact string — which lets us compute mark offsets
// from it with `indexOf` in seedDemoMarks(), below.
const DEMO_LINE =
  "Select any words, then click Highlight or Underline — custom marks render on the canvas, replicate through the CRDT, and survive a reload.";

const INITIAL_MARKDOWN = `# Custom inline marks

${DEMO_LINE}

The **Highlight** and **Underline** buttons above are *not* built in — they're
inline marks defined in host code (see \`marks.ts\`) and toggled with
\`editor.change((c) => c.toggleMark("highlight" | "underline"))\`. **⌘B / Ctrl+B** still
bolds, and marks stack: a word can be bold, highlighted, and underlined at once.

> Reload the page — your highlights come back. They live in the CRDT op log
> (\`doc.encodeState()\`), not in the Markdown.
`;

/** encodeState() returns UTF-8 JSON bytes; store/restore as a plain string. */
const bytesToString = (b: Uint8Array) => new TextDecoder().decode(b);
const stringToBytes = (s: string) => new TextEncoder().encode(s);

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

/**
 * First-run seeding: mark two words in the lead paragraph so the demo isn't
 * blank on open. `replaceInlineRange(blockId, start, end, text, mark)` re-inserts
 * a slice of text carrying a mark — here we replace each word with itself plus
 * the mark, so nothing visibly changes but the run gets marked. (Custom marks
 * can't be written in the INITIAL_MARKDOWN — there's no delimiter for them — so
 * this is how you apply one programmatically.)
 *
 * We authored INITIAL_MARKDOWN, so the block layout is known: block 0 is the H1,
 * block 1 is the DEMO_LINE paragraph. Skipped when restoring saved state, so we
 * never clobber the user's own edits.
 */
function seedDemoMarks(editor: CypherEditor): void {
  const demoBlock = editor.doc.getBlocks()[1];
  if (!demoBlock) return;
  const mark = (word: string, type: string) => {
    const start = DEMO_LINE.indexOf(word);
    if (start === -1) return;
    // Same text in, same length out, so offsets stay valid across both calls.
    editor.change((c) =>
      c.replaceInlineRange(demoBlock.id, start, start + word.length, word, {
        type,
      }),
    );
  };
  mark("Highlight", "highlight");
  mark("Underline", "underline");
}

async function main() {
  // 1. Fonts first — the canvas can't measure text until faces are ready.
  await loadFonts();

  // 2. Build the source-of-truth Doc. Restore the saved CRDT state losslessly if
  //    we have it, else parse the welcome Markdown. The Doc carries the DATA half
  //    of our schema (`schema.data`) so it understands the `highlight`/`underline`
  //    formats it's replicating.
  const saved = localStorage.getItem(STORAGE_KEY);
  const doc = saved
    ? createDoc({ bytes: stringToBytes(saved), schema: schema.data })
    : createDoc({
        markdown: INITIAL_MARKDOWN,
        pageId: PAGE_ID,
        schema: schema.data,
      });

  // 3. Mount the editor over the Doc. `schema` supplies everything: the data
  //    half, the built-in nodes, and the render facet for our two custom marks
  //    (folded in by `extend()`) — no separate `marks` option needed.
  const editor = createEditor({
    element: byId<HTMLDivElement>("editor"),
    doc,
    schema,
    // Per-instance theme: our font registry plus a little page padding.
    theme: {
      fonts: FONT_STYLES,
      styles: {
        canvas: {
          paddingTop: 32,
          paddingBottom: 120,
          paddingLeft: 8,
          paddingRight: 8,
        },
      },
    },
    autofocus: true,
  });

  // 4. First run only: drop a highlight + underline into the lead paragraph.
  if (!saved) seedDemoMarks(editor);

  // 5. Toolbar. Each button maps to one command. We preventDefault on mousedown
  //    so clicking a button doesn't blur the canvas and collapse the selection
  //    (so the mark applies to the text you have selected), then refocus after.
  const keepFocus = (id: string, run: () => void) => {
    const el = byId(id);
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => {
      run();
      editor.refocus();
    });
  };

  // Built-in and custom marks go through the SAME command — `toggleMark(name)`
  // works for any togglable mark on the editor's registry, built-in or not.
  keepFocus("bold", () => editor.change((c) => c.toggleMark("strong")));
  keepFocus("highlight", () => editor.change((c) => c.toggleMark("highlight")));
  keepFocus("underline", () => editor.change((c) => c.toggleMark("underline")));
  keepFocus("undo", () => editor.undo());
  keepFocus("redo", () => editor.redo());
  // Prove the point about Markdown: getMarkdown() round-trips the built-in marks
  // but drops the custom ones (no delimiter for them yet). The CRDT keeps them.
  keepFocus("save", () => {
    console.log(
      "--- getMarkdown() ---\n" +
        editor.getMarkdown() +
        "\n\n(note) custom marks aren't in the Markdown — there's no pluggable " +
        "delimiter yet.\nThey persist in the CRDT instead (doc.encodeState()).",
    );
  });
  // Forget the persisted state and reload from the welcome content (re-seeds).
  byId("reset").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });

  // 6. Persist on every change — the full CRDT state, not a Markdown flatten —
  //    so custom marks (and undo history, and CRDT identity) survive a reload.
  doc.on("update", () => {
    localStorage.setItem(STORAGE_KEY, bytesToString(doc.encodeState()));
  });

  // 7. Live read-model. Reflect word count, selection state, and the active
  //    inline marks in the status bar, and light up a button when its mark is
  //    on. These are pure functions of editor state — recompute on every change
  //    / caret move. getActiveMarks() reports custom marks just like built-ins.
  const wordsEl = byId("status-words");
  const selectionEl = byId("status-selection");
  const formatsEl = byId("status-formats");
  const countWords = (md: string) =>
    md.trim() ? md.trim().split(/\s+/).length : 0;

  const paintStatus = () => {
    const marks = editor.getActiveMarks();
    const words = countWords(editor.getMarkdown());
    wordsEl.textContent = `${words} word${words === 1 ? "" : "s"}`;
    selectionEl.textContent = editor.isSelectionEmpty() ? "caret" : "selection";
    formatsEl.textContent = marks.size ? `marks: ${[...marks].join(", ")}` : "";
    for (const [id, name] of [
      ["bold", "strong"],
      ["highlight", "highlight"],
      ["underline", "underline"],
    ] as const) {
      byId(id).classList.toggle("is-active", marks.has(name));
    }
  };
  editor.on("change", paintStatus);
  editor.on("selectionchange", paintStatus);
  paintStatus();

  // Tear down on hot-reload / navigation so we don't leak listeners or canvases.
  // The Doc is ours (we created it, not the editor), so we destroy it too.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      editor.destroy();
      doc.destroy();
    });
  }
}

void main();
