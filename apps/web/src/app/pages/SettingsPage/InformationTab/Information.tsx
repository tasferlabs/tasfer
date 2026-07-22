import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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

// Taps on the version line needed to reveal the hidden Tasfer Inspector toggle
// (the classic Android "tap build number" gesture).
const UNLOCK_TAPS = 7;

const REPO_URL = "https://github.com/tasferlabs/tasfer";

// Where to surface the in-app Tasfer Inspector switch. iOS (Settings bundle) and
// desktop (app menu) expose OS-level controls instead, so the in-app toggle is
// shown only where there's no native equivalent.
const SHOW_IN_APP_DEV_TOGGLE =
  getClientPlatform() === "android" || getClientPlatform() === "web";

export function Information() {
  const { t } = useTranslation();
  const devToolsEnabled = useDevToolsEnabled();
  const devToolsUnlocked = useDevToolsUnlocked();
  const tapsRef = useRef(0);
  const [justUnlocked, setJustUnlocked] = useState(false);

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

  return (
    <div className={styles.container}>
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

      <div className="text-xs text-muted-foreground mt-auto pt-8 space-y-1">
        <p onClick={handleVersionTap} className="select-none w-fit">
          {t("common.version", "Version")}: {__BUILD_TIMESTAMP__}
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
            "Tasfer is free software, licensed under the GNU AGPL-3.0.",
          )}{" "}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="underline"
          >
            {t("settings.information.viewSource", "View source code")}
          </a>
        </p>
        <p>
          <a
            href={publicAssetUrl("THIRD-PARTY-LICENSES.txt")}
            target="_blank"
            rel="noreferrer noopener"
            className="underline"
          >
            {t("settings.information.thirdPartyLicenses", "Third-party licenses")}
          </a>
        </p>
      </div>
    </div>
  );
}
