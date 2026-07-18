import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePopupQueue } from "@/app/contexts/PopupQueueContext";
import { useVersion } from "../contexts/VersionContext";
import { BottomPopover } from "./BottomPopover";

export default function UpdatePopup() {
  const { t } = useTranslation();
  const { registerPopup, unregisterPopup, isActivePopup } = usePopupQueue();
  const {
    updateAvailable,
    updateDismissed,
    meetsMinimum,
    dismissUpdate,
    performUpdate,
  } = useVersion();
  const [isUpdating, setIsUpdating] = useState(false);

  // Don't show popup if:
  // - No update available
  // - User dismissed this update
  // - Minimum version not met (ForceUpdatePage handles this)
  const eligible = updateAvailable && !updateDismissed && meetsMinimum;

  // Share the bottom popover slot through the queue; an available update
  // outranks the promotional app gate (see POPUP_PRIORITIES).
  useEffect(() => {
    if (!eligible) {
      unregisterPopup("versionUpdate");
      return;
    }
    registerPopup("versionUpdate");
    return () => unregisterPopup("versionUpdate");
  }, [eligible, registerPopup, unregisterPopup]);

  const showPopup = eligible && isActivePopup("versionUpdate");

  const handleUpdate = async () => {
    setIsUpdating(true);
    await performUpdate();
  };

  const handleDismiss = () => {
    unregisterPopup("versionUpdate");
    dismissUpdate();
  };

  return (
    <BottomPopover
      show={showPopup}
      role="dialog"
      aria-labelledby="update-popup-title"
      aria-describedby="update-popup-description"
    >
      {/* Header */}
      <div className="flex justify-between items-center px-4 pt-4">
        <h2 id="update-popup-title" className="text-lg font-semibold">
          {t("update.available", "Update Available")}
        </h2>
      </div>

      {/* Main content */}
      <div className="px-4 pt-4">
        <p
          id="update-popup-description"
          className="text-sm text-muted-foreground"
        >
          {t("update.newVersionAvailable", "A new version of the app is available. Update now to get the latest features and improvements.")}
        </p>
      </div>

      {/* Actions */}
      <div className="mt-4 px-4 pb-4">
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={handleDismiss}
            aria-label={t("update.dismiss", "Dismiss update notification")}
          >
            {t("common.later", "Later")}
          </Button>
          <Button
            variant="default"
            onClick={handleUpdate}
            loading={isUpdating}
            aria-label={t("update.updateTheApp", "Update the app now")}
          >
            {t("update.updateNow", "Update now")}
          </Button>
        </div>
      </div>
    </BottomPopover>
  );
}
