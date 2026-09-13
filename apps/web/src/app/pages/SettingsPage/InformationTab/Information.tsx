import { BookOpen, Bug, ChevronRight, Download, Github, Scale, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import styles from "./Information.module.css";
import { Switch } from "@/components/ui/switch";
import {
  isDevToolsUnlocked,
  setDevToolsEnabled,
  unlockDevTools,
  useDevToolsEnabled,
  useDevToolsUnlocked,
} from "@/lib/devTools";
import { getClientPlatform } from "@/platform";
import { publicAssetUrl } from "@/lib/publicAssetUrl";
import { formatAbsoluteDateTime } from "@/lib/dateTimePreferences";
import { useDateTimePrefs } from "@/app/contexts/DateTimePrefsContext";
import { SITE_URL } from "@/app/routes/siteUrl";
import { APP_VERSION, BUILD_TIMESTAMP, getBuildDate } from "@/version";

// Taps on the version line needed to reveal the hidden Tasfer Inspector toggle
// (the classic Android "tap build number" gesture).
const UNLOCK_TAPS = 7;

const REPO_URL = "https://github.com/tasferlabs/tasfer";
const ISSUES_URL = `${REPO_URL}/issues`;
const AUTHOR_URL = "https://www.hamza.se";

/**
 * A page on the marketing/docs site. The locale segment is hard-coded because
 * the site ships English only (`SUPPORTED_LNGS` in apps/site), so following the
 * app's language would produce a 404 the moment the UI is in Arabic. The
 * trailing slash matches the site's `trailingSlash: true` and saves a redirect.
 */
const siteLink = (path: string) => `${SITE_URL}/en/${path}/`;

// Where to surface the in-app Tasfer Inspector switch. iOS (Settings bundle) and
// desktop (app menu) expose OS-level controls instead, so the in-app toggle is
// shown only where there's no native equivalent.
const SHOW_IN_APP_DEV_TOGGLE =
  getClientPlatform() === "android" || getClientPlatform() === "web";

function LinkRow({
  icon: Icon,
  label,
  href,
}: {
  icon: LucideIcon;
  label: string;
  href: string;
}) {
  return (
    <a
      className={styles.link}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      <Icon size={18} className={styles.linkIcon} />
      <span className={styles.linkLabel}>{label}</span>
      <ChevronRight
        size={18}
        className={`${styles.linkIcon} rtl:-scale-x-100`}
      />
    </a>
  );
}

export function Information() {
  const { t } = useTranslation();
  // Re-render when this person changes a date or time setting on any device.
  useDateTimePrefs();
  const devToolsEnabled = useDevToolsEnabled();
  const devToolsUnlocked = useDevToolsUnlocked();
  const tapsRef = useRef(0);
  const [justUnlocked, setJustUnlocked] = useState(false);

  // The build instant is stored as UTC ISO; show it in the user's date, time and
  // time zone preferences. Falls back to the raw value if it isn't a real date.
  const buildDate = getBuildDate();
  const builtAt = buildDate
    ? formatAbsoluteDateTime(buildDate)
    : BUILD_TIMESTAMP;

  // Link the commit to GitHub only when it's a real, clean hash — a dirty build
  // doesn't match its base commit, and "dev"/"unknown" aren't commits at all.
  const isLinkableCommit =
    __BUILD_COMMIT__ !== "dev" &&
    __BUILD_COMMIT__ !== "unknown" &&
    !__BUILD_COMMIT__.endsWith("-dirty");

  // Reveal the Tasfer Inspector toggle after enough taps on the version. No-op
  // once already unlocked, so the gesture is inert for users who'll never see it.
  const handleVersionTap = () => {
    if (isDevToolsUnlocked()) return;
    tapsRef.current += 1;
    if (tapsRef.current >= UNLOCK_TAPS) {
      unlockDevTools();
      setJustUnlocked(true);
    }
  };

  const links = [
    {
      icon: BookOpen,
      label: t("settings.information.docs", "Documentation"),
      href: siteLink("docs"),
    },
    {
      icon: Download,
      label: t("settings.information.getTheApps", "Get the apps"),
      href: siteLink("download"),
    },
    {
      icon: ShieldCheck,
      label: t("settings.information.privacy", "Privacy"),
      href: siteLink("privacy"),
    },
    {
      icon: Github,
      label: t("settings.information.sourceCode", "Source code"),
      href: REPO_URL,
    },
    {
      icon: Bug,
      label: t("settings.information.reportIssue", "Report an issue"),
      href: ISSUES_URL,
    },
    {
      icon: Scale,
      label: t("settings.information.thirdPartyLicenses", "Third-party licenses"),
      href: publicAssetUrl("THIRD-PARTY-LICENSES.txt"),
    },
  ];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <img
          className={styles.appIcon}
          src={publicAssetUrl("icon-192.png")}
          alt=""
          width={56}
          height={56}
        />
        <div>
          {/* The product name is a proper noun in both locales, so it is not a
              translation key. */}
          <p className={styles.appName}>Tasfer</p>
          <p className={styles.tagline}>
            {t(
              "settings.information.tagline",
              "Markdown notes that stay on your device and sync straight between your own devices.",
            )}
          </p>
        </div>
      </div>

      <p className={styles.about}>
        <Trans
          i18nKey="settings.information.author"
          defaults="Tasfer is designed and built by <author>Hamza Khuswan</author>, an independent developer working on it in the open."
          components={{
            author: (
              <a href={AUTHOR_URL} target="_blank" rel="noreferrer noopener" />
            ),
          }}
        />{" "}
        <Trans
          i18nKey="settings.information.authorNote"
          defaults="It is a one-person project, so <issues>bug reports and ideas</issues> reach the person who writes the code."
          components={{
            issues: (
              <a href={ISSUES_URL} target="_blank" rel="noreferrer noopener" />
            ),
          }}
        />
      </p>

      <div className={styles.links}>
        {links.map((link) => (
          <LinkRow
            key={link.href}
            icon={link.icon}
            label={link.label}
            href={link.href}
          />
        ))}
      </div>

      {SHOW_IN_APP_DEV_TOGGLE && devToolsUnlocked && (
        <div className="flex items-center justify-between gap-4 py-3 border-b border-border">
          <div>
            <p className="text-sm font-medium">
              {t("settings.devTools.title", "Tasfer Inspector")}
            </p>
            <p className="text-sm opacity-75">
              {t(
                "settings.devTools.description",
                "Show the Tasfer inspector panel for examining database, network, CRDT, and editor state",
              )}
            </p>
          </div>
          <Switch
            checked={devToolsEnabled}
            onCheckedChange={setDevToolsEnabled}
            aria-label={t("settings.devTools.title", "Tasfer Inspector")}
          />
        </div>
      )}

      <div className={styles.footer}>
        <p onClick={handleVersionTap} className="select-none w-fit">
          {t("common.version", "Version")}: {APP_VERSION}
        </p>
        <p className="w-fit">
          {t("settings.information.built", "Built")}: {builtAt}
        </p>
        <p className="w-fit">
          {t("settings.information.commit", "Commit")}:{" "}
          {isLinkableCommit ? (
            <a
              href={`${REPO_URL}/commit/${__BUILD_COMMIT__}`}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono underline"
            >
              {__BUILD_COMMIT__}
            </a>
          ) : (
            <span className="font-mono">{__BUILD_COMMIT__}</span>
          )}
        </p>
        {justUnlocked && (
          <p className="text-primary">
            {t("settings.devTools.unlocked", "Tasfer Inspector unlocked")}
          </p>
        )}
        <p>
          {t(
            "settings.information.license",
            "Tasfer App is free software, licensed under the GNU AGPL-3.0.",
          )}
        </p>
      </div>
    </div>
  );
}
