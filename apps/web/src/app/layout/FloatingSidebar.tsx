import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { useActiveEditor } from "../contexts/ActiveEditorContext";
import useDrawerSwipe from "../hooks/useDrawerSwipe";
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
  const { i18n } = useTranslation();
  const location = useLocation();
  const prevLocation = useRef(location);
  const { editor } = useActiveEditor();

  // Stays mounted at every position, closed included: the drag has to have
  // something to pull, and this is also the tree that has to be listening when a
  // peer adds a page.
  const { drawerRef } = useDrawerSwipe({
    open,
    setOpen,
    isRtl: i18n.dir() === "rtl",
    // The canvas fills the page and is a single element, so a drag over it can
    // only be told apart from the inside: the editor knows whether the finger
    // came down on a selection handle, the caret, or the selection itself, and
    // a sideways drag on any of those is the user adjusting a selection, not
    // reaching for the drawer.
    ownsGesture: () => editor?.host.ownsPointerGesture() ?? false,
  });

  // Close sidebar when navigating to a page
  useEffect(() => {
    if (prevLocation.current !== location) {
      prevLocation.current = location;
      if (open) setOpen(false);
    }
  }, [location, open, setOpen]);

  return (
    <div
      ref={drawerRef}
      data-app-sidebar=""
      className={style.floatingSidebar}
      inert={!open ? (true as unknown as boolean) : undefined}
    >
      <SidebarContent
        setOpen={setOpen}
        onAddSpace={onAddSpace}
        onSpaceSettings={onSpaceSettings}
        onInviteMembers={onInviteMembers}
        isMobile
      />
    </div>
  );
}
