import { type ComponentType } from "react";

import * as accessibility from "./pages/accessibility.mdx";
import * as compatibility from "./pages/compatibility.mdx";
import * as crdtCompaction from "./pages/crdt-compaction.mdx";
import * as ethicalDilemma from "./pages/ethical-dilemma-of-tasfer-and-p2p-networks.mdx";
import * as latexAsModel from "./pages/latex-as-model.mdx";
import * as manifest from "./pages/manifest.mdx";
import * as mathBlock from "./pages/math-block.mdx";
import * as obsidian from "./pages/obsidian.mdx";
import * as oneInterface from "./pages/one-interface-mutliple-backends.mdx";
import * as transitionPlan from "./pages/transition-plan.mdx";
import {
  INTERNAL_NOTE_SLUGS,
  type InternalNoteSlug,
} from "./internalNoteSlugs";

/* ============================================================
   Internal notes — the hidden /docs/internals build log.

   Design notes and architecture docs written while Tasfer was
   being built. Each note is an MDX file under ./pages/<slug>.mdx;
   its title, date, and summary live in that file's YAML
   frontmatter (parsed by remark-mdx-frontmatter and re-exported
   as `frontmatter`).

   The registry lists every .mdx under ./pages explicitly, keyed by
   filename (which becomes the route slug) and ordered newest-first
   by the frontmatter `date`. Adding a note means dropping the file
   into ./pages AND adding it to MODULES below — webpack's
   require.context is gone because Turbopack miscompiles it across
   the server/client boundary. `date` is the date the note was
   written.

   This archive is intentionally NOT registered in docsNav.tsx, so
   it is not linked from the docs sidebar, pager, or search. Reach
   it directly at /docs/internals.
   ============================================================ */

interface NoteFrontmatter {
  title: string;
  date: string;
  authors: string[];
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
  authors: string[];
  summary: string;
  Comp: ComponentType;
}

// slug → module. Slugs are the ./pages filenames without extension.
const MODULES: Record<InternalNoteSlug, NoteModule> = {
  accessibility,
  compatibility,
  "crdt-compaction": crdtCompaction,
  "ethical-dilemma-of-tasfer-and-p2p-networks": ethicalDilemma,
  "latex-as-model": latexAsModel,
  manifest,
  "math-block": mathBlock,
  obsidian,
  "one-interface-mutliple-backends": oneInterface,
  "transition-plan": transitionPlan,
};

// Newest-first.
export const NOTES: InternalNote[] = INTERNAL_NOTE_SLUGS
  .map((slug): InternalNote => {
    const mod = MODULES[slug];
    const fm = mod.frontmatter;
    return {
      slug,
      Comp: mod.default,
      title: fm.title,
      date: fm.date,
      authors: fm.authors,
      summary: fm.summary ?? "",
    };
  })
  .sort((a, b) => b.date.localeCompare(a.date));

/** route slug → note lookup. */
export const NOTE_BY_SLUG: Record<string, InternalNote> = Object.fromEntries(
  NOTES.map((n) => [n.slug, n]),
);
