"use client";

import { useEffect, useState, type SVGProps } from "react";
import { Link } from "@/components/Link";
import BrandMark from "@/components/BrandMark";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/providers/ThemeProvider";
import { APP_OPEN_URL } from "@/lib/appUrl";
import "./PrivacyPage.css";

/** Last substantive revision of this policy. Formatted in the active locale. */
const LAST_UPDATED = "2026-03-25";
const REPO_URL = "https://github.com/tasferlabs/tasfer";

const Icons = {
  Sun: (props: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  Moon: (props: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
    </svg>
  ),
};

function ThemeToggle() {
  const { effectiveTheme, setTheme } = useTheme();
  const { t } = useTranslation();
  const isDark = effectiveTheme === "dark";

  return (
    <button
      className="privacy-theme-btn"
      aria-label={t("common.toggleTheme", "Toggle theme")}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Icons.Sun /> : <Icons.Moon />}
    </button>
  );
}

export default function PrivacyPage() {
  const { t, i18n } = useTranslation();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // numberingSystem: "latn" because every other number in ar.json is written
  // with Western digits; Intl would otherwise default Arabic to Arabic-Indic.
  const lastUpdated = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "long",
    day: "numeric",
    numberingSystem: "latn",
  }).format(new Date(`${LAST_UPDATED}T00:00:00`));

  return (
    <div className="privacy">
      <header className={"privacy-header" + (scrolled ? " is-scrolled" : "")}>
        <div className="privacy-header-inner">
          <Link
            to="/home"
            className="privacy-wordmark"
            aria-label={t("home.lp.a11y.home", "Tasfer home")}
          >
            <BrandMark className="privacy-wordmark-mark" />
            {t("brand.wordmark", "tasfer")}
          </Link>
          <nav className="privacy-nav">
            <Link to="/docs">{t("home.lp.nav.docs", "docs")}</Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              {t("home.lp.nav.source", "source")}
            </a>
            <ThemeToggle />
            <a className="privacy-nav-cta" href={APP_OPEN_URL}>
              {t("home.lp.nav.open", "open tasfer")}
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="privacy-hero">
          <div className="privacy-hero-grid" aria-hidden="true" />
          <div className="privacy-content">
            <div className="privacy-label">
              {t("privacy.kicker", "privacy")}
            </div>
            <h1 className="privacy-title">
              {t("privacy.title", "privacy policy")}
            </h1>
            <p className="privacy-date">
              {t("privacy.lastUpdated", "Last updated")}: {lastUpdated}
            </p>

            <p className="privacy-intro">
              {t(
                "privacy.intro",
                "Tasfer is built on a simple principle: your data is yours. We don't collect it, we don't store it, we don't want it.",
              )}
            </p>
          </div>
        </section>

        <section className="privacy-content privacy-policy">
          <div className="privacy-items">
            <div className="privacy-item">
              <span className="privacy-item-num">01</span>
              <div>
                <h3>{t("privacy.noCollection", "No data collection")}</h3>
                <p>
                  {t(
                    "privacy.noCollectionDesc",
                    "Tasfer runs entirely on your device. We have no servers that receive, process, or store your content. Your documents never leave your machine unless you choose to sync with a peer.",
                  )}
                </p>
              </div>
            </div>

            <div className="privacy-item">
              <span className="privacy-item-num">02</span>
              <div>
                <h3>{t("privacy.p2pSync", "Peer-to-peer sync")}</h3>
                <p>
                  {t(
                    "privacy.p2pSyncDesc",
                    "When you collaborate, data flows directly between devices over encrypted WebRTC connections. Our signaling relay only helps peers find each other — it never sees your content.",
                  )}
                </p>
              </div>
            </div>

            <div className="privacy-item">
              <span className="privacy-item-num">03</span>
              <div>
                <h3>{t("privacy.noAnalytics", "No analytics or tracking")}</h3>
                <p>
                  {t(
                    "privacy.noAnalyticsDesc",
                    "No cookies, no trackers, no telemetry. We don't know who you are, what you write, or how you use the app.",
                  )}
                </p>
              </div>
            </div>

            <div className="privacy-item">
              <span className="privacy-item-num">04</span>
              <div>
                <h3>{t("privacy.noThirdParty", "No third parties")}</h3>
                <p>
                  {t(
                    "privacy.noThirdPartyDesc",
                    "There is no data to share because there is no data to collect. No advertising, no partnerships, no data brokers.",
                  )}
                </p>
              </div>
            </div>

            <div className="privacy-item">
              <span className="privacy-item-num">05</span>
              <div>
                <h3>{t("privacy.openSource", "Open source")}</h3>
                <p>
                  {t(
                    "privacy.openSourceDesc",
                    "Don't take our word for it. The entire codebase is open source — you can verify every claim on this page yourself.",
                  )}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="privacy-contact">
          <div className="privacy-contact-box">
            <p>
              {t("privacy.contact", "Questions? Reach out at")}{" "}
              <a href="mailto:hi@tasfer.app">hi@tasfer.app</a>
            </p>
          </div>
        </section>
      </main>

      <footer className="privacy-footer">
        <div className="privacy-footer-inner">
          <div className="privacy-footer-brand">
            <BrandMark className="privacy-footer-mark" />
            <span className="privacy-footer-word">
              {t("brand.wordmark", "tasfer")}
            </span>
          </div>
          <div className="privacy-footer-links">
            <Link to="/docs/internals/manifest">
              {t("home.lp.footer.manifesto", "manifesto")}
            </Link>
            <Link to="/docs">{t("home.lp.footer.docs", "docs")}</Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              {t("home.lp.footer.source", "source")}
            </a>
            <a
              href={`${REPO_URL}/blob/main/LICENSE`}
              target="_blank"
              rel="noreferrer"
            >
              {t("home.lp.footer.license", "license")}
            </a>
            <Link to="/privacy">
              {t("home.lp.footer.privacy", "privacy")}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
