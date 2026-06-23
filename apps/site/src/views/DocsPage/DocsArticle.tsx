"use client";

import { useEffect, useState } from "react";
import { Link } from "@/components/Link";
import { useTranslation } from "react-i18next";
import { Icons } from "./docsIcons";
import { DocsHeader } from "./DocsHeader";
import { Sidebar } from "./Sidebar";
import { Toc } from "./Toc";
import { Pager } from "./Pager";
import { FrameworkProvider, PkgMgrProvider } from "./docsComponents";
import { PAGE, type PageMeta } from "./docsNav";
import "./DocsPage.css";

function Breadcrumb({ meta }: { meta: PageMeta }) {
  const { t } = useTranslation();
  const sectionHome =
    meta.sectionId === "app" ? "/docs/app/getting-started" : "/docs/editor/install";
  return (
    <>
      <div className="dx-breadcrumb">
        <Link to="/docs">{t("docs.tag", "docs")}</Link>
        <span className="sep">/</span>
        <Link to={sectionHome}>{meta.section}</Link>
        {meta.group ? (
          <>
            <span className="sep">/</span>
            <span>{meta.group}</span>
          </>
        ) : null}
        <span className="sep">/</span>
        <span className="cur">{meta.title}</span>
      </div>
      <div className="dx-eyebrow">{meta.eyebrow}</div>
      <h1 className="dx-h1">{meta.title}</h1>
    </>
  );
}

/** Documentation article shell: header, searchable sidebar, prose column,
 *  right-rail TOC, pager, and the mobile drawer. Routed at
 *  /docs/:section/:slug. */
export default function DocsArticle({
  section,
  slug,
}: {
  section: string;
  slug: string;
}) {
  const { t } = useTranslation();
  const route = `${section}/${slug}`;
  const meta = PAGE[route];
  const [drawer, setDrawer] = useState(false);

  // Scroll to top whenever the page changes.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    setDrawer(false);
  }, [route]);

  // Unknown route → gentle 404.
  if (!meta) {
    return (
      <div className="dx-page">
        <DocsHeader onMenu={() => setDrawer(true)} />
        <div className="dx-shell">
          <Sidebar current={route} open={drawer} onNavigate={() => setDrawer(false)} />
          <main className="dx-main">
            <article className="dx-article">
              <div className="dx-eyebrow">404</div>
              <h1 className="dx-h1">{t("docs.notFound.title", "This page wandered off.")}</h1>
              <p className="dx-lede">
                {t("docs.notFound.body", "The page")} <code>{route}</code>{" "}
                {t("docs.notFound.bodyTail", "doesn't exist. Try the documentation home, or search the sidebar.")}
              </p>
              <Link className="dx-btn dx-btn-primary" to="/docs">
                <Icons.ArrowLeft />
                {t("docs.notFound.back", "Back to docs home")}
              </Link>
            </article>
          </main>
          <div className="dx-toc" />
        </div>
        <div className={"dx-scrim" + (drawer ? " is-open" : "")} onClick={() => setDrawer(false)} />
      </div>
    );
  }

  const PageComp = meta.Comp;
  const activeSection = meta.sectionId as "app" | "editor";

  return (
    <FrameworkProvider>
      <PkgMgrProvider>
        <div className="dx-page">
          <DocsHeader activeSection={activeSection} onMenu={() => setDrawer(true)} />
          <div className="dx-shell">
            <Sidebar current={route} open={drawer} onNavigate={() => setDrawer(false)} />
            <main className="dx-main">
              <article className="dx-article">
                <Breadcrumb meta={meta} />
                <PageComp />
                <Pager route={route} />
              </article>
            </main>
            <Toc route={route} />
          </div>
          <div className={"dx-scrim" + (drawer ? " is-open" : "")} onClick={() => setDrawer(false)} />
        </div>
      </PkgMgrProvider>
    </FrameworkProvider>
  );
}
