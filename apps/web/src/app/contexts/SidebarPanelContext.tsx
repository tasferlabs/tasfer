import { createContext, useContext, useRef, useState } from "react";

interface SidebarPanelContextValue {
  /** DOM element inside the sidebar where panels can portal into */
  panelRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Whether a panel is currently occupying the sidebar */
  hasPanel: boolean;
  setHasPanel: (has: boolean) => void;
  /** Whether the panel slot DOM element is currently mounted */
  slotMounted: boolean;
  setSlotMounted: (mounted: boolean) => void;
}

const SidebarPanelContext = createContext<SidebarPanelContextValue>({
  panelRef: { current: null },
  hasPanel: false,
  setHasPanel: () => {},
  slotMounted: false,
  setSlotMounted: () => {},
});

export function SidebarPanelProvider({ children }: { children: React.ReactNode }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [hasPanel, setHasPanel] = useState(false);
  const [slotMounted, setSlotMounted] = useState(false);

  return (
    <SidebarPanelContext.Provider value={{ panelRef, hasPanel, setHasPanel, slotMounted, setSlotMounted }}>
      {children}
    </SidebarPanelContext.Provider>
  );
}

export function useSidebarPanel() {
  return useContext(SidebarPanelContext);
}
