import type { MDXComponents } from "mdx/types";
import { AiDash } from "@/components/AiDash";
import { A, CodeFence } from "@/views/DocsPage/docsComponents";

/**
 * Global MDX component map (picked up automatically by @next/mdx).
 *
 * Markdown links route through the docs `A` helper so absolute in-app paths
 * ("/docs/...") keep the active locale and everything else opens in a new tab.
 * Fenced code blocks render through
 * CodeFence → the docs Code component (header, copy button, syntax tint).
 * Em dashes in prose become <AiDash /> via scripts/remark-ai-dash.mjs.
 * Everything else (Callout, PropsTable, …) is imported explicitly by each
 * .mdx article.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    a: A,
    AiDash,
    pre: CodeFence,
    ...components,
  };
}
