/* @cypherkit/editor guide pages — ported from docs-editor.jsx. */
import { Icons } from "../docsIcons";
import {
  A,
  Callout,
  Card,
  CardGrid,
  Code,
  InstallTabs,
  LicenseCard,
  PropsTable,
  Step,
  Steps,
} from "../docsComponents";

export function EditorInstall() {
  return (
    <>
      <p className="dx-lede">
        <code>@cypherkit/editor</code> is a CRDT-first canvas editor for the web —
        the same engine that powers the Cypher app, extracted as a standalone,
        framework-agnostic package. <strong>It renders to a canvas, models your
        document as a conflict-free replicated data type, and never assumes a
        server exists.</strong>
      </p>

      <LicenseCard>
        Released under the <strong>MIT license</strong>. Use it in commercial and
        closed-source products, fork it, rebrand it — no copyleft, no attribution
        clause beyond keeping the license file. (The Cypher <em>app</em> is GPL-3.0;
        the editor package is deliberately permissive.)
      </LicenseCard>

      <h2 id="install">Install</h2>
      <p>Add the package with your package manager of choice:</p>
      <InstallTabs pkg="@cypherkit/editor" />

      <p>
        The core package has <strong>zero runtime dependencies</strong>. The CRDT,
        the canvas renderer, and the markdown serializer all ship inside it. You
        only add more packages when you want a framework binding or a network
        provider:
      </p>
      <InstallTabs pkg="@cypherkit/react @cypherkit/provider-relay" />

      <h2 id="requirements">Requirements</h2>
      <ul>
        <li><strong>A browser with <code>OffscreenCanvas</code> and <code>ResizeObserver</code></strong> — every evergreen browser since 2021. There is no DOM-contenteditable fallback by design; the canvas <em>is</em> the editor.</li>
        <li><strong>ES2020 or a bundler that targets it.</strong> The package ships ESM with a CommonJS interop entry. Types are bundled — no <code>@types</code> install.</li>
        <li><strong>No build step required for the CRDT.</strong> WASM is inlined and lazy-decoded; nothing to copy into your <code>public/</code> folder.</li>
      </ul>

      <h2 id="first">A thirty-second editor</h2>
      <p>
        Mount an editor into any element. This is the smallest thing that works —
        an editable document with markdown shortcuts, history, and a blinking
        cursor:
      </p>
      <Code file="main.ts" lang="ts" code={`
import { createEditor } from "@cypherkit/editor";
import "@cypherkit/editor/theme.css";

const editor = createEditor({
  element: document.querySelector("#editor")!,
  value: "# Hello\\n\\nStart typing — *markdown* shortcuts just work.",
  autofocus: true,
});

// Read it back at any time, as plain markdown:
editor.on("change", () => {
  localStorage.setItem("draft", editor.getMarkdown());
});
`} />

      <Callout kind="tip" title="That document is already a CRDT.">
        Even with no provider attached, the editor's value is backed by a
        replicated data structure. Wiring up sync later is additive — you never
        rewrite your document model to "make it collaborative."
      </Callout>

      <h2 id="next">Where to go next</h2>
      <CardGrid>
        <Card to="editor/quickstart" icon={<Icons.Bolt />} title="Quick start"
          desc="The full mental model in five minutes — value, state, commands, and events." />
        <Card to="editor/concepts" icon={<Icons.Layers />} title="Core concepts"
          desc="Why CRDT-first changes how you think about an editor's document." />
        <Card to="editor/first-editor" icon={<Icons.Compass />} title="Your first editor"
          desc="A guided tutorial: toolbar, persistence, and live collaboration." />
        <Card to="editor/api-editor" icon={<Icons.Braces />} title="Editor API"
          desc="Every option, method, and event on the Editor instance." />
      </CardGrid>
    </>
  );
}

