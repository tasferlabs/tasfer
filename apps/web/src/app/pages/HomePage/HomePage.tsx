import { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { loadArabicFonts } from "@/editor/fonts";
import "./HomePage.css";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function HomePage() {
  const { t, i18n } = useTranslation();
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const [installable, setInstallable] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (i18n.language === "ar") {
      loadArabicFonts();
    }
  }, [i18n.language]);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      deferredPrompt.current = e as BeforeInstallPromptEvent;
      setInstallable(true);
    };

    const onAppInstalled = () => {
      setInstalled(true);
      setInstallable(false);
      deferredPrompt.current = null;
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppInstalled);

    // Check if already running as installed PWA
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setInstalled(true);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt.current) return;
    await deferredPrompt.current.prompt();
    const { outcome } = await deferredPrompt.current.userChoice;
    if (outcome === "accepted") {
      setInstalled(true);
      setInstallable(false);
    }
    deferredPrompt.current = null;
  };

  return (
    <div className="home">
      <div className="home-grid" />

      <nav className="home-nav">
        <span className="home-logo">cypher</span>
      </nav>

      <section className="home-hero">
        <div className="home-hero-label">&gt; system.manifest</div>
        <h1 className="home-title">
          {t("home.heroLine1", "your words.")}
          <br />
          {t("home.heroLine2", "your machine.")}
          <br />
          <span className="home-title-accent">{t("home.heroLine3", "your rules.")}</span>
        </h1>
        <p className="home-subtitle">{t("home.heroSubtitle", "A canvas-based editor that runs on your device, syncs peer-to-peer, and answers to no server. Your data never leaves your hands.")}</p>
        <div className="home-hero-actions">
          {installable && !installed && (
            <button onClick={handleInstall} className="home-btn home-btn-lg home-btn-install">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 1v9M4.5 6.5 8 10l3.5-3.5M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {t("home.installApp", "install app")}
            </button>
          )}
          <Link to="/page" className="home-btn home-btn-lg home-btn-open">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3H3v10h10v-3M9 1h6v6M15 1 7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {t("home.openInBrowser", "open in browser")}
          </Link>
          <a href="#manifesto" className="home-link">
            {t("home.readManifesto", "read the manifesto")} &darr;
          </a>
        </div>
      </section>

      <section id="manifesto" className="home-section">
        <div className="home-section-label">&gt; manifesto</div>
        <div className="home-manifesto">
          <p>{t("home.manifestoParagraph1", "We built another editor. Not because the world needed one — but because every existing one asks you to trust someone else with your thoughts.")}</p>
          <p>{t("home.manifestoParagraph2", "Cypher is a rejection of that premise. No cloud you don't control. No server that can go down and take your work with it. No company that can read your notes, change the terms, or shut the doors.")}</p>
          <p>{t("home.manifestoParagraph3", "Your documents live on your device. When you collaborate, data flows directly between peers — encrypted, ephemeral, yours. The architecture doesn't just support this philosophy. It enforces it.")}</p>
        </div>
      </section>

      <section className="home-section">
        <div className="home-section-label">&gt; architecture</div>
        <div className="home-arch-grid">
          <div className="home-arch-card">
            <div className="home-arch-header">
              <span className="home-arch-indicator" />
              {t("home.localFirst", "local-first")}
            </div>
            <p>{t("home.localFirstDesc", "Everything runs on your machine. IndexedDB for storage, canvas for rendering. No round-trips, no loading spinners, no permission asked.")}</p>
          </div>
          <div className="home-arch-card">
            <div className="home-arch-header">
              <span className="home-arch-indicator" />
              {t("home.peerToPeer", "peer-to-peer")}
            </div>
            <p>{t("home.peerToPeerDesc", "Direct connections between devices. A thin relay finds your peers — then steps aside. No data stored, no data read, no data owned.")}</p>
          </div>
          <div className="home-arch-card">
            <div className="home-arch-header">
              <span className="home-arch-indicator" />
              {t("home.encrypted", "encrypted by default")}
            </div>
            <p>{t("home.encryptedDesc", "Data is encrypted on your device before it goes anywhere. Only you hold the keys. Not even we can read what you write.")}</p>
          </div>
          <div className="home-arch-card">
            <div className="home-arch-header">
              <span className="home-arch-indicator" />
              {t("home.alwaysInSync", "always in sync")}
            </div>
            <p>{t("home.alwaysInSyncDesc", "Edit on multiple devices. Go offline for days. Come back and everything merges — no conflicts, no data loss.")}</p>
          </div>
        </div>
      </section>


      <section className="home-section">
        <div className="home-section-label">&gt; principles</div>
        <div className="home-principles">
          <div className="home-principle">
            <span className="home-principle-num">01</span>
            <div>
              <h3>{t("home.principle1Title", "No landlords")}</h3>
              <p>{t("home.principle1Desc", "Your editor should not have a login wall, a pricing page, or a terms of service update every quarter.")}</p>
            </div>
          </div>
          <div className="home-principle">
            <span className="home-principle-num">02</span>
            <div>
              <h3>{t("home.principle2Title", "Offline is the default")}</h3>
              <p>{t("home.principle2Desc", "Network is a feature, not a requirement. Everything works without it. Sync is a bonus.")}</p>
            </div>
          </div>
          <div className="home-principle">
            <span className="home-principle-num">03</span>
            <div>
              <h3>{t("home.principle3Title", "Fork the movement")}</h3>
              <p>{t("home.principle3Desc", "Open source means you can take this, change it, ship it. Build exactly what you want. No permission needed.")}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="home-section home-cta">
        <div className="home-section-label">&gt; begin</div>
        <h2 className="home-cta-title">{t("home.ctaTitle", "download. write. own it.")}</h2>
        <p className="home-cta-sub">{t("home.ctaSubtitle", "No account required. No cloud. No strings.")}</p>
        <div className="home-cta-actions">
          {installable && !installed && (
            <button onClick={handleInstall} className="home-btn home-btn-lg home-btn-install">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 1v9M4.5 6.5 8 10l3.5-3.5M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {t("home.installApp", "install app")}
            </button>
          )}
          <Link to="/page" className="home-btn home-btn-lg home-btn-open">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3H3v10h10v-3M9 1h6v6M15 1 7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {t("home.openInBrowser", "open in browser")}
          </Link>
        </div>
      </section>

      <footer className="home-footer">
        <span className="home-logo">cypher</span>
        <div className="home-footer-right">
          <Link to="/privacy" className="home-link">{t("privacy.title", "privacy policy")}</Link>
          <span className="home-footer-text">{t("home.footerText", "decentralized by design. built in the open.")}</span>
        </div>
      </footer>
    </div>
  );
}
