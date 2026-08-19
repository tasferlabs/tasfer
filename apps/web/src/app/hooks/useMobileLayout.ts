import useResponsive from "./useResponsive";

/**
 * Whether the app should show its touch chrome (floating sidebar, full-screen
 * command palette) instead of the docked desktop layout.
 *
 * Width alone is not enough: a phone in landscape is wider than the breakpoint
 * but far too short for a docked sidebar or a centered dialog — the soft
 * keyboard leaves either a sliver. `isShort` is exposed separately so callers
 * can also tighten their density on that viewport.
 */
export default function useMobileLayout(): {
  isMobile: boolean;
  isShort: boolean;
} {
  // One query rather than two ORed together: as separate matchMedia lists a
  // rotation can report the width change before the height one, and the false
  // reading in between is enough to tear down and rebuild the layout it feeds.
  const isMobile = useResponsive(
    "(max-width: 768px), (pointer: coarse) and (max-height: 600px)",
  );
  const isShort = useResponsive("(pointer: coarse) and (max-height: 600px)");
  return { isMobile, isShort };
}
