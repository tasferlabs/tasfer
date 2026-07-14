import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Shield, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getPersistentStorageStatus,
  PERSISTENT_STORAGE_STATUS_EVENT,
  type PersistentStorageStatus,
} from "@/lib/persistentStorage";
import { detectAdapter } from "@/platform";
import useResponsive from "../hooks/useResponsive";
import { InstallAppDialog } from "./InstallAppDialog";

const STANDALONE_QUERY = "(display-mode: standalone)";

/** localStorage flag set when the user dismisses the full banner. */
const COLLAPSED_KEY = "storageBannerCollapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

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
 *
 * Dismissing collapses it to a one-line "Notes unprotected" affordance rather
 * than removing it — the eviction risk persists as long as Cypher runs in a
 * tab, so the signal must too, just quietly. The choice is per browser
 * (localStorage); there is deliberately no way to fully hide it.
 *
 * Also hidden once the origin holds a persistent-storage grant
 * (`navigator.storage.persist()`), which removes the eviction risk the banner
 * warns about. "unsupported" still shows it: without the grant the browser
 * remains free to clean up, and installing is the remaining way out.
 */
export function StorageProtectionBanner() {
  const { t } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [installed, setInstalled] = useState(isInstalledDisplayMode);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // null while the initial async check runs — render nothing rather than
  // flashing the warning at users whose storage is already protected.
  const [protection, setProtection] = useState<PersistentStorageStatus | null>(
    null,
  );
  const isMobile = useResponsive("(max-width: 768px)");

  // The Storage API has no change event; requestPersistentStorage dispatches
  // its outcome (startup request in main.tsx, "Protect data" in Settings), so
  // a grant hides the banner without a reload.
  useEffect(() => {
    let cancelled = false;
    getPersistentStorageStatus().then((status) => {
      // Fallback only: an event that arrived while this poll was in flight
      // (e.g. the startup request granting protection) is fresher than the
      // poll's snapshot, so never overwrite an already-known status.
      if (!cancelled) setProtection((prev) => prev ?? status);
    });
    const onStatus = (event: Event) =>
      setProtection((event as CustomEvent<PersistentStorageStatus>).detail);
    window.addEventListener(PERSISTENT_STORAGE_STATUS_EVENT, onStatus);
    return () => {
      cancelled = true;
      window.removeEventListener(PERSISTENT_STORAGE_STATUS_EVENT, onStatus);
    };
  }, []);

  const collapse = () => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, "1");
    } catch {
      // Storage unavailable — collapse for this page load only.
    }
    setCollapsed(true);
  };

  // An install can complete while the tab is open — Chrome flips the
  // display-mode media query in place, so track it live.
  useEffect(() => {
    const mql = window.matchMedia?.(STANDALONE_QUERY);
    if (!mql) return;
    const update = () => setInstalled(isInstalledDisplayMode());
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  if (
    detectAdapter() !== "web" ||
    installed ||
    protection === null ||
    protection === "protected"
  ) {
    return null;
  }

  if (collapsed) {
    return (
      <>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="flex w-full shrink-0 items-center gap-2 border-t border-border px-3.5 py-2.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Shield className="size-3.5 shrink-0" />
          <span className="underline decoration-border underline-offset-2">
            {t("storage.bannerCollapsedCta", "Notes unprotected")}
          </span>
        </button>
        <InstallAppDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      </>
    );
  }

  return (
    <>
      <div
        role="status"
        // The primary tint reads as a highlight next to the desktop sidebar's
        // panel color; on the mobile full-screen sidebar it just looks like a
        // stray gray block, so the banner stays flush there.
        className="flex shrink-0 items-start gap-2.5 border-t border-border px-3.5 py-2.5 md:bg-[color-mix(in_oklab,var(--primary)_7%,var(--sidebar))]"
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
            // Full touch-target size on mobile, compact inside the desktop sidebar.
            size={isMobile ? "default" : "xs"}
            className="mt-[5px] self-start rounded-[7px]"
            onClick={() => setDialogOpen(true)}
          >
            {t("storage.protectCta", "Protect my notes")}
          </Button>
        </div>
        <button
          type="button"
          aria-label={t("common.dismiss", "Dismiss")}
          onClick={collapse}
          className="-me-1.5 -mt-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <InstallAppDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