export function EditorQuickstart() {
  return (
    <>
      <p className="dx-lede">
        Four things make up the whole surface area: the <strong>value</strong> you
        put in, the <strong>state</strong> you read out, the <strong>commands</strong>
        you dispatch, and the <strong>events</strong> you listen to. Learn these and
        you know the editor.
      </p>

      <h2 id="value">1 — Value in</h2>
      <p>
        An editor is created from markdown, a CRDT document, or nothing at all.
        These three are equivalent starting points:
      </p>
      <Code lang="ts" code={`
import { createEditor, createDoc } from "@cypherkit/editor";

// from a markdown string
createEditor({ element, value: "# Title" });

// from an existing CRDT document (e.g. restored from disk)
const doc = createDoc(savedBytes);
createEditor({ element, doc });

// empty
createEditor({ element });
`} />

      <h2 id="state">2 — State out</h2>
      <p>
        <code>editor.state</code> is an immutable snapshot. Read it whenever you
        need to know what is selected, what marks are active, or render your own
        UI from it. It never changes underneath you — each edit produces a new
        snapshot.
      </p>
      <Code lang="ts" code={`
const { selection, activeMarks, doc } = editor.state;

selection.empty;              // true when it's just a caret
activeMarks.has("strong");    // is bold active at the cursor?
doc.wordCount;                // derived, memoised
`} />

      <h2 id="commands">3 — Commands</h2>
      <p>
        You never mutate the document directly. You dispatch commands, which are
        transactional: they either apply cleanly to the CRDT or no-op. Commands
        are chainable and return whether they ran.
      </p>
      <Code lang="ts" code={`
editor.commands.toggleMark("strong");
editor.commands.setBlock("heading", { level: 2 });

// chain several into one undo step
editor.chain()
  .selectParagraph()
  .toggleMark("emphasis")
  .insertText(" ✶")
  .run();
`} />

      <h2 id="events">4 — Events</h2>
      <p>Subscribe to what the editor does. Every listener returns an unsubscribe function.</p>
      <PropsTable cols={["Event", "Fires when", "Payload"]} rows={[
        { name: "change", type: "Transaction", desc: "The document changed — typing, paste, a remote sync, an undo." },
        { name: "selectionchange", type: "Selection", desc: "The caret or selection moved, without a document edit." },
        { name: "focus / blur", type: "void", desc: "The canvas gained or lost focus." },
        { name: "sync", type: "SyncState", desc: "A provider connected, fell behind, or caught up. See Collaboration." },
      ]} />
      <Code lang="ts" code={`
const off = editor.on("change", (tx) => {
  if (tx.isRemote) return;          // ignore edits that came from a peer
  console.log("local edit:", tx.steps.length, "steps");
});
// later
off();
`} />
    </>
  );
}

export function EditorConcepts() {
  return (
    <>
      <p className="dx-lede">
        Most editors bolt collaboration on at the end and spend years fighting it.
        <code>@cypherkit/editor</code> is built the other way around:
        <strong> the document is a CRDT from the first keystroke</strong>, and
        single-player editing is just the case where there is one replica.
      </p>

      <h2 id="crdt">The document is a CRDT</h2>
      <p>
        A CRDT — conflict-free replicated data type — is a data structure that any
        number of replicas can edit independently and merge without a coordinating
        server and without conflicts. Two people can type in the same paragraph,
        offline, on opposite sides of the planet, and the merge is deterministic:
        every replica converges on the same result.
      </p>
      <p>
        In <code>@cypherkit/editor</code> that structure is not a feature you opt
        into. It is the canonical representation of your text. Reading markdown out
        is a <em>projection</em> of the CRDT; it is not where your data lives.
      </p>
      <Callout kind="note" title="No server in the model.">
        The CRDT does not know what a server is. Persistence, transport, and
        presence are all layered on top as optional providers. This is what lets
        the same editor run fully offline, peer-to-peer, or against your own
        backend without code changes.
      </Callout>

      <h2 id="canvas">Why a canvas, not contenteditable</h2>
      <p>
        Browser <code>contenteditable</code> is a thirty-year-old API that every
        editor team eventually wrestles to the ground. Cypher renders the document
        to a canvas instead and owns every pixel: layout, carets, selection,
        bidirectional text, and composition. That buys three things:
      </p>
      <ul>
        <li><strong>Deterministic layout.</strong> The same document renders identically across browsers — no contenteditable quirks, no <code>&lt;div&gt;</code>-vs-<code>&lt;p&gt;</code> surprises on Enter.</li>
        <li><strong>Real selection control.</strong> Multiple cursors, remote-peer carets, and rectangular selections are first-class, not hacks layered over DOM ranges.</li>
        <li><strong>Performance at length.</strong> Only visible lines are shaped and painted; a 200-page document scrolls like an empty one.</li>
      </ul>

      <h2 id="pieces">The pieces fit together like this</h2>
      <Code lang="text" code={`
  createDoc()        ── the CRDT: the source of truth
        │
        ▼
  createEditor()     ── view + commands + selection over the doc
        │
        ├── schema     what nodes & marks are allowed
        ├── plugins    keymaps, input rules, decorations
        ├── theme      canvas colors, fonts, metrics
        └── provider   (optional) transport that syncs the doc
`} />
      <p>
        You can hold a <code>Doc</code> with no editor (e.g. on a server, to render
        markdown), and you can hold an editor with no provider (single-player). The
        layers are independent on purpose.
      </p>
    </>
  );
}

