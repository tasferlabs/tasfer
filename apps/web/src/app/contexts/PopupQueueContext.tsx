import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * One-at-a-time popover queue (structure ported from mineskin).
 *
 * Floating popovers — the mobile app gate, the update prompt — share the same
 * bottom slot, so at most one may be visible at once. Each widget checks its
 * own eligibility, calls registerPopup() when it wants to show, and renders
 * only while it is the active popup. The active popup is the registered id with
 * the lowest priority number (highest priority). Dismissing a popup
 * unregisters it, which promotes the next one in line.
 *
 * Priorities are defined centrally so the ordering between competing popovers
 * is decided in one place. Consumers must be mounted inside PopupQueueProvider.
 */
export const POPUP_PRIORITIES = {
  versionUpdate: 1, // An available app update outranks any promo.
  mobileAppNudge: 2, // Evergreen "get the native app" nudge on mobile web.
} as const;

export type PopupId = keyof typeof POPUP_PRIORITIES;

interface PopupQueueContextValue {
  /** Register a popup as wanting to show. */
  registerPopup: (id: PopupId) => void;
  /** Unregister a popup (on dismiss, or when it is no longer eligible). */
  unregisterPopup: (id: PopupId) => void;
  /** Whether the given popup is the one currently allowed to render. */
  isActivePopup: (id: PopupId) => boolean;
  /** The active popup id, or null when nothing is queued. */
  activePopup: PopupId | null;
}

const PopupQueueContext = createContext<PopupQueueContextValue | null>(null);

export function PopupQueueProvider({ children }: { children: ReactNode }) {
  const [registered, setRegistered] = useState<Set<PopupId>>(new Set());

  const registerPopup = useCallback((id: PopupId) => {
    setRegistered((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const unregisterPopup = useCallback((id: PopupId) => {
    setRegistered((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // The highest-priority (lowest number) registered popup wins the slot.
  const activePopup = useMemo<PopupId | null>(() => {
    if (registered.size === 0) return null;
    return Array.from(registered).sort(
      (a, b) => POPUP_PRIORITIES[a] - POPUP_PRIORITIES[b],
    )[0];
  }, [registered]);

  const isActivePopup = useCallback(
    (id: PopupId) => activePopup === id,
    [activePopup],
  );

  const value = useMemo(
    () => ({ registerPopup, unregisterPopup, isActivePopup, activePopup }),
    [registerPopup, unregisterPopup, isActivePopup, activePopup],
  );

  return (
    <PopupQueueContext.Provider value={value}>
      {children}
    </PopupQueueContext.Provider>
  );
}

export function usePopupQueue() {
  const ctx = useContext(PopupQueueContext);
  if (!ctx) {
    throw new Error("usePopupQueue must be used within a PopupQueueProvider");
  }
  return ctx;
}
