"use client";

import { Link } from "@/components/Link";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { Icons } from "./docsIcons";
import { DocsHeader } from "./DocsHeader";
import "./DocsPage.css";

const REPO_URL = "https://github.com/hamza512b/cypher";
const EDITOR_SRC_URL = `${REPO_URL}/tree/main/packages/editor`;

/** A sub-link inside a branch card. The whole card is also a link, so these
 *  are spans (no nested anchors) that navigate to a docs route on click. */
function BranchLink({ label, to }: { label: string; to: string }) {
  const router = useRouter();
  const go = () => router.push(to);
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        go();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          go();
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
      <DocsHeader />

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
            {t("docs.hub.lede.b", "— the CRDT-first canvas editor that powers it.")}{" "}
            <strong>
              {t(
                "docs.hub.lede.c",
                "One is the product; one is the engine, MIT-licensed and yours to embed anywhere.",
              )}
            </strong>
          </p>

          <div className="dx-hub-branch">
            {/* App branch — primary, prominent */}
            <Link className="dx-branch dx-branch--primary" to="/docs/app/getting-started">
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
                <BranchLink label={t("docs.hub.app.link1", "Getting started")} to="/docs/app/getting-started" />
                <BranchLink label={t("docs.hub.app.link2", "Sync & relay setup")} to="/docs/app/sync-relay" />
                <BranchLink label={t("docs.hub.app.link3", "Privacy & data")} to="/docs/app/privacy" />
              </div>
            </Link>

            {/* Editor package branch — secondary, recessed */}
            <Link className="dx-branch dx-branch--secondary" to="/docs/editor/install">
              <div className="dx-branch-top">
                <span className="dx-branch-ic"><Icons.Terminal /></span>
                <span className="dx-branch-badge">{t("docs.hub.editor.badge", "the package · MIT")}</span>
              </div>
              <h2 className="dx-branch-name mono">@cypherkit/editor</h2>
              <p className="dx-branch-desc">
                {t(
                  "docs.hub.editor.desc",
                  "The CRDT-first canvas editor as a standalone package. Install it, build your first editor, add collaboration, and dig into the full API reference.",
                )}
              </p>
              <div className="dx-branch-links">
                <BranchLink label={t("docs.hub.editor.link1", "Installation")} to="/docs/editor/install" />
                <BranchLink label={t("docs.hub.editor.link2", "Your first editor")} to="/docs/editor/first-editor" />
                <BranchLink label={t("docs.hub.editor.link3", "API reference")} to="/docs/editor/api-editor" />
              </div>
            </Link>
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
            <Link to="/docs/app/getting-started">{t("docs.hub.foot.appDocs", "app docs")}</Link>
            <Link to="/docs/editor/install">{t("docs.hub.foot.editorDocs", "editor docs")}</Link>
            <a href={EDITOR_SRC_URL} target="_blank" rel="noreferrer">{t("docs.hub.foot.source", "source")}</a>
          </div>
        </div>
      </div>
    </div>
  );
}
