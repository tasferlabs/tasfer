import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePeerVersion } from "../contexts/PeerVersionContext";
import { NudgeCard } from "./NudgeCard";

/**
 * Inline sidebar warning for a device that can't sync because of a version
 * mismatch.
 *
 * A caution, not a failure: nothing is lost and local edits keep working, so it
 * carries the warning hue rather than the destructive one.
 *
 * Collapsing shrinks it to a one-line row rather than dismissing it — sync
 * stays blocked until one of the two devices is updated, so the signal has to
 * outlast any interaction, just quietly. It goes away on its own when the
 * incompatible device disconnects.
 */
export function PeerVersionBanner() {
  const { t } = useTranslation();
  const { notice, localOutdated, collapsed, setCollapsed } = usePeerVersion();

  if (notice === null) return null;

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
            <button
              type="button"
              aria-expanded={false}
              aria-label={t("common.expand", "Expand")}
              onClick={() => setCollapsed(false)}
              className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <AlertTriangle className="size-3.5 shrink-0 text-warning" />
              <span>
                {t(
                  "sync.versionIncompatibleCollapsedCta",
                  "A device can't sync",
                )}
              </span>
              <ChevronUp className="ms-auto size-3.5 shrink-0" />
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeInOut" }}
            // Tinted like the storage banner, in the warning hue; flush on the
            // mobile full-screen sidebar where a stray block reads as noise.
            className="md:bg-[color-mix(in_oklab,var(--warning)_9%,var(--sidebar))]"
          >
            <NudgeCard
              role="alert"
              // The whole banner is an accordion header, as in the storage
              // banner: clicking anywhere collapses it, and the chevron button
              // stays for keyboard and screen-reader users.
              onClick={() => setCollapsed(true)}
              className="cursor-pointer select-none"
              icon={<AlertTriangle className="size-4 text-warning" />}
              title={t(
                "sync.versionIncompatibleTitle",
                "Can't sync with a device",
              )}
              description={
                localOutdated
                  ? t(
                      "sync.versionIncompatibleSidebarUpdate",
                      "Update Tasfer to sync with a connected device. Your local edits are unaffected.",
                    )
                  : t(
                      "sync.versionIncompatibleSidebarPeerOld",
                      "A connected device must be updated before it can sync. Your local edits are unaffected.",
                    )
              }
              trailing={
                <button
                  type="button"
                  aria-expanded
                  aria-label={t("common.collapse", "Collapse")}
                  onClick={() => setCollapsed(true)}
                  className="-me-1.5 -mt-1 cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ChevronDown className="size-3.5" />
                </button>
              }
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
