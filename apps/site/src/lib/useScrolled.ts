"use client";

import { useEffect, useState } from "react";

/**
 * True once the page has scrolled past `threshold` px.
 *
 * Drives the site header's transparent → blurred transition on the marketing
 * pages. Registered passively: it only flips a boolean, never blocks the scroll.
 */
export function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);

  return scrolled;
}
