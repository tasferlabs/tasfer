"use client";

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Link } from "@/components/Link";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { Icons } from "./docsIcons";
import { SiteHeader } from "@/components/SiteHeader";
import { DRAWER_MEDIA, Sidebar } from "./Sidebar";
import { Toc } from "./Toc";
import { Pager } from "./Pager";
import { FrameworkProvider, PkgMgrProvider } from "./docsComponents";
import { PAGE, type PageMeta } from "./docsNav";
import "./DocsPage.css";

function Breadcrumb({ meta }: { meta: PageMeta }) {
  const { t } = useTranslation();
  const sectionHome =
    meta.sectionId === "app"
      ? "/docs/app/getting-started"
      : "/docs/editor/roadmap";
  return (
    <>
      <div className="dx-breadcrumb">
        <Link to="/docs">{t("docs.tag", "docs")}</Link>
        <span className="sep">/</span>
        <Link to={sectionHome}>
          {meta.sectionKey ? t(meta.sectionKey, meta.section) : meta.section}
        </Link>
        {meta.group ? (
          <>
            <span className="sep">/</span>
            <span>
              {meta.groupKey ? t(meta.groupKey, meta.group) : meta.group}
            </span>
          </>
        ) : null}
        <span className="sep">/</span>
        <span className="cur">{t(meta.titleKey, meta.title)}</span>
      </div>
      <h1 className="dx-h1">{t(meta.titleKey, meta.title)}</h1>
    </>
  );
}

/** The navigation rail. Above the drawer breakpoint it is simply a column of
 *  the shell. Below it, the same rail is the content of a modal dialog: Radix
 *  owns the scroll lock, the focus trap, Escape and the inert background, so
 *  the article behind the drawer neither scrolls nor keeps a second scrollbar.
 *
 *  Portalled into `.dx-page` rather than `<body>` so the docs CSS — scoped
 *  under that class on purpose — still reaches it. */
function DocsNav({
  current,
  open,
  onOpenChange,
  container,
}: {
  current: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  container: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const isDrawer = useMediaQuery(DRAWER_MEDIA);
  const drawerRef = useRef<HTMLElement>(null);

  if (!isDrawer) return <Sidebar current={current} />;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="dx-scrim" />
        <Dialog.Content
          asChild
          aria-describedby={undefined}
          // The search field is the first thing in the rail, and focusing it
          // would raise the on-screen keyboard over the links the reader just
          // asked to see. Hold focus on the drawer itself instead.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            drawerRef.current?.focus();
          }}
        >
          <Sidebar
            ref={drawerRef}
            tabIndex={-1}
            current={current}
            onNavigate={() => onOpenChange(false)}
          >
            <Dialog.Title className="dx-sr-only">
              {t("docs.a11y.navigation", "Documentation navigation")}
            </Dialog.Title>
          </Sidebar>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  // A callback ref, not a plain one: the portal needs this node during render,
  // so the container has to survive as state.
  const [page, setPage] = useState<HTMLDivElement | null>(null);

  // Scroll to top whenever the page changes.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    setDrawer(false);
  }, [route]);

  const nav = (
    <DocsNav
      current={route}
      open={drawer}
      onOpenChange={setDrawer}
      container={page}
    />
  );

  // Unknown route → gentle 404.
  if (!meta) {
    return (
      <div className="dx-page" ref={setPage}>
        <SiteHeader
          variant="docs"
          activeSection="docs"
          onMenu={() => setDrawer(true)}
        />
        <div className="dx-shell">
          {nav}
          <main className="dx-main">
            <article className="dx-article">
              <div className="dx-eyebrow">404</div>
              <h1 className="dx-h1">
                {t("docs.notFound.title", "This page wandered off.")}
              </h1>
              <p className="dx-lede">
                {/* dir="ltr" isolates the route: its "/" separators are bidi
                    neutrals that would otherwise reorder inside Arabic prose. */}
                {t("docs.notFound.body", "The page")}{" "}
                <code dir="ltr">{route}</code>{" "}
                {t(
                  "docs.notFound.bodyTail",
                  "doesn't exist. Try the documentation home, or search the sidebar.",
                )}
              </p>
              <Link className="dx-btn dx-btn-primary" to="/docs">
                <Icons.ArrowLeft />
                {t("docs.notFound.back", "Back to docs home")}
              </Link>
            </article>
          </main>
          <div className="dx-toc" />
        </div>
      </div>
    );
  }

  const PageComp = meta.Comp;

  return (
    <FrameworkProvider>
      <PkgMgrProvider>
        <div className="dx-page" ref={setPage}>
          <SiteHeader
            variant="docs"
            activeSection="docs"
            onMenu={() => setDrawer(true)}
          />
          <div className="dx-shell">
            {nav}
            <main className="dx-main">
              <article className="dx-article">
                <Breadcrumb meta={meta} />
                <PageComp />
                <Pager route={route} />
              </article>
            </main>
            <Toc route={route} />
          </div>
        </div>
      </PkgMgrProvider>
    </FrameworkProvider>
  );
}
