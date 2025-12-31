import { CaretDoubleLeftIcon, PlusIcon } from "@phosphor-icons/react";
import { clsx } from "clsx";
import React from "react";
import { ScrollArea } from "../../components/ui/scroll-area";
import Icons from "../components/uiKit/Icons/Icons";
import VisuallyHidden from "../components/uiKit/VisuallyHidden/VisuallyHidden";
import style from "./Layout.module.css";

// Mock t function
const t = (s: string | TemplateStringsArray) => s.toString();

export function SidebarContent({
  setOpen,
}: {
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  // Mock data
  const inboxCount = 0;
  const filteredGroups: { id: string; name: string }[] = [];

  return (
    <>
      <div className={style.appSidebarHeader}>
        {/* UserDropdown placeholder */}
        <div
          className="w-8 h-8 rounded-full bg-muted"
        />

        <button
          onClick={() => setOpen(false)}
          className={clsx(style.iconButton, style.appSidebarClose)}
        >
          <CaretDoubleLeftIcon size={24} />
          <VisuallyHidden>{t`Close sidebar`}</VisuallyHidden>
        </button>
      </div>
      <div className={style.appNavigationLinks}>
        <button className={style.appNavigationLink}>
          <div className={style.appNavigationLinkIcon}>
            <Icons.Gear width={24} height={24} />
          </div>
          {t`Settings`}
        </button>
        <button className={style.appNavigationLink}>
          <div className={style.appNavigationLinkIcon}>
            <Icons.Tray width={24} height={24} />
          </div>
          {t`Inbox`}
          {inboxCount > 0 && (
            <span className={style.appNavigationLinkBadge}>{inboxCount}</span>
          )}
        </button>
        <button className={style.appNavigationLink}>
          <div className={style.appNavigationLinkIcon}>
            <Icons.AddGroup />
          </div>
          {t`Add group`}
        </button>
      </div>

      <ScrollArea className={style.appSidebarScrollArea}>
        {filteredGroups.map((group) => (
          <React.Fragment key={group.id}>
            <div className={style.appSidebarSection}>
              <div className={style.appSidebarSectionTitle}>
                <div className={style.appSidebarSectionIcon}>
                  <Icons.Shared />
                </div>
                {group.name}
              </div>
              <button className={style.appSidebarSectionButton}>
                <PlusIcon size={20} />
                <span className="sr-only">{t`Add page`}</span>
              </button>
            </div>
            {/* PagesArea placeholder */}
            <div style={{ padding: "0 1rem", opacity: 0.5 }}>Pages...</div>
          </React.Fragment>
        ))}

        <div className={style.appSidebarSection}>
          <div className={style.appSidebarSectionTitle}>
            <div className={style.appSidebarSectionIcon}>
              <Icons.Lock width={20} height={20} />
            </div>
            {t`Private`}
          </div>
          <button className={style.appSidebarSectionButton}>
            <PlusIcon size={20} />
            <span className="sr-only">{t`Add page`}</span>
          </button>
        </div>

        {/* PagesArea placeholder */}
        <div style={{ padding: "0 1rem", opacity: 0.5 }}>Pages...</div>
      </ScrollArea>
    </>
  );
}
