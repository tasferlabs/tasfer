import React from "react";
import { invariant } from "@shared/invariant";
import { getPlatform } from "@/platform";

/**
 * Catch-up shorter than this never reaches the screen. Most exchanges settle in
 * a few frames, and a bar that appears and vanishes reads as a glitch rather
 * than as progress.
 */
const SHOW_DELAY_MS = 400;

/**
 * Once shown, the bar stays at least this long even if sync finishes sooner —
 * long enough to be seen and understood as having finished.
 */
const MIN_VISIBLE_MS = 700;

const SyncActivityContext = React.createContext<ReadonlySet<string> | null>(
  null,
);

interface SpaceTimers {
  show?: ReturnType<typeof setTimeout>;
  hide?: ReturnType<typeof setTimeout>;
  /** When the bar became visible; unset while still inside the show delay. */
  shownAt?: number;
}

/**
 * Tracks which spaces are catching up with a peer, smoothed for display.
 *
 * The sync layer reports the exchange exactly as it happens, which is too
 * twitchy to render directly: it usually starts and ends within a frame or two,
 * and can flip back on the moment another peer answers. This holds the raw
 * signal to one on-screen state per space — shown only once catch-up outlasts
 * {@link SHOW_DELAY_MS}, and then kept for {@link MIN_VISIBLE_MS}.
 */
export function SyncActivityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [visible, setVisible] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );

  React.useEffect(() => {
    const timers = new Map<string, SpaceTimers>();

    function show(spaceId: string) {
      setVisible((prev) => {
        if (prev.has(spaceId)) return prev;
        const next = new Set(prev);
        next.add(spaceId);
        return next;
      });
    }

    function hide(spaceId: string) {
      timers.delete(spaceId);
      setVisible((prev) => {
        if (!prev.has(spaceId)) return prev;
        const next = new Set(prev);
        next.delete(spaceId);
        return next;
      });
    }

    function apply(spaceIds: string[]) {
      const syncing = new Set(spaceIds);

      for (const spaceId of syncing) {
        const entry = timers.get(spaceId);
        if (entry) {
          // Syncing again before the bar came down — keep it up.
          clearTimeout(entry.hide);
          entry.hide = undefined;
          continue;
        }
        const next: SpaceTimers = {};
        next.show = setTimeout(() => {
          next.shownAt = Date.now();
          show(spaceId);
        }, SHOW_DELAY_MS);
        timers.set(spaceId, next);
      }

      for (const [spaceId, entry] of timers) {
        if (syncing.has(spaceId) || entry.hide) continue;
        if (entry.shownAt === undefined) {
          // Finished inside the show delay: nothing was ever drawn.
          clearTimeout(entry.show);
          timers.delete(spaceId);
          continue;
        }
        const shownFor = Date.now() - entry.shownAt;
        entry.hide = setTimeout(
          () => hide(spaceId),
          Math.max(0, MIN_VISIBLE_MS - shownFor),
        );
      }
    }

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = getPlatform().sync.onSyncingSpacesChange(apply);
    } catch {
      // Platform not initialized yet — nothing to subscribe to.
    }
    return () => {
      unsubscribe?.();
      for (const entry of timers.values()) {
        clearTimeout(entry.show);
        clearTimeout(entry.hide);
      }
      timers.clear();
    };
  }, []);

  return (
    <SyncActivityContext.Provider value={visible}>
      {children}
    </SyncActivityContext.Provider>
  );
}

/** Whether a space should currently show that it is catching up. */
export function useIsSpaceSyncing(spaceId: string): boolean {
  const syncing = React.useContext(SyncActivityContext);
  invariant(
    syncing,
    "useIsSpaceSyncing must be used within SyncActivityProvider",
  );
  return syncing.has(spaceId);
}
