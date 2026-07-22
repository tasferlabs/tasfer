"use client";

import { Link } from "@/components/Link";
import BrandMark from "@/components/BrandMark";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/providers/ThemeProvider";
import { APP_OPEN_URL } from "@/lib/appUrl";
import { Icons } from "./docsIcons";
import { useState } from "react";

const REPO_URL = "https://github.com/tasferlabs/tasfer";

export function ThemeToggle({ showLabel = false }: { showLabel?: boolean }) {
  const { effectiveTheme, setTheme } = useTheme();
  const { t } = useTranslation();
  const isDark = effectiveTheme === "dark";
  return (
    <button
      className="dx-theme-btn"
      aria-label={t("common.toggleTheme", "Toggle theme")}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Icons.Sun /> : <Icons.Moon />}
      {showLabel ? (
        <span className="dx-theme-label">
          {t("common.toggleTheme", "Toggle theme")}
        </span>
      ) : null}
    </button>
  );
}

/** Shared docs header. Pass `onMenu` on article pages to show the mobile
 *  sidebar toggle; the hub omits it. `activeSection` highlights the matching
 *  nav link. */
export function DocsHeader({
  activeSection = null,
  onMenu,
}: {
  activeSection?: "app" | "editor" | null;
  onMenu?: () => void;
}) {
  const { t } = useTranslation();
  const [isNavigationOpen, setNavigationOpen] = useState(false);

  const closeNavigation = () => setNavigationOpen(false);

  return (
    <header className="dx-header">
      <div className="dx-header-inner">
        {onMenu ? (
          <button
            className="dx-menu-btn"
            aria-label={t("docs.a11y.openNavigation", "Open navigation")}
            onClick={onMenu}
          >
            <Icons.Menu />
          </button>
        ) : null}
        <Link
          className="dx-wordmark"
          to="/home"
          aria-label={t("docs.a11y.home", "Tasfer documentation home")}
        >
          <BrandMark className="dx-wordmark-mark" />
          {t("brand.wordmark", "tasfer")}
        </Link>
        <span className="dx-wordmark-tag">{t("docs.tag", "docs")}</span>
        <span className="dx-header-spacer" />
        <button
          className="dx-site-menu-btn"
          aria-label={t("docs.a11y.openNavigation", "Open navigation")}
          aria-expanded={isNavigationOpen}
          aria-controls="docs-site-navigation"
          onClick={() => setNavigationOpen((open) => !open)}
        >
          {isNavigationOpen ? <Icons.Close /> : <Icons.Menu />}
        </button>
        <nav
          className={"dx-header-nav" + (isNavigationOpen ? " is-open" : "")}
          id="docs-site-navigation"
        >
          <Link
            to="/docs/app/getting-started"
            className={activeSection === "app" ? "is-active" : ""}
            onClick={closeNavigation}
          >
            {t("docs.nav.appDocs", "App docs")}
          </Link>
          <Link
            to="/docs/editor/roadmap"
            className={activeSection === "editor" ? "is-active" : ""}
            onClick={closeNavigation}
          >
            {t("docs.nav.editorDocs", "SDK roadmap")}
          </Link>
          <Link to="/home" onClick={closeNavigation}>
            {t("docs.nav.landing", "Landing")}
          </Link>
          <ThemeToggle showLabel />
          <a
            className="dx-ghost-link"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            <Icons.GitHub />
            {t("docs.nav.github", "GitHub")}
          </a>
          <a className="dx-open-app-link" href={APP_OPEN_URL}>
            {t("docs.nav.openApp", "Open app")}
          </a>
        </nav>
      </div>
    </header>
  );
}
