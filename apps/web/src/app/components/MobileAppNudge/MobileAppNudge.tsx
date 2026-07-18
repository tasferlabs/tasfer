/* MobileAppNudge.tsx — mobile-web "get the app" nudge.
 *
 * On a plain mobile browser Tasfer's touch experience is a compromise: the
 * native iOS/Android build is faster and fully offline. This card recommends
 * the app. The native apps set their own platform markers (getClientPlatform
 * returns "ios" | "android" | "electron"), so it only ever shows on "web".
 *
 * It is a recommendation, not a wall. The web app loads and stays fully usable
 * behind the card — staying in the browser needs no action at all, and both
 * the close button and "Get the app" dismiss it for good (persisted in
 * localStorage, so it shows once per browser). "Get the app" opens the shared
 * InstallAppDialog, which carries the real store badges and
 * add-to-home-screen steps.
 *
 * Visually it reuses NudgeCard — the same icon + title + description + action
 * shape as the storage-protection banner — inside the shared BottomPopover
 * card. It joins the shared popover queue so at most one popover shows at a
 * time.
 */

import React from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getClientPlatform } from "@/platform";
import { getVisitCount } from "@/lib/appVisits";
import { usePopupQueue } from "@/app/contexts/PopupQueueContext";
import { Button } from "@/components/ui/button";
import { BottomPopover } from "../BottomPopover";
import { NudgeCard } from "../NudgeCard";
import { InstallAppDialog } from "../InstallAppDialog";

/** Phone-sized viewport with a touch primary pointer (excludes narrow desktop
 *  windows, which keep a fine pointer). */
const MOBILE_QUERY = "(max-width: 820px) and (pointer: coarse)";

/** localStorage flag set when the user dismisses the nudge. */
const DISMISSED_KEY = "mobileNudgeDismissed";

/** Show from the second load onward, so it never lands on a first impression. */
const VISIT_THRESHOLD = 2;

/** Delay before joining the queue, keeping it off the very first paint. */
const REGISTER_DELAY_MS = 600;

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = React.useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(query).matches
      : false,
  );
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const update = () => setMatch(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return match;
}

export function MobileAppNudge() {
  const { t } = useTranslation();
  const { registerPopup, unregisterPopup, isActivePopup } = usePopupQueue();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [dismissed, setDismissed] = React.useState(readDismissed);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  // Eligible = plain mobile web, not yet dismissed, past the first impression.
  const eligible =
    getClientPlatform() === "web" &&
    isMobile &&
    !dismissed &&
    getVisitCount() >= VISIT_THRESHOLD;

  // Join the shared popover queue while eligible; only the highest-priority
  // registered popover actually renders (see PopupQueueContext). No scroll
  // lock — the nudge is non-blocking and the web app stays usable behind it.
  React.useEffect(() => {
    if (!eligible) {
      unregisterPopup("mobileAppNudge");
      return;
    }
    const timer = window.setTimeout(
      () => registerPopup("mobileAppNudge"),
      REGISTER_DELAY_MS,
    );
    return () => {
      window.clearTimeout(timer);
      unregisterPopup("mobileAppNudge");
    };
  }, [eligible, registerPopup, unregisterPopup]);

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage unavailable — dismiss for this page load only.
    }
    setDismissed(true);
    unregisterPopup("mobileAppNudge");
  };

  const visible = isActivePopup("mobileAppNudge");

  return (
    <>
      <BottomPopover
        show={visible}
        role="region"
        aria-label={t("mobileNudge.label", "Get the Tasfer app")}
        className="select-none"
      >
        <NudgeCard
          icon={
            <svg
              width={15}
              height={21}
              viewBox="0 0 100 140"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M 57 4 Q 79 34 83 66 Q 58 98 41 136 Q 30 98 17 64 Q 39 32 57 4 Z"
                fill="var(--brand-mark-color)"
              />
            </svg>
          }
          title={t("mobileNudge.headline", "Tasfer is better as an app")}
          description={t(
            "mobileNudge.body",
            "Works fully offline, and keeps your notes in protected storage the browser can't clear.",
          )}
          action={
            <Button
              size="default"
              className="mt-[5px] self-start rounded-[7px]"
              onClick={() => {
                dismiss();
                setDialogOpen(true);
              }}
            >
              {t("mobileNudge.getApp", "Get the app")}
            </Button>
          }
          trailing={
            <button
              type="button"
              aria-label={t("mobileNudge.dismiss", "Dismiss")}
              onClick={dismiss}
              className="-me-1.5 -mt-1 cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          }
        />
      </BottomPopover>

      {(visible || dialogOpen) && (
        <InstallAppDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      )}
    </>
  );
}
