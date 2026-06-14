import type { MDXComponents } from "mdx/types";
import { A, CodeFence } from "@/views/DocsPage/docsComponents";

/**
 * Global MDX component map (picked up automatically by @next/mdx).
 *
 * Markdown links route through the docs `A` helper so absolute in-app paths
 * ("/docs/...") use the client-side router and everything else opens in a new
 * tab — same behavior the JSX pages had. Fenced code blocks render through
 * CodeFence → the docs Code component (header, copy button, syntax tint).
 * Everything else (Callout, PropsTable, …) is imported explicitly by each
 * .mdx article.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    a: A,
    pre: CodeFence,
    ...components,
  };
}
