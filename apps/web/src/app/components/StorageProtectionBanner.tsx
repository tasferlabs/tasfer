import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldAlert, X } from "lucide-react";
import { useToast } from "@/app/components/Toast";
import { Button } from "@/components/ui/button";
import {
  getPersistentStorageStatus,
  requestPersistentStorage,
} from "@/lib/persistentStorage";

/** Session-scoped so a dismissal can't hide the warning forever — on web the
 * browser may still evict the only copy of the user's data. */
const DISMISSED_KEY = "storageBannerDismissed";

/**
 * Sidebar warning shown while the origin's storage is still best-effort
 * (evictable). Renders nothing on native platforms, on browsers without the
 * Storage API, or once protection is granted. Settings → Data keeps the
 * always-available status row.
 */
export function StorageProtectionBanner() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [unprotected, setUnprotected] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem(DISMISSED_KEY) === "1",
  );

  useEffect(() => {
    let cancelled = false;
    getPersistentStorageStatus().then((status) => {
      if (!cancelled) setUnprotected(status === "unprotected");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!unprotected || dismissed) return null;

  const handleProtect = async () => {
    const status = await requestPersistentStorage();
    setUnprotected(status === "unprotected");
    if (status === "protected") {
      toast.success(
        t(
          "storage.protectionEnabled",
          "Your local data is now protected from automatic cleanup.",
        ),
      );
    } else {
      toast({
        message: t(
          "storage.protectionDeclined",
          "Your browser declined the request. Installing Cypher as an app usually helps — then try again.",
        ),
      });
    }
  };

  const handleDismiss = () => {
    sessionStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };

  return (
    <div
      role="status"
      className="mx-2 mb-1 shrink-0 rounded-lg border border-amber-600/25 bg-amber-500/10 p-2.5 dark:border-amber-400/20 dark:bg-amber-400/10"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">
            {t("storage.bannerTitle", "Storage protection is off")}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t(
              "storage.bannerDesc",
              "Your browser can delete Cypher's local data when disk space runs low.",
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="-me-1 -mt-1 text-muted-foreground hover:text-foreground"
          onClick={handleDismiss}
        >
          <X />
          <span className="sr-only">{t("common.dismiss", "Dismiss")}</span>
        </Button>
      </div>
      <Button
        size="xs"
        variant="outline"
        className="mt-2 w-full border-amber-600/30 bg-transparent text-amber-700 hover:bg-amber-500/15 hover:text-amber-800 dark:border-amber-400/30 dark:bg-transparent dark:text-amber-300 dark:hover:bg-amber-400/15 dark:hover:text-amber-200"
        onClick={handleProtect}
      >
        {t("storage.protect", "Protect data")}
      </Button>
    </div>
  );
}
