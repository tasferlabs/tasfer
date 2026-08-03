"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Tracks a CSS media query in React state.
 *
 *  The server snapshot is always `false`: the site is a static export, so
 *  prerendering has no viewport to measure. Anything gated on this renders in
 *  its "query does not match" form in the HTML and is corrected on hydration —
 *  keep the desktop layout on that side of the branch. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onStoreChange);
      return () => list.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    useCallback(() => window.matchMedia(query).matches, [query]),
    () => false,
  );
}
