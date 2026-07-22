"use client";

import { useEffect, useState, type SVGProps } from "react";
import { Link } from "@/components/Link";
import BrandMark from "@/components/BrandMark";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/providers/ThemeProvider";
import { APP_OPEN_URL } from "@/lib/appUrl";
import "./DownloadPage.css";

const REPO_URL = "https://github.com/tasferlabs/tasfer";
const RELEASES_URL = `${REPO_URL}/releases`;

/**
 * Release assets are linked through GitHub's `latest` permalink, so the site
 * never has to know which version is current — no version constant to bump, no
 * redeploy when a release ships. That only holds while the filenames stay
 * versionless: they come from `artifactName` in
 * apps/desktop/electron-builder.yml. Change them there and here together.
 */
const FILES = {
  macArm: "Tasfer-arm64.dmg",
  macIntel: "Tasfer-x64.dmg",
  windows: "Tasfer-x64.exe",
  linuxAppImage: "Tasfer-x86_64.AppImage",
  linuxDeb: "Tasfer-amd64.deb",
  linuxPacman: "Tasfer-x64.pacman",
} as const;

const assetUrl = (file: string) => `${RELEASES_URL}/latest/download/${file}`;

/* ── Icons — Lucide-style 1.6px stroke, matching the landing page ── */

const Icons = {
  Arrow: (p: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  ),
  Download: (p: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M12 3v12M7 11l5 5 5-5M4 20h16" />
    </svg>
  ),
  GitHub: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.55 0-.27-.01-1.18-.02-2.14-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.24 2.75.12 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.4-5.27 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.55C20.22 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  ),
  Sun: (p: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  Moon: (p: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
    </svg>
  ),
};

function ThemeToggle() {
  const { effectiveTheme, setTheme } = useTheme();
  const isDark = effectiveTheme === "dark";
  return (
    <button
      className="dl-theme-btn"
      aria-label="toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Icons.Sun /> : <Icons.Moon />}
    </button>
  );
}

/* ── Platform detection ── */

type PlatformId = "mac" | "windows" | "linux" | "ios" | "android" | "web";

/**
 * Deliberately shallow UA sniffing: it only decides which build gets the hero
 * button and the "your device" badge. Every build stays one click away in the
 * grid below, so an unrecognised browser loses nothing.
 */
function detectPlatform(): PlatformId | null {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch points are what tell them apart.
  if (
    /iPhone|iPad|iPod/.test(ua) ||
    (/Mac/.test(ua) && navigator.maxTouchPoints > 1)
  )
    return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "mac";
  if (/Win/.test(ua)) return "windows";
  if (/Linux|X11/.test(ua)) return "linux";
  return null;
}

/* Apple Silicon vs Intel is deliberately NOT detected. The macOS user agent
   claims "Intel Mac OS X" on every Mac, and the one real signal — the
   `architecture` client hint — is Chromium-only (no Safari, no Firefox) and
   reports x86 for a Chrome running under Rosetta. Guessing wrong is not
   symmetric either: an arm64 build refuses to launch on an Intel Mac, while an
   Intel build merely runs under Rosetta. So macOS gets both buttons and picks
   for itself. */

/* ── Page ── */

interface Asset {
  label: string;
  /** Release asset filename — rendered as a download button. */
  file?: string;
  /** Destination that isn't a release asset (the browser build). */
  href?: string;
  /** No published build yet — rendered as a muted chip, not a link. */
  pending?: boolean;
}

