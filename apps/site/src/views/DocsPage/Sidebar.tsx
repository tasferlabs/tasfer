"use client";

import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";
import { Link } from "@/components/Link";
import { useTranslation } from "react-i18next";
import { SiteNavLinks } from "@/components/SiteHeader";
import { Icons } from "./docsIcons";
import { NAV, FLAT, type NavItem } from "./docsNav";

function highlightTitle(title: string, q: string): ReactNode {
  if (!q) return title;
  const i = title.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return title;
  return (
    <>
      {title.slice(0, i)}
      <mark className="dx-hit">{title.slice(i, i + q.length)}</mark>
      {title.slice(i + q.length)}
    </>
  );
}

/** Width at which the rail stops being a column of the shell and becomes the
 *  drawer. Mirrors the breakpoint the sidebar CSS uses; DocsArticle reads it to
 *  decide whether the rail is mounted inline or inside a modal dialog. */
export const DRAWER_MEDIA = "(max-width: 920px)";

/** Left navigation rail with type-ahead filtering. `current` is the active
 *  route (e.g. "app/getting-started"). Extra props land on the `<aside>` so a
 *  Radix `Dialog.Content asChild` can drive it as the mobile drawer. */
export function Sidebar({
  current,
  onNavigate,
  className,
  children,
  ...rest
}: {
  current: string;
  onNavigate?: () => void;
} & ComponentPropsWithRef<"aside">) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const query = q.trim().toLowerCase();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const input = inputRef.current;
      if (e.key === "/" && document.activeElement !== input) {
        e.preventDefault();
        input?.focus();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input?.focus();
      } else if (e.key === "Escape" && document.activeElement === input) {
        setQ("");
        input?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function match(item: NavItem) {
    if (!query) return true;
    const translatedTitle = t(item.titleKey, item.title);
    return (translatedTitle + " " + item.title + " " + item.kw)
      .toLowerCase()
      .includes(query);
  }

  const anyMatch = FLAT.some(match);

  return (
    <aside
      className={"dx-sidebar" + (className ? " " + className : "")}
      {...rest}
    >
      {/* Empty in the shell; carries the dialog's accessible name when the
          rail is mounted as the drawer. */}
      {children}
      <div className="dx-search">
        <Icons.Search />
        <input
          ref={inputRef}
          type="text"
          placeholder={t("docs.search.placeholder", "Search the docs…")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {!q ? <kbd>/</kbd> : null}
      </div>

      {!anyMatch ? (
        <div className="dx-nav-empty">
          {t("docs.search.empty", "No pages match")} “{q}”.
        </div>
      ) : null}

      {NAV.map((section) => {
        const visibleGroups = section.groups
          .map((g) => ({ ...g, items: g.items.filter(match) }))
          .filter((g) => g.items.length > 0);
        if (visibleGroups.length === 0) return null;
        return (
          <div className="dx-nav-section" key={section.id}>
            <div
              className="dx-nav-section-head"
              style={
                section.mono
                  ? { fontFamily: "var(--font-terminal)", textTransform: "none", letterSpacing: "-0.01em", fontSize: 13 }
                  : undefined
              }
            >
              {section.icon}
              {section.labelKey ? t(section.labelKey, section.label) : section.label}
            </div>
            {visibleGroups.map((g, gi) => (
              <div className="dx-nav-group" key={gi}>
                {g.label ? (
                  <div className="dx-nav-group-label">
                    {g.labelKey ? t(g.labelKey, g.label) : g.label}
                  </div>
                ) : null}
                <ul className="dx-nav-list">
                  {g.items.map((it) => (
                    <li key={it.route}>
                      <Link
                        className={"dx-nav-link" + (it.route === current ? " is-active" : "")}
                        to={"/docs/" + it.route}
                        onClick={onNavigate}
                      >
                        {highlightTitle(t(it.titleKey, it.title), query)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        );
      })}

      {/* The same site links the header nav carries. Once the header collapses
          the drawer is the only menu, so they live here instead of behind a
          second toggle. Hidden by CSS above the drawer breakpoint. */}
      <div className="dx-sidebar-site">
        <SiteNavLinks
          activeSection="docs"
          linkClassName="dx-nav-link"
          onNavigate={onNavigate}
          showThemeLabel
        />
      </div>
    </aside>
  );
}