export function EditorFirstEditor() {
  return (
    <>
      <p className="dx-lede">
        We'll build a real editor from scratch: a writing surface, a formatting
        toolbar wired to live state, local persistence, and — in the last step —
        two browser tabs editing the same document in real time. No framework
        required; plain TypeScript.
      </p>

      <Callout kind="note" title="Following along.">
        Every snippet below is cumulative. By the end you'll have one
        <code> main.ts</code> file under ~70 lines that does everything described.
      </Callout>

      <h2 id="mount">Step 1 — Mount the editor</h2>
      <Steps>
        <Step title="Create a host element">
          <p>The editor needs a block-level element to own. Give it a height — the canvas fills its container.</p>
          <Code file="index.html" lang="html" code={`
<div id="editor" style="height: 70vh"></div>
<div id="toolbar"></div>
`} />
        </Step>
        <Step title="Instantiate">
          <p>Import the engine and its base theme, then create the editor.</p>
          <Code file="main.ts" lang="ts" code={`
import { createEditor } from "@cypherkit/editor";
import "@cypherkit/editor/theme.css";

const editor = createEditor({
  element: document.querySelector("#editor")!,
  value: "# My notes\\n\\nWrite something.",
  placeholder: "Start writing…",
  autofocus: true,
});
`} />
        </Step>
      </Steps>

      <h2 id="toolbar">Step 2 — A toolbar that reflects state</h2>
      <p>
        The key idea: the toolbar is a <em>function of editor state</em>, never a
        place where you track formatting yourself. Read <code>activeMarks</code> to
        light up buttons, dispatch a command on click.
      </p>
      <Code file="main.ts" lang="ts" code={`
const toolbar = document.querySelector("#toolbar")!;

const buttons = [
  { label: "B", mark: "strong" },
  { label: "i", mark: "emphasis" },
  { label: "</>", mark: "code" },
];

for (const b of buttons) {
  const el = document.createElement("button");
  el.textContent = b.label;
  el.onclick = () => editor.commands.toggleMark(b.mark);
  toolbar.append(el);
  b.el = el;
}

// keep the active states in sync — runs on every edit & caret move
function paint() {
  const active = editor.state.activeMarks;
  for (const b of buttons) {
    b.el.classList.toggle("is-active", active.has(b.mark));
  }
}
editor.on("change", paint);
editor.on("selectionchange", paint);
paint();
`} />
      <Callout kind="tip" title="Markdown shortcuts are already on.">
        Type <code>**bold**</code>, <code>## </code> at the start of a line, or
        <code> &gt; </code> for a quote — the built-in input rules transform them as
        you type. Your toolbar and the shortcuts edit the same state.
      </Callout>

      <h2 id="persist">Step 3 — Persist locally</h2>
      <p>
        Save on change. Because the document is a CRDT, the most robust thing to
        persist is its binary update — but for a single device, markdown is fine
        and human-readable:
      </p>
      <Code file="main.ts" lang="ts" code={`
// restore on load
const saved = localStorage.getItem("draft");
if (saved) editor.setMarkdown(saved);

// save on change (debounced by the engine to once per animation frame)
editor.on("change", (tx) => {
  if (tx.isRemote) return;
  localStorage.setItem("draft", editor.getMarkdown());
});
`} />

      <h2 id="collab">Step 4 — Make it collaborative</h2>
      <p>
        Here's the payoff for being CRDT-first. To sync two replicas, you attach a
        provider — a transport that ships CRDT updates between peers. Nothing about
        the steps above changes. Open the page in two tabs and watch:
      </p>
      <Code file="main.ts" lang="ts" code={`
import { createRelayProvider } from "@cypherkit/provider-relay";

const provider = createRelayProvider({
  doc: editor.doc,                 // sync THIS editor's document
  room: "my-notes-demo",           // peers in the same room converge
  relay: "wss://relay.cypher.md",  // swap for your own; it forwards, can't read
});

editor.on("sync", (s) => {
  status.textContent = s.connected ? \`live · \${s.peers} peer(s)\` : "offline";
});
`} />
      <Callout kind="warn" title="The relay can't read your document.">
        Updates are encrypted end-to-end before they leave the tab; the relay
        forwards opaque bytes and keeps no log. This is the same relay model the
        Cypher app uses — see <A href="/docs/app/sync-relay">Sync &amp; relay setup</A>.
      </Callout>

      <h2 id="done">What you built</h2>
      <p>
        A canvas editor with markdown shortcuts, a state-driven toolbar, local
        persistence, and real-time collaboration — and step 4 was purely additive.
        That's the whole point of starting from a CRDT.
      </p>
      <CardGrid>
        <Card to="editor/collaboration" icon={<Icons.Users />} title="Realtime collaboration"
          desc="Providers, presence, remote cursors, and offline merge in depth." />
        <Card to="editor/custom-nodes" icon={<Icons.Puzzle />} title="Custom nodes & marks"
          desc="Teach the schema new block types — callouts, mentions, embeds." />
      </CardGrid>
    </>
  );
}

