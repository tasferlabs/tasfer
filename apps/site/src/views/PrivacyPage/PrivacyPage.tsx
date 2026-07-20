"use client";

import { Link } from "@/components/Link";
import { useTranslation } from "react-i18next";
import "./PrivacyPage.css";

export default function PrivacyPage() {
  const { t } = useTranslation();

  return (
    <div className="privacy">
      <nav className="privacy-nav">
        <Link to="/home" className="privacy-logo">
          tasfer
        </Link>
        <Link to="/home" className="privacy-nav-back">
          &larr; {t("privacy.backToHome", "back to home")}
        </Link>
      </nav>

      <section className="privacy-content">
        <div className="privacy-label">&gt; privacy</div>
        <h1 className="privacy-title">
          {t("privacy.title", "privacy policy")}
        </h1>
        <p className="privacy-date">
          {t("privacy.lastUpdated", "Last updated")}: March 25, 2026
        </p>

        <p className="privacy-intro">
          {t(
            "privacy.intro",
            "Tasfer is built on a simple principle: your data is yours. We don't collect it, we don't store it, we don't want it.",
          )}
        </p>

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

      <footer className="privacy-footer">
        <Link to="/home" className="privacy-logo">
          tasfer
        </Link>
      </footer>
    </div>
  );
}
