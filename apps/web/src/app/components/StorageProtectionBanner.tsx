import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { detectAdapter } from "@/platform";
import { InstallAppDialog } from "./InstallAppDialog";

const STANDALONE_QUERY = "(display-mode: standalone)";

/** True when Cypher runs as an installed app (PWA or Add-to-Home-Screen). */
function isInstalledDisplayMode(): boolean {
  if (typeof window === "undefined") return false;
  // iOS Safari home-screen apps predate the display-mode media query.
  if ((navigator as { standalone?: boolean }).standalone === true) return true;
  return window.matchMedia?.(STANDALONE_QUERY).matches ?? false;
}

/**
 * Sidebar-bottom nudge shown while Cypher runs in a plain browser tab, where
 * the only copy of the user's data sits in evictable browser storage. Opens
 * the install dialog; hidden on native builds and installed PWAs, where
 * storage is already out of the browser's cleanup reach.
 */
export function StorageProtectionBanner() {
  const { t } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [installed, setInstalled] = useState(isInstalledDisplayMode);

  // An install can complete while the tab is open — Chrome flips the
  // display-mode media query in place, so track it live.
  useEffect(() => {
    const mql = window.matchMedia?.(STANDALONE_QUERY);
    if (!mql) return;
    const update = () => setInstalled(isInstalledDisplayMode());
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  if (detectAdapter() !== "web" || installed) return null;

  return (
    <>
      <div
        role="status"
        className="flex shrink-0 items-start gap-2.5 border-t border-border bg-[color-mix(in_oklab,var(--primary)_7%,var(--sidebar))] px-3.5 py-2.5"
      >
        <Shield className="mt-px size-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[12.5px] font-semibold leading-[1.35] text-foreground">
            {t("storage.bannerTitle", "Your notes live only in this browser")}
          </span>
          <span className="text-[11.5px] leading-[1.45] text-muted-foreground">
            {t(
              "storage.bannerDesc",
              "The browser can clear this storage. Install Cypher to keep them safe.",
            )}
          </span>
          <Button
            size="xs"
            className="mt-[5px] self-start rounded-[7px]"
            onClick={() => setDialogOpen(true)}
          >
            {t("storage.protectCta", "Protect my notes")}
          </Button>
        </div>
      </div>
      <InstallAppDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
