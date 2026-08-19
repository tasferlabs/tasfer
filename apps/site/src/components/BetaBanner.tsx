"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./BetaBanner.css";

const LS_KEY = "tasfer.banner.beta";

/**
 * Site-wide beta notice. It sits in the flow above the page chrome and scrolls
 * away with the content.
 *
 * Sticky headers (landing, download, docs) need nothing from it — they scroll
 * away with the bar and pin at 0 behind it. The privacy header is an overlay
 * pinned to the viewport, so it would cover the bar: it reads `--site-banner-h`,
 * which tracks how much of the banner is still on screen and reaches 0 once it
 * has scrolled past. Docs uses it for the chrome pinned under its header.
 * globals.css seeds an estimate for the frames before this mounts.
 *
 * The bar is rendered server-side and hidden pre-paint by the inline script in
 * the locale layout when it was dismissed earlier — that keeps the markup stable
 * across hydration and avoids a flash of the bar.
 */
export function BetaBanner() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem(LS_KEY) === "dismissed") setDismissed(true);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const bar = barRef.current;
    const root = document.documentElement;
    if (dismissed || !bar) {
      root.style.removeProperty("--site-banner-h");
      return;
    }
    let frame = 0;
    const sync = () => {
      frame = 0;
      const left = Math.max(0, bar.offsetHeight - window.scrollY);
      root.style.setProperty("--site-banner-h", `${left}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(bar);
    window.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      root.style.removeProperty("--site-banner-h");
    };
  }, [dismissed]);

  function dismiss() {
    setDismissed(true);
    document.documentElement.setAttribute("data-beta-banner", "off");
    try {
      localStorage.setItem(LS_KEY, "dismissed");
    } catch {
      /* ignore */
    }
  }

  if (dismissed) return null;

  return (
    <div className="site-banner" role="status" ref={barRef}>
      <div className="site-banner-inner">
        <p className="site-banner-text">
          <span className="site-banner-tag">
            {t("banner.beta.tag", "Beta")}
          </span>
          {t(
            "banner.beta.text",
            "Tasfer is unfinished software. Sync can fail, formats may change, and notes can be lost. Keep your own backups.",
          )}
        </p>
        <button className="site-banner-dismiss" onClick={dismiss}>
          {t("banner.beta.dismiss", "Dismiss")}
        </button>
      </div>
    </div>
  );
}

export default BetaBanner;
