/* @cypherkit/editor API reference pages — ported from docs-editor-api.jsx. */
import { A, Callout, Code, PropsTable } from "../docsComponents";

export function EditorApiEditor() {
  return (
    <>
      <p className="dx-lede">
        <code>createEditor(options)</code> returns an <code>Editor</code> — the view,
        command dispatcher, and selection owner over a CRDT document. This is the
        object you'll hold onto for the lifetime of the editing surface.
      </p>

      <h2 id="create">createEditor(options)</h2>
      <Code lang="ts" code={`
import { createEditor } from "@cypherkit/editor";
const editor = createEditor(options: EditorOptions): Editor;
`} />
      <PropsTable rows={[
        { name: "element", type: "HTMLElement", required: true, desc: "The host element the canvas mounts into. Sized to fill it." },
        { name: "value", type: "string", desc: "Initial document as markdown. Ignored if doc is provided." },
        { name: "doc", type: "Doc", desc: "An existing CRDT document to edit. Takes precedence over value." },
        { name: "schema", type: "Schema", desc: "Allowed nodes & marks. Defaults to baseSchema (CommonMark + GFM)." },
        { name: "plugins", type: "Plugin[]", desc: "Keymaps, input rules, decorations. See the Plugins reference." },
        { name: "theme", type: "Theme", desc: "Canvas colors, fonts, metrics. Defaults to the inherit theme." },
        { name: "editable", type: "boolean", desc: "Set false for a read-only renderer. Default true." },
        { name: "placeholder", type: "string", desc: "Ghost text shown when the document is empty." },
        { name: "autofocus", type: "boolean", desc: "Focus the editor on mount. Default false." },
      ]} />

      <h2 id="methods">Instance methods</h2>
      <PropsTable cols={["Method", "Signature", "Description"]} rows={[
        { name: "getMarkdown", type: "() => string", desc: "Serialise the current document to markdown." },
        { name: "setMarkdown", type: "(md: string) => void", desc: "Replace the document. Recorded as one undoable transaction." },
        { name: "focus", type: "(at?: 'start'|'end') => void", desc: "Move focus to the canvas, optionally placing the caret." },
        { name: "blur", type: "() => void", desc: "Remove focus from the editor." },
        { name: "on", type: "(event, cb) => () => void", desc: "Subscribe to an event. Returns an unsubscribe function." },
        { name: "chain", type: "() => CommandChain", desc: "Begin a chain of commands committed as a single undo step." },
        { name: "destroy", type: "() => void", desc: "Tear down listeners, canvas, and providers attached via the editor." },
      ]} />

      <h2 id="props">Instance properties</h2>
      <PropsTable cols={["Property", "Type", "Description"]} rows={[
        { name: "state", type: "EditorState", desc: "Immutable snapshot: selection, activeMarks, doc. Replaced on every edit." },
        { name: "commands", type: "Commands", desc: "The command registry — call e.g. editor.commands.toggleMark('strong')." },
        { name: "doc", type: "Doc", desc: "The underlying CRDT document. Pass this to providers to sync." },
        { name: "view", type: "EditorView", desc: "Low-level canvas view. You rarely need it; escape hatch for custom rendering." },
      ]} />

      <Callout kind="note" title="state is a value, not a store.">
        <code>editor.state</code> is replaced — never mutated — on each
        transaction. Capture it in a variable only for the duration of one read;
        for live UI, recompute inside a <code>change</code> / <code>selectionchange</code>
        handler.
      </Callout>

      <h2 id="lifecycle">Lifecycle</h2>
      <Code lang="ts" code={`
const editor = createEditor({ element });

// ... use it ...

// always destroy when the surface unmounts, or you'll leak
// the canvas, the ResizeObserver, and any attached providers.
editor.destroy();
`} />
    </>
  );
}

export function EditorApiCommands() {
  return (
    <>
      <p className="dx-lede">
        Commands are the only way to change a document. Each is a transactional
        function that applies to the CRDT or no-ops, returning a boolean for whether
        it ran. They live on <code>editor.commands</code> and chain via
        <code> editor.chain()</code>.
      </p>

      <h2 id="builtins">Built-in commands</h2>
      <PropsTable cols={["Command", "Signature", "Description"]} rows={[
        { name: "toggleMark", type: "(name, attrs?) => boolean", desc: "Add or remove an inline mark across the selection." },
        { name: "setBlock", type: "(name, attrs?) => boolean", desc: "Turn the selected blocks into a node type (heading, paragraph…)." },
        { name: "wrapIn", type: "(name, attrs?) => boolean", desc: "Wrap the selection in a block — blockquote, callout, list." },
        { name: "insertText", type: "(text: string) => boolean", desc: "Insert text at the cursor, replacing any selection." },
        { name: "insertNode", type: "(name, attrs?) => boolean", desc: "Insert a leaf or block node (rule, image, embed)." },
        { name: "undo / redo", type: "() => boolean", desc: "Step through local history. Remote edits never enter your undo stack." },
        { name: "selectAll", type: "() => boolean", desc: "Select the whole document." },
      ]} />

      <h2 id="chaining">Chaining</h2>
      <p>
        A chain batches commands into one transaction — one network update, one undo
        step. The chain runs only if every command in it can apply:
      </p>
      <Code lang="ts" code={`
const ok = editor.chain()
  .setBlock("heading", { level: 1 })
  .insertText("Untitled")
  .run();              // commits everything, or nothing if any step fails

// dry-run: will this chain apply right now? (for enabling a toolbar button)
const canRun = editor.chain().wrapIn("callout").canRun();
`} />

      <h2 id="custom">Custom commands</h2>
      <p>
        A command receives the current state and a <code>dispatch</code>. Call
        <code> dispatch</code> with a transaction to apply; return <code>false</code>
        to signal it can't run (which keeps it out of a chain).
      </p>
      <Code lang="ts" code={`
import { defineCommand } from "@cypherkit/editor";

const clearFormatting = defineCommand((state, dispatch) => {
  if (state.selection.empty) return false;
  if (dispatch) {
    const tx = state.tr.removeMarks(state.selection.range);
    dispatch(tx);
  }
  return true;
});

editor.commands.register({ clearFormatting });
editor.commands.clearFormatting();
`} />
    </>
  );
}

