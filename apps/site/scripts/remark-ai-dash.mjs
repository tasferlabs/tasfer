/**
 * Remark plugin: turn every em dash in an article's prose into an <AiDash />
 * element (src/components/AiDash.tsx, wired in src/mdx-components.tsx), the
 * dash that opens an "AI was used here" bubble.
 *
 * Only markdown `text` nodes are touched, so code fences, inline code, and JSX
 * attribute strings keep their dashes as written. Text inside a link is skipped
 * too: the bubble carries its own link, and links cannot nest.
 *
 * Docs articles (src/views/DocsPage/pages) are left alone: there the bubble
 * got in the way of reading.
 *
 * Lives in its own module (not inline in next.config.ts) because Turbopack
 * requires MDX loader options to be serializable.
 */
const DASH = "—";
const SKIP = new Set(["link", "linkReference"]);
const DOCS_DIR = /[\\/]views[\\/]DocsPage[\\/]/;

function split(value) {
  const out = [];
  value.split(DASH).forEach((part, i) => {
    if (i > 0) {
      out.push({ type: "mdxJsxTextElement", name: "AiDash", attributes: [], children: [] });
    }
    if (part) out.push({ type: "text", value: part });
  });
  return out;
}

export default function remarkAiDash() {
  return (tree, file) => {
    if (file?.path && DOCS_DIR.test(file.path)) return;
    const visit = (node) => {
      if (!node?.children || SKIP.has(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && child.value.includes(DASH)) return split(child.value);
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}
