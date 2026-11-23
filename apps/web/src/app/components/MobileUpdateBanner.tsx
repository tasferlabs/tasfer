import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Download,
  ExternalLink,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { storeListing } from "@/lib/storeLinks";
import { useMobileUpdate } from "../contexts/MobileUpdateContext";
import { NudgeCard } from "./NudgeCard";
import styles from "./MobileUpdateBanner.module.css";

/**
 * Sidebar card for the phone apps' over-the-air updates, the sibling of the
 * desktop update banner.
 *
 * It lives in the sidebar, not at the bottom of the editor, because the
 * keyboard and the formatting toolbar own that edge while someone is writing.
 * The top bar's sidebar button carries a dot while the card has something new
 * to say (see TopActionBar).
 *
 * The update is optional: nothing is downloaded until "Update now" is tapped.
 * Collapsing the card is the "not now"; it shrinks to one line and stays that
 * way until the app is opened again. Once downloaded, the new version is used
 * from the next time the app is opened, or straight away with "Restart now".
 *
 * A version this store build is too old to run cannot be downloaded here. The
 * card then sends the person to the App Store or Google Play instead.
 *
 * Controls are sized for thumbs (36px button, 44px collapse target) where the
 * desktop banner uses pointer sizes.
 */
export function MobileUpdateBanner() {
  const { t } = useTranslation();
  const update = useMobileUpdate();
  const [isActing, setIsActing] = useState(false);

  if (!update || !update.notice) return null;
  const { notice, collapsed, setCollapsed } = update;
  const { phase, version } = notice;
  const listing = storeListing();
  // Nowhere to send the person: say nothing rather than show a dead end.
  if (phase === "store" && !listing) return null;

  const percent =
    notice.phase === "downloading" && notice.percent !== null
      ? Math.round(notice.percent)
      : null;

  const collapsedLabel =
    phase === "ready"
      ? t("update.readyCollapsedCta", "Update ready")
      : phase === "downloading"
        ? t("update.downloadingCollapsedCta", "Downloading update")
        : t("update.availableCollapsedCta", "Update available");

  const title =
    phase === "ready"
      ? t("update.readyTitle", "Update ready")
      : phase === "downloading"
        ? t("update.downloadingTitle", "Downloading update")
        : phase === "failed"
          ? t("update.downloadFailedTitle", "Couldn't download the update")
          : t("update.availableTitle", "Update available");

  const description =
    phase === "ready"
      ? t("update.readyDescVersion", "Restart to install {{version}}", {
          version,
        })
      : phase === "downloading"
        ? percent !== null
          ? t("update.downloadingDescPercent", "{{percent}}% downloaded", {
              percent,
            })
          : t("update.downloadingDesc", "Tasfer is fetching the new version.")
        : phase === "failed"
          ? t(
              "update.downloadFailedDesc",
              "Check your connection and try again.",
            )
          : phase === "store"
            ? listing?.store === "googlePlay"
              ? t(
                  "update.storeDescGooglePlay",
                  "Update Tasfer from Google Play to get version {{version}}",
                  { version },
                )
              : t(
                  "update.storeDescAppStore",
                  "Update Tasfer from the App Store to get version {{version}}",
                  { version },
                )
            : t(
              "update.availableDescVersion",
              "Version {{version}} is ready to download",
              { version },
            );

  const icon =
    phase === "ready" ? (
      <Check className="size-4 text-success" />
    ) : phase === "failed" ? (
      <CircleAlert className="size-4 text-destructive" />
    ) : (
      <Download className="size-4 text-muted-foreground" />
    );

  const handleDownload = async () => {
    setIsActing(true);
    try {
      await update.download();
    } finally {
      setIsActing(false);
    }
  };

  const action =
    phase === "downloading" ? (
      <div
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="relative me-2 mt-2 h-1 overflow-hidden rounded-full bg-muted"
      >
        {percent !== null ? (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        ) : (
          // No honest number yet (iOS reports none until the zip is in): a
          // moving bar says the download is running.
          <div className={styles.indeterminate} />
        )}
      </div>
    ) : phase === "store" && listing ? (
      <Button asChild className="mt-2 self-start px-3">
        <a
          href={listing.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => event.stopPropagation()}
        >
          {listing.store === "googlePlay"
            ? t("update.openGooglePlay", "Open Google Play")
            : t("update.openAppStore", "Open App Store")}
          <ExternalLink data-icon="inline-end" className="size-3.5" />
        </a>
      </Button>
    ) : (
      <Button
        variant={phase === "failed" ? "outline" : "default"}
        className="mt-2 self-start px-3"
        loading={isActing}
        onClick={(event) => {
          event.stopPropagation();
          if (phase === "ready") update.restart();
          else void handleDownload();
        }}
      >
        {phase === "ready"
          ? t("update.restartNow", "Restart now")
          : phase === "failed"
            ? t("common.tryAgain", "Try again")
            : t("update.updateNow", "Update now")}
      </Button>
    );

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
              className="min-h-11 w-full justify-start gap-2 px-3.5 text-[11.5px] font-normal text-muted-foreground hover:text-foreground"
            >
              <Download
                className={`size-3.5 shrink-0 ${phase === "ready" ? "text-success" : ""}`}
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
          >
            <NudgeCard
              // A failed download is announced at once; the other states wait
              // their turn.
              role={phase === "failed" ? "alert" : "status"}
              className="py-3 pe-1.5"
              icon={icon}
              title={title}
              description={description}
              action={action}
              trailing={
                // A download cannot be put off halfway, so there is nothing to
                // collapse while it runs.
                phase === "downloading" ? undefined : (
                  <Button
                    type="button"
                    variant="unstyled"
                    size="unstyled"
                    aria-expanded
                    aria-label={t("common.collapse", "Collapse")}
                    onClick={() => setCollapsed(true)}
                    className="-mt-2.5 size-11 shrink-0 justify-center rounded-md text-muted-foreground hover:text-foreground"
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                )
              }
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
