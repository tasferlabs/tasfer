/* MobileAppGate.tsx — mobile-web "get the app" interstitial.
 *
 * On a plain mobile browser Cypher's touch experience is a compromise: the
 * native iOS/Android build is faster and fully offline. This screen recommends
 * the app and shows the App Store / Google Play badges. The native apps set
 * their own platform markers (getClientPlatform returns "ios" | "android" |
 * "electron"), so this only ever shows on the "web" platform.
 *
 * iOS isn't published yet, so the App Store badge is a placeholder that carries
 * the official artwork but doesn't link. Android ships via an open beta, so that
 * slot is a live "Join the Android beta" button that opens a prefilled email.
 *
 * The gate is a recommendation, not a wall: "Continue in the browser" dismisses
 * it (persisted in localStorage, so it shows once per browser) and drops the
 * user into the full web app.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { getClientPlatform } from "@/platform";
import "./MobileAppGate.css";

/** Phone-sized viewport with a touch primary pointer (excludes narrow desktop
 *  windows, which keep a fine pointer). */
const MOBILE_QUERY = "(max-width: 820px) and (pointer: coarse)";

/** localStorage flag set when the user taps "Continue in the browser". */
const DISMISSED_KEY = "mobileGateDismissed";

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

export function MobileAppGate() {
  const { t } = useTranslation();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [dismissed, setDismissed] = React.useState(readDismissed);
  const shouldShow = getClientPlatform() === "web" && isMobile && !dismissed;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage unavailable — dismiss for this page load only.
    }
    setDismissed(true);
  };

  // Lock body scroll while the gate covers the app.
  React.useEffect(() => {
    if (!shouldShow) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [shouldShow]);

  if (!shouldShow) return null;

  const base = import.meta.env.BASE_URL;

  const betaSubject = t("mobileGate.betaSubject", "Cypher Android beta");
  const betaBody = t(
    "mobileGate.betaBody",
    "Hi Hamza,\n\nI'd like to join the Cypher Android beta.\n",
  );
  const betaHref = `mailto:hi@hamza.se?subject=${encodeURIComponent(
    betaSubject,
  )}&body=${encodeURIComponent(betaBody)}`;

  return (
    <div className="mag-root" role="dialog" aria-modal="true">
      <div className="mag-inner">
        <div className="mag-logo">
          <img src={`${base}logo.png`} alt="" width={84} height={84} />
        </div>

        <div className="mag-wordmark">Cypher</div>

        <h1 className="mag-headline">
          {t("mobileGate.headline", "Cypher is better in the app")}
        </h1>

        <p className="mag-body">
          {t(
            "mobileGate.body",
            "The native app is faster, works fully offline, and is built for your phone.",
          )}
        </p>

        <div className="mag-badges">
          <img
            className="mag-badge"
            src={`${base}badges/app-store.svg`}
            alt={t("mobileGate.appStore", "Download on the App Store")}
          />
        </div>

        <p className="mag-beta-line">
          {t("mobileGate.androidPrefix", "On Android?")}{" "}
          <a className="mag-beta-link" href={betaHref}>
            {t("mobileGate.androidBeta", "Join the beta")}
          </a>
        </p>

        <button type="button" className="mag-continue" onClick={dismiss}>
          {t("mobileGate.continueBrowser", "Continue in the browser")}
        </button>
      </div>
    </div>
  );
}