export function EditorCollaboration() {
  return (
    <>
      <p className="dx-lede">
        A provider connects your editor's CRDT to other replicas. Swap providers
        to change <em>how</em> peers reach each other — the document model and your
        UI stay identical.
      </p>

      <h2 id="providers">Choosing a provider</h2>
      <PropsTable cols={["Provider", "Transport", "Use it when"]} rows={[
        { name: "provider-relay", type: "WebSocket relay", desc: "Peers behind NATs/firewalls. The relay introduces peers and forwards encrypted updates it cannot read." },
        { name: "provider-webrtc", type: "Peer-to-peer", desc: "Direct browser-to-browser once introduced. Lowest latency; needs a small signaling step." },
        { name: "provider-indexeddb", type: "Local disk", desc: "Not a network provider — persists the CRDT to IndexedDB so reloads are instant and offline-complete." },
        { name: "custom", type: "Anything", desc: "Implement the Provider interface over your own backend, BroadcastChannel, or a file watcher." },
      ]} />

      <h2 id="stack">Stack them</h2>
      <p>
        Providers compose. A typical setup persists locally <em>and</em> syncs over
        the network — the editor merges all of them into one converging document:
      </p>
      <Code lang="ts" code={`
import { createIndexedDBProvider } from "@cypherkit/provider-indexeddb";
import { createRelayProvider } from "@cypherkit/provider-relay";

createIndexedDBProvider({ doc: editor.doc, name: "notes/today" });
const net = createRelayProvider({ doc: editor.doc, room: "team-notes" });
`} />

      <h2 id="presence">Presence & remote cursors</h2>
      <p>
        Presence is ephemeral state that travels alongside the document but is never
        persisted — who is here, where their cursor is, what color to draw them. The
        editor renders remote carets on the canvas for you once you publish presence.
      </p>
      <Code lang="ts" code={`
net.presence.set({ name: "Ada", color: "#1db984" });

// the editor draws remote carets automatically; subscribe for a UI list:
net.presence.on("change", (peers) => {
  avatars.render(peers.map((p) => p.name));
});
`} />
      <Callout kind="note" title="Offline is not a special case.">
        Disconnect, edit for an hour on a plane, reconnect — the CRDT merges your
        changes with everyone else's deterministically. There is no "resolve
        conflicts" dialog because there are no conflicts to resolve.
      </Callout>
    </>
  );
}

