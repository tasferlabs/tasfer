/**
 * @cypherkit/editor — collaboration + extensibility example.
 *
 * Framework-agnostic, no React. It exercises the two new headline APIs:
 *
 *   1. Doc — the CRDT document as a first-class object, independent of any
 *      editor. We build TWO editors over TWO Docs and wire their Docs together
 *      like a transport: edits in either pane flow through `doc.on("update")`
 *      into the other via `doc.applyUpdate(ops)`, and converge. This is exactly
 *      the loopback a real WebRTC/WebSocket provider would do — the editors
 *      never talk to each other directly, only their Docs do.
 *
 *   2. Schema — a custom `callout` block type (see schema.ts), declared in host
 *      code with `defineNode` + `baseSchema.extend`. It parses from Markdown,
 *      replicates through the CRDT, renders as a styled box, and round-trips
 *      back to `<x-callout … />` — across BOTH panes.
 *
 * Persistence is lossless: we save `docA.encodeState()` (the full op log +
 * version vector, not a Markdown flattening) and restore with `createDoc(bytes)`
 * — so undo history and CRDT identity survive a reload.
 */
import { createDoc, createEditor } from "@cypherkit/editor";

import { FONT_STYLES, loadFonts } from "./fonts";
import { schema } from "./schema";

const STORAGE_KEY = "cypher-collab-doc";
const PAGE_ID = "collab-demo";

const INITIAL_MARKDOWN = `# Two editors, one document

Type in **either** pane — edits sync through the CRDT \`Doc\` and converge.
Use **⌘B / Ctrl+B** to bold, **⌘Z** to undo (CRDT-aware, not a text diff).

<x-callout tone="tip" />

The box above is a **custom block type** defined in host code. It replicates and
round-trips to Markdown as \`<x-callout … />\` — try **Log .md** below.

<x-callout tone="warn" />
`;

/** encodeState() returns UTF-8 JSON bytes; store/restore as a plain string. */
const bytesToString = (b: Uint8Array) => new TextDecoder().decode(b);
const stringToBytes = (s: string) => new TextEncoder().encode(s);

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

async function main() {
  // 1. Fonts first — the canvas can't measure text until faces are ready.
  await loadFonts();

  // 2. Build the source-of-truth Doc. Restore the saved state losslessly if we
  //    have it, else parse the welcome Markdown. The Doc carries the DATA half
  //    of our schema (`schema.data`) so its reducer validates the callout's
  //    `tone` field and its Markdown projection knows the `<x-callout>` codec.
  const saved = localStorage.getItem(STORAGE_KEY);
  const docA = saved
    ? createDoc({ bytes: stringToBytes(saved), schema: schema.data })
    : createDoc({
        markdown: INITIAL_MARKDOWN,
        pageId: PAGE_ID,
        schema: schema.data,
      });

  // A SECOND replica of the same page. Seeding it from docA's encoded state
  // gives it identical history (so the two converge), its own peer identity
  // (so its local ops are distinct), and the same schema.
  const docB = createDoc({ bytes: docA.encodeState(), schema: schema.data });

  // 3. The "transport": cross-wire the two Docs. Forward every update you
  //    didn't cause, tagging inbound applies with a wire origin so the origin
  //    guard + version-vector dedup stop the echo — no infinite ping-pong.
  const WIRE_A_TO_B = "wire:a→b";
  const WIRE_B_TO_A = "wire:b→a";
  docA.on("update", (u) => {
    if (u.origin !== WIRE_B_TO_A) docB.applyUpdate(u.ops, WIRE_A_TO_B);
  });
  docB.on("update", (u) => {
    if (u.origin !== WIRE_A_TO_B) docA.applyUpdate(u.ops, WIRE_B_TO_A);
  });

  // 4. Mount one editor per Doc. Passing `doc` makes the editor a VIEW over it:
  //    local edits flow into the Doc, and updates applied to the Doc from
  //    elsewhere (the wire) flow back into the editor. We still pass `schema`
  //    so the custom callout node renders.
  // Per-instance theme: same font registry + page padding for both editors.
  // Because the theme is per instance (no globals), you could give A and B
  // different `tokens`/`fonts` here and they would not clobber each other.
  const theme = {
    fonts: FONT_STYLES,
    styles: {
      canvas: {
        paddingTop: 28,
        paddingBottom: 80,
        paddingLeft: 28,
        paddingRight: 12,
      },
    },
  };
  const editorA = createEditor({
    element: byId<HTMLDivElement>("editorA"),
    doc: docA,
    schema,
    theme,
    autofocus: true,
  });

  const editorB = createEditor({
    element: byId<HTMLDivElement>("editorB"),
    doc: docB,
    schema,
    theme,
  });

  // 5. Toolbar drives editor A (whatever you do there syncs to B). preventDefault
  //    on mousedown so clicking a button doesn't blur the canvas / drop the
  //    selection, then refocus after.
  const keepFocus = (id: string, run: () => void) => {
    const el = byId(id);
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => {
      run();
      editorA.refocus();
    });
  };

  keepFocus("bold", () => editorA.change((c) => c.toggleMark("strong")));
  keepFocus("h1", () => editorA.change((c) => c.setBlock("heading1")));
  keepFocus("bullet", () => editorA.change((c) => c.setBlock("bullet_list")));
  keepFocus("undo", () => editorA.undo());
  keepFocus("redo", () => editorA.redo());
  // Prove the custom block round-trips: its `<x-callout … />` tag is right there
  // in the serialized Markdown.
  keepFocus("save", () => {
    console.log("--- editor A markdown ---\n" + editorA.getMarkdown());
  });
  // Forget the persisted state and reload from the welcome content.
  byId("reset").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });

  // 6. Persist on every change — the full CRDT state, not a Markdown flatten.
  //    docA sees everything (B's edits arrive over the wire), so saving A is
  //    enough to capture the whole shared document.
  docA.on("update", () => {
    localStorage.setItem(STORAGE_KEY, bytesToString(docA.encodeState()));
  });

  // 7. Live read-model. Word counts + op-log sizes make convergence tangible:
  //    both Docs' operation counts climb in lockstep as edits replicate.
  //    Word count is a consumer concern — the editor ships no counter, so we
  //    derive it from each peer's serialized Markdown.
  const boldBtn = byId("bold");
  const countWords = (md: string) =>
    md.trim() ? md.trim().split(/\s+/).length : 0;
  const paintStatus = () => {
    const wordsA = countWords(editorA.getMarkdown());
    const wordsB = countWords(editorB.getMarkdown());
    byId("status-a").textContent =
      `Peer A — ${wordsA} words · ${docA.getOperations().length} ops`;
    byId("status-b").textContent =
      `Peer B — ${wordsB} words · ${docB.getOperations().length} ops`;
    byId("status-sync").textContent =
      editorA.getMarkdown() === editorB.getMarkdown()
        ? "✓ converged"
        : "… syncing";
    boldBtn.classList.toggle(
      "is-active",
      editorA.getActiveMarks().has("strong"),
    );
  };
  // Repaint whenever either Doc advances or the caret moves.
  docA.on("update", paintStatus);
  docB.on("update", paintStatus);
  editorA.on("selectionchange", paintStatus);
  paintStatus();

  // Tear down on hot-reload / navigation so we don't leak listeners or canvases.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      editorA.destroy();
      editorB.destroy();
      docA.destroy();
      docB.destroy();
    });
  }
}

void main();
