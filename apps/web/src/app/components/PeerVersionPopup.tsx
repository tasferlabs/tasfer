import { Button } from "@/components/ui/button";
import { getPlatform } from "@/platform";
import type { PeerVersionInfo } from "@/platform/types";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Notifies the user about a version mismatch with a connected device.
 * Every protocol or wire mismatch is blocking: authoritative structured
 * content cannot safely exchange ops with peers running older merge semantics.
 * Re-surfaces on every mismatch so the user knows which device must update.
 */

export default function PeerVersionPopup() {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<PeerVersionInfo | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    try {
      unsub = getPlatform().sync.onPeerVersionMismatch((next) => {
        if (!next.syncCompatible) setNotice(next);
      });
    } catch {
      // Platform not initialized yet — nothing to subscribe to.
    }
    return () => unsub?.();
  }, []);

  const dismiss = () => setNotice(null);

  const showPopup = notice !== null;
  // Our app is behind when either negotiated version is newer on the peer.
  const localOutdated = notice
    ? notice.remoteProtocolVersion > notice.localProtocolVersion ||
      notice.remoteWireVersion > notice.localWireVersion
    : false;

  const title = t("sync.versionIncompatibleTitle", "Can't sync with a device");

  const body = localOutdated
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
          role="alert"
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
