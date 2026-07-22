// Allow CSS side-effect and dynamic imports (e.g. the @fontsource faces loaded
// lazily in src/lib/fonts.ts) to typecheck. Webpack still processes the actual
// CSS; this only satisfies the type checker.
declare module "*.css";

// Augment the ambient `*.mdx` module type (from @types/mdx, which only types the
// default component export) so the `frontmatter` named export — injected at build
// time by remark-mdx-frontmatter — is typed. Used by the internals archive.
declare module "*.mdx" {
  export const frontmatter: {
    title: string;
    date: string;
    authors: string[];
    summary: string;
    source?: string;
  };
}