export function EditorCustomNodes() {
  return (
    <>
      <p className="dx-lede">
        The schema declares what your document is made of. Extend it to add new
        block types (<em>nodes</em>) and inline formatting (<em>marks</em>) — a
        callout block, an @-mention, a highlight.
      </p>

      <h2 id="mark">Define a mark</h2>
      <p>A mark is inline formatting that wraps a span of text. Here's a highlight:</p>
      <Code lang="ts" code={`
import { defineMark } from "@cypherkit/editor";

const highlight = defineMark("highlight", {
  // how it serialises to / from markdown
  toMarkdown: (text) => \`==\${text}==\`,
  parseMarkdown: /==([^=]+)==/,
  // how the canvas paints it
  render: { background: "rgba(29,185,132,0.22)" },
});
`} />

      <h2 id="node">Define a node</h2>
      <p>
        A node is a block. It declares whether it holds text, other blocks, or
        nothing, and how it draws. A callout that contains paragraphs:
      </p>
      <Code lang="ts" code={`
import { defineNode } from "@cypherkit/editor";

const callout = defineNode("callout", {
  group: "block",
  content: "block+",            // contains one or more blocks
  attrs: { tone: { default: "note" } },
  toMarkdown: (node, inner) => \`> [!\${node.attrs.tone}]\\n\` + inner,
  render: {
    padding: 16,
    borderLeft: { width: 2, color: "var(--accent)" },
  },
});
`} />

      <h2 id="register">Register them</h2>
      <Code lang="ts" code={`
import { createEditor, baseSchema } from "@cypherkit/editor";

const schema = baseSchema.extend({
  marks: { highlight },
  nodes: { callout },
});

const editor = createEditor({ element, schema });

// now commands exist for them:
editor.commands.toggleMark("highlight");
editor.commands.wrapIn("callout", { tone: "warn" });
`} />
      <Callout kind="tip" title="Schema changes are CRDT-safe.">
        Nodes and marks are addressed by name in the replicated structure, so a peer
        running the same schema merges your callouts cleanly. Ship schema changes to
        all peers together, the way you'd ship a database migration.
      </Callout>
    </>
  );
}

export function EditorTheming() {
  return (
    <>
      <p className="dx-lede">
        Because the editor paints its own pixels, theming is done through a token
        object — colors, fonts, and metrics — not CSS selectors into a DOM you
        don't control. The base <code>theme.css</code> wires those tokens to CSS
        custom properties so light/dark just works.
      </p>

      <h2 id="tokens">The theme object</h2>
      <Code lang="ts" code={`
import { createTheme } from "@cypherkit/editor";

const editorial = createTheme({
  fontFamily: '"Libre Baskerville", Georgia, serif',
  fontSize: 17,
  lineHeight: 1.7,
  color: {
    text: "#1c1c1f",
    heading: "#09090b",
    cursor: "#1db984",
    selection: "rgba(29,185,132,0.30)",
    link: "#1db984",
    codeBg: "#f4f4f5",
  },
});

createEditor({ element, theme: editorial });
`} />

      <h2 id="css-vars">Driving it from CSS variables</h2>
      <p>
        Pass <code>"inherit"</code> for any token and the editor reads the matching
        CSS custom property off its host element. This is how you get free dark mode:
        flip a class on <code>&lt;html&gt;</code> and the canvas repaints.
      </p>
      <Code lang="ts" code={`
const theme = createTheme({
  color: {
    text: "inherit",        // reads --cy-editor-text
    cursor: "inherit",      // reads --cy-editor-cursor
    selection: "inherit",   // reads --cy-editor-selection
  },
});
`} />
      <Callout kind="note" title="Matching the Cypher look.">
        The token names line up one-to-one with the <code>--cy-editor-*</code>
        variables in Cypher's design tokens, so dropping the editor into a Cypher
        surface needs no theme at all — it inherits.
      </Callout>

      <h2 id="metrics">Metrics</h2>
      <PropsTable cols={["Token", "Default", "Description"]} rows={[
        { name: "fontSize", type: "16", desc: "Base paragraph size in px. Headings scale from this." },
        { name: "lineHeight", type: "1.6", desc: "Unitless multiple applied to every line box." },
        { name: "maxWidth", type: "680", desc: "Measure of the text column in px; the canvas centers it." },
        { name: "padding", type: "[40, 40]", desc: "Vertical / horizontal canvas padding in px." },
      ]} />
    </>
  );
}
