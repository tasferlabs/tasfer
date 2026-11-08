import {
  BookOpen,
  Bug,
  ChevronRight,
  Download,
  Github,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { useRef, useState } from "react";
import type { ComponentType } from "react";
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
const DISCORD_URL = "https://discord.gg/drfUeSA8bw";
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

type RowIcon = ComponentType<{ size?: number; className?: string }>;

/**
 * The Discord logo. Lucide ships no brand marks, so it is drawn here. The
 * padded viewBox gives it the same inset as a Lucide glyph, so it sits at the
 * same optical size as the other row icons.
 */
function DiscordLogo({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-2 -2 28 28"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

function LinkRow({
  icon: Icon,
  label,
  href,
}: {
  icon: RowIcon;
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
      icon: DiscordLogo,
      label: t("settings.information.community", "Join us on Discord"),
      href: DISCORD_URL,
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
