import { type ComponentType } from "react";

/* ============================================================
   Internal notes — the hidden /docs/internals build log.

   Design notes and architecture docs written while Cypher was
   being built. Each note is an MDX file under ./pages/<slug>.mdx;
   its title, date, and summary live in that file's YAML
   frontmatter (parsed by remark-mdx-frontmatter and re-exported
   as `frontmatter`).

   The registry is built dynamically: every .mdx under ./pages is
   discovered at build time via webpack's require.context, keyed by
   filename (which becomes the route slug) and ordered newest-first
   by the frontmatter `date`. Drop a new note into ./pages and it
   shows up automatically — no edit here required. `date` is the
   date the note was written.

   This archive is intentionally NOT registered in docsNav.tsx, so
   it is not linked from the docs sidebar, pager, or search. Reach
   it directly at /docs/internals.
   ============================================================ */

interface NoteFrontmatter {
  title: string;
  date: string;
  summary: string;
  source?: string;
}

interface NoteModule {
  default: ComponentType;
  frontmatter: NoteFrontmatter;
}

export interface InternalNote {
  slug: string;
  title: string;
  /** Date the note was written (ISO yyyy-mm-dd). */
  date: string;
  summary: string;
  Comp: ComponentType;
}

// Eagerly glob every MDX note in ./pages. `require.context` is a webpack
// (Next.js) build-time primitive: keys() are paths like "./manifest.mdx".
const ctx = (
  require as unknown as {
    context: (
      dir: string,
      recursive: boolean,
      pattern: RegExp,
    ) => {
      keys: () => string[];
      (id: string): NoteModule;
    };
  }
).context("./pages", false, /\.mdx$/);

// Newest-first.
export const NOTES: InternalNote[] = ctx
  .keys()
  .map((key): InternalNote => {
    const mod = ctx(key);
    const fm = mod.frontmatter;
    const slug = key.replace(/^\.\//, "").replace(/\.mdx$/, "");
    return {
      slug,
      Comp: mod.default,
      title: fm.title,
      date: fm.date,
      summary: fm.summary,
    };
  })
  .sort((a, b) => b.date.localeCompare(a.date));

/** route slug → note lookup. */
export const NOTE_BY_SLUG: Record<string, InternalNote> = Object.fromEntries(
  NOTES.map((n) => [n.slug, n]),
);
