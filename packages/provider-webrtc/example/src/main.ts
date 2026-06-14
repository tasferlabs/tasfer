/**
 * @cypherkit/provider — two replicas, one document, synced by a provider.
 *
 * The editor's `collab` example hand-wires two Docs together to fake a
 * transport. This example does the real thing: each Doc gets its own
 * `Provider`, and the provider moves CRDT ops between them — version-vector
 * catch-up on connect, op streaming on every edit. The two editors never talk
 * to each other; only their providers do.
 *
 *   • Replica A parses the welcome Markdown (it is the source of truth).
 *   • Replica B starts EMPTY and catches up entirely over the provider —
 *     proving the catch-up handshake, not a pre-seeded copy.
 *   • Edit either pane, or open a second browser tab: every replica converges.
 *
 * TRANSPORT picks the pipe. Both run the identical protocol from
 * `@cypherkit/provider-core`:
 *
 *   "broadcast" — BroadcastChannel. Zero infrastructure; syncs across panes and
 *                 tabs on this origin. The default, so the demo just works.
 *   "webrtc"    — real peer-to-peer over `@cypherkit/provider-webrtc`. Set
 *                 SIGNALING_URL to a running signaling server (apps/live).
 */
import { createDoc, createEditor, type Doc } from "@cypherkit/editor";
import {
  createBroadcastChannelTransport,
  createProvider,
  type Provider,
} from "@cypherkit/provider-core";
import { createWebrtcProvider } from "@cypherkit/provider-webrtc";

import { FONT_STYLES, loadFonts } from "./fonts";

// ── Configuration ────────────────────────────────────────────────────────────
const TRANSPORT: "broadcast" | "webrtc" = "broadcast";
const ROOM = "cypher-provider-demo";
const SIGNALING_URL = "wss://your-signaling-server.example.com"; // webrtc only
const STORAGE_KEY = "cypher-provider-doc";
const PAGE_ID = "provider-demo";

const INITIAL_MARKDOWN = `# Two replicas, one document

Replica B started **empty** — everything you see in it arrived over the
provider's catch-up handshake. Type in **either** pane and watch them converge.

Use **⌘B / Ctrl+B** to bold, **⌘Z** to undo (CRDT-aware, not a text diff).
Open this page in a **second tab** to add more replicas to the room.
`;

const bytesToString = (b: Uint8Array) => new TextDecoder().decode(b);
const stringToBytes = (s: string) => new TextEncoder().encode(s);

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

/** Build a provider over the configured transport. Same protocol either way. */
function makeProvider(doc: Doc): Provider {
  if (TRANSPORT === "webrtc") {
    return createWebrtcProvider({ doc, room: ROOM, signaling: SIGNALING_URL });
  }
  return createProvider({
    doc,
    transport: createBroadcastChannelTransport(ROOM, doc.peerId),
  });
}

async function main() {
  await loadFonts();

  // Replica A is the source of truth: restore the saved CRDT state losslessly,
  // else parse the welcome Markdown.
  const saved = localStorage.getItem(STORAGE_KEY);
  const docA = saved
    ? createDoc({ bytes: stringToBytes(saved), pageId: PAGE_ID })
    : createDoc({ markdown: INITIAL_MARKDOWN, pageId: PAGE_ID });

  // Replica B starts truly empty (`ops: []` ⇒ no starter paragraph) and is
  // filled entirely by sync. Same pageId so A's ops land on B's page.
  const docB = createDoc({ ops: [], pageId: PAGE_ID });

  // One provider per replica. They discover each other in ROOM and converge —
  // no direct Doc↔Doc wiring like the editor's collab example needed.
  const providerA = makeProvider(docA);
  const providerB = makeProvider(docB);

  // Ephemeral presence — published alongside the document, never persisted.
  providerA.presence.set({ name: "Replica A", color: "#1db984" });
  providerB.presence.set({ name: "Replica B", color: "#f0883e" });

  const theme = {
    fonts: FONT_STYLES,
    styles: {
      canvas: { paddingTop: 28, paddingBottom: 80, paddingLeft: 28, paddingRight: 12 },
    },
  };
  const editorA = createEditor({ element: byId("editorA"), doc: docA, theme, autofocus: true });
  const editorB = createEditor({ element: byId("editorB"), doc: docB, theme });

  // Toolbar drives editor A; its edits replicate to B (and any other tabs).
  const keepFocus = (id: string, run: () => void) => {
    const el = byId(id);
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => {
      run();
      editorA.refocus();
    });
  };
  keepFocus("bold", () => editorA.commands.toggleMark("strong"));
  keepFocus("h1", () => editorA.commands.setBlock("heading1"));
  keepFocus("bullet", () => editorA.commands.setBlock("bullet_list"));
  keepFocus("undo", () => editorA.commands.undo());
  keepFocus("redo", () => editorA.commands.redo());
  byId("reset").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });

  // Persist the full CRDT state of A on every change (A sees everything, since
  // B's edits replicate back to it over the provider).
  docA.on("update", () => {
    localStorage.setItem(STORAGE_KEY, bytesToString(docA.encodeState()));
  });

  // ── Live read-model ────────────────────────────────────────────────────────
  const boldBtn = byId("bold");
  const countWords = (md: string) => (md.trim() ? md.trim().split(/\s+/).length : 0);
  const paintStatus = () => {
    byId("status-a").textContent =
      `Replica A — ${countWords(editorA.getMarkdown())} words · ${docA.getOperations().length} ops`;
    byId("status-b").textContent =
      `Replica B — ${countWords(editorB.getMarkdown())} words · ${docB.getOperations().length} ops`;
    byId("status-sync").textContent =
      editorA.getMarkdown() === editorB.getMarkdown() ? "✓ converged" : "… syncing";
    boldBtn.classList.toggle("is-active", editorA.getActiveMarks().has("strong"));
  };

  // Provider connectivity → status line.
  const paintNet = (peers: number) => {
    byId("status-net").textContent =
      peers > 0 ? `${TRANSPORT} · ${peers} peer(s)` : `${TRANSPORT} · offline`;
  };
  providerA.on("sync", (s) => paintNet(s.peers));

  docA.on("update", paintStatus);
  docB.on("update", paintStatus);
  editorA.on("selectionchange", paintStatus);
  paintStatus();
  paintNet(providerA.getPeerIds().length);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      providerA.destroy();
      providerB.destroy();
      editorA.destroy();
      editorB.destroy();
      docA.destroy();
      docB.destroy();
    });
  }
}

void main();
