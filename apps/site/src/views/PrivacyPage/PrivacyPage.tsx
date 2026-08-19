"use client";

import { Link } from "@/components/Link";
import BrandMark from "@/components/BrandMark";
import { REPO_URL, SiteHeader } from "@/components/SiteHeader";
import { useTranslation } from "react-i18next";
import { APP_OPEN_URL } from "@/lib/appUrl";
import "./PrivacyPage.css";

/** Last substantive revision of this policy. Formatted in the active locale. */
const LAST_UPDATED = "2026-03-25";

export default function PrivacyPage() {
  const { t, i18n } = useTranslation();
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
      <SiteHeader />

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
