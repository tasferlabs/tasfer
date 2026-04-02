import { clsx } from "clsx";
import { useLocation } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import style from "./Layout.module.css";
import { SidebarContent } from "./SidebarContent";

export function FloatingSidebar({
  open,
  setOpen,
  onAddSpace,
  onSpaceSettings,
  onInviteMembers,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onAddSpace: () => void;
  onSpaceSettings: (spaceId: string) => void;
  onInviteMembers: (spaceId: string) => void;
}) {
  const location = useLocation();
  const prevLocation = useRef(location);
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep sidebar mounted during close animation
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open) setVisible(true);
  }, [open]);

  // Close sidebar when navigating to a page
  useEffect(() => {
    if (prevLocation.current !== location) {
      prevLocation.current = location;
      if (open) setOpen(false);
    }
  }, [location, open, setOpen]);

  const handleTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      // Only handle transitions on the container itself, not children
      if (e.target === containerRef.current && !open) {
        setVisible(false);
      }
    },
    [open]
  );

  if (!visible && !open) return null;

  return (
    <div
      ref={containerRef}
      className={clsx(style.floatingSidebar, open && style.floatingSidebarOpen)}
      onTransitionEnd={handleTransitionEnd}
    >
      <SidebarContent setOpen={setOpen} onAddSpace={onAddSpace} onSpaceSettings={onSpaceSettings} onInviteMembers={onInviteMembers} />
    </div>
  );
}

