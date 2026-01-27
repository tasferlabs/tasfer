import { Button } from "@/components/ui/button";
import { BUILD_TIMESTAMP } from "@/version";
import { WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVersion } from "../contexts/VersionContext";

export default function ForceUpdatePage() {
  const { t } = useTranslation();
  const { performUpdate } = useVersion();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Track online/offline status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Auto-focus the update button when overlay mounts (only when online)
  useEffect(() => {
    if (isOnline) {
      buttonRef.current?.focus();
    }
  }, [isOnline]);

  const handleUpdate = async () => {
    setIsUpdating(true);
    await performUpdate();
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-background p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="force-update-title"
      aria-describedby="force-update-description"
    >
      <div className="max-w-md w-full text-center space-y-6">
        {/* Icon */}
        <div
          className={`mx-auto w-20 h-20 rounded-full flex items-center justify-center ${
            isOnline ? "bg-primary/10" : "bg-muted"
          }`}
          aria-hidden="true"
        >
          {isOnline ? (
            <svg
              className="w-10 h-10 text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </svg>
          ) : (
            <WifiOff className="w-10 h-10 text-muted-foreground" />
          )}
        </div>

        {/* Title */}
        <h1
          id="force-update-title"
          className="text-2xl font-semibold text-foreground"
        >
          {isOnline ? t`Update Required` : t`You're Offline`}
        </h1>

        {/* Description */}
        <p id="force-update-description" className="text-muted-foreground">
          {isOnline
            ? t`A new version of the app is required to continue. Please update to access the latest features and security improvements.`
            : t`Please connect to the internet to download the latest update and continue using the app.`}
        </p>

        {/* Update button */}
        <Button
          ref={buttonRef}
          onClick={handleUpdate}
          loading={isUpdating}
          size="lg"
          className="w-full"
        >
          {isOnline ? t`Update Now` : t`Try Update`}
        </Button>

        {/* Build info for debugging */}
        <p className="text-xs text-muted-foreground/60" aria-hidden="true">
          Build: {BUILD_TIMESTAMP}
        </p>
      </div>
    </div>
  );
}
