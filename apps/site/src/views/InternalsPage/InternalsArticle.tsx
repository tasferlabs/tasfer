"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@/components/Link";
import { PkgMgrProvider } from "@/views/DocsPage/docsComponents";
import { DocsHeader } from "@/views/DocsPage/DocsHeader";
import { NOTE_BY_SLUG } from "./internalsNav";
import "@/views/DocsPage/DocsPage.css";
import "./InternalsPage.css";

const REPO_URL = "https://github.com/hamza512b/tasfer";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-03-25" → "March 25, 2026" (parsed as a plain date, no timezone drift). */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * Internals — a hidden, blog-style long-form page, one per build-log note.
 *
 * Routed at /docs/internals/:slug but intentionally absent from the docs nav
 * (docsNav.tsx), so nothing links to it from the docs surface. It reuses the
 * documentation token layer and prose/component styles (DocsPage.css) and
 * overlays the blog chrome (InternalsPage.css): a single centered reading
 * column, an editorial hero, a byline, and a slim footer. The post body lives
 * in `pages/<slug>.mdx`; title, date, and summary come from `internalsNav`.
 */
export default function InternalsArticle({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const note = NOTE_BY_SLUG[slug];

  // Long-form pages start at the top, like the docs articles.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [slug]);

  if (!note) {
    return (
      <PkgMgrProvider>
        <div className="dx-page ix-blog">
          <DocsHeader />
          <main className="ix-main">
            <article className="dx-article ix-article">
              <header className="ix-hero">
                <div className="dx-eyebrow">404</div>
                <h1 className="ix-title">{t("internals.notFound", "This note wandered off.")}</h1>
              </header>
            </article>
          </main>
          <footer className="ix-foot">
            <Link to="/docs/internals">{t("internals.backToArchive", "← Internal notes")}</Link>
            <Link to="/docs">{t("internals.backToDocs", "← Documentation")}</Link>
          </footer>
        </div>
      </PkgMgrProvider>
    );
  }

  const Post = note.Comp;

  return (
    <PkgMgrProvider>
      <div className="dx-page ix-blog">
        <DocsHeader />
        <main className="ix-main">
          <article className="dx-article ix-article">
            <header className="ix-hero">
              <div className="dx-eyebrow">{t("internals.kicker", "internals")}</div>
              <h1 className="ix-title">{note.title}</h1>
              {note.summary ? <p className="ix-lede">{note.summary}</p> : null}
              <div className="ix-byline">
                <span className="author">{t("internals.author", "Tasfer")}</span>
                <span className="dot" aria-hidden="true" />
                <span>{formatDate(note.date)}</span>
              </div>
            </header>
            <div className="ix-body">
              <Post />
            </div>
          </article>
        </main>
        <footer className="ix-foot">
          <Link to="/docs/internals">{t("internals.backToArchive", "← Internal notes")}</Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            {t("docs.nav.github", "GitHub")}
          </a>
        </footer>
      </div>
    </PkgMgrProvider>
  );
}
