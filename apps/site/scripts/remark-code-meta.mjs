/**
 * Remark plugin: carry a fenced code block's meta string (the part after the
 * language, e.g. ```ts file="main.ts") through to the rendered <code> as a
 * data-meta attribute. MDX/mdast-util-to-hast drops the meta otherwise, and
 * the docs `pre` component (CodeFence) needs it to rebuild the snippet header.
 * Setting it as hProperties at the mdast stage is the reliable path — node.meta
 * is always present here, before hast conversion can lose it.
 *
 * Lives in its own module (not inline in next.config.ts) because Turbopack
 * requires MDX loader options to be serializable: plugins are referenced by
 * path string, not passed as functions.
 */
export default function remarkCodeMeta() {
  return (tree) => {
    const visit = (node) => {
      if (node?.type === "code" && node.meta) {
        node.data = node.data || {};
        node.data.hProperties = { ...node.data.hProperties, "data-meta": node.meta };
      }
      for (const child of node?.children ?? []) visit(child);
    };
    visit(tree);
  };
}
