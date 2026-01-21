import { Button } from "@/components/ui/button";
import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useVersion } from "../contexts/VersionContext";
import { useKeyboardOpen } from "../hooks/useKeyboardOpen";

export default function UpdatePopup() {
  const { t } = useTranslation();
  const {
    updateAvailable,
    updateDismissed,
    meetsMinimum,
    dismissUpdate,
    performUpdate,
  } = useVersion();
  const [isUpdating, setIsUpdating] = useState(false);
  const isKeyboardOpen = useKeyboardOpen();

  const handleUpdate = async () => {
    setIsUpdating(true);
    await performUpdate();
  };

  // Don't show popup if:
  // - No update available
  // - User dismissed this update
  // - Minimum version not met (ForceUpdatePage handles this)
  // - Keyboard is open (avoid covering content while typing)
  const showPopup = updateAvailable && !updateDismissed && meetsMinimum && !isKeyboardOpen;

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
            bottom: "calc(0.5rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
            left: "calc(0.5rem + var(--safe-area-inset-left, env(safe-area-inset-left, 0px)))",
            right: "calc(0.5rem + var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))",
          }}
          initial="hidden"
          animate="visible"
          exit="exit"
          variants={popupVariants}
          role="dialog"
          aria-labelledby="update-popup-title"
          aria-describedby="update-popup-description"
        >
          <div className="max-w-md w-full bg-card text-card-foreground rounded-lg shadow-lg overflow-hidden border border-border">
            {/* Header */}
            <div className="flex justify-between items-center px-4 pt-4">
              <h2 id="update-popup-title" className="text-lg font-semibold">
                {t`Update Available`}
              </h2>
            </div>

            {/* Main content */}
            <div className="px-4 pt-4">
              <p
                id="update-popup-description"
                className="text-sm text-muted-foreground"
              >
                {t`A new version of the app is available. Update now to get the latest features and improvements.`}
              </p>
            </div>

            {/* Actions */}
            <div className="mt-4 px-4 pb-4">
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={dismissUpdate}
                  aria-label={t`Dismiss update notification`}
                >
                  {t`Later`}
                </Button>
                <Button
                  variant="default"
                  onClick={handleUpdate}
                  loading={isUpdating}
                  aria-label={t`Update the app now`}
                >
                  {t`Update now`}
                </Button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
