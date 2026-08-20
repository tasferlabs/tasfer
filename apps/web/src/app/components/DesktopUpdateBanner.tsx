import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { detectAdapter } from "@/platform";
import { useVersion } from "../contexts/VersionContext";
import { NudgeCard } from "./NudgeCard";

/**
 * Sidebar accordion for the desktop auto-updater, in the same family as the
 * storage-protection and peer-version banners.
 *
 * Desktop-only: the updater is an Electron main-process concern, and the web
 * and mobile builds update through the service worker and the app stores.
 *
 * The update downloads on its own in the background, so the banner is mostly a
 * status line — "downloading", then "ready, restart to install". The download
 * button only appears when that background fetch didn't happen or failed, so
 * the user isn't stuck waiting for the next four-hourly check.
 *
 * It carries no dismiss: an installed update sits unused until the app
 * restarts, so the signal has to outlast an interaction. Collapsing shrinks it
 * to a one-line row instead, and the state resets on relaunch (by which point
 * the update is in).
 */
export function DesktopUpdateBanner() {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [isActing, setIsActing] = useState(false);
  const {
    updateAvailable,
    updateVersion,
    updateDownloading,
    downloadPercent,
    updateDownloaded,
    performUpdate,
  } = useVersion();

  if (detectAdapter() !== "electron" || !updateAvailable) return null;

  const percent =
    downloadPercent === null ? null : Math.round(downloadPercent);

  const collapsedLabel = updateDownloaded
    ? t("update.readyCollapsedCta", "Update ready")
    : updateDownloading
      ? t("update.downloadingCollapsedCta", "Downloading update")
      : t("update.availableCollapsedCta", "Update available");

  const title = updateDownloaded
    ? t("update.readyTitle", "Update ready")
    : updateDownloading
      ? t("update.downloadingTitle", "Downloading update")
      : t("update.availableTitle", "Update available");

  const description = updateDownloaded
    ? updateVersion
      ? t("update.readyDescVersion", "Restart to install {{version}}", {
          version: updateVersion,
        })
      : t("update.readyDesc", "Restart to finish installing.")
    : updateDownloading
      ? percent !== null
        ? t("update.downloadingDescPercent", "{{percent}}% downloaded", {
            percent,
          })
        : t("update.downloadingDesc", "Tasfer is fetching the new version.")
      : updateVersion
        ? t(
            "update.availableDescVersion",
            "Version {{version}} is ready to download",
            { version: updateVersion },
          )
        : t("update.availableDesc", "A new version is ready to download.");

  const handleAction = async () => {
    setIsActing(true);
    try {
      await performUpdate();
    } finally {
      setIsActing(false);
    }
  };

  return (
    <div className="shrink-0 overflow-hidden border-t border-border">
      <AnimatePresence initial={false} mode="wait">
        {collapsed ? (
          <motion.div
            key="collapsed"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeInOut" }}
          >
            <Button
              type="button"
              variant="unstyled"
              size="unstyled"
              aria-expanded={false}
              aria-label={t("common.expand", "Expand")}
              onClick={() => setCollapsed(false)}
              className="w-full justify-start gap-2 px-3.5 py-2.5 text-[11.5px] font-normal text-muted-foreground hover:text-foreground"
            >
              <Download
                className={`size-3.5 shrink-0 ${updateDownloaded ? "text-success" : ""}`}
              />
              <span>{collapsedLabel}</span>
              <ChevronUp className="ms-auto size-3.5 shrink-0" />
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeInOut" }}
            // Tinted like the sibling banners — in the success hue once the
            // update is installed and waiting, neutral while it downloads.
            className={
              updateDownloaded
                ? "md:bg-[color-mix(in_oklab,var(--success)_9%,var(--sidebar))]"
                : "md:bg-[color-mix(in_oklab,var(--muted-foreground)_6%,var(--sidebar))]"
            }
          >
            <NudgeCard
              role="status"
              // The whole banner is the accordion header, as in the sibling
              // banners; the chevron button stays for keyboard and
              // screen-reader users.
              onClick={() => setCollapsed(true)}
              className="cursor-pointer select-none"
              icon={
                <Download
                  className={`size-4 ${updateDownloaded ? "text-success" : "text-muted-foreground"}`}
                />
              }
              title={
                <span className={updateDownloaded ? "text-success" : undefined}>
                  {title}
                </span>
              }
              description={description}
              action={
                updateDownloading ? undefined : (
                  <Button
                    size="xs"
                    className="mt-[5px] cursor-pointer self-start rounded-[7px]"
                    loading={isActing}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleAction();
                    }}
                  >
                    {updateDownloaded
                      ? t("update.restartNow", "Restart now")
                      : t("update.download", "Download")}
                  </Button>
                )
              }
              trailing={
                <Button
                  type="button"
                  variant="unstyled"
                  size="unstyled"
                  aria-expanded
                  aria-label={t("common.collapse", "Collapse")}
                  onClick={() => setCollapsed(true)}
                  className="-me-1.5 -mt-1 rounded-md p-1.5 text-muted-foreground hover:text-foreground"
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              }
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
