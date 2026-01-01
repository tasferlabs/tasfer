import { CaretDoubleLeftIcon, PlusIcon } from "@phosphor-icons/react";
import { clsx } from "clsx";
import React from "react";
import { DndProvider, MouseTransition, TouchTransition } from "react-dnd-multi-backend";
import type { MultiBackendOptions } from "react-dnd-multi-backend";
import { HTML5Backend } from "react-dnd-html5-backend";
import { TouchBackend } from "react-dnd-touch-backend";
import { useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "../../components/ui/scroll-area";
import Icons from "../components/uiKit/Icons/Icons";
import VisuallyHidden from "../components/uiKit/VisuallyHidden/VisuallyHidden";
import { useCreatePage } from "../api/pages.api";
import { PagesArea } from "./components/PagesArea";
import style from "./Layout.module.css";

// Mock t function
const t = (s: string | TemplateStringsArray) => s.toString();

export const HTML5toTouch: MultiBackendOptions = {
  backends: [
    {
      id: "html5",
      backend: HTML5Backend,
      transition: MouseTransition,
    },
    {
      id: "touch",
      backend: TouchBackend,
      options: { enableMouseEvents: true, delayTouchStart: 100 },
      preview: true,
      transition: TouchTransition,
    },
  ],
};

export function SidebarContent({
  setOpen,
}: {
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const queryClient = useQueryClient();
  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: variables.parentId }],
      });
    },
  });

  function handleAdd(parentId: string | null) {
    createPage({
      title: "",
      parentId,
    });
  }

  // Mock data
  const inboxCount = 0;
  const filteredGroups: { id: string; name: string }[] = [];

  return (
    <>
      <div className={style.appSidebarHeader}>
        {/* UserDropdown placeholder */}
        <div className="w-8 h-8 rounded-full bg-muted" />

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

      <DndProvider options={HTML5toTouch}>
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
                <button 
                  className={style.appSidebarSectionButton}
                  onClick={() => handleAdd(null)}
                  disabled={isCreating}
                >
                  <PlusIcon size={20} />
                  <span className="sr-only">{t`Add page`}</span>
                </button>
              </div>
              <PagesArea parentId={null} />
            </React.Fragment>
          ))}

          <div className={style.appSidebarSection}>
            <div className={style.appSidebarSectionTitle}>
              <div className={style.appSidebarSectionIcon}>
                <Icons.Lock width={20} height={20} />
              </div>
              {t`Private`}
            </div>
            <button 
              className={style.appSidebarSectionButton}
              onClick={() => handleAdd(null)}
              disabled={isCreating}
            >
              <PlusIcon size={20} />
              <span className="sr-only">{t`Add page`}</span>
            </button>
          </div>

          <PagesArea className={style.appSidebarSectionPagesArea} parentId={null} />
        </ScrollArea>
      </DndProvider>
    </>
  );
}
