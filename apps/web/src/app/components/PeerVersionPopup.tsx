import { Button } from "@/components/ui/button";
import { getPlatform } from "@/platform";
import type { PeerVersionInfo } from "@/platform/types";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Notifies the user about a version mismatch with a connected device. Two
 * severities, both surfaced from `sync.onPeerVersionMismatch`:
 *
 *  - "blocking" — the peer is *wire*-incompatible (`wireCompatible === false`),
 *    so the replicator refuses it (no ops exchanged in either direction). The
 *    user must update or the device won't sync. Re-surfaces on every mismatch.
 *  - "info" — the peer speaks a newer *protocol* (same wire) and WE are behind.
 *    Sync still works (unknown ops degrade gracefully); this is a soft "update
 *    for the latest features" nudge. Shown at most once per newer protocol
 *    version (dismissed versions are remembered) so reconnects don't nag.
 *
 * A protocol mismatch where the *peer* is the older one is never shown — it's
 * not actionable for this user. Local editing is never affected either way.
 */

type Severity = "blocking" | "info";
interface Notice {
  info: PeerVersionInfo;
  severity: Severity;
}

export default function PeerVersionPopup() {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<Notice | null>(null);
  // Protocol versions whose "info" notice the user already dismissed — so we
  // don't re-nag on every reconnect to a peer on that same newer version.
  const dismissedInfoVersions = useRef<Set<number>>(new Set());

  useEffect(() => {
    let unsub: (() => void) | undefined;
    try {
      unsub = getPlatform().sync.onPeerVersionMismatch((next) => {
        if (!next.wireCompatible) {
          // Blocking: sync is refused — always surface.
          setNotice({ info: next, severity: "blocking" });
          return;
        }
        // Protocol-only mismatch: only nudge when WE are the outdated side, and
        // only once per newer version. (A newer-peer-but-older case isn't ours
        // to act on.)
        if (next.remoteProtocolVersion <= next.localProtocolVersion) return;
        if (dismissedInfoVersions.current.has(next.remoteProtocolVersion))
          return;
        // Never let an info notice clobber an active blocking one.
        setNotice((cur) =>
          cur?.severity === "blocking" ? cur : { info: next, severity: "info" },
        );
      });
    } catch {
      // Platform not initialized yet — nothing to subscribe to.
    }
    return () => unsub?.();
  }, []);

  const dismiss = () => {
    if (notice?.severity === "info") {
      dismissedInfoVersions.current.add(notice.info.remoteProtocolVersion);
    }
    setNotice(null);
  };

  const showPopup = notice !== null;
  const isInfo = notice?.severity === "info";
  // For the blocking case, our app is behind when the peer's wire is newer.
  const localOutdated = notice
    ? notice.info.remoteWireVersion > notice.info.localWireVersion
    : false;

  const title = isInfo
    ? t("sync.versionUpdateAvailableTitle", "A connected device is newer")
    : t("sync.versionIncompatibleTitle", "Can't sync with a device");

  const body = isInfo
    ? t(
        "sync.versionUpdateAvailableBody",
        "A device you're connected to is running a newer version of Cypher. Everything still syncs — update the app to get the latest features.",
      )
    : localOutdated
      ? t(
          "sync.versionIncompatibleUpdate",
          "A device you're connected to is running a newer version of Cypher. Update the app to sync with it. Your local edits are unaffected.",
        )
      : t(
          "sync.versionIncompatiblePeerOld",
          "A device you're connected to is running an older version of Cypher and can't sync until it's updated. Your local edits are unaffected.",
        );

  const popupVariants = {
    hidden: { y: 80, opacity: 0 },
    visible: { y: 0, opacity: 1, transition: { duration: 0.5 } },
    exit: { y: 80, opacity: 0, transition: { duration: 0.5 } },
  };

  return (
    <AnimatePresence>
      {showPopup && (
        <motion.div
          className="z-[2000] fixed pointer-events-auto"
          style={{
            bottom:
              "calc(0.5rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
            left: "calc(0.5rem + var(--safe-area-inset-left, env(safe-area-inset-left, 0px)))",
            right:
              "calc(0.5rem + var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))",
          }}
          initial="hidden"
          animate="visible"
          exit="exit"
          variants={popupVariants}
          // Blocking is assertive ("alert"); the info nudge is polite ("status").
          role={isInfo ? "status" : "alert"}
          aria-labelledby="peer-version-popup-title"
          aria-describedby="peer-version-popup-description"
        >
          <div className="max-w-md w-full bg-card text-card-foreground rounded-lg shadow-lg overflow-hidden border border-border">
            <div className="flex justify-between items-center px-4 pt-4">
              <h2
                id="peer-version-popup-title"
                className="text-lg font-semibold"
              >
                {title}
              </h2>
            </div>

            <div className="px-4 pt-4">
              <p
                id="peer-version-popup-description"
                className="text-sm text-muted-foreground"
              >
                {body}
              </p>
            </div>

            <div className="mt-4 px-4 pb-4">
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={dismiss}
                  aria-label={t("common.dismiss", "Dismiss")}
                >
                  {t("common.dismiss", "Dismiss")}
                </Button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
