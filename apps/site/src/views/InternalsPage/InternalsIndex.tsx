"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@/components/Link";
import { DirArrow } from "@/components/DirArrow";
import { PkgMgrProvider } from "@/views/DocsPage/docsComponents";
import { DocsHeader } from "@/views/DocsPage/DocsHeader";
import { NOTES } from "./internalsNav";
import "@/views/DocsPage/DocsPage.css";
import "./InternalsPage.css";

const REPO_URL = "https://github.com/hamza512b/tasfer";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-03-25" → "25 Mar 2026" (parsed as a plain date, no timezone drift). */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Internal notes — the hidden build-log index at /docs/internals.
 *
 * Lists the design notes and architecture docs written while Tasfer was being
 * built, newest-first, each linking to its own blog-style page. Like the
 * individual notes, this page is intentionally absent from the docs nav and
 * reachable only by direct URL.
 */
export default function InternalsIndex() {
  const { t } = useTranslation();

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <PkgMgrProvider>
      <div className="dx-page ix-blog">
        <DocsHeader />
        <main className="ix-main">
          <article className="dx-article ix-article">
            <header className="ix-hero">
              <div className="dx-eyebrow">{t("internals.archive.kicker", "internals · build log")}</div>
              <h1 className="ix-title">{t("internals.archive.title", "Internal notes")}</h1>
              <p className="ix-lede">
                {t(
                  "internals.archive.lede",
                  "How Tasfer got built — the design notes, architecture decisions, and plans behind the editor, written as the work happened.",
                )}
              </p>
            </header>
            <ul className="ix-list">
              {NOTES.map((note) => (
                <li className="ix-entry" key={note.slug}>
                  <Link to={`/docs/internals/${note.slug}`}>
                    <span className="ix-entry-date">{formatDate(note.date)}</span>
                    <h2 className="ix-entry-title">{note.title}</h2>
                    <p className="ix-entry-summary">{note.summary}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </article>
        </main>
        <footer className="ix-foot">
          <Link to="/docs">
            <DirArrow towards="back" />
            {t("internals.backToDocs", "Documentation")}
          </Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            {t("docs.nav.github", "GitHub")}
          </a>
        </footer>
      </div>
    </PkgMgrProvider>
  );
}
