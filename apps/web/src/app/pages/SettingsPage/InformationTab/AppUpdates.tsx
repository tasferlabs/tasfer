import { useId, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/app/components/Toast";
import { useMobileUpdate } from "@/app/contexts/MobileUpdateContext";
import { storeListing } from "@/lib/storeLinks";
import { APP_VERSION } from "@/version";

/**
 * The phone apps' update rows: the version that is running with the one thing
 * that can be done about it, and whether new versions download on their own.
 * Draws nothing where the app does not update over the air (web, desktop).
 *
 * The version row always carries one button, and it follows the update: look
 * for one, download it, restart into it, or, when the new version needs a
 * newer app from the store, open the store.
 *
 * `onVersionTap` is the hidden "tap the version" gesture of the Information
 * tab. The row takes it over because the footer drops its own version line
 * where this is shown.
 */
export function AppUpdates({ onVersionTap }: { onVersionTap?: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const update = useMobileUpdate();
  const switchId = useId();
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);

  if (!update) return null;
  const { status, autoUpdate } = update;
  const listing = storeListing();

  // The row shows what a check found. Only the outcomes that leave it as it
  // was need a toast, or the button would look like it did nothing.
  const handleCheck = async () => {
    setChecking(true);
    try {
      const { outcome } = await update.check();
      if (outcome === "up-to-date") {
        toast.success(t("update.upToDate", "You're on the latest version"));
      } else if (outcome === "error") {
        toast.error(t("update.checkFailed", "Couldn't check for updates"));
      } else if (outcome === "unsupported") {
        toast({
          message: t(
            "update.checkUnsupported",
            "This installation doesn't update itself",
          ),
        });
      }
    } finally {
      setChecking(false);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await update.download();
    } finally {
      setDownloading(false);
    }
  };

  const percent =
    status.phase === "downloading" && status.percent !== null
      ? Math.round(status.percent)
      : null;

  let detail: string | null = null;
  let action = (
    <Button
      variant="outline"
      loading={checking}
      onClick={() => void handleCheck()}
    >
      {t("update.checkForUpdates", "Check for Updates")}
    </Button>
  );

  switch (status.phase) {
    case "idle":
      break;
    case "available":
      detail = t(
        "update.availableDescVersion",
        "Version {{version}} is ready to download",
        { version: status.version },
      );
      action = (
        <Button loading={downloading} onClick={() => void handleDownload()}>
          {t("update.updateNow", "Update now")}
        </Button>
      );
      break;
    case "failed":
      detail = t("update.downloadFailedTitle", "Couldn't download the update");
      action = (
        <Button
          variant="outline"
          loading={downloading}
          onClick={() => void handleDownload()}
        >
          {t("common.tryAgain", "Try again")}
        </Button>
      );
      break;
    case "downloading":
      detail =
        percent !== null
          ? t("update.downloadingDescPercent", "{{percent}}% downloaded", {
              percent,
            })
          : t("update.downloadingDesc", "Tasfer is fetching the new version.");
      action = (
        <Loader2
          aria-hidden
          className="size-5 shrink-0 animate-spin text-muted-foreground"
        />
      );
      break;
    case "ready":
      detail = t("update.readyDescVersion", "Restart to install {{version}}", {
        version: status.version,
      });
      action = (
        <Button onClick={update.restart}>
          {t("update.restartNow", "Restart now")}
        </Button>
      );
      break;
    case "store":
      // No listing to open means nothing to offer beyond the check.
      if (!listing) break;
      detail =
        listing.store === "googlePlay"
          ? t(
              "update.storeDescGooglePlay",
              "Update Tasfer from Google Play to get version {{version}}",
              { version: status.version },
            )
          : t(
              "update.storeDescAppStore",
              "Update Tasfer from the App Store to get version {{version}}",
              { version: status.version },
            );
      action = (
        <Button asChild>
          <a href={listing.url} target="_blank" rel="noreferrer noopener">
            {listing.store === "googlePlay"
              ? t("update.openGooglePlay", "Open Google Play")
              : t("update.openAppStore", "Open App Store")}
            <ExternalLink data-icon="inline-end" className="size-3.5" />
          </a>
        </Button>
      );
      break;
  }

  return (
    <div className="mb-5 border-t border-border">
      <div className="border-b border-border py-3.5">
        <div className="flex min-h-9 items-center gap-3">
          <div className="min-w-0 flex-1 select-none" onClick={onVersionTap}>
            <p>{t("common.version", "Version")}</p>
            <p className="text-[0.8125rem] leading-normal text-muted-foreground">
              {APP_VERSION}
            </p>
          </div>
          {action}
        </div>
        {/* Always mounted, so a screen reader hears the state change. */}
        <p
          role="status"
          className="text-[0.8125rem] leading-normal text-muted-foreground"
        >
          {detail && <span className="mt-1.5 block">{detail}</span>}
        </p>
      </div>
      <div className="flex min-h-11 items-center gap-4 border-b border-border py-3.5">
        <div className="min-w-0 flex-1">
          <label htmlFor={switchId}>
            {t("settings.updates.auto", "Update automatically")}
          </label>
          <p className="text-[0.8125rem] leading-normal text-muted-foreground">
            {t(
              "settings.updates.autoHint",
              "Download new versions and switch to them the next time you open Tasfer.",
            )}
          </p>
        </div>
        <Switch
          id={switchId}
          checked={autoUpdate}
          onCheckedChange={update.setAutoUpdate}
          className="shrink-0"
        />
      </div>
    </div>
  );
}