export function EditorApiSchema() {
  return (
    <>
      <p className="dx-lede">
        A <code>Schema</code> is the grammar of a document: which nodes and marks
        exist, and how they may nest. The default <code>baseSchema</code> covers
        CommonMark plus GFM tables, task lists, and strikethrough.
      </p>

      <h2 id="base">baseSchema</h2>
      <PropsTable cols={["Node", "Content", "Markdown"]} rows={[
        { name: "doc", type: "block+", desc: "The root. Holds one or more blocks." },
        { name: "paragraph", type: "inline*", desc: "Plain text block." },
        { name: "heading", type: "inline*", desc: "Levels 1–6. attrs: { level }." },
        { name: "blockquote", type: "block+", desc: "> quoted blocks." },
        { name: "codeBlock", type: "text*", desc: "Fenced code. attrs: { lang }." },
        { name: "list / listItem", type: "listItem+ / block+", desc: "Ordered, bulleted, and task lists." },
        { name: "image / hr", type: "leaf", desc: "Leaf nodes with no children." },
      ]} />
      <p>Marks in the base schema: <code>strong</code>, <code>emphasis</code>, <code>code</code>, <code>strike</code>, <code>link</code>.</p>

      <h2 id="extend">Extending</h2>
      <Code lang="ts" code={`
const schema = baseSchema.extend({
  nodes: { callout, mention },
  marks: { highlight },
});
`} />
      <p>See <A href="/docs/editor/custom-nodes">Custom nodes &amp; marks</A> for the full <code>defineNode</code> / <code>defineMark</code> options.</p>

      <h2 id="content">Content expressions</h2>
      <p>A node's <code>content</code> is a small grammar, the same shape ProseMirror users will recognise:</p>
      <PropsTable cols={["Expression", "Means", ""]} rows={[
        { name: '"block+"', type: "one or more blocks", desc: "Used by doc and blockquote." },
        { name: '"inline*"', type: "zero or more inline", desc: "Used by paragraph and heading." },
        { name: '"text*"', type: "raw text only", desc: "Used by code blocks." },
        { name: '"listItem+"', type: "one or more of a node", desc: "Used by lists." },
      ]} />
    </>
  );
}

export function EditorApiPlugins() {
  return (
    <>
      <p className="dx-lede">
        Plugins extend the editor without forking it: add keymaps, input rules,
        decorations, or react to transactions. They're plain objects passed to
        <code> createEditor({"{ plugins }"})</code>.
      </p>

      <h2 id="define">definePlugin</h2>
      <Code lang="ts" code={`
import { definePlugin } from "@cypherkit/editor";

const wordGoal = definePlugin({
  name: "wordGoal",
  // react to every transaction
  appendTransaction(transactions, oldState, newState) {
    if (newState.doc.wordCount >= 500) emit("goal-reached");
    return null;  // return a tr to append an edit, or null
  },
});
`} />

      <h2 id="keymap">Keymaps & input rules</h2>
      <Code lang="ts" code={`
import { keymap, inputRules } from "@cypherkit/editor";

const myKeys = keymap({
  "Mod-s": () => { save(); return true; },          // returns handled?
  "Mod-Shift-h": (editor) => editor.commands.toggleMark("highlight"),
});

const myRules = inputRules([
  // type "(c) " → insert ©
  { match: /\\(c\\)\\s$/, replace: "© " },
]);

createEditor({ element, plugins: [myKeys, myRules, wordGoal] });
`} />

      <h2 id="decorations">Decorations</h2>
      <p>
        Decorations paint over the document without changing it — spellcheck
        squiggles, search highlights, remote cursors. They're recomputed from state,
        never persisted into the CRDT.
      </p>
      <Code lang="ts" code={`
const searchHighlight = definePlugin({
  name: "search",
  decorations(state) {
    return state.doc
      .findText(query)
      .map((range) => Decoration.highlight(range, { class: "search-hit" }));
  },
});
`} />
      <Callout kind="tip" title="Decorations are free to be expensive-looking.">
        Only decorations intersecting the visible viewport are painted, so
        highlighting every match in a long document costs nothing until you scroll
        to it.
      </Callout>
    </>
  );
}
