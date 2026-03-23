import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Drawer } from "vaul";
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

  // Close sidebar when location changes (e.g., when opening or creating a page)
  useEffect(() => {
    setOpen(false);
  }, [location, setOpen]);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={setOpen}
      direction={i18n.dir() === "rtl" ? "right" : "left"}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Drawer.Content className={style.floatingSidebar}>
          <SidebarContent setOpen={setOpen} onAddSpace={onAddSpace} onSpaceSettings={onSpaceSettings} onInviteMembers={onInviteMembers} />
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

