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
        { name: "schema", type: "Schema", desc: "Allowed nodes & marks. Defaults to baseSchema." },
        { name: "theme", type: "EditorTheme", desc: "Canvas color tokens, styles, and fonts. Defaults to the neutral palette." },
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
        { name: "insertText", type: "(text: string) => boolean", desc: "Insert text at the cursor, replacing any selection." },
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
const canRun = editor.chain().setBlock("heading", { level: 1 }).canRun();
`} />

    </>
  );
}

export function EditorApiSchema() {
  return (
    <>
      <p className="dx-lede">
        A <code>Schema</code> declares what a document is made of: the block
        types and inline marks the editor understands. The default{" "}
        <code>baseSchema</code> covers every built-in type; derive your own with{" "}
        <code>baseSchema.extend(...)</code>.
      </p>

      <Callout kind="note" title="Cypher's block model is flat.">
        A document is an ordered <em>list</em> of blocks — there is no block
        nesting. Each block is either text-bearing (paragraph, heading, a list
        item) or a leaf (image, divider, math). Nested containers — a blockquote
        wrapping several blocks, columns — are on the roadmap; today every block
        stands on its own.
      </Callout>

      <h2 id="base">Built-in block types</h2>
      <PropsTable cols={["Block type", "Markdown", "Notes"]} rows={[
        { name: "paragraph", type: "(plain text)", desc: "The default text block." },
        { name: "heading1 / 2 / 3", type: "# / ## / ###", desc: 'Three heading levels. setBlock("heading", { level }) maps here.' },
        { name: "bullet_list", type: "- ", desc: "Unordered list item." },
        { name: "numbered_list", type: "1. ", desc: "Ordered list item." },
        { name: "todo_list", type: "- [ ] ", desc: "Checkable task item." },
        { name: "image", type: "![alt](url)", desc: "Leaf. attrs: width, height, objectFit, alt." },
        { name: "line", type: "---", desc: 'Leaf horizontal divider (the classic "hr").' },
        { name: "math", type: "$$ … $$", desc: "Leaf block-level math." },
      ]} />
      <p>
        Inline marks: <code>strong</code> (<code>**</code>),{" "}
        <code>emphasis</code> (<code>*</code>), <code>strike</code>{" "}
        (<code>~~</code>), <code>code</code> (backticks), <code>link</code>{" "}
        (<code>[text](url)</code>), plus inline <code>math</code> (<code>$…$</code>).
      </p>

      <h2 id="extend">Extending</h2>
      <p>
        <code>extend</code> takes <em>arrays</em> of node and mark specs and
        returns a new, immutable schema — the base is never mutated, so two
        editors on one page can run different schemas:
      </p>
      <Code lang="ts" code={`
import { baseSchema, defineNode, defineMark } from "@cypherkit/editor";

const schema = baseSchema.extend({
  nodes: [defineNode("callout", { attrs: { tone: { default: "note" } } })],
  marks: [defineMark("highlight")],
});
`} />
      <p>
        Custom block types are leaf, void nodes today (a styled box carrying
        replicated attributes). See <A href="/docs/editor/custom-nodes">Custom
        nodes &amp; marks</A> for the full <code>defineNode</code> /{" "}
        <code>defineMark</code> options and how they round-trip through Markdown.
      </p>
    </>
  );
}
