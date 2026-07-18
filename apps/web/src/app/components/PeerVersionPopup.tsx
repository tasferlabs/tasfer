import { Button } from "@/components/ui/button";
import { getPlatform } from "@/platform";
import type { PeerVersionInfo } from "@/platform/types";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BottomPopover } from "./BottomPopover";

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
        "A device you're connected to is running a newer version of Tasfer. Update the app to sync with it. Your local edits are unaffected.",
      )
    : t(
        "sync.versionIncompatiblePeerOld",
        "A device you're connected to is running an older version of Tasfer and can't sync until it's updated. Your local edits are unaffected.",
      );

  return (
    <BottomPopover
      show={showPopup}
      role="alert"
      aria-labelledby="peer-version-popup-title"
      aria-describedby="peer-version-popup-description"
    >
      <div className="flex justify-between items-center px-4 pt-4">
        <h2 id="peer-version-popup-title" className="text-lg font-semibold">
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
    </BottomPopover>
  );
}
