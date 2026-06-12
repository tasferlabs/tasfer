"use client";

import { Link } from "@/components/Link";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/providers/ThemeProvider";
import { Icons } from "./docsIcons";

const REPO_URL = "https://github.com/hamza512b/cypher";

export function ThemeToggle() {
  const { effectiveTheme, setTheme } = useTheme();
  const isDark = effectiveTheme === "dark";
  return (
    <button
      className="dx-theme-btn"
      aria-label="toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Icons.Sun /> : <Icons.Moon />}
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
  return (
    <header className="dx-header">
      <div className="dx-header-inner">
        {onMenu ? (
          <button className="dx-menu-btn" aria-label="open navigation" onClick={onMenu}>
            <Icons.Menu />
          </button>
        ) : null}
        <Link className="dx-wordmark" to="/home" aria-label="Cypher docs home">
          <img src="/logo.png" alt="" className="dx-wordmark-mark" />
          Cypher
        </Link>
        <span className="dx-wordmark-tag">{t("docs.tag", "docs")}</span>
        <span className="dx-header-spacer" />
        <nav className="dx-header-nav">
          <Link
            to="/docs/app/getting-started"
            className={activeSection === "app" ? "is-active" : ""}
          >
            {t("docs.nav.appDocs", "App docs")}
          </Link>
          <Link
            to="/docs/editor/install"
            className={activeSection === "editor" ? "is-active" : ""}
          >
            {t("docs.nav.editorDocs", "Editor docs")}
          </Link>
          <Link to="/home">{t("docs.nav.landing", "Landing")}</Link>
          <ThemeToggle />
          <a className="dx-ghost-link" href={REPO_URL} target="_blank" rel="noreferrer">
            <Icons.GitHub />
            {t("docs.nav.github", "GitHub")}
          </a>
        </nav>
      </div>
    </header>
  );
}
