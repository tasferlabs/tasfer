"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, type ReactElement, type SVGProps } from "react";
import { useTranslation } from "react-i18next";

import BrandMark from "@/components/BrandMark";
import { Link } from "@/components/Link";
import { APP_OPEN_URL } from "@/lib/appUrl";
import { useScrolled } from "@/lib/useScrolled";
import { useTheme } from "@/providers/ThemeProvider";

import "./SiteHeader.css";

export const REPO_URL = "https://github.com/tasferlabs/tasfer";

/** Pages that own a nav entry, so the current one can mark itself active. */
export type SiteSection = "docs" | "download";

/** The one nav model. Every surface — marketing headers, the docs header, and
 *  the docs sidebar drawer — renders this list in this order. */
const SITE_LINKS: {
  section: SiteSection;
  to: string;
  key: string;
  fallback: string;
}[] = [
  { section: "docs", to: "/docs", key: "site.nav.docs", fallback: "docs" },
  {
    section: "download",
    to: "/download",
    key: "site.nav.download",
    fallback: "download",
  },
];

type Icon = (props: SVGProps<SVGSVGElement>) => ReactElement;

const Icons: Record<string, Icon> = {
  Sun: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  Moon: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
    </svg>
  ),
  Menu: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  ),
  Close: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
};

export function ThemeToggle({ showLabel = false }: { showLabel?: boolean }) {
  const { effectiveTheme, setTheme } = useTheme();
  const { t } = useTranslation();
  const isDark = effectiveTheme === "dark";
  const label = t("common.toggleTheme", "Toggle theme");

  return (
    <button
      className="site-theme-btn"
      aria-label={label}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Icons.Sun /> : <Icons.Moon />}
      {showLabel ? <span className="site-theme-label">{label}</span> : null}
    </button>
  );
}

/** Nav entries without the surrounding <nav>, so the docs sidebar drawer can
 *  render the same list under its own classes when the header collapses. */
export function SiteNavLinks({
  activeSection = null,
  onNavigate,
  linkClassName,
  showThemeLabel = false,
}: {
  activeSection?: SiteSection | null;
  onNavigate?: () => void;
  linkClassName?: string;
  showThemeLabel?: boolean;
}) {
  const { t } = useTranslation();
  const cls = (section: SiteSection | null) =>
    [linkClassName, section && section === activeSection ? "is-active" : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <>
      {SITE_LINKS.map((item) => (
        <Link
          key={item.section}
          to={item.to}
          className={cls(item.section)}
          onClick={onNavigate}
        >
          {t(item.key, item.fallback)}
        </Link>
      ))}
      <a
        className={cls(null)}
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        onClick={onNavigate}
      >
        {t("site.nav.source", "source")}
      </a>
      <ThemeToggle showLabel={showThemeLabel} />
      <a
        className={["site-nav-cta", linkClassName].filter(Boolean).join(" ")}
        href={APP_OPEN_URL}
        onClick={onNavigate}
      >
        {t("site.nav.open", "open tasfer")}
      </a>
    </>
  );
}

/**
 * The site header, shared by every page.
 *
 * `variant` picks the surface only — "marketing" starts transparent and blurs
 * once the page scrolls, "docs" is a solid bordered bar over long-form content.
 * The wordmark, link set, mobile disclosure, and theme toggle are identical.
 *
 * Exactly one menu button shows on a narrow screen. Pass `onMenu` on docs
 * article pages to get the sidebar toggle; those pages carry the site links at
 * the foot of that drawer, so the header's own disclosure steps aside.
 */
export function SiteHeader({
  variant = "marketing",
  activeSection = null,
  onMenu,
}: {
  variant?: "marketing" | "docs";
  activeSection?: SiteSection | null;
  onMenu?: () => void;
}) {
  const { t } = useTranslation();
  const scrolled = useScrolled();
  const [isNavOpen, setNavOpen] = useState(false);
  const [headerRef, setHeaderRef] = useState<HTMLElement | null>(null);
  const isDocs = variant === "docs";

  return (
    <header
      ref={setHeaderRef}
      className={[
        "site-header",
        isDocs ? "is-docs" : "",
        !isDocs && scrolled ? "is-scrolled" : "",
        isNavOpen ? "is-nav-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="site-header-inner">
        {onMenu ? (
          <button
            className="site-sidebar-btn"
            aria-label={t("docs.a11y.openNavigation", "Open navigation")}
            onClick={onMenu}
          >
            <Icons.Menu />
          </button>
        ) : null}
        <Link
          className="site-wordmark"
          to="/home"
          aria-label={t("site.a11y.home", "Tasfer home")}
        >
          <BrandMark className="site-wordmark-mark" />
          {t("brand.wordmark", "tasfer")}
        </Link>
        <span className="site-header-spacer" />
        {/* Above the collapse breakpoint this is a plain row of links, so the
            nav renders outside the dialog and CSS hides the trigger. Below it,
            the same links are the dialog's content: Radix owns the scrim,
            Escape, the focus trap and the outside click — so a tap outside
            dismisses the panel instead of falling through to the page. */}
        {onMenu ? null : (
          <Dialog.Root open={isNavOpen} onOpenChange={setNavOpen}>
            <Dialog.Trigger asChild>
              <button
                className="site-nav-btn"
                aria-label={
                  isNavOpen
                    ? t("site.a11y.closeMenu", "Close menu")
                    : t("site.a11y.openMenu", "Open menu")
                }
              >
                {isNavOpen ? <Icons.Close /> : <Icons.Menu />}
              </button>
            </Dialog.Trigger>
            {/* Portalled into the header, not <body>: the panel hangs off the
                bar, whose height varies by variant and by the beta banner
                above it. Staying inside that box tracks the offset for free. */}
            <Dialog.Portal container={headerRef}>
              <Dialog.Overlay className="site-nav-scrim" />
              <Dialog.Content
                className="site-nav site-nav-panel"
                aria-describedby={undefined}
                // The panel is a menu of links, not a form. Focusing the first
                // link on open would scroll it under the bar on short screens.
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                <Dialog.Title className="site-sr-only">
                  {t("site.a11y.menu", "Site navigation")}
                </Dialog.Title>
                <SiteNavLinks
                  activeSection={activeSection}
                  onNavigate={() => setNavOpen(false)}
                  showThemeLabel
                />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
        <nav className="site-nav site-nav-inline">
          <SiteNavLinks activeSection={activeSection} showThemeLabel />
        </nav>
      </div>
    </header>
  );
}

export default SiteHeader;
