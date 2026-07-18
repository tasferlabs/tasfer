import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueries } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getPersistentStorageStatus,
  PERSISTENT_STORAGE_STATUS_EVENT,
  type PersistentStorageStatus,
} from "@/lib/persistentStorage";
import { detectAdapter } from "@/platform";
import { getPages } from "../api/pages.api";
import { useSpaces } from "../contexts/SpaceContext";
import useResponsive from "../hooks/useResponsive";
import { InstallAppDialog } from "./InstallAppDialog";
import { NudgeCard } from "./NudgeCard";

const STANDALONE_QUERY = "(display-mode: standalone)";

/**
 * localStorage record of the user's explicit collapse/expand choice: "1"
 * collapsed, "0" expanded, absent when they never touched the banner (state
 * then follows whether any notes exist yet).
 */
const COLLAPSED_KEY = "storageBannerCollapsed";

function readCollapsedChoice(): boolean | null {
  try {
    const value = window.localStorage.getItem(COLLAPSED_KEY);
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

/** True when Tasfer runs as an installed app (PWA or Add-to-Home-Screen). */
function isInstalledDisplayMode(): boolean {
  if (typeof window === "undefined") return false;
  // iOS Safari home-screen apps predate the display-mode media query.
  if ((navigator as { standalone?: boolean }).standalone === true) return true;
  return window.matchMedia?.(STANDALONE_QUERY).matches ?? false;
}

/**
 * Sidebar-bottom nudge shown while Tasfer runs in a plain browser tab, where
 * the only copy of the user's data sits in evictable browser storage. Opens
 * the install dialog; hidden on native builds and installed PWAs, where
 * storage is already out of the browser's cleanup reach.
 *
 * Collapsing shrinks it to a one-line "Notes in browser storage" affordance
 * rather than removing it — the eviction risk persists as long as Tasfer runs
 * in a tab, so the signal must too, just quietly. The collapsed row expands
 * back to the full banner. The choice is per browser (localStorage); there is
 * deliberately no way to fully hide it.
 *
 * Until the user has made that choice, the state follows whether there is
 * anything to protect: collapsed while no pages exist (a fresh arrival out of
 * onboarding has no data at risk, and warning them then reads as noise), full
 * banner once the first note does. An explicit collapse/expand overrides this
 * permanently.
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
  // null = the user never collapsed or expanded the banner themselves.
  const [collapsedChoice, setCollapsedChoice] = useState<boolean | null>(
    readCollapsedChoice,
  );
  // null while the initial async check runs — render nothing rather than
  // flashing the warning at users whose storage is already protected.
  const [protection, setProtection] = useState<PersistentStorageStatus | null>(
    null,
  );
  const isMobile = useResponsive("(max-width: 768px)");

  // Same query keys as the sidebar page trees, so this shares their cache and
  // flips live when the first page is created (["pages"] invalidation).
  const { spaces } = useSpaces();
  const pageQueries = useQueries({
    queries: spaces.map((space) => ({
      queryKey: [
        "pages",
        { spaceId: space.id, parentId: null, includeTasks: false },
      ],
      queryFn: () => getPages(space.id, null),
    })),
  });
  const hasNotes = pageQueries.some(
    (query) => (query.data?.length ?? 0) > 0,
  );
  // Latches after the initial load: creating a space later re-adds a pending
  // query, and unmounting the banner for that beat would flicker.
  const pagesSettled = useRef(false);
  if (pageQueries.every((query) => !query.isPending)) {
    pagesSettled.current = true;
  }

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
    setCollapsedChoice(true);
  };

  const expand = () => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, "0");
    } catch {
      // Storage unavailable — expand for this page load only.
    }
    setCollapsedChoice(false);
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
    protection === "protected" ||
    // No explicit choice yet: wait for the page queries before deriving the
    // state from hasNotes, so the banner mounts in its final shape instead of
    // rendering collapsed and animating open a beat later.
    (collapsedChoice === null && !pagesSettled.current)
  ) {
    return null;
  }

  const collapsed = collapsedChoice ?? !hasNotes;

  return (
    <>
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
                onClick={expand}
                className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <Shield className="size-3.5 shrink-0" />
                <span>
                  {t("storage.bannerCollapsedCta", "Notes in browser storage")}
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
              // The primary tint reads as a highlight next to the desktop
              // sidebar's panel color; on the mobile full-screen sidebar it
              // just looks like a stray gray block, so the banner stays
              // flush there.
              className="md:bg-[color-mix(in_oklab,var(--primary)_7%,var(--sidebar))]"
            >
              <NudgeCard
                role="status"
                // The whole banner is an accordion header: clicking anywhere
                // collapses it. The chevron button stays for keyboard and
                // screen-reader users; its click bubbling here is harmless
                // (same collapse).
                onClick={collapse}
                className="cursor-pointer select-none"
                icon={<Shield className="size-4 text-primary" />}
                title={t(
                  "storage.bannerTitle",
                  "Your notes are in browser storage",
                )}
                description={t(
                  "storage.bannerDesc",
                  "The browser may clear it to free up space. Install Tasfer to keep them safe.",
                )}
                action={
                  <Button
                    // Full touch-target size on mobile, compact inside the desktop sidebar.
                    size={isMobile ? "default" : "xs"}
                    className="mt-[5px] cursor-pointer self-start rounded-[7px]"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDialogOpen(true);
                    }}
                  >
                    {t("storage.protectCta", "Protect my notes")}
                  </Button>
                }
                trailing={
                  <button
                    type="button"
                    aria-expanded
                    aria-label={t("common.collapse", "Collapse")}
                    onClick={collapse}
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
      <InstallAppDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
