"use client";

import { useEffect, useState, useRef, type SVGProps } from "react";
import { Link } from "@/components/Link";
import BrandMark from "@/components/BrandMark";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/providers/ThemeProvider";
import { loadArabicFonts } from "@/lib/fonts";
import { APP_OPEN_URL } from "@/lib/appUrl";
import "./HomePage.css";

const REPO_URL = "https://github.com/hamza512b/tasfer";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/* ── Icons — hand-rolled Lucide-style 1.5px stroke ── */

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
  Lock: (p: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <rect x="4" y="11" width="16" height="10" rx="1.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  Home: (p: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
    </svg>
  ),
  Link: (p: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07L11.5 4.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07L12.5 19.5" />
    </svg>
  ),
  ArrowLeftRight: (p: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </svg>
  ),
};

/* ── Theme toggle wired to the app's ThemeProvider ── */

function ThemeToggle() {
  const { effectiveTheme, setTheme } = useTheme();
  const isDark = effectiveTheme === "dark";
  return (
    <button
      className="lp-theme-btn"
      aria-label="toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Icons.Sun /> : <Icons.Moon />}
    </button>
  );
}

/* ── Animated stateless relay diagram ── */

function RelayDiagram() {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [auto, setAuto] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const steps = [
    {
      key: "introduce",
      label: t("home.lp.relay.introduce.label", "introduce"),
      caption: t(
        "home.lp.relay.introduce.caption",
        "The relay's only job: tell Alice and Bob how to reach each other. It does not authenticate them. It does not learn anything else.",
      ),
      memory: t("home.lp.relay.memory.ephemeral", "ephemeral"),
    },
    {
      key: "direct",
      label: t("home.lp.relay.direct.label", "direct (default)"),
      caption: t(
        "home.lp.relay.direct.caption",
        "Alice and Bob talk peer-to-peer over an encrypted channel they alone negotiated. The relay is no longer in the path.",
      ),
      memory: t("home.lp.relay.memory.empty", "empty"),
    },
    {
      key: "fallback",
      label: t("home.lp.relay.fallback.label", "fallback"),
      caption: t(
        "home.lp.relay.fallback.caption",
        "When a direct connection isn't possible, the relay forwards encrypted bytes it cannot decrypt. It still holds no accounts and stores no messages.",
      ),
      memory: t("home.lp.relay.memory.forwarding", "forwarding (encrypted)"),
    },
  ];

  useEffect(() => {
    if (!auto) return;
    timerRef.current = setTimeout(() => {
      setStep((s) => (s + 1) % steps.length);
    }, 3600);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [step, auto, steps.length]);

  function pick(i: number) {
    setAuto(false);
    setStep(i);
  }

  const cur = steps[step];

  const A = { x: 120, y: 220 };
  const B = { x: 680, y: 220 };
  const R = { x: 400, y: 80 };

  const pathThroughRelay = `M ${A.x} ${A.y} Q ${R.x} ${R.y - 20} ${B.x} ${B.y}`;
  const pathDirect = `M ${A.x} ${A.y} Q ${(A.x + B.x) / 2} ${A.y + 30} ${B.x} ${B.y}`;

  return (
    <div className="lp-relay-wrap">
      <div className="lp-relay-stage">
        <svg
          className="lp-relay-svg"
          viewBox="0 0 800 340"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <linearGradient id="relay-flow" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0" />
              <stop offset="50%" stopColor="var(--primary)" stopOpacity="1" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
            </linearGradient>
            <marker
              id="relay-tip"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0 0 L10 5 L0 10 z" fill="var(--primary)" />
            </marker>
          </defs>

          {/* Background dashed paths — both possible routes, faint */}
          <path
            d={pathThroughRelay}
            stroke="var(--border)"
            strokeWidth="1.5"
            strokeDasharray="3 5"
            fill="none"
          />
          <path
            d={pathDirect}
            stroke="var(--border)"
            strokeWidth="1.5"
            strokeDasharray="3 5"
            fill="none"
            opacity={step === 2 ? 0 : 0.6}
            style={{ transition: "opacity 0.4s ease" }}
          />

          {(step === 0 || step === 2) && (
            <g style={{ transition: "opacity 0.4s ease" }}>
              <path
                d={pathThroughRelay}
                stroke="var(--primary)"
                strokeWidth="2.2"
                fill="none"
                strokeDasharray="12 8"
                style={{ animation: "lp-relay-dash 1.4s linear infinite" }}
              />
            </g>
          )}
          {step === 1 && (
            <g>
              <path
                d={pathDirect}
                stroke="var(--primary)"
                strokeWidth="2.4"
                fill="none"
                strokeDasharray="12 8"
                style={{ animation: "lp-relay-dash 1.2s linear infinite" }}
              />
            </g>
          )}

          {/* Relay node — dimmed when peers talk directly (step 1) */}
          <g
            style={{
              opacity: step === 1 ? 0.35 : 1,
              transition: "opacity 0.5s ease",
            }}
          >
            <circle
              cx={R.x}
              cy={R.y}
              r="36"
              fill="var(--bg)"
              stroke="var(--fg)"
              strokeWidth="1.4"
            />
            <circle
              cx={R.x}
              cy={R.y}
              r={step === 1 ? 36 : 48}
              fill="none"
              stroke="var(--primary)"
              strokeOpacity={step === 1 ? 0 : 0.25}
              strokeWidth="1"
              style={{ transition: "all 0.5s ease" }}
            />
            <g
              transform={`translate(${R.x - 9}, ${R.y - 10})`}
              stroke="var(--fg)"
              strokeWidth="1.4"
              fill="none"
              strokeLinecap="round"
            >
              <path d="M3 4 L9 4 L13 16 L-1 16 Z" fill="none" />
              <path
                d="M-3 0 Q 6 -4 15 0"
                strokeOpacity={step === 0 ? 1 : 0.3}
              />
              <path
                d="M-5 -4 Q 6 -10 17 -4"
                strokeOpacity={step === 0 ? 0.6 : 0.15}
              />
            </g>
            {step === 2 && (
              <g transform={`translate(${R.x + 22}, ${R.y - 30})`}>
                <circle r="11" fill="var(--primary)" />
                <g
                  transform="translate(-5,-5)"
                  stroke="var(--bg)"
                  strokeWidth="1.4"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect
                    x="1.5"
                    y="5"
                    width="7"
                    height="5"
                    rx="0.8"
                    fill="var(--bg)"
                  />
                  <path d="M3 5 V3.5 a2 2 0 0 1 4 0 V5" />
                </g>
              </g>
            )}
            <text
              x={R.x}
              y={R.y + 60}
              textAnchor="middle"
              className="lp-relay-node"
            >
              {t("home.lp.relay.node.relay", "relay")}
            </text>
            <text
              x={R.x}
              y={R.y + 78}
              textAnchor="middle"
              className="lp-relay-sub"
            >
              {t("home.lp.relay.node.memory", "memory:")} {cur.memory}
            </text>
          </g>

          {/* Alice */}
          <g>
            <circle
              cx={A.x}
              cy={A.y}
              r="34"
              fill="var(--surface-raised)"
              stroke="var(--fg)"
              strokeWidth="1.4"
            />
            <text
              x={A.x}
              y={A.y + 5}
              textAnchor="middle"
              className="lp-relay-node"
              style={{
                fontFamily: "var(--font-editorial)",
                fontStyle: "italic",
                fontSize: 16,
              }}
            >
              A
            </text>
            <text
              x={A.x}
              y={A.y + 60}
              textAnchor="middle"
              className="lp-relay-node"
            >
              {t("home.lp.relay.node.alice", "alice")}
            </text>
            <text
              x={A.x}
              y={A.y + 78}
              textAnchor="middle"
              className="lp-relay-sub"
            >
              {t("home.lp.relay.node.herDevice", "her device")}
            </text>
          </g>

          {/* Bob */}
          <g>
            <circle
              cx={B.x}
              cy={B.y}
              r="34"
              fill="var(--surface-raised)"
              stroke="var(--fg)"
              strokeWidth="1.4"
            />
            <text
              x={B.x}
              y={B.y + 5}
              textAnchor="middle"
              className="lp-relay-node"
              style={{
                fontFamily: "var(--font-editorial)",
                fontStyle: "italic",
                fontSize: 16,
              }}
            >
              B
            </text>
            <text
              x={B.x}
              y={B.y + 60}
              textAnchor="middle"
              className="lp-relay-node"
            >
              {t("home.lp.relay.node.bob", "bob")}
            </text>
            <text
              x={B.x}
              y={B.y + 78}
              textAnchor="middle"
              className="lp-relay-sub"
            >
              {t("home.lp.relay.node.hisDevice", "his device")}
            </text>
          </g>

          {step === 1 && (
            <circle r="5" fill="var(--primary)">
              <animateMotion
                dur="2.2s"
                repeatCount="indefinite"
                path={pathDirect}
              />
            </circle>
          )}
          {step === 2 && (
            <circle r="5" fill="var(--primary)">
              <animateMotion
                dur="2.4s"
                repeatCount="indefinite"
                path={pathThroughRelay}
              />
            </circle>
          )}
        </svg>

        <style>{`
          @keyframes lp-relay-dash {
            from { stroke-dashoffset: 20; }
            to   { stroke-dashoffset: 0;  }
          }
        `}</style>
      </div>

      <div className="lp-relay-controls">
        <p className="lp-relay-caption">
          <strong>
            {step + 1}/3 — {cur.label}.
          </strong>{" "}
          {cur.caption}
        </p>
        <div className="lp-relay-steps" role="tablist">
          {steps.map((s, i) => (
            <button
              key={s.key}
              role="tab"
              aria-selected={i === step}
              className={"lp-relay-step" + (i === step ? " is-active" : "")}
              onClick={() => pick(i)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const { t, i18n } = useTranslation();
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const [installable, setInstallable] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (i18n.language === "ar") {
      loadArabicFonts();
    }
  }, [i18n.language]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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

  const showInstall = installable && !installed;

  const scrollTo = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const pillars = [
    {
      icon: <Icons.Home />,
      name: t("home.lp.pillar.local.name", "local-first"),
      body: t(
        "home.lp.pillar.local.body",
        "Every keystroke lands in your storage. Not 'syncs to your storage.' Lands. The network is a choice, not a dependency. Pull the plug and Tasfer keeps working.",
      ),
    },
    {
      icon: <Icons.Lock />,
      name: t("home.lp.pillar.e2e.name", "end-to-end encrypted"),
      body: t(
        "home.lp.pillar.e2e.body",
        "Documents are encrypted on your device before they ever cross a wire. Only the people you share with hold the keys. The relay is structurally unable to read your work — not 'promises not to.' Cannot.",
      ),
    },
    {
      icon: <Icons.Link />,
      name: t("home.lp.pillar.relay.name", "stateless relay"),
      body: t(
        "home.lp.pillar.relay.body",
        "A postman with no inbox. It introduces peers, then forgets they met. No account database. No message log. No surface for a subpoena, a leak, or a curious engineer to land on.",
      ),
    },
  ];

  const refusals: [string, string, string][] = [
    [
      "i.",
      t("home.lp.refusal.keys.name", "your keys"),
      t(
        "home.lp.refusal.keys.detail",
        "End-to-end encryption with keys generated on your device. They never leave it. We could not read your notes if a court ordered us to.",
      ),
    ],
    [
      "ii.",
      t("home.lp.refusal.sync.name", "your sync"),
      t(
        "home.lp.refusal.sync.detail",
        "Direct, peer-to-peer, on your timing. Off by default. With the people you pick — and no one else in the room.",
      ),
    ],
    [
      "iii.",
      t("home.lp.refusal.backups.name", "your backups"),
      t(
        "home.lp.refusal.backups.detail",
        "Copy the folder. Email it to yourself. Print it. Bury it in a tin. Tasfer does not own a single byte you write.",
      ),
    ],
    [
      "iv.",
      t("home.lp.refusal.fork.name", "your fork"),
      t(
        "home.lp.refusal.fork.detail",
        "AGPL-3.0 or MIT. Take the code. Swap the relay for your own. Ship your own build. The license is the point: the refusal is in the code, and the code is yours to keep.",
      ),
    ],
    [
      "v.",
      t("home.lp.refusal.leave.name", "your right to leave"),
      t(
        "home.lp.refusal.leave.detail",
        "There is no account to delete because there was never one to begin with. You walk away by making an export and closing the tab.",
      ),
    ],
    [
      "vi.",
      t("home.lp.refusal.attention.name", "your attention"),
      t(
        "home.lp.refusal.attention.detail",
        "No ads. No analytics. No engagement loops. The page you are reading is the last one we will ever ask you to sit through.",
      ),
    ],
  ];

  const knows: string[] = [
    t("home.lp.knows.email.key", "your email address"),
    t("home.lp.knows.name.key", "your name"),
    t("home.lp.knows.docs.key", "your documents"),
    t("home.lp.knows.sync.key", "who you sync with"),
    t("home.lp.knows.habits.key", "your editing habits"),
    t("home.lp.knows.fingerprint.key", "device fingerprint"),
  ];

  return (
    <div className="lp-page">
      <header className={"lp-header" + (scrolled ? " is-scrolled" : "")}>
        <div className="lp-header-inner">
          <Link to="/home" className="lp-wordmark" aria-label="Tasfer home">
            <BrandMark className="lp-wordmark-mark" />
            tasfer
          </Link>
          <nav className="lp-nav">
            <Link to="/docs">{t("home.lp.nav.docs", "docs")}</Link>
            <a href="#repo" onClick={scrollTo("repo")}>
              {t("home.lp.nav.source", "source")}
            </a>
            <ThemeToggle />
            <a className="lp-nav-cta" href={APP_OPEN_URL}>
              {t("home.lp.nav.open", "open tasfer")}
            </a>
          </nav>
        </div>
      </header>

      <main>
        {/* ── Hero ── */}
        <section className="lp-hero">
          <div className="lp-hero-grid" aria-hidden="true" />
          <div className="column-wide" style={{ position: "relative" }}>
            <h1 className="lp-hero-title">
              {t("home.lp.hero.titleA", "You hand your thoughts")}
              <br />
              {t("home.lp.hero.titleB", "to strangers.")}
              <br />
              <em>{t("home.lp.hero.titleEm", "Every day.")}</em>
            </h1>
            <p className="lp-hero-lede">
              {t(
                "home.lp.hero.lede1",
                "Open a tab. Open a notes app. Type a half-formed idea, a draft email, a thing you would not say out loud. It lands on a server you do not own, in a city you have never been to, governed by a fourteen-page agreement you did not read. ",
              )}
              <strong>
                {t("home.lp.hero.ledeStrong", "Tasfer refuses that trade.")}
              </strong>
              {t(
                "home.lp.hero.lede2",
                " Your files stay on your disk. Your keys never leave it. Sync is peer-to-peer and forgets you the moment it is done.",
              )}
            </p>
            <div className="lp-hero-actions">
              <a className="lp-btn lp-btn-accent" href={APP_OPEN_URL}>
                {t("home.lp.hero.open", "open tasfer")}
                <Icons.Arrow />
              </a>
              {showInstall && (
                <button className="lp-btn lp-btn-ghost" onClick={handleInstall}>
                  <Icons.Download />
                  {t("home.lp.hero.install", "install app")}
                </button>
              )}
              <a
                className="lp-btn lp-btn-ghost"
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
              >
                <Icons.GitHub />
                {t("home.lp.hero.readSource", "read the source")}
              </a>
            </div>
            <div className="lp-hero-meta">
              <span className="lp-hero-tagline">
                {t("home.lp.hero.metaTailOpenSource", "Open source project")}
              </span>
              <span>
                {t(
                  "home.lp.hero.metaTail",
                  "0 accounts · 0 trackers · you choose what to share",
                )}
              </span>
            </div>
          </div>
        </section>

        {/* ── Definition — what Tasfer is, plainly ── */}
        <section id="definition" className="lp-section lp-define">
          <div className="column">
            <h2 className="lp-section-title">
              {t("home.lp.define.titleA", "Tasfer is a ")}
              <em>{t("home.lp.define.titleEm", "markdown-based editor")}</em>
              {t("home.lp.define.titleB", ".")}
            </h2>
            <p className="lp-define-lede">
              {t(
                "home.lp.define.lede",
                "An app you write in. Notes, drafts, journals — stored on your own disk, encrypted end-to-end when they travel, synced device-to-device with no central server and no account.",
              )}
            </p>
            <blockquote className="lp-pullquote">
              {t(
                "home.lp.define.pull",
                "A place to write, an encrypted way to carry it, and the source code to prove both. That is the whole product.",
              )}
            </blockquote>
            <dl className="lp-define-facts">
              <div className="lp-define-fact">
                <dt>{t("home.lp.define.fact.storageK", "storage")}</dt>
                <dd>{t("home.lp.define.fact.storageV", "your disk")}</dd>
              </div>
              <div className="lp-define-fact">
                <dt>{t("home.lp.define.fact.syncK", "sync")}</dt>
                <dd className="lp-define-sync">
                  {t("home.lp.define.fact.syncDevice", "device")}
                  <Icons.ArrowLeftRight
                    className="lp-define-sync-icon"
                    aria-hidden="true"
                  />
                  {t("home.lp.define.fact.syncDevice", "device")}
                </dd>
              </div>
            </dl>
            <div className="lp-define-actions">
              <a
                className="lp-btn lp-btn-primary"
                href="#premise"
                onClick={scrollTo("premise")}
              >
                {t("home.lp.define.readCase", "read the case")}
                <Icons.Arrow />
              </a>
            </div>
          </div>
        </section>

        {/* ── I — Premise ── */}
        <section id="premise" className="lp-section lp-premise">
          <div className="column-wide">
            <div className="lp-premise-grid">
              <aside className="lp-margin-note">
                {t(
                  "home.lp.premise.note",
                  "You would not mail your diary to a stranger. You type it into one, every morning, for free.",
                )}
              </aside>
              <div className="lp-prose">
                <h2 className="lp-section-title">
                  {t("home.lp.premise.titleA", "You wouldn't mail it.")}
                  <br />
                  <em>{t("home.lp.premise.titleEm", "You type it.")}</em>
                </h2>
                <p>
                  {t(
                    "home.lp.premise.p1",
                    "You would not hand a notebook to someone in the street. You would not read your medical history into a stranger's phone. You would not shout your half-drafted resignation letter into a crowd.",
                  )}
                </p>
                <p>
                  {t(
                    "home.lp.premise.p2",
                    "And yet — every free notes app, every free document, every free AI assistant is a trade. Your thoughts, in plain text, on a machine you will never see, indexed by software you will never read, owned by a company that will outlive you or be outlived by you. The bargain is so quiet you forget you took it.",
                  )}
                </p>
                <blockquote className="lp-pullquote">
                  {t(
                    "home.lp.premise.pull",
                    "A grocery list deserves the same dignity as a manifesto.",
                  )}
                </blockquote>
                <p>
                  {t("home.lp.premise.p3a", "Tasfer does not take the trade. ")}
                  <strong>
                    {t(
                      "home.lp.premise.p3strong",
                      "Not the storage. Not the keys. Not the protocol. Not the permission to leave.",
                    )}
                  </strong>
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── II — Mechanism ── */}
        <section id="mechanism" className="lp-section">
          <div className="column">
            <h2 className="lp-section-title">
              {t("home.lp.mechanism.titleA", "Three places.")}{" "}
              <em>{t("home.lp.mechanism.titleEm", "None of them ours.")}</em>
            </h2>
            <div className="lp-prose">
              <p>
                <strong>
                  {t("home.lp.mechanism.p1strong", "On your device.")}
                </strong>
                {t(
                  "home.lp.mechanism.p1",
                  ' Every keystroke lands in your own storage, instantly — no round-trip, no "saving" spinner reporting back to a server somewhere. Tasfer works on a plane, in a basement, in a Faraday cage.',
                )}
              </p>
              <p>
                <strong>
                  {t("home.lp.mechanism.p2strong", "Between your devices.")}
                </strong>
                {t(
                  "home.lp.mechanism.p2",
                  " When you sync, traffic flows peer-to-peer, encrypted with keys that never leave your hardware. Your laptop talks to your phone the way two friends meet — in person, with no third party in the room.",
                )}
              </p>
              <p>
                <strong>
                  {t(
                    "home.lp.mechanism.p3strong",
                    "Through a stateless relay — only when a direct path can't be made.",
                  )}
                </strong>
                {t(
                  "home.lp.mechanism.p3",
                  " It forwards bytes it cannot decrypt. No accounts. No logs. No memory of who connected to whom. It introduces, then forgets. And if you don't trust ours, point Tasfer at your own — it's a config field.",
                )}
              </p>
            </div>
          </div>

          <div className="column-wide">
            <RelayDiagram />
          </div>
        </section>

        {/* ── Pillars ── */}
        <div className="column-wide">
          <div className="lp-pillars">
            {pillars.map((p) => (
              <div className="lp-pillar" key={p.name}>
                <div className="lp-pillar-icon">{p.icon}</div>
                <h3 className="lp-pillar-name">{p.name}</h3>
                <p className="lp-pillar-body">{p.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── III — What is yours ── */}
        <section id="refusal" className="lp-section lp-refusal">
          <div className="column">
            <h2 className="lp-section-title">
              {t("home.lp.refusal.titleA", "A short inventory of ")}
              <em>{t("home.lp.refusal.titleEm", "what stays yours.")}</em>
            </h2>
            <ul className="lp-refusal-list">
              {refusals.map(([n, name, detail]) => (
                <li className="lp-refusal-item" key={name}>
                  <span className="lp-refusal-name">{name}</span>
                  <span className="lp-refusal-detail">{detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── IV — In the open ── */}
        <section id="repo" className="lp-section">
          <div className="column">
            <h2 className="lp-section-title">
              {t("home.lp.repo.titleA", "Don't trust us.")}{" "}
              <em>{t("home.lp.repo.titleEm", "Read the code.")}</em>
            </h2>
            <div className="lp-prose">
              <p>
                {t(
                  "home.lp.repo.p",
                  "Every privacy promise on the internet is a sentence on a webpage. Ours is a directory of source files. The encryption is in the repo. The relay is in the repo. The protocol is in the repo. Every line that runs between you and the words you wrote is something you can audit, fork, or replace with a build of your own.",
                )}
              </p>
            </div>

            <div className="lp-repo">
              <div>
                <h3 className="lp-repo-title">github.com/hamza512b/tasfer</h3>
                <p className="lp-repo-sub">
                  {t(
                    "home.lp.repo.repoSub",
                    "Every commit. Every dependency. Yours to read, yours to change, yours to keep.",
                  )}
                </p>
                <div className="lp-repo-actions">
                  <a
                    className="lp-btn lp-btn-primary"
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icons.GitHub />
                    {t("home.lp.repo.browse", "browse the source")}
                  </a>
                  <a
                    className="lp-btn lp-btn-ghost"
                    href={`${REPO_URL}#readme`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("home.lp.repo.spec", "read the protocol spec")}
                    <Icons.Arrow />
                  </a>
                </div>
              </div>
              {/* <div className="lp-repo-stats">
                <div className="lp-repo-stat">
                  <span className="v">AGPL-3.0</span>
                  <span className="k">
                    {t("home.lp.repo.stat.copyleft", "copyleft")}
                  </span>
                </div>
                <div className="lp-repo-stat">
                  <span className="v">0</span>
                  <span className="k">
                    {t("home.lp.repo.stat.trackers", "trackers")}
                  </span>
                </div>
                <div className="lp-repo-stat">
                  <span className="v">0</span>
                  <span className="k">
                    {t("home.lp.repo.stat.accounts", "accounts")}
                  </span>
                </div>
                <div className="lp-repo-stat">
                  <span className="v">
                    {t("home.lp.repo.stat.swapV", "swap")}
                  </span>
                  <span className="k">
                    {t("home.lp.repo.stat.swapK", "the relay")}
                  </span>
                </div>
              </div> */}
            </div>
          </div>
        </section>

        {/* ── V — Begin ── */}
        <section className="lp-finale">
          <div
            className="lp-hero-grid"
            aria-hidden="true"
            style={{ opacity: 0.35 }}
          />
          <div className="column" style={{ position: "relative" }}>
            <h2 className="lp-finale-title">
              {t("home.lp.finale.titleA", "Your words.")}
              <br />
              {t("home.lp.finale.titleB", "Your machine.")}
              <br />
              <em>{t("home.lp.finale.titleEm", "Your rules.")}</em>
            </h2>
            <p className="lp-finale-sub">
              {t(
                "home.lp.finale.sub",
                "Install it. Fork it. Swap the relay. Take it offline for a year. Hand it to a friend. Bury it. Walk away. The choice was always supposed to be yours — Tasfer is the editor that finally agrees.",
              )}
            </p>
            <div className="lp-finale-actions">
              <a className="lp-btn lp-btn-primary" href={APP_OPEN_URL}>
                {t("home.lp.finale.open", "open tasfer")}
                <Icons.Arrow />
              </a>
              {showInstall && (
                <button className="lp-btn lp-btn-ghost" onClick={handleInstall}>
                  <Icons.Download />
                  {t("home.lp.hero.install", "install app")}
                </button>
              )}
              <a
                className="lp-btn lp-btn-ghost"
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
              >
                <Icons.GitHub />
                {t("home.lp.finale.github", "github")}
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <BrandMark style={{ width: 18, height: 18 }} />
            <span className="lp-footer-word">tasfer</span>
          </div>
          <div className="lp-footer-links">
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
            <Link to="/privacy">{t("home.lp.footer.privacy", "privacy")}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
