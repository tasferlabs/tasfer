"use client";

import { Link } from "@/components/Link";
import BrandMark from "@/components/BrandMark";
import { useParams, useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { isLng } from "@/lib/i18n/locales";
import { Icons } from "./docsIcons";
import { DocsHeader } from "./DocsHeader";
import "./DocsPage.css";

const REPO_URL = "https://github.com/tasferlabs/tasfer";

/** A sub-link inside a branch card. The whole card is also a link, so these
 *  are spans (no nested anchors) that navigate to a docs route on click. */
function BranchLink({ label, to }: { label: string; to: string }) {
  const router = useRouter();
  const params = useParams<{ lang?: string }>();
  const lang = params.lang;
  const go = () => router.push(lang && isLng(lang) ? `/${lang}${to}` : to);
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
          <h1 className="dx-hub-title">
            {t("docs.hub.title.a", "Tasfer today.")}
            <br />
            <em>{t("docs.hub.title.b", "Every note on your own disk.")}</em>
          </h1>
          <p className="dx-hub-lede">
            {t(
              "docs.hub.lede.a",
              "Use and self-host the app now: peer-to-peer sync, end-to-end encryption, no accounts, and",
            )}{" "}
            <strong>
              {t("docs.hub.lede.b", "markdown files you can read without us.")}
            </strong>
          </p>

          <div className="dx-hub-branch">
            {/* App branch — primary, prominent */}
            <Link
              className="dx-branch dx-branch--primary"
              to="/docs/app/getting-started"
            >
              <div className="dx-branch-top">
                <span className="dx-branch-ic">
                  <Icons.Shield />
                </span>
                <span className="dx-branch-badge">
                  {t("docs.hub.app.badge", "the app · AGPL-3.0")}
                </span>
              </div>
              <h2 className="dx-branch-name">
                {t("docs.hub.app.name", "Tasfer, the app")}
              </h2>
              <p className="dx-branch-desc">
                {t(
                  "docs.hub.app.desc",
                  "A local-first, end-to-end encrypted markdown editor. Set it up, sync across your devices, run your own relay, and read exactly what stays on your disk.",
                )}
              </p>
              <div className="dx-branch-links">
                <BranchLink
                  label={t("docs.hub.app.link1", "Getting started")}
                  to="/docs/app/getting-started"
                />
                <BranchLink
                  label={t("docs.hub.app.link2", "Sync & relay setup")}
                  to="/docs/app/sync-relay"
                />
                <BranchLink
                  label={t("docs.hub.app.link3", "Privacy & data")}
                  to="/docs/app/privacy"
                />
              </div>
            </Link>

            {/* Future SDK branch — visible without promising a supported API. */}
            <Link
              className="dx-branch dx-branch--secondary"
              to="/docs/editor/roadmap"
            >
              <div className="dx-branch-top">
                <span className="dx-branch-ic">
                  <Icons.Terminal />
                </span>
                <span className="dx-branch-badge">
                  {t("docs.hub.editor.badge", "roadmap · MIT")}
                </span>
              </div>
              <h2 className="dx-branch-name mono">@tasfer/editor</h2>
              <p className="dx-branch-desc">
                {t(
                  "docs.hub.editor.desc",
                  "The Tasfer editor packages are MIT-licensed source. A supported public SDK is on the roadmap, but the packages are not published yet.",
                )}
              </p>
              <div className="dx-branch-links">
                <BranchLink
                  label={t("docs.hub.editor.link1", "View the roadmap")}
                  to="/docs/editor/roadmap"
                />
              </div>
            </Link>
          </div>
        </div>

        <div className="dx-hub-foot">
          <div className="dx-hub-foot-brand">
            <BrandMark />
            <span className="dx-hub-foot-name">
              {t("brand.wordmark", "tasfer")}
            </span>
          </div>
          <div className="dx-hub-foot-links">
            <Link to="/home">{t("docs.hub.foot.landing", "landing")}</Link>
            <Link to="/docs/app/getting-started">
              {t("docs.hub.foot.appDocs", "app docs")}
            </Link>
            <Link to="/docs/editor/roadmap">
              {t("docs.hub.foot.editorDocs", "SDK roadmap")}
            </Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              {t("docs.hub.foot.source", "source")}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