export default function DownloadPage() {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<PlatformId | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const platforms: {
    id: PlatformId;
    name: string;
    desc: string;
    assets: Asset[];
  }[] = [
    {
      id: "mac",
      name: "macOS",
      desc: t("download.mac.desc", "Signed and notarized by Apple."),
      assets: [
        {
          label: t("download.mac.arm", "Apple Silicon .dmg"),
          file: FILES.macArm,
        },
        { label: t("download.mac.intel", "Intel .dmg"), file: FILES.macIntel },
      ],
    },
    {
      id: "windows",
      name: "Windows",
      desc: t(
        "download.windows.desc",
        "Signed installer. Windows 10 or later, 64-bit.",
      ),
      assets: [
        {
          label: t("download.windows.exe", "Installer .exe"),
          file: FILES.windows,
        },
      ],
    },
    {
      id: "linux",
      name: "Linux",
      desc: t("download.linux.desc", "Pick the package your distro speaks."),
      assets: [
        {
          label: t("download.linux.appimage", "AppImage"),
          file: FILES.linuxAppImage,
        },
        { label: t("download.linux.deb", "Debian .deb"), file: FILES.linuxDeb },
        {
          label: t("download.linux.pacman", "Arch .pacman"),
          file: FILES.linuxPacman,
        },
      ],
    },
    {
      id: "ios",
      name: "iOS",
      desc: t(
        "download.ios.desc",
        "Reads and writes the same encrypted files. Until the store build lands, Safari installs it to your home screen.",
      ),
      assets: [{ label: "App Store", pending: true }],
    },
    {
      id: "android",
      name: "Android",
      desc: t(
        "download.android.desc",
        "Same app, same files, no account. Until the store build lands, Chrome installs it to your home screen.",
      ),
      assets: [{ label: "Google Play", pending: true }],
    },
    {
      id: "web",
      name: t("download.web.name", "Web"),
      desc: t(
        "download.web.desc",
        "Nothing to install. Runs local-first in your browser.",
      ),
      assets: [
        { label: t("download.web.cta", "open tasfer"), href: APP_OPEN_URL },
      ],
    },
  ];

  /* The hero button follows the detected platform — macOS excepted, which shows
     both builds (see the note above detectPlatform). Before detection — what the
     prerendered HTML ships, and what a browser with JS off keeps — it points at
     the grid, so the page is never a dead end. */
  const hero =
    platform === "windows"
      ? { name: "Windows", file: FILES.windows }
      : platform === "linux"
        ? { name: "Linux", file: FILES.linuxAppImage }
        : null;

  const isMobile = platform === "ios" || platform === "android";

  return (
    <div className="dl-page">
      <header className={"dl-header" + (scrolled ? " is-scrolled" : "")}>
        <div className="dl-header-inner">
          <Link to="/home" className="dl-wordmark" aria-label="Tasfer home">
            <BrandMark className="dl-wordmark-mark" />
            tasfer
          </Link>
          <nav className="dl-nav">
            <Link to="/docs">{t("home.lp.nav.docs", "docs")}</Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              {t("home.lp.footer.source", "source")}
            </a>
            <ThemeToggle />
            <a className="dl-nav-cta" href={APP_OPEN_URL}>
              {t("home.lp.nav.open", "open tasfer")}
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="dl-hero">
          <div className="dl-hero-grid" aria-hidden="true" />
          <div className="dl-column">
            <h1 className="dl-title">
              {t("download.titleA", "Your machine.")}
              <br />
              <em>{t("download.titleEm", "Your copy.")}</em>
            </h1>

            <p className="dl-lede">
              {t(
                "download.lede",
                "No account. No telemetry. Download the binary, verify it if you like, and everything you write stays on the disk it was written to.",
              )}
            </p>

            <div className="dl-hero-actions">
              {platform === "mac" ? (
                <span className="dl-hero-pair">
                  <a
                    className="dl-btn dl-btn-accent"
                    href={assetUrl(FILES.macArm)}
                  >
                    <Icons.Download />
                    {t("download.mac.arm", "Apple Silicon .dmg")}
                  </a>
                  <a
                    className="dl-btn dl-btn-ghost"
                    href={assetUrl(FILES.macIntel)}
                  >
                    <Icons.Download />
                    {t("download.mac.intel", "Intel .dmg")}
                  </a>
                </span>
              ) : hero ? (
                <a className="dl-btn dl-btn-accent" href={assetUrl(hero.file)}>
                  <Icons.Download />
                  {t("download.forPlatform", "download for {{platform}}", {
                    platform: hero.name,
                  })}
                </a>
              ) : isMobile ? (
                <a className="dl-btn dl-btn-accent" href={APP_OPEN_URL}>
                  {t("download.web.cta", "open tasfer")}
                  <Icons.Arrow />
                </a>
              ) : (
                <a className="dl-btn dl-btn-accent" href="#platforms">
                  <Icons.Download />
                  {t("download.pick", "pick your platform")}
                </a>
              )}

              <p className="dl-hero-meta">
                {hero ? (
                  <>
                    <span className="dl-hero-file">
                      {t("download.latest", "latest release")} · {hero.file}
                    </span>
                    <span className="dl-hero-hint">
                      {t(
                        "download.detected",
                        "detected from your browser — everything else is below.",
                      )}
                    </span>
                  </>
                ) : (
                  <span className="dl-hero-hint">
                    {platform === "mac"
                      ? t(
                          "download.macHint",
                          "macOS detected. Both builds are native — the Apple menu, then About This Mac, names your chip.",
                        )
                      : isMobile
                        ? t(
                            "download.mobileHint",
                            "the store builds are not out yet — this one runs in your browser and installs to your home screen.",
                          )
                        : t(
                            "download.allHint",
                            "macOS, Windows, Linux, and the browser — every build is below.",
                          )}
                  </span>
                )}
              </p>
            </div>
          </div>
        </section>

        <section className="dl-platforms" id="platforms">
          <div className="dl-column">
            <div className="dl-grid">
              {platforms.map((p) => (
                <article
                  key={p.id}
                  className={
                    "dl-card" + (p.id === platform ? " is-detected" : "")
                  }
                >
                  <div className="dl-card-head">
                    <h2 className="dl-card-title">{p.name}</h2>
                    {p.id === platform && (
                      <span className="dl-card-badge">
                        {t("download.yourDevice", "your device")}
                      </span>
                    )}
                  </div>
                  <p className="dl-card-desc">{p.desc}</p>
                  <div className="dl-card-assets">
                    {p.assets.map((a) =>
                      a.pending ? (
                        <span key={a.label} className="dl-asset is-pending">
                          {a.label}
                          <span className="dl-asset-note">
                            {t("download.pending", "not yet published")}
                          </span>
                        </span>
                      ) : a.file ? (
                        <a
                          key={a.label}
                          className="dl-asset"
                          href={assetUrl(a.file)}
                        >
                          <Icons.Download />
                          {a.label}
                        </a>
                      ) : (
                        <a key={a.label} className="dl-asset" href={a.href}>
                          {a.label}
                          <Icons.Arrow />
                        </a>
                      ),
                    )}
                  </div>
                </article>
              ))}
            </div>

            <p className="dl-note">
              {t(
                "download.note",
                "macOS builds are notarized by Apple, Windows builds are signed, and every release ships sha512 sums alongside the binaries.",
              )}{" "}
              {t(
                "download.updates",
                "The desktop app checks GitHub for a newer release and asks before downloading one. Apart from spaces you choose to sync, that check is the only request it makes on its own.",
              )}{" "}
              <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                {t("download.releaseNotes", "release notes")}
              </a>
              {" · "}
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                {t("download.buildFromSource", "build it from source")}
              </a>
            </p>
          </div>
        </section>
      </main>

      <footer className="dl-footer">
        <div className="dl-footer-inner">
          <div className="dl-footer-brand">
            <BrandMark style={{ width: 18, height: 18 }} />
            <span className="dl-footer-word">tasfer</span>
          </div>
          <div className="dl-footer-links">
            <Link to="/home">{t("privacy.backToHome", "back to home")}</Link>
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
            <Link to="/privacy">{t("home.lp.footer.privacy", "privacy")}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
