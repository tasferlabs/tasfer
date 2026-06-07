import { type SVGProps } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/app/hooks/useTheme";
import "./DocsPage.css";

const REPO_URL = "https://github.com/hamza512b/cypher";
const EDITOR_SRC_URL = `${REPO_URL}/tree/main/packages/editor`;

/* ── Icons — Lucide-style 1.5px stroke, matching HomePage ── */
const Icons = {
  Shield: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
    </svg>
  ),
  Terminal: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  ),
  ChevronRight: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  GitHub: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.55 0-.27-.01-1.18-.02-2.14-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.24 2.75.12 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.4-5.27 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.55C20.22 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  ),
  Sun: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  Moon: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
    </svg>
  ),
};

function ThemeToggle() {
  const { effectiveTheme, setTheme } = useTheme();
  const isDark = effectiveTheme === "dark";
  return (
    <button className="dx-theme-btn" aria-label="toggle theme" onClick={() => setTheme(isDark ? "light" : "dark")}>
      {isDark ? <Icons.Sun /> : <Icons.Moon />}
    </button>
  );
}

/** A sub-link inside a branch card. The whole card is also a link, so these are
 *  spans (no nested anchors) that navigate on click — internal via the router,
 *  external in a new tab. */
function BranchLink({ label, to, external }: { label: string; to: string; external?: boolean }) {
  const navigate = useNavigate();
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (external) window.open(to, "_blank", "noreferrer");
        else navigate(to);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          if (external) window.open(to, "_blank", "noreferrer");
          else navigate(to);
        }
      }}
    >
      {label}
      <Icons.ChevronRight className="ar" />
    </span>
  );
}

export default function DocsPage() {
  const { t } = useTranslation();

  return (
    <div className="dx-page">
      <header className="dx-header">
        <div className="dx-header-inner">
          <Link className="dx-wordmark" to="/home" aria-label="Cypher docs home">
            <img src="/logo.png" alt="" className="dx-wordmark-mark" />
            Cypher
          </Link>
          <span className="dx-wordmark-tag">{t("docs.tag", "docs")}</span>
          <span className="dx-header-spacer" />
          <nav className="dx-header-nav">
            <Link to="/home">{t("docs.nav.landing", "Landing")}</Link>
            <Link to="/page">{t("docs.nav.openApp", "Open app")}</Link>
            <ThemeToggle />
            <a className="dx-ghost-link" href={REPO_URL} target="_blank" rel="noreferrer">
              <Icons.GitHub />
              {t("docs.nav.github", "GitHub")}
            </a>
          </nav>
        </div>
      </header>

      <div className="dx-hub">
        <div className="dx-hub-grid" aria-hidden="true" />
        <div className="dx-hub-inner">
          <div className="dx-hub-eyebrow">{t("docs.hub.eyebrow", "documentation")}</div>
          <h1 className="dx-hub-title">
            {t("docs.hub.title.a", "Two things to read.")}
            <br />
            <em>{t("docs.hub.title.b", "Both yours to keep.")}</em>
          </h1>
          <p className="dx-hub-lede">
            {t(
              "docs.hub.lede.a",
              "Everything you need to use the Cypher app, and everything you need to build on",
            )}{" "}
            <code>@cypherkit/editor</code>{" "}
            {t(
              "docs.hub.lede.b",
              "— the CRDT-first canvas editor that powers it.",
            )}{" "}
            <strong>
              {t(
                "docs.hub.lede.c",
                "One is the product; one is the engine, MIT-licensed and yours to embed anywhere.",
              )}
            </strong>
          </p>

          <div className="dx-hub-branch">
            {/* App branch */}
            <Link className="dx-branch" to="/home">
              <div className="dx-branch-top">
                <span className="dx-branch-ic"><Icons.Shield /></span>
                <span className="dx-branch-badge">{t("docs.hub.app.badge", "the app · AGPL-3.0")}</span>
              </div>
              <h2 className="dx-branch-name">{t("docs.hub.app.name", "Cypher, the app")}</h2>
              <p className="dx-branch-desc">
                {t(
                  "docs.hub.app.desc",
                  "A local-first, end-to-end encrypted markdown editor. Set it up, sync across your devices, run your own relay, and read exactly what stays on your disk.",
                )}
              </p>
              <div className="dx-branch-links">
                <BranchLink label={t("docs.hub.app.link1", "Read the manifesto")} to="/home" />
                <BranchLink label={t("docs.hub.app.link2", "How sync works")} to="/home" />
                <BranchLink label={t("docs.hub.app.link3", "Privacy & data")} to="/privacy" />
              </div>
            </Link>

            {/* Editor package branch */}
            <a className="dx-branch" href={EDITOR_SRC_URL} target="_blank" rel="noreferrer">
              <div className="dx-branch-top">
                <span className="dx-branch-ic"><Icons.Terminal /></span>
                <span className="dx-branch-badge">{t("docs.hub.editor.badge", "the package · MIT")}</span>
              </div>
              <h2 className="dx-branch-name mono">@cypherkit/editor</h2>
              <p className="dx-branch-desc">
                {t(
                  "docs.hub.editor.desc",
                  "The CRDT-first canvas editor as a standalone package. Install it, build your first editor, add collaboration, and dig into the source.",
                )}
              </p>
              <div className="dx-branch-links">
                <BranchLink label={t("docs.hub.editor.link1", "Installation")} to={EDITOR_SRC_URL} external />
                <BranchLink label={t("docs.hub.editor.link2", "Your first editor")} to={EDITOR_SRC_URL} external />
                <BranchLink label={t("docs.hub.editor.link3", "Browse the source")} to={`${REPO_URL}/blob/main/packages/editor/src/index.ts`} external />
              </div>
            </a>
          </div>

          {/* Stats — corrected to accurate facts (editor ships 2 runtime deps,
              so the original "0 runtime deps" claim is dropped). */}
          <div className="dx-hub-strip">
            <div className="dx-hub-stat"><span className="v">MIT</span><span className="k">{t("docs.hub.stat.editorLicense", "editor license")}</span></div>
            <div className="dx-hub-stat"><span className="v">AGPL-3.0</span><span className="k">{t("docs.hub.stat.appLicense", "app license")}</span></div>
            <div className="dx-hub-stat"><span className="v">0</span><span className="k">{t("docs.hub.stat.accounts", "accounts")}</span></div>
            <div className="dx-hub-stat"><span className="v">CRDT</span><span className="k">{t("docs.hub.stat.crdt", "first, by design")}</span></div>
            <div className="dx-hub-stat"><span className="v">P2P</span><span className="k">{t("docs.hub.stat.p2p", "encrypted sync")}</span></div>
          </div>
        </div>

        <div className="dx-hub-foot">
          <div className="dx-hub-foot-brand">
            <img src="/logo.png" alt="" />
            <span className="dx-hub-foot-name">Cypher</span>
            <span className="dx-hub-foot-tail">{t("docs.hub.foot.tagline", "— documentation, built in the open.")}</span>
          </div>
          <div className="dx-hub-foot-links">
            <Link to="/home">{t("docs.hub.foot.landing", "landing")}</Link>
            <Link to="/page">{t("docs.hub.foot.app", "open app")}</Link>
            <a href={EDITOR_SRC_URL} target="_blank" rel="noreferrer">{t("docs.hub.foot.editor", "editor")}</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer">{t("docs.hub.foot.source", "source")}</a>
          </div>
        </div>
      </div>
    </div>
  );
}
