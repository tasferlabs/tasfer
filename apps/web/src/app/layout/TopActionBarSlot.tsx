import React, { createContext, useCallback, useContext, useState } from "react";
import { createPortal } from "react-dom";

type SlotContextValue = {
  node: HTMLDivElement | null;
  ref: (el: HTMLDivElement | null) => void;
};

const SlotContext = createContext<SlotContextValue>({
  node: null,
  ref: () => {},
});

/**
 * Provides a React-managed ref for the top action bar slot element.
 * TopActionBar attaches `slotRef` to the slot div, and pages use
 * `TopActionBarPortal` to render into it. Because the reference is
 * managed through React context (not getElementById), portals are
 * properly cleaned up on HMR and component unmount.
 */
export function TopActionBarSlotProvider({ children }: { children: React.ReactNode }) {
  const [node, setBlock] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => setBlock(el), []);

  return (
    <SlotContext.Provider value={{ node, ref }}>
      {children}
    </SlotContext.Provider>
  );
}

/**
 * Returns a callback ref to attach to the slot div element.
 * Used by TopActionBar.
 */
export function useTopActionBarSlotRef() {
  return useContext(SlotContext).ref;
}

/**
 * Renders children into the top action bar slot via portal.
 * Used by page components (EditorPage, CalendarPage, SettingsPage).
 */
export function TopActionBarPortal({ children }: { children: React.ReactNode }) {
  const { node } = useContext(SlotContext);
  if (!node) return null;
  return createPortal(children, node);
}
