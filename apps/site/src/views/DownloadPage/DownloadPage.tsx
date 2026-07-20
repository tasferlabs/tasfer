"use client";

import { Link } from "@/components/Link";
import { useTranslation } from "react-i18next";
import { APP_OPEN_URL } from "@/lib/appUrl";
import "./DownloadPage.css";

const RELEASES_URL = "https://github.com/hamza512b/tasfer/releases";

/**
 * Placeholder download page. The web build is the one install path that works
 * today, so it is the primary action; native desktop/mobile builds are still
 * being packaged. When signed builds ship, replace the "native" block with
 * per-platform download buttons (macOS / Windows / Linux / iOS / Android).
 */
export default function DownloadPage() {
  const { t } = useTranslation();

  return (
    <div className="download">
      <nav className="download-nav">
        <Link to="/home" className="download-logo">
          tasfer
        </Link>
        <Link to="/home" className="download-nav-back">
          &larr; {t("privacy.backToHome", "back to home")}
        </Link>
      </nav>

      <section className="download-content">
        <div className="download-label">&gt; download</div>
        <h1 className="download-title">
          {t("download.title", "Download Tasfer")}
        </h1>
        <p className="download-intro">
          {t(
            "download.intro",
            "Tasfer runs locally on your device. Today it installs straight from your browser — nothing to sign up for, your work never leaves your machine. Signed desktop and mobile builds are on the way.",
          )}
        </p>

        <div className="download-options">
          <a className="download-card is-primary" href={APP_OPEN_URL}>
            <span className="download-card-title">
              {t("download.web.title", "Open in your browser")}
            </span>
            <p className="download-card-desc">
              {t(
                "download.web.desc",
                "Launch Tasfer instantly — no install required. It works offline and can be added to your home screen as an app.",
              )}
            </p>
            <span className="download-card-cta">
              {t("download.web.cta", "Open Tasfer")} &rarr;
            </span>
          </a>

          <div className="download-card is-soon">
            <span className="download-card-title">
              {t("download.native.title", "Desktop & mobile")}
              <span className="download-badge">
                {t("download.native.badge", "coming soon")}
              </span>
            </span>
            <p className="download-card-desc">
              {t(
                "download.native.desc",
                "Native builds for macOS, Windows, Linux, iOS, and Android are being packaged. They will be published as signed releases on GitHub.",
              )}
            </p>
            <a
              className="download-card-cta"
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("download.native.cta", "Watch releases on GitHub")} &rarr;
            </a>
          </div>
        </div>
      </section>

      <footer className="download-footer">
        <Link to="/home" className="download-logo">
          tasfer
        </Link>
      </footer>
    </div>
  );
}
